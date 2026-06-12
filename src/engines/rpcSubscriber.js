/**
 * rpcSubscriber.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Surveillance des wallets via Helius WebSocket natif (transactionSubscribe).
 *
 * Pourquoi pas onLogs de @solana/web3.js ?
 *   → onLogs ne déclenche jamais le callback sur Helius enhanced WS pour
 *     les wallets standards. Helius recommande leur propre méthode
 *     "transactionSubscribe" via WebSocket JSON-RPC natif.
 *
 * URL: wss://atlas-mainnet.helius-rpc.com/?api-key=KEY
 * Méthode: transactionSubscribe avec accountInclude[]
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const { EventEmitter } = require('events');
const WebSocket        = require('ws');
const logger           = require('../utils/logger');

const HELIUS_API_KEY       = process.env.HELIUS_API_KEY || '';
const HELIUS_WS_URL        = `wss://atlas-mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const RECONNECT_DELAY_MS   = parseInt(process.env.WS_RECONNECT_DELAY_MS || '5000', 10);
const MAX_RECONNECT_DELAY  = 120_000;
const PING_INTERVAL_MS     = 30_000;
const MAX_RECONNECT_ATTEMPTS = 10;

class RpcSubscriber extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(200);

    /** @type {Set<string>} wallets actuellement surveillés */
    this._wallets = new Set();

    /** WebSocket actif */
    this._ws = null;

    /** subscriptionId retourné par Helius */
    this._subId = null;

    this._isShuttingDown    = false;
    this._pingTimer         = null;
    this._reconnectTimer    = null;
    this._reconnectAttempts = 0;
    this._isReconnecting    = false;

    /** request id counter pour JSON-RPC */
    this._reqId = 1;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // PUBLIC
  // ──────────────────────────────────────────────────────────────────────────

  async start() {
    this._isShuttingDown    = false;
    this._reconnectAttempts = 0;

    if (!HELIUS_API_KEY) {
      logger.error('[RpcSubscriber] HELIUS_API_KEY manquante — arrêt');
      return;
    }

    logger.info('[RpcSubscriber] Démarrage WebSocket Helius transactionSubscribe');
    this._connect();
  }

  /** Ajoute un wallet à surveiller (reconnecte si WS déjà ouvert) */
  subscribe(walletAddress) {
    if (this._wallets.has(walletAddress)) {
      logger.debug(`[RpcSubscriber] Déjà souscrit: ${walletAddress}`);
      return;
    }
    this._wallets.add(walletAddress);
    logger.info(`[RpcSubscriber] Wallet ajouté: ${walletAddress} (total: ${this._wallets.size})`);

    // Reconnecte le WS pour que Helius inclue le nouveau wallet
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._resubscribeAll();
    }
  }

  /** Retire un wallet de la surveillance */
  async unsubscribe(walletAddress) {
    if (!this._wallets.has(walletAddress)) return;
    this._wallets.delete(walletAddress);
    logger.info(`[RpcSubscriber] Wallet retiré: ${walletAddress} (total: ${this._wallets.size})`);

    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._resubscribeAll();
    }
  }

  async stop() {
    this._isShuttingDown = true;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this._pingTimer)      clearInterval(this._pingTimer);
    this._closeWs();
    logger.info('[RpcSubscriber] Arrêté');
  }

  getSubscribedWallets() {
    return [...this._wallets];
  }

  // ──────────────────────────────────────────────────────────────────────────
  // PRIVATE — WebSocket
  // ──────────────────────────────────────────────────────────────────────────

  _connect() {
    if (this._isShuttingDown) return;

    logger.info(`[RpcSubscriber] Connexion à Helius WS... (${this._wallets.size} wallet(s))`);

    this._ws = new WebSocket(HELIUS_WS_URL);

    this._ws.on('open', () => {
      logger.info('[RpcSubscriber] ✅ WebSocket Helius connecté');
      this._reconnectAttempts = 0;
      this._isReconnecting    = false;
      this._startPing();
      this._resubscribeAll();
    });

    this._ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this._handleMessage(msg);
      } catch (err) {
        logger.warn(`[RpcSubscriber] Message JSON invalide: ${err.message}`);
      }
    });

    this._ws.on('error', (err) => {
      logger.error(`[RpcSubscriber] Erreur WS: ${err.message}`);
    });

    this._ws.on('close', (code, reason) => {
      logger.warn(`[RpcSubscriber] WS fermé (code=${code} reason=${reason || 'N/A'})`);
      if (this._pingTimer) clearInterval(this._pingTimer);

      if (code === 4401 || (reason && reason.toString().includes('401'))) {
        logger.error(
          '[RpcSubscriber] 🔴 ERREUR 401 — Clé Helius invalide ou expirée.\n' +
          '  → Vérifie HELIUS_API_KEY dans ton .env'
        );
        return; // pas de reconnexion
      }

      this._scheduleReconnect();
    });
  }

  _closeWs() {
    if (!this._ws) return;
    try {
      this._ws.removeAllListeners();
      this._ws.terminate();
    } catch {}
    this._ws   = null;
    this._subId = null;
  }

  /** Envoie transactionSubscribe avec tous les wallets courants */
  _resubscribeAll() {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;

    const wallets = [...this._wallets];
    if (wallets.length === 0) {
      logger.info('[RpcSubscriber] Aucun wallet à surveiller');
      return;
    }

    // D'abord unsubscribe l'ancienne sub si elle existe
    if (this._subId !== null) {
      const unsubMsg = {
        jsonrpc: '2.0',
        id:      this._reqId++,
        method:  'transactionUnsubscribe',
        params:  [this._subId],
      };
      this._ws.send(JSON.stringify(unsubMsg));
      this._subId = null;
    }

    const subMsg = {
      jsonrpc: '2.0',
      id:      this._reqId++,
      method:  'transactionSubscribe',
      params: [
        {
          accountInclude: wallets,
        },
        {
          commitment:                     'confirmed',
          encoding:                       'jsonParsed',
          transactionDetails:             'full',
          showRewards:                    false,
          maxSupportedTransactionVersion: 0,
        },
      ],
    };

    this._ws.send(JSON.stringify(subMsg));
    logger.info(`[RpcSubscriber] transactionSubscribe envoyé — ${wallets.length} wallet(s): ${wallets.join(', ')}`);
  }

  /** Traite les messages entrants du WS */
  _handleMessage(msg) {
    // Réponse à transactionSubscribe → stocke le subId
    if (msg.id && msg.result !== undefined && typeof msg.result === 'number') {
      this._subId = msg.result;
      logger.info(`[RpcSubscriber] ✅ Souscription confirmée — subId=${this._subId}`);
      return;
    }

    // Notification de transaction
    if (msg.method === 'transactionNotification') {
      const params = msg.params;
      if (!params || !params.result) return;

      const txResult = params.result;
      const meta     = txResult.transaction?.meta;
      const tx       = txResult.transaction?.transaction;
      const sig      = tx?.signatures?.[0];
      const slot     = txResult.slot;

      if (!sig) return;
      if (meta?.err) return; // tx échouée

      // Détermine quel wallet surveillé est impliqué
      const accountKeys = tx?.message?.accountKeys || [];
      const involvedWallet = accountKeys
        .map(k => (typeof k === 'string' ? k : k?.pubkey))
        .find(addr => this._wallets.has(addr));

      if (!involvedWallet) return; // ne concerne pas nos wallets

      logger.debug(`[RpcSubscriber] 🔔 Tx détectée — wallet=${involvedWallet} sig=${sig}`);

      this.emit('tx', {
        walletAddress: involvedWallet,
        signature:     sig,
        slot,
      });

      return;
    }

    // Erreur JSON-RPC
    if (msg.error) {
      logger.error(`[RpcSubscriber] Erreur JSON-RPC: ${JSON.stringify(msg.error)}`);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // PRIVATE — Reconnexion & Ping
  // ──────────────────────────────────────────────────────────────────────────

  _scheduleReconnect() {
    if (this._isShuttingDown || this._isReconnecting) return;

    this._isReconnecting    = true;
    this._reconnectAttempts++;

    if (this._reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      logger.error(
        `[RpcSubscriber] 🔴 ${MAX_RECONNECT_ATTEMPTS} tentatives épuisées. Redémarre le bot.`
      );
      this._isReconnecting = false;
      return;
    }

    const delay = Math.min(
      RECONNECT_DELAY_MS * Math.pow(2, this._reconnectAttempts - 1),
      MAX_RECONNECT_DELAY
    );

    logger.info(`[RpcSubscriber] ⏳ Reconnexion dans ${delay / 1000}s (tentative ${this._reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);

    this._reconnectTimer = setTimeout(() => {
      this._closeWs();
      this._connect();
    }, delay);
  }

  /** Ping WebSocket toutes les 30s pour maintenir la connexion */
  _startPing() {
    if (this._pingTimer) clearInterval(this._pingTimer);

    this._pingTimer = setInterval(() => {
      if (this._isShuttingDown) return;

      if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
        logger.warn('[RpcSubscriber] Ping: WS non ouvert → reconnexion');
        clearInterval(this._pingTimer);
        this._scheduleReconnect();
        return;
      }

      // Envoie un ping JSON-RPC simple (getSlot)
      try {
        this._ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id:      this._reqId++,
          method:  'getSlot',
          params:  [],
        }));
        logger.debug('[RpcSubscriber] ❤️ Ping WS envoyé');
      } catch (err) {
        logger.warn(`[RpcSubscriber] Ping échoué: ${err.message}`);
      }
    }, PING_INTERVAL_MS);
  }
}

// Singleton
const rpcSubscriber = new RpcSubscriber();
module.exports = rpcSubscriber;
