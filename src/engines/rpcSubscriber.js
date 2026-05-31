/**
 * rpcSubscriber.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Gestion des souscriptions WebSocket Solana via @solana/web3.js.
 *
 * Corrections v1.1:
 *   - Backoff exponentiel global persistant (ne reset plus entre cycles)
 *   - Détection 401 WSS: arrêt immédiat + message d'erreur explicite
 *   - resetConnection() appelé avant toute reconnexion (force nouveau handshake)
 *   - Guard: si aucune clé API valide, on refuse de boucler indéfiniment
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const { EventEmitter }              = require('events');
const { PublicKey }                 = require('@solana/web3.js');
const { getConnection,
        resetConnection }           = require('../utils/solana');
const logger                        = require('../utils/logger');

const RECONNECT_DELAY_MS  = parseInt(process.env.WS_RECONNECT_DELAY_MS || '5000', 10);
const MAX_RECONNECT_DELAY = 120_000; // 2 minutes plafond
const PING_INTERVAL_MS    = 30_000;
const MAX_RECONNECT_ATTEMPTS = 10;  // Au-delà → on stoppe pour éviter le spam

class RpcSubscriber extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(200);

    /** @type {Map<string, number>} wallet → subscriptionId */
    this._subs = new Map();

    this._connection        = null;
    this._reconnectTimer    = null;
    this._isShuttingDown    = false;
    this._pingTimer         = null;

    // Compteur global de tentatives de reconnexion (persistant entre cycles)
    this._reconnectAttempts = 0;
    this._isReconnecting    = false; // Évite les reconnexions parallèles
  }

  // ──────────────────────────────────────────────────────────────────────────
  // PUBLIC
  // ──────────────────────────────────────────────────────────────────────────

  async start() {
    this._isShuttingDown = false;
    this._reconnectAttempts = 0;
    this._connection = getConnection();
    this._startPing();
    logger.info('[RpcSubscriber] Démarré');
  }

  subscribe(walletAddress) {
    if (this._subs.has(walletAddress)) {
      logger.debug(`[RpcSubscriber] Déjà souscrit: ${walletAddress}`);
      return;
    }
    if (!this._connection) {
      logger.warn('[RpcSubscriber] subscribe() appelé sans connexion active');
      return;
    }

    try {
      const pubkey = new PublicKey(walletAddress);

      const subId = this._connection.onLogs(
        pubkey,
        (logs, context) => this._handleLogs(walletAddress, logs, context),
        'confirmed'
      );

      this._subs.set(walletAddress, subId);
      logger.info(`[RpcSubscriber] ✅ Souscription active: ${walletAddress} (subId=${subId})`);
    } catch (err) {
      logger.error(`[RpcSubscriber] subscribe() erreur pour ${walletAddress}: ${err.message}`);
    }
  }

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
    }
  }

  async stop() {
    this._isShuttingDown = true;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this._pingTimer)      clearTimeout(this._pingTimer);

    const addresses = [...this._subs.keys()];
    await Promise.allSettled(addresses.map((a) => this.unsubscribe(a)));
    logger.info('[RpcSubscriber] Arrêté');
  }

  getSubscribedWallets() {
    return [...this._subs.keys()];
  }

  // ──────────────────────────────────────────────────────────────────────────
  // PRIVATE
  // ──────────────────────────────────────────────────────────────────────────

  _handleLogs(walletAddress, logs, context) {
    if (logs.err) return; // Tx échouée → ignore

    logger.debug(`[RpcSubscriber] Tx détectée pour ${walletAddress}: ${logs.signature}`);

    this.emit('tx', {
      walletAddress,
      signature: logs.signature,
      slot:      context.slot,
    });
  }

  /**
   * Ping HTTP RPC toutes les 30s.
   * Si ça échoue → reconnexion. Si 401 WSS détecté → log clair et stop.
   */
  _startPing() {
    const ping = async () => {
      if (this._isShuttingDown) return;

      try {
        await this._connection.getSlot('finalized');
        // Ping OK → reset le compteur de tentatives
        if (this._reconnectAttempts > 0) {
          logger.info('[RpcSubscriber] ❤️ RPC de nouveau opérationnel — reset backoff');
          this._reconnectAttempts = 0;
        }
        logger.debug('[RpcSubscriber] ❤️ Ping RPC OK');
      } catch (err) {
        const msg = err.message || '';

        // 401 = clé API invalide/expirée → inutile de boucler
        if (msg.includes('401') || msg.includes('Unauthorized') || msg.includes('403')) {
          logger.error(
            '[RpcSubscriber] 🔴 ERREUR 401/403 — Clé API Helius invalide ou expirée.\n' +
            '  → Vérifie HELIUS_API_KEY et HELIUS_RPC_WSS dans ton .env\n' +
            '  → Regénère ta clé sur https://dev.helius.xyz/dashboard'
          );
          // On stoppe les reconnexions automatiques pour ne pas spammer
          this._isShuttingDown = true;
          return;
        }

        logger.warn(`[RpcSubscriber] ⚠️ Ping RPC échoué (${msg}) — tentative de reconnexion...`);
        await this._reconnectAll();
      }

      // Planifie le prochain ping seulement si on n'est pas en shutdown
      if (!this._isShuttingDown) {
        this._pingTimer = setTimeout(ping, PING_INTERVAL_MS);
      }
    };

    this._pingTimer = setTimeout(ping, PING_INTERVAL_MS);
  }

  /**
   * Reconnecte toutes les souscriptions avec backoff exponentiel persistant.
   */
  async _reconnectAll() {
    if (this._isShuttingDown || this._isReconnecting) return;

    this._isReconnecting = true;
    this._reconnectAttempts++;

    const wallets = [...this._subs.keys()];
    logger.warn(`[RpcSubscriber] Reconnexion de ${wallets.length} wallet(s)... (tentative ${this._reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);

    // Plafond de tentatives pour éviter le spam infini
    if (this._reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      logger.error(
        `[RpcSubscriber] 🔴 ${MAX_RECONNECT_ATTEMPTS} tentatives épuisées.\n` +
        '  → Vérifier la connexion réseau et la clé API RPC.\n' +
        '  → Redémarre le bot manuellement.'
      );
      this._isReconnecting = false;
      return;
    }

    // Annule les subs actuelles
    for (const [addr, subId] of this._subs.entries()) {
      try { await this._connection.removeOnLogsListener(subId); } catch {}
      this._subs.delete(addr);
    }

    // Backoff exponentiel: 5s, 10s, 20s, 40s ... plafonné à 2min
    const delay = Math.min(
      RECONNECT_DELAY_MS * Math.pow(2, this._reconnectAttempts - 1),
      MAX_RECONNECT_DELAY
    );

    logger.info(`[RpcSubscriber] ⏳ Attente ${delay / 1000}s avant reconnexion (tentative ${this._reconnectAttempts})`);

    this._reconnectTimer = setTimeout(async () => {
      try {
        // Force un nouveau handshake complet
        resetConnection();
        this._connection = getConnection();

        // Re-souscrit tous les wallets
        for (const addr of wallets) {
          this.subscribe(addr);
        }

        logger.info(`[RpcSubscriber] ✅ Re-souscriptions terminées (${wallets.length} wallet(s))`);
      } catch (err) {
        logger.error(`[RpcSubscriber] Reconnexion échouée: ${err.message}`);
      } finally {
        this._isReconnecting = false;
      }
    }, delay);
  }
}

// Singleton
const rpcSubscriber = new RpcSubscriber();
module.exports = rpcSubscriber;
