/**
 * webhookServer.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Serveur Express qui reçoit les webhooks Helius (Enhanced Transactions).
 * Helius appelle POST /webhook à chaque tx impliquant un wallet surveillé.
 *
 * Helius webhook payload: array de transactions enrichies
 * Doc: https://docs.helius.dev/webhooks-and-websockets/what-are-webhooks
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const express   = require('express');
const { EventEmitter } = require('events');
const logger    = require('../utils/logger');

const WEBHOOK_PORT   = parseInt(process.env.WEBHOOK_PORT || '3000', 10);
const WEBHOOK_SECRET = process.env.HELIUS_WEBHOOK_SECRET || '';

class WebhookServer extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(200);
    this._app    = null;
    this._server = null;
  }

  start() {
    this._app = express();
    this._app.use(express.json({ limit: '10mb' }));

    // Health check
    this._app.get('/health', (_req, res) => {
      res.json({ status: 'ok', ts: Date.now() });
    });

    // Route principale Helius webhook
    this._app.post('/webhook', (req, res) => {
      // Vérification du secret optionnel
      if (WEBHOOK_SECRET) {
        const auth = req.headers['authorization'] || req.query.secret || '';
        if (auth !== WEBHOOK_SECRET) {
          logger.warn('[Webhook] ⚠️ Secret invalide — requête rejetée');
          return res.status(401).json({ error: 'Unauthorized' });
        }
      }

      res.status(200).json({ ok: true }); // répond vite à Helius

      const txs = Array.isArray(req.body) ? req.body : [req.body];

      for (const tx of txs) {
        try {
          this._processTx(tx);
        } catch (err) {
          logger.error(`[Webhook] Erreur traitement tx: ${err.message}`);
        }
      }
    });

    this._server = this._app.listen(WEBHOOK_PORT, '0.0.0.0', () => {
      logger.info(`[Webhook] ✅ Serveur HTTP démarré sur port ${WEBHOOK_PORT}`);
      logger.info(`[Webhook] Route: POST http://0.0.0.0:${WEBHOOK_PORT}/webhook`);
    });

    this._server.on('error', (err) => {
      logger.error(`[Webhook] Erreur serveur: ${err.message}`);
    });
  }

  stop() {
    if (this._server) {
      this._server.close();
      logger.info('[Webhook] Serveur arrêté');
    }
  }

  /**
   * Traite une transaction Helius enrichie et émet l'event 'tx'
   * Format Helius: https://docs.helius.dev/webhooks-and-websockets/enhanced-transactions-api
   */
  _processTx(tx) {
    if (!tx) return;

    const sig  = tx.signature;
    const slot = tx.slot;

    if (!sig) return;

    // Tx échouée
    if (tx.transactionError) {
      logger.debug(`[Webhook] Tx échouée ignorée: ${sig}`);
      return;
    }

    // Détermine le(s) wallet(s) impliqué(s) depuis accountData
    const accountKeys = (tx.accountData || []).map(a => a.account).filter(Boolean);

    // Aussi depuis feePayer
    if (tx.feePayer) accountKeys.unshift(tx.feePayer);

    logger.debug(`[Webhook] 🔔 Tx reçue: sig=${sig} accounts=${accountKeys.slice(0, 3).join(',')}`);

    this.emit('tx', {
      signature:    sig,
      slot,
      accountKeys,
      raw:          tx,   // payload complet Helius pour les moteurs
    });
  }
}

// Singleton
const webhookServer = new WebhookServer();
module.exports = webhookServer;
