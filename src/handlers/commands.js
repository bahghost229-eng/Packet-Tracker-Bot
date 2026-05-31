/**
 * commands.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Handlers des commandes Telegram via Telegraf — avec inline keyboards.
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
const { analyzePattern, formatPatternResult } = require('../utils/pattern');
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

/** Échappe les caractères spéciaux MarkdownV2 */
const esc = (t) => String(t).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');

/**
 * Enregistre toutes les commandes sur l'instance Telegraf.
 * @param {import('telegraf').Telegraf} bot
 * @param {Function} restartEngines
 * @param {import('telegraf').Scenes.Stage} stage
 */
function registerCommands(bot, restartEngines, stage) {

  bot.use(authGuard);

  // ═══════════════════════════════════════════════════════════════════════════
  // /start — Menu principal avec boutons
  // ═══════════════════════════════════════════════════════════════════════════

  bot.command('start', (ctx) => {
    const msg =
      `👋 *Packet Tracker Bot*\n\n` +
      `Surveillance Solana en temps réel\\.\n` +
      `Clique sur un bouton pour commencer\\.`;

    ctx.replyWithMarkdownV2(msg, Markup.inlineKeyboard([
      [
        Markup.button.callback('📡 Mes Stratégies', 'menu_status'),
        Markup.button.callback('➕ Ajouter Standard', 'menu_add_standard'),
      ],
      [
        Markup.button.callback('🔗 Ajouter Chain', 'menu_add_chain'),
        Markup.button.callback('🔬 Backtest', 'menu_add_backtest'),
      ],
      [
        Markup.button.callback('🏦 Exchanges', 'menu_exchanges'),
        Markup.button.callback('📋 Mes Strats Perso', 'menu_my_strategy'),
      ],
      [
        Markup.button.callback('📤 Exporter CSV', 'menu_export'),
        Markup.button.callback('📖 Aide', 'menu_help'),
      ],
    ]));
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // /help
  // ═══════════════════════════════════════════════════════════════════════════

  bot.command('help', (ctx) => sendHelp(ctx));

  // ═══════════════════════════════════════════════════════════════════════════
  // /status — avec boutons Pause/Resume/Delete par stratégie
  // ═══════════════════════════════════════════════════════════════════════════

  bot.command('status', (ctx) => sendStatus(ctx));

  // ═══════════════════════════════════════════════════════════════════════════
  // /pause <id>
  // ═══════════════════════════════════════════════════════════════════════════

  bot.command('pause', async (ctx) => {
    const id = parseInt(ctx.message.text.split(/\s+/)[1], 10);
    if (!id) return ctx.reply(
      '❌ Usage: /pause <id>',
      Markup.inlineKeyboard([[Markup.button.callback('📡 Voir Stratégies', 'menu_status')]])
    );
    await doPause(ctx, id, restartEngines);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // /resume <id>
  // ═══════════════════════════════════════════════════════════════════════════

  bot.command('resume', async (ctx) => {
    const id = parseInt(ctx.message.text.split(/\s+/)[1], 10);
    if (!id) return ctx.reply(
      '❌ Usage: /resume <id>',
      Markup.inlineKeyboard([[Markup.button.callback('📡 Voir Stratégies', 'menu_status')]])
    );
    await doResume(ctx, id, restartEngines);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // /delete <id>
  // ═══════════════════════════════════════════════════════════════════════════

  bot.command('delete', async (ctx) => {
    const id = parseInt(ctx.message.text.split(/\s+/)[1], 10);
    if (!id) return ctx.reply(
      '❌ Usage: /delete <id>',
      Markup.inlineKeyboard([[Markup.button.callback('📡 Voir Stratégies', 'menu_status')]])
    );

    const s = getStrategyById(id);
    if (!s || String(s.user_id) !== String(ctx.from.id)) {
      return ctx.reply('❌ Stratégie introuvable.');
    }

    // Demande confirmation avant suppression
    ctx.reply(
      `⚠️ Confirmes-tu la suppression de la stratégie [${id}] — *${esc(s.label)}* ?`,
      {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ Oui, supprimer', `confirm_delete_${id}`),
            Markup.button.callback('❌ Annuler', 'menu_status'),
          ],
        ]),
      }
    );
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // /add_standard — lance le wizard si pas d'args, sinon traite direct
  // ═══════════════════════════════════════════════════════════════════════════

  bot.command('add_standard', async (ctx) => {
    const args = ctx.message.text.split(/\s+/).slice(1);
    // Pas d'args → wizard
    if (args.length < 3) return ctx.scene.enter('ADD_STANDARD_WIZARD');

    const [wallet, minStr, maxStr, label = '', freshStr = 'false', tradewiz_name = ''] = args;
    const min_sol    = parseFloat(minStr);
    const max_sol    = parseFloat(maxStr);
    const fresh_only = freshStr.toLowerCase() === 'true' ? 1 : 0;

    if (!isValidPublicKey(wallet)) {
      return ctx.reply('❌ Adresse de wallet invalide.',
        Markup.inlineKeyboard([[Markup.button.callback('🔙 Menu', 'menu_start')]]));
    }
    if (isNaN(min_sol) || isNaN(max_sol) || min_sol >= max_sol) {
      return ctx.reply('❌ min_sol et max_sol invalides (min < max requis).',
        Markup.inlineKeyboard([[Markup.button.callback('🔙 Menu', 'menu_start')]]));
    }

    const id = addStrategy({
      user_id:       String(ctx.from.id),
      type:          'standard',
      label:         label || wallet.slice(0, 8) + '...',
      wallet,
      min_sol,
      max_sol,
      max_hops:      0,
      fresh_only,
      tradewiz_name: tradewiz_name || null,
    });

    logger.info(`[CMD] add_standard: stratégie ${id} créée par ${ctx.from.id}`);
    await restartEngines();

    ctx.replyWithMarkdownV2(
      `✅ *Stratégie Standard ajoutée* \\[ID: ${id}\\]\n\n` +
      `🏷️ Label: *${esc(label || wallet.slice(0, 8) + '...')}*\n` +
      `👛 Wallet: \`${esc(wallet)}\`\n` +
      `📊 Range: ${esc(min_sol)} — ${esc(max_sol)} SOL\n` +
      `🔍 Fresh Only: ${fresh_only ? '✅ Oui' : '❌ Non'}\n` +
      `🤖 TradeWiz: ${tradewiz_name ? esc(tradewiz_name) : '\\-'}`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback('📡 Voir Stratégies', 'menu_status'),
          Markup.button.callback('➕ Ajouter une autre', 'menu_add_standard'),
        ],
        [Markup.button.callback('🔙 Menu Principal', 'menu_start')],
      ])
    );
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // /add_chain — lance le wizard si pas d'args, sinon traite direct
  // ═══════════════════════════════════════════════════════════════════════════

  bot.command('add_chain', async (ctx) => {
    const args = ctx.message.text.split(/\s+/).slice(1);
    // Pas d'args → wizard
    if (args.length < 2) return ctx.scene.enter('ADD_CHAIN_WIZARD');

    const [wallet, hopsStr, minStr = '0', maxStr = '9999', label = '', freshStr = 'false', tradewiz_name = ''] = args;
    const max_hops   = parseInt(hopsStr, 10);
    const min_sol    = parseFloat(minStr);
    const max_sol    = parseFloat(maxStr);
    const fresh_only = freshStr.toLowerCase() === 'true' ? 1 : 0;

    if (!isValidPublicKey(wallet)) {
      return ctx.reply('❌ Adresse de wallet invalide.',
        Markup.inlineKeyboard([[Markup.button.callback('🔙 Menu', 'menu_start')]]));
    }
    if (isNaN(max_hops) || max_hops < 1 || max_hops > 10) {
      return ctx.reply('❌ max_hops invalide (valeur entre 1 et 10).',
        Markup.inlineKeyboard([[Markup.button.callback('🔙 Menu', 'menu_start')]]));
    }

    const id = addStrategy({
      user_id:       String(ctx.from.id),
      type:          'chain',
      label:         label || 'Mother_' + wallet.slice(0, 6),
      wallet,
      min_sol,
      max_sol,
      max_hops,
      fresh_only,
      tradewiz_name: tradewiz_name || null,
    });

    logger.info(`[CMD] add_chain: stratégie ${id} créée par ${ctx.from.id}`);
    await restartEngines();

    ctx.replyWithMarkdownV2(
      `✅ *Chain Tracker ajouté* \\[ID: ${id}\\]\n\n` +
      `🏷️ Label: *${esc(label || 'Mother_' + wallet.slice(0, 6))}*\n` +
      `👛 Mother Wallet: \`${esc(wallet)}\`\n` +
      `🔗 Max Hops: ${max_hops}\n` +
      `📊 Range: ${esc(min_sol)} — ${esc(max_sol)} SOL\n` +
      `🔍 Fresh Only: ${fresh_only ? '✅ Oui' : '❌ Non'}\n` +
      `🤖 TradeWiz: ${tradewiz_name ? esc(tradewiz_name) : '\\-'}`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback('📡 Voir Stratégies', 'menu_status'),
          Markup.button.callback('🔗 Ajouter un autre', 'menu_add_chain'),
        ],
        [Markup.button.callback('🔙 Menu Principal', 'menu_start')],
      ])
    );
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // /backtest
  // ═══════════════════════════════════════════════════════════════════════════

  bot.command('backtest', async (ctx) => {
    const args = ctx.message.text.split(/\s+/).slice(1);

    if (args.length < 2) {
      return ctx.reply(
        '🔬 *Backtest*\n\nFormat:\n`/backtest <wallet> <signature> [max_hops]`\n\nEx:\n`/backtest ABC...XYZ 5UqmK...abc 5`',
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Menu', 'menu_start')]]),
        }
      );
    }

    const [wallet, signature, hopsStr = '10'] = args;
    const maxHops = parseInt(hopsStr, 10) || 10;

    if (!isValidPublicKey(wallet)) {
      return ctx.reply('❌ Adresse de wallet invalide.',
        Markup.inlineKeyboard([[Markup.button.callback('🔙 Menu', 'menu_start')]]));
    }

    const loadingMsg = await ctx.reply('🔬 Backtest en cours\\.\\.\\. ⏳', { parse_mode: 'MarkdownV2' });

    try {
      const result = await runBacktest(wallet, signature, maxHops);
      const msg    = formatBacktestResult(result);

      await ctx.replyWithMarkdownV2(msg, {
        disable_web_page_preview: true,
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('🔬 Nouveau Backtest', 'menu_add_backtest'),
            Markup.button.callback('🧠 Analyser Pattern', `pattern_${signature}`),
            Markup.button.callback('🔙 Menu', 'menu_start'),
          ],
        ]),
      });

      // Lance l'analyse pattern automatiquement si backtest réussi
      if (result.success) {
        await ctx.reply('🧠 Analyse du pattern dev en cours\\.\\.\\. ⏳', { parse_mode: 'MarkdownV2' });

        try {
          const pattern    = await analyzePattern(result);
          const patternMsg = formatPatternResult(pattern);

          await ctx.replyWithMarkdownV2(patternMsg, {
            disable_web_page_preview: true,
            ...Markup.inlineKeyboard([
              [
                Markup.button.callback('🔬 Nouveau Backtest', 'menu_add_backtest'),
                Markup.button.callback('🔙 Menu', 'menu_start'),
              ],
            ]),
          });
        } catch (patternErr) {
          logger.error(`[CMD] pattern erreur: ${patternErr.message}`);
          ctx.reply(`⚠️ Pattern: ${patternErr.message}`);
        }
      }
    } catch (err) {
      logger.error(`[CMD] backtest erreur: ${err.message}`);
      ctx.reply(`❌ Erreur backtest: ${err.message}`,
        Markup.inlineKeyboard([[Markup.button.callback('🔙 Menu', 'menu_start')]]));
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // /analyze_pattern <wallet> <signature> [max_hops]
  // ═══════════════════════════════════════════════════════════════════════════

  bot.command('analyze_pattern', async (ctx) => {
    const args = ctx.message.text.split(/\s+/).slice(1);

    if (args.length < 2) {
      return ctx.reply(
        '🧠 *Analyze Pattern*\n\nFormat:\n`/analyze_pattern <wallet> <signature> [max_hops]`\n\nAnalyse le pattern complet du dev :\n• Financeur récurrent\n• Timing des hops\n• Fresh wallets\n• Heures actives UTC\n• Tokens lancés depuis dev wallet',
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Menu', 'menu_start')]]),
        }
      );
    }

    const [wallet, signature, hopsStr = '10'] = args;
    const maxHops = parseInt(hopsStr, 10) || 10;

    if (!isValidPublicKey(wallet)) {
      return ctx.reply('❌ Adresse de wallet invalide.',
        Markup.inlineKeyboard([[Markup.button.callback('🔙 Menu', 'menu_start')]]));
    }

    await ctx.reply('🔬 Backtest en cours pour extraire le chemin\\.\\.\\. ⏳', { parse_mode: 'MarkdownV2' });

    try {
      // D'abord le backtest pour avoir le path
      const backtestResult = await runBacktest(wallet, signature, maxHops);

      if (!backtestResult.success) {
        return ctx.reply(
          `❌ Backtest échoué: ${backtestResult.error || 'Erreur inconnue'}`,
          Markup.inlineKeyboard([[Markup.button.callback('🔙 Menu', 'menu_start')]])
        );
      }

      // Affiche le résultat backtest d'abord
      const backtestMsg = formatBacktestResult(backtestResult);
      await ctx.replyWithMarkdownV2(backtestMsg, { disable_web_page_preview: true });

      // Puis lance l'analyse pattern
      await ctx.reply('🧠 Analyse du pattern dev en cours\\.\\.\\. ⏳', { parse_mode: 'MarkdownV2' });

      const pattern    = await analyzePattern(backtestResult);
      const patternMsg = formatPatternResult(pattern);

      await ctx.replyWithMarkdownV2(patternMsg, {
        disable_web_page_preview: true,
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('🔬 Nouveau Backtest', 'menu_add_backtest'),
            Markup.button.callback('🔙 Menu', 'menu_start'),
          ],
        ]),
      });
    } catch (err) {
      logger.error(`[CMD] analyze_pattern erreur: ${err.message}`);
      ctx.reply(`❌ Erreur: ${err.message}`,
        Markup.inlineKeyboard([[Markup.button.callback('🔙 Menu', 'menu_start')]]));
    }
  });

  // Action inline : bouton "Analyser Pattern" depuis un résultat backtest
  // Format: pattern_<signature>
  bot.action(/^pattern_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const signature = ctx.match[1];
    await ctx.reply('🧠 Analyse du pattern dev en cours\\.\\.\\. ⏳', { parse_mode: 'MarkdownV2' });
    await ctx.reply(
      `💡 Lance : /analyze_pattern <wallet> ${signature}`,
      { parse_mode: 'Markdown' }
    );
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // /exchanges
  // ═══════════════════════════════════════════════════════════════════════════

  bot.command('exchanges', (ctx) => sendExchanges(ctx));

  // ═══════════════════════════════════════════════════════════════════════════
  // /add_exchange <nom> <wallet> [notes]
  // ═══════════════════════════════════════════════════════════════════════════

  bot.command('add_exchange', (ctx) => {
    const args = ctx.message.text.split(/\s+/).slice(1);

    if (args.length < 2) {
      return ctx.reply(
        '🏦 *Ajouter un Exchange*\n\nFormat:\n`/add_exchange <nom> <wallet> [notes]`\n\nEx:\n`/add_exchange Binance ABC...XYZ "Hot wallet"`',
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Menu', 'menu_start')]]),
        }
      );
    }

    const [name, wallet, ...notesParts] = args;
    const notes = notesParts.join(' ') || null;

    if (!isValidPublicKey(wallet)) {
      return ctx.reply('❌ Adresse de wallet invalide.',
        Markup.inlineKeyboard([[Markup.button.callback('🔙 Menu', 'menu_start')]]));
    }

    addExchange({ user_id: ctx.from.id, name, wallet, notes });

    ctx.reply(
      `✅ Exchange *"${name}"* ajouté\\.`,
      {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('🏦 Voir Exchanges', 'menu_exchanges'),
            Markup.button.callback('➕ Ajouter un autre', 'menu_add_exchange'),
          ],
          [Markup.button.callback('🔙 Menu Principal', 'menu_start')],
        ]),
      }
    );
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // /del_exchange <nom>
  // ═══════════════════════════════════════════════════════════════════════════

  bot.command('del_exchange', (ctx) => {
    const name = ctx.message.text.split(/\s+/).slice(1).join(' ').trim();

    if (!name) {
      return ctx.reply('❌ Usage: /del_exchange <nom>',
        Markup.inlineKeyboard([[Markup.button.callback('🏦 Exchanges', 'menu_exchanges')]]));
    }

    deleteExchange(ctx.from.id, name);
    ctx.reply(
      `🗑️ Exchange *"${esc(name)}"* supprimé\\.`,
      {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('🏦 Voir Exchanges', 'menu_exchanges'),
            Markup.button.callback('🔙 Menu', 'menu_start'),
          ],
        ]),
      }
    );
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // /my_strategy
  // ═══════════════════════════════════════════════════════════════════════════

  bot.command('my_strategy', (ctx) => sendMyStrategies(ctx));

  // ═══════════════════════════════════════════════════════════════════════════
  // /add_my_strategy <wallet> <min_sol> <max_sol> [description]
  // ═══════════════════════════════════════════════════════════════════════════

  bot.command('add_my_strategy', (ctx) => {
    const args = ctx.message.text.split(/\s+/).slice(1);

    if (args.length < 3) {
      return ctx.reply(
        '📋 *Ajouter une Stratégie Perso*\n\nFormat:\n`/add_my_strategy <wallet> <min_sol> <max_sol> [description]`',
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Menu', 'menu_start')]]),
        }
      );
    }

    const [wallet, minStr, maxStr, ...descParts] = args;
    const min_sol     = parseFloat(minStr);
    const max_sol     = parseFloat(maxStr);
    const description = descParts.join(' ') || null;

    if (!isValidPublicKey(wallet)) {
      return ctx.reply('❌ Adresse de wallet invalide.',
        Markup.inlineKeyboard([[Markup.button.callback('🔙 Menu', 'menu_start')]]));
    }
    if (isNaN(min_sol) || isNaN(max_sol) || min_sol >= max_sol) {
      return ctx.reply('❌ min_sol et max_sol invalides.',
        Markup.inlineKeyboard([[Markup.button.callback('🔙 Menu', 'menu_start')]]));
    }

    const id = addUserStrategy({ user_id: ctx.from.id, wallet, min_sol, max_sol, description });

    ctx.reply(
      `✅ Stratégie perso \\[ID: ${id}\\] ajoutée\\.`,
      {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('📋 Voir Mes Strats', 'menu_my_strategy'),
            Markup.button.callback('🔙 Menu', 'menu_start'),
          ],
        ]),
      }
    );
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // /del_my_strategy <id>
  // ═══════════════════════════════════════════════════════════════════════════

  bot.command('del_my_strategy', (ctx) => {
    const id = parseInt(ctx.message.text.split(/\s+/)[1], 10);
    if (!id) return ctx.reply('❌ Usage: /del_my_strategy <id>',
      Markup.inlineKeyboard([[Markup.button.callback('📋 Mes Strats', 'menu_my_strategy')]]));

    // Demande confirmation
    ctx.reply(
      `⚠️ Confirmes-tu la suppression de la stratégie perso \\[${id}\\] ?`,
      {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ Oui, supprimer', `confirm_del_mystrat_${id}`),
            Markup.button.callback('❌ Annuler', 'menu_my_strategy'),
          ],
        ]),
      }
    );
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // /export <strategy_id>
  // ═══════════════════════════════════════════════════════════════════════════

  bot.command('export', async (ctx) => {
    const stratId = parseInt(ctx.message.text.split(/\s+/)[1], 10);

    if (!stratId) {
      // Affiche la liste des stratégies pour que l'user clique
      const strategies = getStrategies(String(ctx.from.id));
      if (!strategies.length) {
        return ctx.reply('📭 Aucune stratégie disponible.',
          Markup.inlineKeyboard([[Markup.button.callback('🔙 Menu', 'menu_start')]]));
      }

      const buttons = strategies.map((s) =>
        [Markup.button.callback(`📤 [${s.id}] ${s.label}`, `export_${s.id}`)]
      );
      buttons.push([Markup.button.callback('🔙 Menu', 'menu_start')]);

      return ctx.reply('📊 Choisir la stratégie à exporter:', Markup.inlineKeyboard(buttons));
    }

    await doExport(ctx, stratId);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CALLBACKS — Boutons inline
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Navigation menu ───────────────────────────────────────────────────────

  bot.action('menu_start', (ctx) => {
    ctx.answerCbQuery();
    const msg =
      `👋 *Packet Tracker Bot*\n\n` +
      `Surveillance Solana en temps réel\\.\n` +
      `Clique sur un bouton pour commencer\\.`;

    ctx.editMessageText(msg, {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('📡 Mes Stratégies', 'menu_status'),
          Markup.button.callback('➕ Ajouter Standard', 'menu_add_standard'),
        ],
        [
          Markup.button.callback('🔗 Ajouter Chain', 'menu_add_chain'),
          Markup.button.callback('🔬 Backtest', 'menu_add_backtest'),
        ],
        [
          Markup.button.callback('🏦 Exchanges', 'menu_exchanges'),
          Markup.button.callback('📋 Mes Strats Perso', 'menu_my_strategy'),
        ],
        [
          Markup.button.callback('📤 Exporter CSV', 'menu_export'),
          Markup.button.callback('📖 Aide', 'menu_help'),
        ],
      ]),
    }).catch(() => {});
  });

  bot.action('menu_help', (ctx) => {
    ctx.answerCbQuery();
    sendHelp(ctx);
  });

  bot.action('menu_status', (ctx) => {
    ctx.answerCbQuery();
    sendStatus(ctx);
  });

  bot.action('menu_exchanges', (ctx) => {
    ctx.answerCbQuery();
    sendExchanges(ctx);
  });

  bot.action('menu_my_strategy', (ctx) => {
    ctx.answerCbQuery();
    sendMyStrategies(ctx);
  });

  bot.action('menu_add_standard', (ctx) => {
    ctx.answerCbQuery();
    ctx.scene.enter('ADD_STANDARD_WIZARD');
  });

  bot.action('menu_add_chain', (ctx) => {
    ctx.answerCbQuery();
    ctx.scene.enter('ADD_CHAIN_WIZARD');
  });

  bot.action('menu_add_backtest', (ctx) => {
    ctx.answerCbQuery();
    ctx.reply(
      '🔬 *Backtest*\n\n' +
      'Envoie la commande avec le format suivant:\n\n' +
      '`/backtest <wallet> <signature> [max_hops]`\n\n' +
      '📌 *Exemple:*\n`/backtest ABC...XYZ 5UqmK...abc 5`',
      {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Menu', 'menu_start')]]),
      }
    );
  });

  bot.action('menu_add_exchange', (ctx) => {
    ctx.answerCbQuery();
    ctx.reply(
      '🏦 *Ajouter un Exchange*\n\n' +
      'Envoie la commande avec le format suivant:\n\n' +
      '`/add_exchange <nom> <wallet> [notes]`\n\n' +
      '📌 *Exemple:*\n`/add_exchange Binance ABC...XYZ "Hot wallet"`',
      {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Menu', 'menu_start')]]),
      }
    );
  });

  bot.action('menu_export', (ctx) => {
    ctx.answerCbQuery();
    const strategies = getStrategies(String(ctx.from.id));
    if (!strategies.length) {
      return ctx.reply('📭 Aucune stratégie disponible.',
        Markup.inlineKeyboard([[Markup.button.callback('🔙 Menu', 'menu_start')]]));
    }

    const buttons = strategies.map((s) =>
      [Markup.button.callback(`📤 [${s.id}] ${s.label}`, `export_${s.id}`)]
    );
    buttons.push([Markup.button.callback('🔙 Menu', 'menu_start')]);

    ctx.reply('📊 Choisir la stratégie à exporter:', Markup.inlineKeyboard(buttons));
  });

  // ── Actions par stratégie ─────────────────────────────────────────────────

  // Pause inline
  bot.action(/^pause_(\d+)$/, async (ctx) => {
    ctx.answerCbQuery();
    const id = parseInt(ctx.match[1], 10);
    await doPause(ctx, id, restartEngines);
  });

  // Resume inline
  bot.action(/^resume_(\d+)$/, async (ctx) => {
    ctx.answerCbQuery();
    const id = parseInt(ctx.match[1], 10);
    await doResume(ctx, id, restartEngines);
  });

  // Delete — demande confirmation
  bot.action(/^delete_(\d+)$/, (ctx) => {
    ctx.answerCbQuery();
    const id = parseInt(ctx.match[1], 10);
    const s  = getStrategyById(id);
    if (!s || String(s.user_id) !== String(ctx.from.id)) {
      return ctx.reply('❌ Stratégie introuvable.');
    }

    ctx.reply(
      `⚠️ Confirmes-tu la suppression de la stratégie \\[${id}\\] — *${esc(s.label)}* ?`,
      {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ Oui, supprimer', `confirm_delete_${id}`),
            Markup.button.callback('❌ Annuler', 'menu_status'),
          ],
        ]),
      }
    );
  });

  // Confirm delete
  bot.action(/^confirm_delete_(\d+)$/, async (ctx) => {
    ctx.answerCbQuery('Suppression...');
    const id = parseInt(ctx.match[1], 10);
    const s  = getStrategyById(id);
    if (!s || String(s.user_id) !== String(ctx.from.id)) {
      return ctx.reply('❌ Stratégie introuvable.');
    }

    deleteStrategy(id);
    await restartEngines();

    ctx.editMessageText(
      `🗑️ Stratégie \\[${id}\\] *${esc(s.label)}* supprimée\\.`,
      {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([[Markup.button.callback('📡 Voir Stratégies', 'menu_status')]]),
      }
    ).catch(() => ctx.reply(`🗑️ Stratégie [${id}] supprimée.`));
  });

  // Export inline
  bot.action(/^export_(\d+)$/, async (ctx) => {
    ctx.answerCbQuery('Export en cours...');
    const stratId = parseInt(ctx.match[1], 10);
    await doExport(ctx, stratId);
  });

  // Confirm del_my_strategy
  bot.action(/^confirm_del_mystrat_(\d+)$/, (ctx) => {
    ctx.answerCbQuery('Suppression...');
    const id = parseInt(ctx.match[1], 10);
    deleteUserStrategy(ctx.from.id, id);

    ctx.editMessageText(
      `🗑️ Stratégie perso \\[${id}\\] supprimée\\.`,
      {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([[Markup.button.callback('📋 Mes Strats', 'menu_my_strategy')]]),
      }
    ).catch(() => ctx.reply(`🗑️ Stratégie perso [${id}] supprimée.`));
  });

  // ── Handler erreurs globales ──────────────────────────────────────────────

  bot.catch((err, ctx) => {
    logger.error(`[Telegraf] Erreur non gérée: ${err.message}`);
    ctx.reply('❌ Erreur interne. Consultez les logs.').catch(() => {});
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Fonctions helpers réutilisables
// ═══════════════════════════════════════════════════════════════════════════

/** Envoie le message d'aide */
function sendHelp(ctx) {
  const msg =
    `📖 *Aide Packet Tracker*\n\n` +
    `*Mode Standard:*\n` +
    `\`/add\\_standard <wallet> <min\\_sol> <max\\_sol> \\[label\\] \\[fresh\\_only\\] \\[tradewiz\\]\`\n\n` +
    `*Mode Chain Tracker:*\n` +
    `\`/add\\_chain <wallet> <max\\_hops> \\[min\\_sol\\] \\[max\\_sol\\] \\[label\\] \\[fresh\\_only\\] \\[tradewiz\\]\`\n\n` +
    `*Backtest & Pattern:*\n` +
    `\`/backtest <wallet> <signature> \\[max\\_hops\\]\`\n` +
    `\`/analyze\\_pattern <wallet> <signature> \\[max\\_hops\\]\`\n\n` +
    `*Exchanges:*\n` +
    `\`/add\\_exchange <nom> <wallet> \\[notes\\]\`\n` +
    `\`/del\\_exchange <nom>\`\n\n` +
    `*Mes Stratégies Perso:*\n` +
    `\`/add\\_my\\_strategy <wallet> <min> <max> \\[desc\\]\`\n` +
    `\`/del\\_my\\_strategy <id>\`\n\n` +
    `*Export:*\n` +
    `\`/export <strategy\\_id>\``;

  ctx.replyWithMarkdownV2(msg, Markup.inlineKeyboard([
    [
      Markup.button.callback('📡 Mes Stratégies', 'menu_status'),
      Markup.button.callback('🔙 Menu Principal', 'menu_start'),
    ],
  ]));
}

/** Envoie la liste des stratégies avec boutons Pause/Resume/Delete/Export */
function sendStatus(ctx) {
  const strategies = getStrategies(String(ctx.from.id));

  if (!strategies.length) {
    return ctx.reply(
      '📭 Aucune stratégie active.\nUtilise les boutons ci-dessous pour en créer une.',
      Markup.inlineKeyboard([
        [
          Markup.button.callback('➕ Standard', 'menu_add_standard'),
          Markup.button.callback('🔗 Chain', 'menu_add_chain'),
        ],
        [Markup.button.callback('🔙 Menu', 'menu_start')],
      ])
    );
  }

  const msg = formatStatus(strategies);

  // Boutons par stratégie
  const buttons = strategies.map((s) => {
    const statusIcon  = s.active ? '⏸️' : '▶️';
    const actionLabel = s.active ? `Pause [${s.id}]` : `Resume [${s.id}]`;
    const actionCb    = s.active ? `pause_${s.id}` : `resume_${s.id}`;

    return [
      Markup.button.callback(statusIcon + ' ' + actionLabel, actionCb),
      Markup.button.callback(`🗑️ Del [${s.id}]`, `delete_${s.id}`),
      Markup.button.callback(`📤 CSV [${s.id}]`, `export_${s.id}`),
    ];
  });

  buttons.push([
    Markup.button.callback('➕ Standard', 'menu_add_standard'),
    Markup.button.callback('🔗 Chain', 'menu_add_chain'),
    Markup.button.callback('🔙 Menu', 'menu_start'),
  ]);

  ctx.replyWithMarkdownV2(msg, Markup.inlineKeyboard(buttons));
}

/** Envoie la liste des exchanges avec bouton Supprimer par exchange */
function sendExchanges(ctx) {
  const list = getExchanges(ctx.from.id);

  if (!list.length) {
    return ctx.reply(
      '📭 Aucun exchange enregistré.',
      Markup.inlineKeyboard([
        [Markup.button.callback('➕ Ajouter Exchange', 'menu_add_exchange')],
        [Markup.button.callback('🔙 Menu', 'menu_start')],
      ])
    );
  }

  let msg = `🏦 *Exchanges enregistrés \\(${list.length}\\):*\n\n`;
  for (const e of list) {
    msg += `*${esc(e.name)}*\n\`${esc(e.wallet)}\`\n`;
    if (e.notes) msg += `_${esc(e.notes)}_\n`;
    msg += '\n';
  }

  const delButtons = list.map((e) =>
    [Markup.button.callback(`🗑️ Suppr ${e.name}`, `del_exchange_${encodeURIComponent(e.name)}`)]
  );
  delButtons.push([
    Markup.button.callback('➕ Ajouter', 'menu_add_exchange'),
    Markup.button.callback('🔙 Menu', 'menu_start'),
  ]);

  ctx.replyWithMarkdownV2(msg.trim(), Markup.inlineKeyboard(delButtons));
}

/** Envoie les stratégies perso */
function sendMyStrategies(ctx) {
  const list = getUserStrategies(ctx.from.id);

  if (!list.length) {
    return ctx.reply(
      '📭 Aucune stratégie perso.',
      Markup.inlineKeyboard([
        [Markup.button.callback('➕ Ajouter Strat Perso', 'menu_my_strategy')],
        [Markup.button.callback('🔙 Menu', 'menu_start')],
      ])
    );
  }

  let msg = `📋 *Mes Stratégies \\(${list.length}\\):*\n\n`;
  for (const s of list) {
    msg +=
      `*ID ${s.id}* — \`${esc(s.wallet)}\`\n` +
      `Range: ${esc(s.min_sol)} — ${esc(s.max_sol)} SOL\n`;
    if (s.description) msg += `_${esc(s.description)}_\n`;
    msg += '\n';
  }

  const delButtons = list.map((s) =>
    [Markup.button.callback(`🗑️ Suppr [${s.id}]`, `confirm_del_mystrat_${s.id}`)]
  );
  delButtons.push([Markup.button.callback('🔙 Menu', 'menu_start')]);

  ctx.replyWithMarkdownV2(msg.trim(), Markup.inlineKeyboard(delButtons));
}

/** Effectue la mise en pause */
async function doPause(ctx, id, restartEngines) {
  const s = getStrategyById(id);
  if (!s || String(s.user_id) !== String(ctx.from.id)) {
    return ctx.reply('❌ Stratégie introuvable.');
  }

  toggleStrategy(id, false);
  await restartEngines();

  ctx.reply(
    `⏸️ Stratégie \\[${id}\\] *${esc(s.label)}* mise en pause\\.`,
    {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback(`▶️ Resume [${id}]`, `resume_${id}`),
          Markup.button.callback('📡 Voir Stratégies', 'menu_status'),
        ],
      ]),
    }
  );
}

