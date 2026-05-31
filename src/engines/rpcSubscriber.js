/**
 * rpcSubscriber.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Gestion des souscriptions WebSocket Solana via @solana/web3.js.
 * Supporte:
 *   - onAccountChange  (notification immédiate dès qu'un compte change)
 *   - onLogs           (filter par mention d'une adresse — plus léger)
 *
 * Architecture:
 *   - Un Map<walletAddress, Set<subscriptionId>> pour tracker les sub actifs
 *   - Reconnexion automatique exponentielle en cas de drop WSS
 *   - Event emitter central que les engines Standard & Chain écoutent
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const { EventEmitter }    = require('events');
const { PublicKey }       = require('@solana/web3.js');
const { getConnection }   = require('../utils/solana');
const logger              = require('../utils/logger');

const RECONNECT_DELAY_MS  = parseInt(process.env.WS_RECONNECT_DELAY_MS || '3000', 10);
const MAX_RECONNECT_DELAY = 60_000; // 1 minute plafond

class RpcSubscriber extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(200); // beaucoup de wallets potentiels

    /** @type {Map<string, number>} wallet → subscriptionId */
    this._subs = new Map();

    /** @type {Map<string, number>} wallet → reconnect attempt count */
    this._reconnectCounts = new Map();

    this._connection = null;
    this._reconnectTimer = null;
    this._isShuttingDown = false;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // PUBLIC API
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Démarre le subscriber (initialise la connexion).
   */
  async start() {
    this._isShuttingDown = false;
    this._connection = getConnection();
    this._setupConnectionMonitor();
    logger.info('[RpcSubscriber] Démarré');
  }

  /**
   * Abonne un wallet à la surveillance.
   * Utilise onLogs (filter: "mentions") pour capter toutes les tx impliquant l'adresse.
   *
   * @param {string} walletAddress
   */
  subscribe(walletAddress) {
    if (this._subs.has(walletAddress)) {
      logger.debug(`[RpcSubscriber] Déjà souscrit: ${walletAddress}`);
      return;
    }

    try {
      const pubkey = new PublicKey(walletAddress);
      const conn   = this._connection;

      const subId = conn.onLogs(
        pubkey,
        (logs, context) => this._handleLogs(walletAddress, logs, context),
        'confirmed'
      );

      this._subs.set(walletAddress, subId);
      this._reconnectCounts.set(walletAddress, 0);
      logger.info(`[RpcSubscriber] Souscription active: ${walletAddress} (subId=${subId})`);
    } catch (err) {
      logger.error(`[RpcSubscriber] subscribe() erreur pour ${walletAddress}: ${err.message}`);
    }
  }

  /**
   * Désabonne un wallet.
   * @param {string} walletAddress
   */
  async unsubscribe(walletAddress) {
    if (!this._subs.has(walletAddress)) return;

    const subId = this._subs.get(walletAddress);
    try {
      await this._connection.removeOnLogsListener(subId);
      logger.info(`[RpcSubscriber] Désabonné: ${walletAddress}`);
    } catch (err) {
      logger.warn(`[RpcSubscriber] unsubscribe() erreur: ${err.message}`);
    } finally {
      this._subs.delete(walletAddress);
      this._reconnectCounts.delete(walletAddress);
    }
  }

  /**
   * Désabonne tous les wallets et stoppe le subscriber.
   */
  async stop() {
    this._isShuttingDown = true;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);

    const addresses = [...this._subs.keys()];
    await Promise.allSettled(addresses.map((a) => this.unsubscribe(a)));
    logger.info('[RpcSubscriber] Arrêté');
  }

  /**
   * Retourne les wallets actuellement surveillés.
   * @returns {string[]}
   */
  getSubscribedWallets() {
    return [...this._subs.keys()];
  }

  // ──────────────────────────────────────────────────────────────────────────
  // PRIVATE
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Handler appelé par onLogs dès qu'une transaction mentionne le wallet.
   */
  _handleLogs(walletAddress, logs, context) {
    if (logs.err) {
      // Transaction échouée → on ignore
      return;
    }

    const { signature } = logs;

    logger.debug(`[RpcSubscriber] Tx détectée pour ${walletAddress}: ${signature}`);

    /**
     * On émet un event "tx" que les engines vont écouter.
     * On ne parse pas ici pour ne pas bloquer le handler WSS.
     * Le parsing complet est délégué de façon asynchrone aux engines.
     */
    this.emit('tx', {
      walletAddress,
      signature,
      slot: context.slot,
    });
  }

  /**
   * Surveille la santé de la connexion WebSocket et reconnecte si nécessaire.
   * @solana/web3.js gère sa propre reconnexion interne, mais on ajoute une
   * couche supplémentaire pour forcer la re-souscription après drop prolongé.
   */
  _setupConnectionMonitor() {
    // Ping toutes les 30s pour détecter les drops silencieux
    const PING_INTERVAL = 30_000;

    const ping = async () => {
      if (this._isShuttingDown) return;
      try {
        await this._connection.getSlot('finalized');
        logger.debug('[RpcSubscriber] ❤️ Connexion RPC OK');
      } catch (err) {
        logger.warn('[RpcSubscriber] ⚠️ Ping RPC échoué, reconnexion...');
        await this._reconnectAll();
      }
      setTimeout(ping, PING_INTERVAL);
    };

    setTimeout(ping, PING_INTERVAL);
  }

  /**
   * Reconnecte toutes les souscriptions (ex: après drop réseau).
   */
  async _reconnectAll() {
    if (this._isShuttingDown) return;

    const wallets = [...this._subs.keys()];
    logger.warn(`[RpcSubscriber] Reconnexion de ${wallets.length} wallet(s)...`);

    // Annule toutes les subs actuelles sans émettre d'erreur
    for (const [addr, subId] of this._subs.entries()) {
      try {
        await this._connection.removeOnLogsListener(subId);
      } catch {}
      this._subs.delete(addr);
    }

    // Recalcule le délai exponentiel
    const attemptKey = '_global';
    const count = (this._reconnectCounts.get(attemptKey) || 0) + 1;
    this._reconnectCounts.set(attemptKey, count);
    const delay = Math.min(RECONNECT_DELAY_MS * Math.pow(2, count - 1), MAX_RECONNECT_DELAY);

    logger.info(`[RpcSubscriber] Attente ${delay}ms avant reconnexion (tentative ${count})`);

    this._reconnectTimer = setTimeout(() => {
      // Re-crée la connexion
      this._connection = getConnection();

      // Re-souscrit tous les wallets
      for (const addr of wallets) {
        this.subscribe(addr);
      }

      // Reset le compteur si succès
      this._reconnectCounts.set(attemptKey, 0);
      logger.info('[RpcSubscriber] Re-souscriptions terminées');
    }, delay);
  }
}

// Singleton
const rpcSubscriber = new RpcSubscriber();
module.exports = rpcSubscriber;
