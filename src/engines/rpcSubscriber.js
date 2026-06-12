/**
 * rpcSubscriber.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Façade qui maintient la liste des wallets surveillés et relaie les events
 * "tx" depuis webhookServer vers les moteurs (standardEngine, chainEngine).
 *
 * Architecture webhook:
 *   Helius → POST /webhook → webhookServer → rpcSubscriber (emit 'tx') → engines
 *
 * La gestion des souscriptions Helius (ajout/retrait de wallets dans le webhook)
 * est faite via heliusWebhook.js (API REST Helius).
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const { EventEmitter } = require('events');
const logger           = require('../utils/logger');
const webhookServer    = require('./webhookServer');
const heliusWebhook    = require('../utils/heliusWebhook');

class RpcSubscriber extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(200);

    /** @type {Set<string>} wallets actuellement surveillés */
    this._wallets = new Set();
    this._started = false;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // PUBLIC
  // ──────────────────────────────────────────────────────────────────────────

  async start() {
    if (this._started) return;
    this._started = true;

    // Démarre le serveur HTTP webhook
    webhookServer.start();

    // Relaie les events 'tx' du webhookServer vers les moteurs
    webhookServer.on('tx', (txData) => {
      const { accountKeys = [], signature, slot, raw } = txData;

      // Trouve le wallet surveillé impliqué dans cette tx
      const involvedWallet = accountKeys.find(addr => this._wallets.has(addr));

      if (!involvedWallet) {
        // Helius envoie parfois des txs hors wallets surveillés (rare) → ignore
        logger.debug(`[RpcSubscriber] Tx ${signature} — aucun wallet surveillé impliqué`);
        return;
      }

      logger.info(`[RpcSubscriber] 🔔 Tx détectée — wallet=${involvedWallet} sig=${signature}`);

      this.emit('tx', {
        walletAddress: involvedWallet,
        signature,
        slot,
        raw,
      });
    });

    logger.info('[RpcSubscriber] ✅ Mode Webhook Helius actif');
  }

  /** Ajoute un wallet à surveiller + met à jour le webhook Helius */
  async subscribe(walletAddress) {
    if (this._wallets.has(walletAddress)) return;
    this._wallets.add(walletAddress);
    logger.info(`[RpcSubscriber] Wallet ajouté: ${walletAddress} (total: ${this._wallets.size})`);

    // Met à jour le webhook Helius avec la nouvelle liste
    await heliusWebhook.updateWallets([...this._wallets]).catch(err =>
      logger.error(`[RpcSubscriber] Erreur update webhook: ${err.message}`)
    );
  }

  /** Retire un wallet de la surveillance + met à jour le webhook Helius */
  async unsubscribe(walletAddress) {
    if (!this._wallets.has(walletAddress)) return;
    this._wallets.delete(walletAddress);
    logger.info(`[RpcSubscriber] Wallet retiré: ${walletAddress} (total: ${this._wallets.size})`);

    await heliusWebhook.updateWallets([...this._wallets]).catch(err =>
      logger.error(`[RpcSubscriber] Erreur update webhook: ${err.message}`)
    );
  }

  async stop() {
    webhookServer.stop();
    this._started = false;
    logger.info('[RpcSubscriber] Arrêté');
  }

  getSubscribedWallets() {
    return [...this._wallets];
  }
}

// Singleton
const rpcSubscriber = new RpcSubscriber();
module.exports = rpcSubscriber;
