/**
 * heliusWebhook.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Gestion du webhook Helius via leur API REST.
 *
 * - Au démarrage: crée ou retrouve le webhook existant
 * - Sur subscribe/unsubscribe: met à jour la liste des wallets via PATCH
 *
 * Variables d'environnement requises:
 *   HELIUS_API_KEY        — clé Helius
 *   HELIUS_WEBHOOK_URL    — URL publique de ton bot (ex: http://199.19.73.16:3000/webhook)
 *   HELIUS_WEBHOOK_ID     — (optionnel) ID d'un webhook existant à réutiliser
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const axios  = require('axios');
const logger = require('./logger');

const HELIUS_API_KEY   = process.env.HELIUS_API_KEY || '';
const WEBHOOK_URL      = process.env.HELIUS_WEBHOOK_URL || `http://199.19.73.16:3000/webhook`;
const HELIUS_BASE      = 'https://api.helius.xyz/v0';

class HeliusWebhookManager {
  constructor() {
    this._webhookId = process.env.HELIUS_WEBHOOK_ID || null;
  }

  /**
   * Initialise: crée le webhook si pas d'ID existant, sinon le retrouve.
   * Appelé une fois au démarrage.
   */
  async init() {
    if (!HELIUS_API_KEY) {
      logger.error('[HeliusWebhook] HELIUS_API_KEY manquante');
      return;
    }

    try {
      if (this._webhookId) {
        // Vérifie que le webhook existe encore
        const wh = await this._getWebhook(this._webhookId);
        if (wh) {
          logger.info(`[HeliusWebhook] ✅ Webhook existant trouvé: ${this._webhookId}`);
          return;
        }
        logger.warn(`[HeliusWebhook] Webhook ${this._webhookId} introuvable — création d'un nouveau`);
      }

      // Cherche un webhook existant avec la même URL
      const existing = await this._findWebhookByUrl(WEBHOOK_URL);
      if (existing) {
        this._webhookId = existing.webhookID;
        logger.info(`[HeliusWebhook] ✅ Webhook retrouvé par URL: ${this._webhookId}`);
        return;
      }

      // Crée un nouveau webhook (sans wallets pour l'instant)
      await this._createWebhook([]);

    } catch (err) {
      logger.error(`[HeliusWebhook] Erreur init: ${err.message}`);
    }
  }

  /**
   * Met à jour la liste des wallets surveillés dans le webhook Helius.
   * @param {string[]} wallets - Liste complète des wallets à surveiller
   */
  async updateWallets(wallets) {
    if (!HELIUS_API_KEY) return;

    // Init si pas encore fait
    if (!this._webhookId) {
      await this.init();
    }

    if (!this._webhookId) {
      logger.error('[HeliusWebhook] Pas de webhookId — impossible de mettre à jour');
      return;
    }

    try {
      await axios.put(
        `${HELIUS_BASE}/webhooks/${this._webhookId}?api-key=${HELIUS_API_KEY}`,
        {
          webhookURL:        WEBHOOK_URL,
          transactionTypes:  ['Any'],
          accountAddresses:  wallets,
          webhookType:       'enhanced',
          txnStatus:         'success',
        },
        { timeout: 10_000 }
      );

      logger.info(`[HeliusWebhook] ✅ Webhook mis à jour — ${wallets.length} wallet(s)`);
    } catch (err) {
      const msg = err.response?.data?.error || err.message;
      logger.error(`[HeliusWebhook] Erreur update wallets: ${msg}`);
      throw err;
    }
  }

  /** Récupère un webhook par ID */
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

  /** Cherche un webhook existant avec la même webhookURL */
  async _findWebhookByUrl(url) {
    try {
      const res = await axios.get(
        `${HELIUS_BASE}/webhooks?api-key=${HELIUS_API_KEY}`,
        { timeout: 10_000 }
      );
      const webhooks = Array.isArray(res.data) ? res.data : [];
      return webhooks.find(w => w.webhookURL === url) || null;
    } catch (err) {
      logger.warn(`[HeliusWebhook] Impossible de lister les webhooks: ${err.message}`);
      return null;
    }
  }

  /** Crée un nouveau webhook Helius */
  async _createWebhook(wallets = []) {
    try {
      const res = await axios.post(
        `${HELIUS_BASE}/webhooks?api-key=${HELIUS_API_KEY}`,
        {
          webhookURL:       WEBHOOK_URL,
          transactionTypes: ['Any'],
          accountAddresses: wallets,
          webhookType:      'enhanced',
          txnStatus:        'success',
        },
        { timeout: 10_000 }
      );

      this._webhookId = res.data.webhookID;
      logger.info(`[HeliusWebhook] ✅ Webhook créé: ${this._webhookId}`);
      logger.info(`[HeliusWebhook] → Ajoute dans ton .env: HELIUS_WEBHOOK_ID=${this._webhookId}`);
      return res.data;
    } catch (err) {
      const msg = err.response?.data?.error || err.message;
      logger.error(`[HeliusWebhook] Erreur création webhook: ${msg}`);
      throw err;
    }
  }

  getWebhookId() {
    return this._webhookId;
  }
}

// Singleton
const heliusWebhook = new HeliusWebhookManager();
module.exports = heliusWebhook;
