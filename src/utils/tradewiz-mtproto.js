/**
 * tradewiz-mtproto.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Envoie un message à @TradeWizFast_Solbot via un compte utilisateur Telegram
 * (MTProto / gramjs) — contourne la restriction bot→bot de la Bot API.
 *
 * Prérequis .env:
 *   TELEGRAM_API_ID      = 12345678
 *   TELEGRAM_API_HASH    = abcdef...
 *   SESSION_STRING       = <généré par generate-session.js>
 *   TRADEWIZ_BOT         = @TradeWizFast_Solbot  (ou username/id du bot)
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const { TelegramClient } = require('telegram');
const { StringSession }  = require('telegram/sessions');
const logger             = require('./logger');

const API_ID        = parseInt(process.env.TELEGRAM_API_ID  || '0', 10);
const API_HASH      = process.env.TELEGRAM_API_HASH          || '';
const SESSION_STR   = process.env.SESSION_STRING             || '';
const TRADEWIZ_BOT  = process.env.TRADEWIZ_BOT               || '@TradeWizFast_Solbot';

// Client singleton — réutilisé entre les appels
let _client     = null;
let _connecting = false;

/**
 * Retourne le client MTProto connecté (singleton).
 * @returns {Promise<TelegramClient>}
 */
async function getClient() {
  if (_client?.connected) return _client;
  if (_connecting) {
    // Attend que la connexion en cours se termine
    await new Promise((res) => setTimeout(res, 2000));
    return _client;
  }

  _connecting = true;

  if (!API_ID || !API_HASH || !SESSION_STR) {
    _connecting = false;
    throw new Error(
      'TELEGRAM_API_ID, TELEGRAM_API_HASH ou SESSION_STRING manquant dans .env'
    );
  }

  _client = new TelegramClient(
    new StringSession(SESSION_STR),
    API_ID,
    API_HASH,
    { connectionRetries: 5, retryDelay: 2000 }
  );

  await _client.connect();
  _connecting = false;
  logger.info('[MTProto] Client Telegram connecté');
  return _client;
}

/**
 * Envoie un message à TradeWiz pour déclencher un achat.
 *
 * Format envoyé: juste l'adresse du token mint (TradeWiz détecte automatiquement)
 * ou une commande selon ce que TradeWiz accepte.
 *
 * @param {string} tokenMint - Adresse du token à acheter
 * @param {object} opts
 * @param {number}  opts.amountSol   - Montant SOL (pour info dans les logs/notifs)
 * @param {string}  opts.userId      - ID Telegram user pour notif de retour
 * @param {object}  opts.bot         - Instance Telegraf (pour notif retour)
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function sendToTradeWiz(tokenMint, { amountSol, userId, bot } = {}) {
  try {
    const client = await getClient();

    // Message envoyé à TradeWiz — adresse du token suffit pour déclencher l'achat
    const message = tokenMint;

    await client.sendMessage(TRADEWIZ_BOT, { message });

    logger.info(`[MTProto] Message envoyé à ${TRADEWIZ_BOT}: ${tokenMint}`);

    // Notifie l'utilisateur via le bot Telegram
    if (bot && userId) {
      const esc = (t) => String(t).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
      const notif =
        `⚡ *TradeWiz déclenché\\!*\n\n` +
        `🪙 Token: \`${esc(tokenMint)}\`\n` +
        `💰 Montant: ${amountSol ? amountSol.toFixed(4) + ' SOL' : 'config TradeWiz'}\n` +
        `🤖 Envoyé à: ${esc(TRADEWIZ_BOT)}`;

      await bot.telegram.sendMessage(userId, notif, {
        parse_mode:               'MarkdownV2',
        disable_web_page_preview: true,
      });
    }

    return { success: true };
  } catch (err) {
    logger.error(`[MTProto] Erreur envoi TradeWiz: ${err.message}`);

    if (bot && userId) {
      await bot.telegram
        .sendMessage(userId, `❌ TradeWiz erreur: ${err.message}`)
        .catch(() => {});
    }

    return { success: false, error: err.message };
  }
}

module.exports = { sendToTradeWiz };
