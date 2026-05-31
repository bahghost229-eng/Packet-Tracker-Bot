/**
 * commands.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Handlers des commandes Telegram via Telegraf.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const { Markup }          = require('telegraf');
const { isValidPublicKey } = require('../utils/solana');
const {
  addStrategy,
  getStrategies,
  getStrategyById,
  toggleStrategy,
  deleteStrategy,
}                         = require('../db/database');
const { formatStatus }    = require('../utils/formatter');
const logger              = require('../utils/logger');

// IDs utilisateurs autorisés
const ALLOWED_IDS = (process.env.ALLOWED_USER_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

/**
 * Middleware de guard: seuls les IDs autorisés peuvent utiliser le bot.
 */
function authGuard(ctx, next) {
  const userId = String(ctx.from?.id);
  if (ALLOWED_IDS.length > 0 && !ALLOWED_IDS.includes(userId)) {
    return ctx.reply('⛔ Accès non autorisé.');
  }
  return next();
}

/**
 * Enregistre toutes les commandes sur l'instance Telegraf.
 * @param {import('telegraf').Telegraf} bot
 * @param {Function} restartEngines - Callback pour redémarrer les moteurs après ajout de stratégie
 */
function registerCommands(bot, restartEngines) {

  bot.use(authGuard);

  // ── /start ──────────────────────────────────────────────────────────────

  bot.command('start', (ctx) => {
    const msg =
      `👋 *Packet Tracker Bot*\n\n` +
      `Surveillance Solana en temps réel\\.\n\n` +
      `*Commandes disponibles:*\n` +
      `/add\\_standard — Surveiller un wallet \\(range SOL stricte\\)\n` +
      `/add\\_chain — Suivre une chaîne de transferts\n` +
      `/status — Voir les stratégies actives\n` +
      `/pause \\[id\\] — Mettre en pause une stratégie\n` +
      `/resume \\[id\\] — Réactiver une stratégie\n` +
      `/delete \\[id\\] — Supprimer une stratégie\n` +
      `/help — Aide détaillée`;

    ctx.replyWithMarkdownV2(msg);
  });

  // ── /help ────────────────────────────────────────────────────────────────

  bot.command('help', (ctx) => {
    const msg =
      `📖 *Aide Packet Tracker*\n\n` +
      `*Mode Standard:*\n` +
      `\`/add\\_standard <wallet> <min\\_sol> <max\\_sol> [label] [fresh\\_only]\`\n` +
      `Ex: \`/add\\_standard ABC...XYZ 1\\.057 1\\.058 "Dev Alpha" true\`\n\n` +
      `*Mode Chain Tracker:*\n` +
      `\`/add\\_chain <mother\\_wallet> <max\\_hops> [min\\_sol] [max\\_sol] [label] [fresh\\_only]\`\n` +
      `Ex: \`/add\\_chain ABC...XYZ 3 0\\.5 2\\.0 "Mother Alpha" true\`\n\n` +
      `*Gestion:*\n` +
      `/status — Liste toutes les stratégies\n` +
      `/pause 1 — Pause la stratégie ID 1\n` +
      `/resume 1 — Reprend la stratégie ID 1\n` +
      `/delete 1 — Supprime la stratégie ID 1`;

    ctx.replyWithMarkdownV2(msg);
  });

  // ── /add_standard ────────────────────────────────────────────────────────
  // Usage: /add_standard <wallet> <min_sol> <max_sol> [label] [fresh_only]

  bot.command('add_standard', async (ctx) => {
    const args = ctx.message.text.split(/\s+/).slice(1);

    if (args.length < 3) {
      return ctx.reply(
        '❌ Usage: /add_standard <wallet> <min_sol> <max_sol> [label] [fresh_only]\n' +
        'Ex: /add_standard ABC...XYZ 1.057 1.058 "Dev Alpha" true'
      );
    }

    const [wallet, minStr, maxStr, label = '', freshStr = 'false'] = args;
    const min_sol    = parseFloat(minStr);
    const max_sol    = parseFloat(maxStr);
    const fresh_only = freshStr.toLowerCase() === 'true' ? 1 : 0;

    if (!isValidPublicKey(wallet)) {
      return ctx.reply('❌ Adresse de wallet invalide.');
    }
    if (isNaN(min_sol) || isNaN(max_sol) || min_sol >= max_sol) {
      return ctx.reply('❌ min_sol et max_sol invalides (min < max requis).');
    }

    const id = addStrategy({
      user_id:    String(ctx.from.id),
      type:       'standard',
      label:      label || wallet.slice(0, 8) + '...',
      wallet,
      min_sol,
      max_sol,
      max_hops:   0,
      fresh_only,
    });

    logger.info(`[CMD] add_standard: stratégie ${id} créée par ${ctx.from.id}`);

    // Redémarre les moteurs pour inclure la nouvelle stratégie
    await restartEngines();

    ctx.reply(
      `✅ Stratégie Standard ajoutée \\[ID: ${id}\\]\n` +
      `Wallet: \`${wallet}\`\n` +
      `Range: ${min_sol} — ${max_sol} SOL\n` +
      `Fresh Only: ${fresh_only ? 'Oui' : 'Non'}`,
      { parse_mode: 'MarkdownV2' }
    );
  });

  // ── /add_chain ───────────────────────────────────────────────────────────
  // Usage: /add_chain <mother_wallet> <max_hops> [min_sol] [max_sol] [label] [fresh_only]

  bot.command('add_chain', async (ctx) => {
    const args = ctx.message.text.split(/\s+/).slice(1);

    if (args.length < 2) {
      return ctx.reply(
        '❌ Usage: /add_chain <mother_wallet> <max_hops> [min_sol] [max_sol] [label] [fresh_only]\n' +
        'Ex: /add_chain ABC...XYZ 3 0.5 2.0 "Mother Alpha" true'
      );
    }

    const [wallet, hopsStr, minStr = '0', maxStr = '9999', label = '', freshStr = 'false'] = args;
    const max_hops   = parseInt(hopsStr, 10);
    const min_sol    = parseFloat(minStr);
    const max_sol    = parseFloat(maxStr);
    const fresh_only = freshStr.toLowerCase() === 'true' ? 1 : 0;

    if (!isValidPublicKey(wallet)) {
      return ctx.reply('❌ Adresse de wallet invalide.');
    }
    if (isNaN(max_hops) || max_hops < 1 || max_hops > 10) {
      return ctx.reply('❌ max_hops invalide (valeur entre 1 et 10).');
    }

    const id = addStrategy({
      user_id:    String(ctx.from.id),
      type:       'chain',
      label:      label || 'Mother_' + wallet.slice(0, 6),
      wallet,
      min_sol,
      max_sol,
      max_hops,
      fresh_only,
    });

    logger.info(`[CMD] add_chain: stratégie ${id} créée par ${ctx.from.id}`);
    await restartEngines();

    ctx.reply(
      `✅ Chain Tracker ajouté \\[ID: ${id}\\]\n` +
      `Mother Wallet: \`${wallet}\`\n` +
      `Max Hops: ${max_hops} \\| Fresh Only: ${fresh_only ? 'Oui' : 'Non'}`,
      { parse_mode: 'MarkdownV2' }
    );
  });

  // ── /status ──────────────────────────────────────────────────────────────

  bot.command('status', (ctx) => {
    const strategies = getStrategies(String(ctx.from.id));
    const msg = formatStatus(strategies);
    ctx.replyWithMarkdownV2(msg);
  });

  // ── /pause <id> ──────────────────────────────────────────────────────────

  bot.command('pause', async (ctx) => {
    const id = parseInt(ctx.message.text.split(/\s+/)[1], 10);
    if (!id) return ctx.reply('❌ Usage: /pause <id>');

    const s = getStrategyById(id);
    if (!s || String(s.user_id) !== String(ctx.from.id)) {
      return ctx.reply('❌ Stratégie introuvable.');
    }

    toggleStrategy(id, false);
    await restartEngines();
    ctx.reply(`⏸️ Stratégie [${id}] mise en pause.`);
  });

  // ── /resume <id> ─────────────────────────────────────────────────────────

  bot.command('resume', async (ctx) => {
    const id = parseInt(ctx.message.text.split(/\s+/)[1], 10);
    if (!id) return ctx.reply('❌ Usage: /resume <id>');

    const s = getStrategyById(id);
    if (!s || String(s.user_id) !== String(ctx.from.id)) {
      return ctx.reply('❌ Stratégie introuvable.');
    }

    toggleStrategy(id, true);
    await restartEngines();
    ctx.reply(`✅ Stratégie [${id}] réactivée.`);
  });

  // ── /delete <id> ─────────────────────────────────────────────────────────

  bot.command('delete', async (ctx) => {
    const id = parseInt(ctx.message.text.split(/\s+/)[1], 10);
    if (!id) return ctx.reply('❌ Usage: /delete <id>');

    const s = getStrategyById(id);
    if (!s || String(s.user_id) !== String(ctx.from.id)) {
      return ctx.reply('❌ Stratégie introuvable.');
    }

    deleteStrategy(id);
    await restartEngines();
    ctx.reply(`🗑️ Stratégie [${id}] supprimée.`);
  });

  // ── Handler erreurs globales ──────────────────────────────────────────────

  bot.catch((err, ctx) => {
    logger.error(`[Telegraf] Erreur non gérée: ${err.message}`);
    ctx.reply('❌ Erreur interne. Consultez les logs.').catch(() => {});
  });
}

module.exports = { registerCommands, authGuard };
