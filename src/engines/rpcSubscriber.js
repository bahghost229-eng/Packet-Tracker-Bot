/**
 * rpcSubscriber.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Surveillance des wallets via Helius WebSocket — logsSubscribe (gratuit).
 *
 * logsSubscribe avec filtre "mentions" = méthode Solana native, plan free OK.
 * Une souscription par wallet (Solana ne supporte pas multi-wallet en un seul
 * logsSubscribe avec mentions).
 *
 * URL: wss://mainnet.helius-rpc.com/?api-key=KEY
 * Méthode: logsSubscribe { mentions: [walletAddress] }
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const { EventEmitter } = require('events');
const WebSocket        = require('ws');
const logger           = require('../utils/logger');

const HELIUS_API_KEY      = process.env.HELIUS_API_KEY || '';
const HELIUS_WS_URL       = `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const RECONNECT_DELAY_MS  = parseInt(process.env.WS_RECONNECT_DELAY_MS || '5000', 10);
const MAX_RECONNECT_DELAY = 120_000;
const PING_INTERVAL_MS    = 30_000;
const MAX_RECONNECT_ATTEMPTS = 10;

class RpcSubscriber extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(200);

    /** @type {Set<string>} */
    this._wallets = new Set();

    /** WebSocket actif */
    this._ws = null;

    /** Map<walletAddress, subId> */
    this._subIds = new Map();

    /** Map<reqId, walletAddress> — pour associer la réponse à la souscription */
    this._pendingSubs = new Map();

    this._isShuttingDown     = false;
    this._pingTimer          = null;
    this._reconnectTimer     = null;
    this._reconnectAttempts  = 0;
    this._isReconnecting     = false;
    this._reqId              = 1;
  }

  // ────────────────────────────────────────────────────────────────────────
  // PUBLIC
  // ────────────────────────────────────────────────────────────────────────

  async start() {
    this._isShuttingDown    = false;
    this._reconnectAttempts = 0;

    if (!HELIUS_API_KEY) {
      logger.error('[RpcSubscriber] HELIUS_API_KEY manquante — arrêt');
      return;
    }

    logger.info('[RpcSubscriber] Démarrage WebSocket Helius (logsSubscribe)');
    this._connect();
  }

  subscribe(walletAddress) {
    if (this._wallets.has(walletAddress)) return;
    this._wallets.add(walletAddress);
    logger.info(`[RpcSubscriber] Wallet ajouté: ${walletAddress} (total: ${this._wallets.size})`);

    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._subscribeWallet(walletAddress);
    }
  }

  async unsubscribe(walletAddress) {
    if (!this._wallets.has(walletAddress)) return;
    this._wallets.delete(walletAddress);
    logger.info(`[RpcSubscriber] Désabonné: ${walletAddress} (total: ${this._wallets.size})`);

    const subId = this._subIds.get(walletAddress);
    if (subId !== undefined && this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id:      this._reqId++,
        method:  'logsUnsubscribe',
        params:  [subId],
      }));
      this._subIds.delete(walletAddress);
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

  // ────────────────────────────────────────────────────────────────────────
  // PRIVATE — WebSocket
  // ────────────────────────────────────────────────────────────────────────

  _connect() {
    if (this._isShuttingDown) return;

    logger.info(`[RpcSubscriber] Connexion à Helius WS... (${this._wallets.size} wallet(s))`);
    this._ws = new WebSocket(HELIUS_WS_URL);

    this._ws.on('open', () => {
      logger.info('[RpcSubscriber] ✅ WebSocket Helius connecté');
      this._reconnectAttempts = 0;
      this._isReconnecting    = false;
      this._subIds.clear();
      this._pendingSubs.clear();
      this._startPing();

      // Souscription individuelle pour chaque wallet
      for (const wallet of this._wallets) {
        this._subscribeWallet(wallet);
      }
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
        logger.error('[RpcSubscriber] 🔴 ERREUR 401 — Clé Helius invalide. Vérifie HELIUS_API_KEY.');
        return;
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
    this._ws = null;
    this._subIds.clear();
    this._pendingSubs.clear();
  }

  /** Envoie un logsSubscribe pour un wallet spécifique */
  _subscribeWallet(walletAddress) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;

    const id = this._reqId++;
    this._pendingSubs.set(id, walletAddress);

    const msg = {
      jsonrpc: '2.0',
      id,
      method:  'logsSubscribe',
      params: [
        { mentions: [walletAddress] },
        { commitment: 'confirmed' },
      ],
    };

    this._ws.send(JSON.stringify(msg));
    logger.info(`[RpcSubscriber] logsSubscribe envoyé — wallet: ${walletAddress} (reqId=${id})`);
  }

  _handleMessage(msg) {
    // Confirmation de souscription → stocke le subId
    if (msg.id && msg.result !== undefined && typeof msg.result === 'number') {
      const wallet = this._pendingSubs.get(msg.id);
      if (wallet) {
        this._subIds.set(wallet, msg.result);
        this._pendingSubs.delete(msg.id);
        logger.info(`[RpcSubscriber] ✅ Souscription confirmée — wallet=${wallet} subId=${msg.result}`);
      }
      return;
    }

    // Notification de log
    if (msg.method === 'logsNotification') {
      const value = msg.params?.result?.value;
      if (!value) return;

      const sig  = value.signature;
      const logs = value.logs || [];
      const err  = value.err;

      if (!sig) return;
      if (err)  return; // tx échouée

      // Trouve quel wallet est mentionné
      const involvedWallet = [...this._wallets].find(w =>
        logs.some(line => line.includes(w))
      );

      // Fallback: on émet quand même si on a le sig (le moteur ira chercher la tx)
      const wallet = involvedWallet || null;

      logger.debug(`[RpcSubscriber] 🔔 Log détecté — wallet=${wallet} sig=${sig}`);

      this.emit('tx', {
        walletAddress: wallet,
        signature:     sig,
        slot:          msg.params?.result?.context?.slot,
        logs,
      });

      return;
    }

    // Erreur JSON-RPC
    if (msg.error) {
      logger.error(`[RpcSubscriber] Erreur JSON-RPC: ${JSON.stringify(msg.error)}`);
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // PRIVATE — Reconnexion & Ping
  // ────────────────────────────────────────────────────────────────────────

  _scheduleReconnect() {
    if (this._isShuttingDown || this._isReconnecting) return;

    this._isReconnecting = true;
    this._reconnectAttempts++;

    if (this._reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      logger.error(`[RpcSubscriber] 🔴 ${MAX_RECONNECT_ATTEMPTS} tentatives épuisées.`);
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

  _startPing() {
    if (this._pingTimer) clearInterval(this._pingTimer);

    this._pingTimer = setInterval(() => {
      if (this._isShuttingDown) return;

      if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
        clearInterval(this._pingTimer);
        this._scheduleReconnect();
        return;
      }

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
