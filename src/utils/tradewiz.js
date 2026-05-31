/**
 * tradewiz.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Intégration TradeWiz — envoie un message de copy trade formaté vers le bot
 * TradeWiz via l'API Telegram (MTProto via Telegram Bot API forward).
 *
 * Deux méthodes supportées:
 *   1. Forward via Bot API: le bot envoie le message à un chat TradeWiz configuré
 *   2. Format texte pur copié dans le presse-papier (mode manuel)
 *
 * Format TradeWiz attendu (basé sur la vidéo):
 *   Copy trade: <WALLET_ADDRESS>
 *
 * Configuration dans .env:
 *   TRADEWIZ_CHAT_ID   = ID du chat ou groupe TradeWiz (ex: @tradewiz_bot ou -100xxx)
 *   TRADEWIZ_BOT_NAME  = Nom du copy trade à dupliquer (ex: "Chain 1")
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const logger = require('./logger');

const TRADEWIZ_CHAT_ID  = process.env.TRADEWIZ_CHAT_ID  || null;
const TRADEWIZ_BOT_NAME = process.env.TRADEWIZ_BOT_NAME || 'CopyTrade';

/**
 * Envoie une instruction de copy trade à TradeWiz.
 *
 * @param {object}   bot          - Instance Telegraf
 * @param {string}   walletAddress - Wallet du dev à copy-trader
 * @param {string}   copyTradeName - Nom du copy trade à dupliquer dans TradeWiz
 * @param {number}   amountSol     - Montant SOL détecté
 * @param {boolean}  isFresh       - Wallet fresh ou non
 * @param {string}   userId        - ID Telegram de l'utilisateur (pour notif)
 * @returns {Promise<boolean>}
 */
async function sendTradeWizCopyTrade(bot, { walletAddress, copyTradeName, amountSol, isFresh, userId }) {
  const name  = copyTradeName || TRADEWIZ_BOT_NAME;
  const chatId = TRADEWIZ_CHAT_ID;

  // Message formaté pour TradeWiz (format attendu par le bot)
  const tradeWizMessage = `/copytrade ${walletAddress}`;

  try {
    // 1. Notifie l'utilisateur du déclenchement
    const notifMsg =
      `⚡ *TradeWiz Copy Trade déclenché*\n\n` +
      `🎯 Wallet: \`${walletAddress}\`\n` +
      `💰 Amount: ${amountSol.toFixed(6)} SOL\n` +
      `🔍 Fresh: ${isFresh ? '🟢 Oui' : '🔴 Non'}\n` +
      `📋 Copy Trade: *${name}*`;

    await bot.telegram.sendMessage(userId, notifMsg, { parse_mode: 'Markdown' });

    // 2. Envoie vers TradeWiz si configuré
    if (chatId) {
      await bot.telegram.sendMessage(chatId, tradeWizMessage);
      logger.info(`[TradeWiz] Copy trade envoyé vers ${chatId}: ${walletAddress}`);
    } else {
      logger.warn('[TradeWiz] TRADEWIZ_CHAT_ID non configuré — copy trade non envoyé automatiquement');
    }

    return true;
  } catch (err) {
    logger.error(`[TradeWiz] Erreur envoi: ${err.message}`);
    return false;
  }
}

/**
 * Génère le message texte TradeWiz (pour copier/coller manuellement).
 * @param {string} walletAddress
 * @param {string} copyTradeName
 * @returns {string}
 */
function buildTradeWizMessage(walletAddress, copyTradeName) {
  return `/copytrade ${walletAddress}`;
}

module.exports = { sendTradeWizCopyTrade, buildTradeWizMessage };
