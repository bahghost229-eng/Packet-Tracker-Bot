/**
 * heliusWebhook.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Gestion du webhook Helius via API REST.
 * Crée ou retrouve le webhook, met à jour la liste des wallets.
 *
 * Variables d'environnement:
 *   HELIUS_API_KEY        — clé Helius
 *   HELIUS_WEBHOOK_URL    — URL publique (ex: http://199.19.73.16:3000/webhook)
 *   HELIUS_WEBHOOK_ID     — (optionnel) ID webhook existant à réutiliser
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const axios  = require('axios');
const logger = require('./logger');

const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '';
const WEBHOOK_URL    = process.env.HELIUS_WEBHOOK_URL || 'http://199.19.73.16:3000/webhook';
const HELIUS_BASE    = 'https://api.helius.xyz/v0';

// Wallet placeholder requis par Helius quand la liste est vide
const PLACEHOLDER = 'So11111111111111111111111111111111111111112'; // SOL mint

class HeliusWebhookManager {
  constructor() {
    this._webhookId = process.env.HELIUS_WEBHOOK_ID || null;
  }

  async init() {
    if (!HELIUS_API_KEY) {
      logger.error('[HeliusWebhook] HELIUS_API_KEY manquante');
      return;
    }

    try {
      // Si on a déjà un ID, vérifie qu'il existe
      if (this._webhookId) {
        const wh = await this._getWebhook(this._webhookId);
        if (wh) {
          logger.info(`[HeliusWebhook] ✅ Webhook existant: ${this._webhookId}`);
          return;
        }
        logger.warn(`[HeliusWebhook] Webhook ${this._webhookId} introuvable — recréation`);
        this._webhookId = null;
      }

      // Cherche un webhook existant avec la même URL
      const existing = await this._findWebhookByUrl(WEBHOOK_URL);
      if (existing) {
        this._webhookId = existing.webhookID;
        logger.info(`[HeliusWebhook] ✅ Webhook retrouvé par URL: ${this._webhookId}`);
        logger.info(`[HeliusWebhook] → Ajoute dans .env: HELIUS_WEBHOOK_ID=${this._webhookId}`);
        return;
      }

      // Crée un nouveau webhook avec le placeholder
      await this._createWebhook([PLACEHOLDER]);

    } catch (err) {
      logger.error(`[HeliusWebhook] Erreur init: ${err.response?.data ? JSON.stringify(err.response.data) : err.message}`);
    }
  }

  async updateWallets(wallets) {
    if (!HELIUS_API_KEY) return;

    if (!this._webhookId) {
      await this.init();
    }

    if (!this._webhookId) {
      logger.error('[HeliusWebhook] Pas de webhookId — impossible de mettre à jour');
      return;
    }

    // Helius refuse les listes vides — on garde le placeholder si 0 wallets
    const addresses = wallets.length > 0 ? wallets : [PLACEHOLDER];

    try {
      await axios.put(
        `${HELIUS_BASE}/webhooks/${this._webhookId}?api-key=${HELIUS_API_KEY}`,
        {
          webhookURL:       WEBHOOK_URL,
          transactionTypes: ['Any'],
          accountAddresses: addresses,
          webhookType:      'enhanced',
          txnStatus:        'success',
        },
        { timeout: 10_000 }
      );

      logger.info(`[HeliusWebhook] ✅ Webhook mis à jour — ${addresses.length} wallet(s) (dont éventuels placeholders)`);
    } catch (err) {
      const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      logger.error(`[HeliusWebhook] Erreur update: ${detail}`);

      // Si le webhook n'existe plus côté Helius, on le recrée
      if (err.response?.status === 404) {
        logger.warn('[HeliusWebhook] Webhook disparu — recréation...');
        this._webhookId = null;
        await this.init();
        await this.updateWallets(wallets); // réessaie
      }
    }
  }

  async _getWebhook(id) {
    try {
      const res = await axios.get(
        `${HELIUS_BASE}/webhooks/${id}?api-key=${HELIUS_API_KEY}`,
        { timeout: 10_000 }
      );
      return res.data;
    } catch {
      return null;
    }
  }

  async _findWebhookByUrl(url) {
    try {
      const res = await axios.get(
        `${HELIUS_BASE}/webhooks?api-key=${HELIUS_API_KEY}`,
        { timeout: 10_000 }
      );
      const list = Array.isArray(res.data) ? res.data : [];
      return list.find(w => w.webhookURL === url) || null;
    } catch (err) {
      logger.warn(`[HeliusWebhook] Liste webhooks: ${err.message}`);
      return null;
    }
  }

  async _createWebhook(wallets = [PLACEHOLDER]) {
    const payload = {
      webhookURL:       WEBHOOK_URL,
      transactionTypes: ['Any'],
      accountAddresses: wallets,
      webhookType:      'enhanced',
      txnStatus:        'success',
    };

    logger.info(`[HeliusWebhook] Création webhook: ${JSON.stringify(payload)}`);

    const res = await axios.post(
      `${HELIUS_BASE}/webhooks?api-key=${HELIUS_API_KEY}`,
      payload,
      { timeout: 10_000 }
    );

    this._webhookId = res.data.webhookID;
    logger.info(`[HeliusWebhook] ✅ Webhook créé: ${this._webhookId}`);
    logger.info(`[HeliusWebhook] → Ajoute dans .env: HELIUS_WEBHOOK_ID=${this._webhookId}`);
    return res.data;
  }

  getWebhookId() {
    return this._webhookId;
  }
}

const heliusWebhook = new HeliusWebhookManager();
module.exports = heliusWebhook;