/** Effectue la reprise */
async function doResume(ctx, id, restartEngines) {
  const s = getStrategyById(id);
  if (!s || String(s.user_id) !== String(ctx.from.id)) {
    return ctx.reply('❌ Stratégie introuvable.');
  }

  toggleStrategy(id, true);
  await restartEngines();

  ctx.reply(
    `✅ Stratégie \\[${id}\\] *${esc(s.label)}* réactivée\\.`,
    {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback(`⏸️ Pause [${id}]`, `pause_${id}`),
          Markup.button.callback('📡 Voir Stratégies', 'menu_status'),
        ],
      ]),
    }
  );
}

/** Effectue l'export CSV */
async function doExport(ctx, stratId) {
  const strategy = getStrategyById(stratId);
  if (!strategy || String(strategy.user_id) !== String(ctx.from.id)) {
    return ctx.reply('❌ Stratégie introuvable.');
  }

  const rows = getTrackedTxsByStrategy(stratId);

  if (!rows.length) {
    return ctx.reply(
      `📭 Aucune transaction trackée pour la stratégie \\[${stratId}\\]\\.`,
      {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Menu', 'menu_start')]]),
      }
    );
  }

  try {
    const label    = strategy.label || `strategy_${stratId}`;
    const filePath = generateCsv(rows, label);

    await ctx.replyWithDocument(
      { source: filePath, filename: filePath.split('/').pop() },
      {
        caption: `📊 Export CSV — Stratégie [${stratId}] — ${rows.length} tx`,
        ...Markup.inlineKeyboard([[Markup.button.callback('📡 Voir Stratégies', 'menu_status')]]),
      }
    );

    fs.unlink(filePath, () => {});
  } catch (err) {
    logger.error(`[CMD] export erreur: ${err.message}`);
    ctx.reply(`❌ Erreur lors de l'export: ${err.message}`);
  }
}

// ── Callback: suppression exchange inline ────────────────────────────────────
// Note: ce handler doit être en dehors de registerCommands pour accéder à bot
// On l'ajoute dans registerCommands via une closure

function registerExchangeDeleteCallbacks(bot) {
  bot.action(/^del_exchange_(.+)$/, (ctx) => {
    ctx.answerCbQuery('Suppression...');
    const name = decodeURIComponent(ctx.match[1]);
    deleteExchange(ctx.from.id, name);

    ctx.editMessageText(
      `🗑️ Exchange *"${esc(name)}"* supprimé\\.`,
      {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('🏦 Voir Exchanges', 'menu_exchanges'),
            Markup.button.callback('🔙 Menu', 'menu_start'),
          ],
        ]),
      }
    ).catch(() => ctx.reply(`🗑️ Exchange "${name}" supprimé.`));
  });
}

// Patch registerCommands pour inclure les callbacks exchange
const _registerCommands = registerCommands;
module.exports = {
  registerCommands: (bot, restartEngines) => {
    _registerCommands(bot, restartEngines);
    registerExchangeDeleteCallbacks(bot);
  },
  authGuard,
};
