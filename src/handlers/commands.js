/**
 * commands.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Handlers des commandes Telegram via Telegraf.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const fs                   = require('fs');
const { Markup }           = require('telegraf');
const { isValidPublicKey } = require('../utils/solana');
const {
  addStrategy,
  getStrategies,
  getStrategyById,
  toggleStrategy,
  deleteStrategy,
  addExchange,
  getExchanges,
  deleteExchange,
  addUserStrategy,
  getUserStrategies,
  deleteUserStrategy,
  getTrackedTxsByStrategy,
}                          = require('../db/database');
const { formatStatus }     = require('../utils/formatter');
const { runBacktest, formatBacktestResult } = require('../utils/backtest');
const { generateCsv }      = require('../utils/csv');
const logger               = require('../utils/logger');

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
      `/backtest — Rejouer une chaîne sur une tx passée\n` +
      `/exchanges — Lister les exchanges enregistrés\n` +
      `/add\\_exchange — Ajouter un exchange\n` +
      `/del\\_exchange — Supprimer un exchange\n` +
      `/my\\_strategy — Voir tes stratégies perso\n` +
      `/add\\_my\\_strategy — Ajouter une stratégie perso\n` +
      `/export — Exporter les transactions en CSV\n` +
      `/help — Aide détaillée`;

    ctx.replyWithMarkdownV2(msg);
  });

  // ── /help ────────────────────────────────────────────────────────────────

  bot.command('help', (ctx) => {
    const msg =
      `📖 *Aide Packet Tracker*\n\n` +
      `*Mode Standard:*\n` +
      `\`/add\\_standard <wallet> <min\\_sol> <max\\_sol> [label] [fresh\\_only] [tradewiz\\_name]\`\n` +
      `Ex: \`/add\\_standard ABC\\.\\.\\.XYZ 1\\.057 1\\.058 "Dev Alpha" true "CopyTrade1"\`\n\n` +
      `*Mode Chain Tracker:*\n` +
      `\`/add\\_chain <mother\\_wallet> <max\\_hops> [min\\_sol] [max\\_sol] [label] [fresh\\_only] [tradewiz\\_name]\`\n` +
      `Ex: \`/add\\_chain ABC\\.\\.\\.XYZ 3 0\\.5 2\\.0 "Mother Alpha" true "Chain1"\`\n\n` +
      `*Backtest:*\n` +
      `\`/backtest <wallet> <signature> [max\\_hops]\`\n\n` +
      `*Exchanges:*\n` +
      `/exchanges — Liste les exchanges\n` +
      `/add\\_exchange <nom> <wallet> \\[notes\\] — Ajouter\n` +
      `/del\\_exchange <nom> — Supprimer\n\n` +
      `*Mes Stratégies:*\n` +
      `/my\\_strategy — Voir mes stratégies perso\n` +
      `/add\\_my\\_strategy <wallet> <min> <max> \\[description\\] — Ajouter\n\n` +
      `*Export:*\n` +
      `/export <strategy\\_id> — Exporte les tx en CSV\n\n` +
      `*Gestion:*\n` +
      `/status — Liste toutes les stratégies\n` +
      `/pause 1 — Pause la stratégie ID 1\n` +
      `/resume 1 — Reprend la stratégie ID 1\n` +
      `/delete 1 — Supprime la stratégie ID 1`;

    ctx.replyWithMarkdownV2(msg);
  });

  // ── /add_standard ────────────────────────────────────────────────────────
  // Usage: /add_standard <wallet> <min_sol> <max_sol> [label] [fresh_only] [tradewiz_name]

  bot.command('add_standard', async (ctx) => {
    const args = ctx.message.text.split(/\s+/).slice(1);

    if (args.length < 3) {
      return ctx.reply(
        '❌ Usage: /add_standard <wallet> <min_sol> <max_sol> [label] [fresh_only] [tradewiz_name]\n' +
        'Ex: /add_standard ABC...XYZ 1.057 1.058 "Dev Alpha" true "CopyTrade1"'
      );
    }

    const [wallet, minStr, maxStr, label = '', freshStr = 'false', tradewiz_name = ''] = args;
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
      user_id:      String(ctx.from.id),
      type:         'standard',
      label:        label || wallet.slice(0, 8) + '...',
      wallet,
      min_sol,
      max_sol,
      max_hops:     0,
      fresh_only,
      tradewiz_name: tradewiz_name || null,
    });

    logger.info(`[CMD] add_standard: stratégie ${id} créée par ${ctx.from.id}`);
    await restartEngines();

    const esc = (t) => String(t).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
    ctx.replyWithMarkdownV2(
      `✅ Stratégie Standard ajoutée \\[ID: ${id}\\]\n` +
      `Wallet: \`${esc(wallet)}\`\n` +
      `Range: ${esc(min_sol)} — ${esc(max_sol)} SOL\n` +
      `Fresh Only: ${fresh_only ? 'Oui' : 'Non'}\n` +
      `TradeWiz: ${tradewiz_name ? esc(tradewiz_name) : '\\-'}`
    );
  });

  // ── /add_chain ───────────────────────────────────────────────────────────
  // Usage: /add_chain <mother_wallet> <max_hops> [min_sol] [max_sol] [label] [fresh_only] [tradewiz_name]

  bot.command('add_chain', async (ctx) => {
    const args = ctx.message.text.split(/\s+/).slice(1);

    if (args.length < 2) {
      return ctx.reply(
        '❌ Usage: /add_chain <mother_wallet> <max_hops> [min_sol] [max_sol] [label] [fresh_only] [tradewiz_name]\n' +
        'Ex: /add_chain ABC...XYZ 3 0.5 2.0 "Mother Alpha" true "Chain1"'
      );
    }

    const [wallet, hopsStr, minStr = '0', maxStr = '9999', label = '', freshStr = 'false', tradewiz_name = ''] = args;
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
      user_id:      String(ctx.from.id),
      type:         'chain',
      label:        label || 'Mother_' + wallet.slice(0, 6),
      wallet,
      min_sol,
      max_sol,
      max_hops,
      fresh_only,
      tradewiz_name: tradewiz_name || null,
    });

    logger.info(`[CMD] add_chain: stratégie ${id} créée par ${ctx.from.id}`);
    await restartEngines();

    const esc = (t) => String(t).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
    ctx.replyWithMarkdownV2(
      `✅ Chain Tracker ajouté \\[ID: ${id}\\]\n` +
      `Mother Wallet: \`${esc(wallet)}\`\n` +
      `Max Hops: ${max_hops} \\| Fresh Only: ${fresh_only ? 'Oui' : 'Non'}\n` +
      `TradeWiz: ${tradewiz_name ? esc(tradewiz_name) : '\\-'}`
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

  // ── /backtest <wallet> <signature> [max_hops] ────────────────────────────

  bot.command('backtest', async (ctx) => {
    const args = ctx.message.text.split(/\s+/).slice(1);

    if (args.length < 2) {
      return ctx.reply(
        '❌ Usage: /backtest <wallet> <signature> [max_hops]\n' +
        'Ex: /backtest ABC...XYZ 5UqmK...abc123 5'
      );
    }

    const [wallet, signature, hopsStr = '10'] = args;
    const maxHops = parseInt(hopsStr, 10) || 10;

    if (!isValidPublicKey(wallet)) {
      return ctx.reply('❌ Adresse de wallet invalide.');
    }

    await ctx.reply('🔬 Backtest en cours... (peut prendre quelques secondes)');

    try {
      const result = await runBacktest(wallet, signature, maxHops);
      const msg    = formatBacktestResult(result);
      await ctx.replyWithMarkdownV2(msg, { disable_web_page_preview: true });
    } catch (err) {
      logger.error(`[CMD] backtest erreur: ${err.message}`);
      ctx.reply(`❌ Erreur backtest: ${err.message}`);
    }
  });

  // ── /exchanges ───────────────────────────────────────────────────────────

  bot.command('exchanges', (ctx) => {
    const list = getExchanges(ctx.from.id);
    if (!list.length) {
      return ctx.reply('📭 Aucun exchange enregistré.\nUtilise /add_exchange pour en ajouter.');
    }

    const esc = (t) => String(t).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
    let msg = `🏦 *Exchanges enregistrés \\(${list.length}\\):*\n\n`;
    for (const e of list) {
      msg += `*${esc(e.name)}*\n\`${esc(e.wallet)}\`\n`;
      if (e.notes) msg += `_${esc(e.notes)}_\n`;
      msg += '\n';
    }

    ctx.replyWithMarkdownV2(msg.trim());
  });

  // ── /add_exchange <nom> <wallet> [notes] ─────────────────────────────────

  bot.command('add_exchange', (ctx) => {
    const args = ctx.message.text.split(/\s+/).slice(1);

    if (args.length < 2) {
      return ctx.reply('❌ Usage: /add_exchange <nom> <wallet> [notes]');
    }

    const [name, wallet, ...notesParts] = args;
    const notes = notesParts.join(' ') || null;

    if (!isValidPublicKey(wallet)) {
      return ctx.reply('❌ Adresse de wallet invalide.');
    }

    addExchange({ user_id: ctx.from.id, name, wallet, notes });
    ctx.reply(`✅ Exchange "${name}" ajouté.`);
  });

  // ── /del_exchange <nom> ───────────────────────────────────────────────────

  bot.command('del_exchange', (ctx) => {
    const name = ctx.message.text.split(/\s+/).slice(1).join(' ').trim();

    if (!name) {
      return ctx.reply('❌ Usage: /del_exchange <nom>');
    }

    deleteExchange(ctx.from.id, name);
    ctx.reply(`🗑️ Exchange "${name}" supprimé.`);
  });

  // ── /my_strategy ──────────────────────────────────────────────────────────

  bot.command('my_strategy', (ctx) => {
    const list = getUserStrategies(ctx.from.id);
    if (!list.length) {
      return ctx.reply('📭 Aucune stratégie perso.\nUtilise /add_my_strategy pour en créer une.');
    }

    const esc = (t) => String(t).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
    let msg = `📋 *Mes Stratégies \\(${list.length}\\):*\n\n`;
    for (const s of list) {
      msg +=
        `*ID ${s.id}* — \`${esc(s.wallet)}\`\n` +
        `Range: ${esc(s.min_sol)} — ${esc(s.max_sol)} SOL\n`;
      if (s.description) msg += `_${esc(s.description)}_\n`;
      msg += '\n';
    }

    ctx.replyWithMarkdownV2(msg.trim());
  });

  // ── /add_my_strategy <wallet> <min_sol> <max_sol> [description] ──────────

  bot.command('add_my_strategy', (ctx) => {
    const args = ctx.message.text.split(/\s+/).slice(1);

    if (args.length < 3) {
      return ctx.reply('❌ Usage: /add_my_strategy <wallet> <min_sol> <max_sol> [description]');
    }

    const [wallet, minStr, maxStr, ...descParts] = args;
    const min_sol     = parseFloat(minStr);
    const max_sol     = parseFloat(maxStr);
    const description = descParts.join(' ') || null;

    if (!isValidPublicKey(wallet)) {
      return ctx.reply('❌ Adresse de wallet invalide.');
    }
    if (isNaN(min_sol) || isNaN(max_sol) || min_sol >= max_sol) {
      return ctx.reply('❌ min_sol et max_sol invalides (min < max requis).');
    }

    const id = addUserStrategy({ user_id: ctx.from.id, wallet, min_sol, max_sol, description });
    ctx.reply(`✅ Stratégie perso [ID: ${id}] ajoutée.`);
  });

  // ── /del_my_strategy <id> ─────────────────────────────────────────────────

  bot.command('del_my_strategy', (ctx) => {
    const id = parseInt(ctx.message.text.split(/\s+/)[1], 10);
    if (!id) return ctx.reply('❌ Usage: /del_my_strategy <id>');

    deleteUserStrategy(ctx.from.id, id);
    ctx.reply(`🗑️ Stratégie perso [${id}] supprimée.`);
  });

  // ── /export <strategy_id> ─────────────────────────────────────────────────

  bot.command('export', async (ctx) => {
    const stratId = parseInt(ctx.message.text.split(/\s+/)[1], 10);

    if (!stratId) {
      return ctx.reply('❌ Usage: /export <strategy_id>');
    }

    const strategy = getStrategyById(stratId);
    if (!strategy || String(strategy.user_id) !== String(ctx.from.id)) {
      return ctx.reply('❌ Stratégie introuvable.');
    }

    const rows = getTrackedTxsByStrategy(stratId);

    if (!rows.length) {
      return ctx.reply(`📭 Aucune transaction trackée pour la stratégie [${stratId}].`);
    }

    try {
      const label    = strategy.label || `strategy_${stratId}`;
      const filePath = generateCsv(rows, label);

      await ctx.replyWithDocument(
        { source: filePath, filename: filePath.split('/').pop() },
        { caption: `📊 Export CSV — Stratégie [${stratId}] — ${rows.length} tx` }
      );

      // Nettoyage du fichier temporaire après envoi
      fs.unlink(filePath, () => {});
    } catch (err) {
      logger.error(`[CMD] export erreur: ${err.message}`);
      ctx.reply(`❌ Erreur lors de l'export: ${err.message}`);
    }
  });

  // ── Handler erreurs globales ──────────────────────────────────────────────

  bot.catch((err, ctx) => {
    logger.error(`[Telegraf] Erreur non gérée: ${err.message}`);
    ctx.reply('❌ Erreur interne. Consultez les logs.').catch(() => {});
  });
}

module.exports = { registerCommands, authGuard };
