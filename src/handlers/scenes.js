/**
 * scenes.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Wizards Telegraf pour /add_standard et /add_chain.
 * Chaque wizard guide l'utilisateur étape par étape avec des boutons.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const { Scenes, Markup }   = require('telegraf');
const { isValidPublicKey } = require('../utils/solana');
const { addStrategy }      = require('../db/database');
const logger               = require('../utils/logger');

// Escape tous les caractères réservés MarkdownV2
const esc = (t) => String(t).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');

// ══════════════════════════════════════════════════════════════════════════════
// WIZARD : Add Standard
// ══════════════════════════════════════════════════════════════════════════════

const addStandardWizard = new Scenes.WizardScene(
  'ADD_STANDARD_WIZARD',

  // ── Étape 1 : Wallet ─────────────────────────────────────────────────────
  async (ctx) => {
    ctx.wizard.state.data = {};
    await ctx.reply(
      '📝 *Ajouter une stratégie Standard*\n\n' +
      '*Étape 1/5 — Wallet à surveiller*\n\n' +
      'Envoie l\'adresse du wallet Solana :',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('❌ Annuler', 'wizard_cancel')]]),
      }
    );
    return ctx.wizard.next();
  },

  // ── Étape 2 : Min SOL ────────────────────────────────────────────────────
  async (ctx) => {
    if (ctx.callbackQuery?.data === 'wizard_cancel') {
      await ctx.answerCbQuery();
      await ctx.reply('❌ Annulé.', Markup.inlineKeyboard([[Markup.button.callback('🔙 Menu', 'menu_start')]]));
      return ctx.scene.leave();
    }

    // Guard: input doit être du texte
    if (!ctx.message?.text) {
      await ctx.reply('Envoie l\'adresse wallet en texte :', Markup.inlineKeyboard([[Markup.button.callback('❌ Annuler', 'wizard_cancel')]]));
      return;
    }

    const wallet = ctx.message.text.trim();
    if (!isValidPublicKey(wallet)) {
      await ctx.reply('❌ Adresse invalide. Réessaie :', Markup.inlineKeyboard([[Markup.button.callback('❌ Annuler', 'wizard_cancel')]]));
      return;
    }

    ctx.wizard.state.data.wallet = wallet;

    await ctx.reply(
      `✅ Wallet: \`${wallet.slice(0, 8)}...${wallet.slice(-4)}\`\n\n` +
      '*Étape 2/5 — Montant minimum (SOL)*\n\n' +
      'Envoie le montant minimum à détecter (ex: `1.057`) :',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('❌ Annuler', 'wizard_cancel')]]),
      }
    );
    return ctx.wizard.next();
  },

  // ── Étape 3 : Max SOL ────────────────────────────────────────────────────
  async (ctx) => {
    if (ctx.callbackQuery?.data === 'wizard_cancel') {
      await ctx.answerCbQuery();
      await ctx.reply('❌ Annulé.');
      return ctx.scene.leave();
    }

    if (!ctx.message?.text) {
      await ctx.reply('Envoie un nombre (ex: `1.057`) :', { parse_mode: 'Markdown' });
      return;
    }

    const val = parseFloat(ctx.message.text.trim());
    if (isNaN(val) || val <= 0) {
      await ctx.reply('❌ Valeur invalide. Envoie un nombre (ex: `1.057`) :', { parse_mode: 'Markdown' });
      return;
    }

    ctx.wizard.state.data.min_sol = val;

    await ctx.reply(
      `✅ Min SOL: \`${val}\`\n\n` +
      '*Étape 3/5 — Montant maximum (SOL)*\n\n' +
      'Envoie le montant maximum (ex: `1.058`) :',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('❌ Annuler', 'wizard_cancel')]]),
      }
    );
    return ctx.wizard.next();
  },

  // ── Étape 4 : Label ──────────────────────────────────────────────────────
  async (ctx) => {
    if (ctx.callbackQuery?.data === 'wizard_cancel') {
      await ctx.answerCbQuery();
      await ctx.reply('❌ Annulé.');
      return ctx.scene.leave();
    }

    if (!ctx.message?.text) {
      await ctx.reply('Envoie un nombre (ex: `1.058`) :', { parse_mode: 'Markdown' });
      return;
    }

    const val = parseFloat(ctx.message.text.trim());
    const min = ctx.wizard.state.data.min_sol;

    if (isNaN(val) || val <= min) {
      await ctx.reply(`❌ Doit être > ${min}. Réessaie :`, { parse_mode: 'Markdown' });
      return;
    }

    ctx.wizard.state.data.max_sol = val;

    await ctx.reply(
      `✅ Range: \`${min}\` — \`${val}\` SOL\n\n` +
      '*Étape 4/5 — Label (optionnel)*\n\n' +
      'Envoie un nom pour cette stratégie, ou clique Passer :',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('⏭️ Passer', 'wizard_skip_label')],
          [Markup.button.callback('❌ Annuler', 'wizard_cancel')],
        ]),
      }
    );
    return ctx.wizard.next();
  },

  // ── Étape 5 : Fresh Only → Confirmation ──────────────────────────────────
  async (ctx) => {
    if (ctx.callbackQuery?.data === 'wizard_cancel') {
      await ctx.answerCbQuery();
      await ctx.reply('❌ Annulé.');
      return ctx.scene.leave();
    }

    if (ctx.callbackQuery?.data === 'wizard_skip_label') {
      await ctx.answerCbQuery();
      ctx.wizard.state.data.label = '';
    } else if (ctx.message?.text) {
      ctx.wizard.state.data.label = ctx.message.text.trim();
    } else {
      await ctx.reply('Envoie un label ou clique Passer ⬆️');
      return;
    }

    const d = ctx.wizard.state.data;

    await ctx.reply(
      `✅ Label: \`${esc(d.label || 'Auto')}\`\n\n` +
      '*Étape 5/5 — Options*\n\n' +
      'Activer *Fresh Only* ? \\(ignore les anciens wallets\\)',
      {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ Oui, Fresh Only', 'wizard_fresh_yes'),
            Markup.button.callback('❌ Non', 'wizard_fresh_no'),
          ],
          [Markup.button.callback('❌ Annuler', 'wizard_cancel')],
        ]),
      }
    );
    return ctx.wizard.next();
  },

  // ── Étape 6 : Confirmation finale ────────────────────────────────────────
  async (ctx) => {
    if (ctx.callbackQuery?.data === 'wizard_cancel') {
      await ctx.answerCbQuery();
      await ctx.reply('❌ Annulé.');
      return ctx.scene.leave();
    }

    if (ctx.callbackQuery?.data === 'wizard_fresh_yes') {
      await ctx.answerCbQuery();
      ctx.wizard.state.data.fresh_only = 1;
    } else if (ctx.callbackQuery?.data === 'wizard_fresh_no') {
      await ctx.answerCbQuery();
      ctx.wizard.state.data.fresh_only = 0;
    } else {
      await ctx.reply('Clique sur un bouton ⬆️');
      return;
    }

    const d = ctx.wizard.state.data;
    const shortWallet = `${d.wallet.slice(0, 8)}...${d.wallet.slice(-4)}`;

    await ctx.reply(
      `📋 *Récapitulatif*\n\n` +
      `👛 Wallet: \`${shortWallet}\`\n` +
      `📊 Range: \`${d.min_sol}\` — \`${d.max_sol}\` SOL\n` +
      `🏷️ Label: \`${d.label || 'Auto'}\`\n` +
      `🔍 Fresh Only: ${d.fresh_only ? '✅ Oui' : '❌ Non'}\n\n` +
      `Confirmes-tu la création ?`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ Créer', 'wizard_confirm'),
            Markup.button.callback('❌ Annuler', 'wizard_cancel'),
          ],
        ]),
      }
    );
    return ctx.wizard.next();
  },

  // ── Étape 7 : Création ───────────────────────────────────────────────────
  async (ctx) => {
    if (ctx.callbackQuery?.data === 'wizard_cancel') {
      await ctx.answerCbQuery();
      await ctx.reply('❌ Annulé.');
      return ctx.scene.leave();
    }

    if (ctx.callbackQuery?.data !== 'wizard_confirm') {
      await ctx.reply('Clique sur un bouton ⬆️');
      return;
    }

    await ctx.answerCbQuery('Création...');

    const d = ctx.wizard.state.data;

    const id = addStrategy({
      user_id:       String(ctx.from.id),
      type:          'standard',
      label:         d.label || d.wallet.slice(0, 8) + '...',
      wallet:        d.wallet,
      min_sol:       d.min_sol,
      max_sol:       d.max_sol,
      max_hops:      0,
      fresh_only:    d.fresh_only,
      tradewiz_name: null,
    });

    logger.info(`[Wizard] add_standard: stratégie ${id} créée par ${ctx.from.id}`);

    ctx.scene.state.onCreate && ctx.scene.state.onCreate();

    await ctx.reply(
      `✅ *Stratégie Standard créée* \\[ID: ${id}\\]\n\n` +
      `👛 \`${esc(d.wallet)}\`\n` +
      `📊 Range: ${esc(String(d.min_sol))} — ${esc(String(d.max_sol))} SOL\n` +
      `🔍 Fresh Only: ${d.fresh_only ? '✅' : '❌'}`,
      {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('📡 Voir Stratégies', 'menu_status'),
            Markup.button.callback('➕ Ajouter autre', 'menu_add_standard'),
          ],
          [Markup.button.callback('🔙 Menu', 'menu_start')],
        ]),
      }
    );

    return ctx.scene.leave();
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// WIZARD : Add Chain
// ══════════════════════════════════════════════════════════════════════════════

const addChainWizard = new Scenes.WizardScene(
  'ADD_CHAIN_WIZARD',

  // ── Étape 1 : Mother Wallet ───────────────────────────────────────────────
  async (ctx) => {
    ctx.wizard.state.data = {};
    await ctx.reply(
      '🔗 *Ajouter un Chain Tracker*\n\n' +
      '*Étape 1/5 — Mother Wallet*\n\n' +
      'Envoie l\'adresse du Mother Wallet :',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('❌ Annuler', 'wizard_cancel')]]),
      }
    );
    return ctx.wizard.next();
  },

  // ── Étape 2 : Max Hops ───────────────────────────────────────────────────
  async (ctx) => {
    if (ctx.callbackQuery?.data === 'wizard_cancel') {
      await ctx.answerCbQuery();
      await ctx.reply('❌ Annulé.');
      return ctx.scene.leave();
    }

    // Guard: input doit être du texte
    if (!ctx.message?.text) {
      await ctx.reply('Envoie l\'adresse Mother Wallet en texte :', Markup.inlineKeyboard([[Markup.button.callback('❌ Annuler', 'wizard_cancel')]]));
      return;
    }

    const wallet = ctx.message.text.trim();
    if (!isValidPublicKey(wallet)) {
      await ctx.reply('❌ Adresse invalide. Réessaie :', Markup.inlineKeyboard([[Markup.button.callback('❌ Annuler', 'wizard_cancel')]]));
      return;
    }

    ctx.wizard.state.data.wallet = wallet;
    const short = `${wallet.slice(0, 8)}...${wallet.slice(-4)}`;

    await ctx.reply(
      `✅ Mother Wallet: \`${esc(short)}\`\n\n` +
      '*Étape 2/5 — Nombre de sauts \\(Max Hops\\)*\n\n' +
      'Combien de sauts veux\\-tu suivre ? \\(1 à 10\\)',
      {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('1', 'hops_1'),
            Markup.button.callback('2', 'hops_2'),
            Markup.button.callback('3', 'hops_3'),
            Markup.button.callback('5', 'hops_5'),
          ],
          [
            Markup.button.callback('7', 'hops_7'),
            Markup.button.callback('10', 'hops_10'),
          ],
          [Markup.button.callback('❌ Annuler', 'wizard_cancel')],
        ]),
      }
    );
    return ctx.wizard.next();
  },

  // ── Étape 3 : Range SOL (optionnel) ──────────────────────────────────────
  async (ctx) => {
    if (ctx.callbackQuery?.data === 'wizard_cancel') {
      await ctx.answerCbQuery();
      await ctx.reply('❌ Annulé.');
      return ctx.scene.leave();
    }

    let hops = null;
    if (ctx.callbackQuery?.data?.startsWith('hops_')) {
      await ctx.answerCbQuery();
      hops = parseInt(ctx.callbackQuery.data.replace('hops_', ''), 10);
    } else if (ctx.message?.text) {
      hops = parseInt(ctx.message.text.trim(), 10);
    }

    if (!hops || hops < 1 || hops > 10) {
      await ctx.reply('❌ Valeur invalide. Clique sur un bouton ⬆️');
      return;
    }

    ctx.wizard.state.data.max_hops = hops;

    await ctx.reply(
      `✅ Max Hops: \`${hops}\`\n\n` +
      '*Étape 3/5 — Filtre SOL \\(optionnel\\)*\n\n' +
      'Veux\\-tu filtrer par montant de transfert ?',
      {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Oui, définir un filtre', 'chain_sol_yes')],
          [Markup.button.callback('⏭️ Non, tout détecter', 'chain_sol_no')],
          [Markup.button.callback('❌ Annuler', 'wizard_cancel')],
        ]),
      }
    );
    return ctx.wizard.next();
  },

  // ── Étape 4 : Min/Max SOL si filtre activé ────────────────────────────────
  async (ctx) => {
    if (ctx.callbackQuery?.data === 'wizard_cancel') {
      await ctx.answerCbQuery();
      await ctx.reply('❌ Annulé.');
      return ctx.scene.leave();
    }

    if (ctx.callbackQuery?.data === 'chain_sol_no') {
      await ctx.answerCbQuery();
      ctx.wizard.state.data.min_sol = 0;
      ctx.wizard.state.data.max_sol = 9999;
      ctx.wizard.state.data.skipSol = true;
      await _askChainLabel(ctx);
      return ctx.wizard.next();
    }

    if (ctx.callbackQuery?.data === 'chain_sol_yes') {
      await ctx.answerCbQuery();
      ctx.wizard.state.data.awaitingSolRange = true;
      await ctx.reply(
        'Envoie le range au format: `min max`\n\nEx: `0.5 2.0`',
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('❌ Annuler', 'wizard_cancel')]]),
        }
      );
      return;
    }

    // Input texte pour min/max SOL
    if (ctx.wizard.state.data.awaitingSolRange && ctx.message?.text) {
      const parts = ctx.message.text.trim().split(/\s+/);
      const min = parseFloat(parts[0]);
      const max = parseFloat(parts[1]);

      if (isNaN(min) || isNaN(max) || min >= max) {
        await ctx.reply('❌ Format invalide. Ex: `0.5 2.0`', { parse_mode: 'Markdown' });
        return;
      }

      ctx.wizard.state.data.min_sol = min;
      ctx.wizard.state.data.max_sol = max;
      await _askChainLabel(ctx);
      return ctx.wizard.next();
    }

    await ctx.reply('Clique sur un bouton ⬆️');
  },

  // ── Étape 5 : Label + Fresh Only → Confirmation ──────────────────────────
  async (ctx) => {
    if (ctx.callbackQuery?.data === 'wizard_cancel') {
      await ctx.answerCbQuery();
      await ctx.reply('❌ Annulé.');
      return ctx.scene.leave();
    }

    if (ctx.callbackQuery?.data === 'wizard_skip_label') {
      await ctx.answerCbQuery();
      ctx.wizard.state.data.label = '';
    } else if (ctx.message?.text) {
      ctx.wizard.state.data.label = ctx.message.text.trim();
    } else {
      await ctx.reply('Envoie un label ou clique Passer ⬆️');
      return;
    }

    await ctx.reply(
      'Activer *Fresh Only* ?',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ Oui', 'wizard_fresh_yes'),
            Markup.button.callback('❌ Non', 'wizard_fresh_no'),
          ],
          [Markup.button.callback('❌ Annuler', 'wizard_cancel')],
        ]),
      }
    );
    return ctx.wizard.next();
  },

  // ── Étape 6 : Confirmation ────────────────────────────────────────────────
  async (ctx) => {
    if (ctx.callbackQuery?.data === 'wizard_cancel') {
      await ctx.answerCbQuery();
      await ctx.reply('❌ Annulé.');
      return ctx.scene.leave();
    }

    if (ctx.callbackQuery?.data === 'wizard_fresh_yes') {
      await ctx.answerCbQuery();
      ctx.wizard.state.data.fresh_only = 1;
    } else if (ctx.callbackQuery?.data === 'wizard_fresh_no') {
      await ctx.answerCbQuery();
      ctx.wizard.state.data.fresh_only = 0;
    } else {
      await ctx.reply('Clique sur un bouton ⬆️');
      return;
    }

    const d = ctx.wizard.state.data;
    const shortWallet = `${d.wallet.slice(0, 8)}...${d.wallet.slice(-4)}`;
    const rangeStr = d.skipSol ? 'Tout' : `${d.min_sol} — ${d.max_sol} SOL`;

    await ctx.reply(
      `📋 *Récapitulatif Chain Tracker*\n\n` +
      `👛 Mother: \`${shortWallet}\`\n` +
      `🔗 Max Hops: \`${d.max_hops}\`\n` +
      `📊 Range: \`${rangeStr}\`\n` +
      `🏷️ Label: \`${d.label || 'Auto'}\`\n` +
      `🔍 Fresh Only: ${d.fresh_only ? '✅ Oui' : '❌ Non'}\n\n` +
      `Confirmes-tu ?`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ Créer', 'wizard_confirm'),
            Markup.button.callback('❌ Annuler', 'wizard_cancel'),
          ],
        ]),
      }
    );
    return ctx.wizard.next();
  },

  // ── Étape 7 : Création ───────────────────────────────────────────────────
  async (ctx) => {
    if (ctx.callbackQuery?.data === 'wizard_cancel') {
      await ctx.answerCbQuery();
      await ctx.reply('❌ Annulé.');
      return ctx.scene.leave();
    }

    if (ctx.callbackQuery?.data !== 'wizard_confirm') {
      await ctx.reply('Clique sur un bouton ⬆️');
      return;
    }

    await ctx.answerCbQuery('Création...');

    const d = ctx.wizard.state.data;

    const id = addStrategy({
      user_id:       String(ctx.from.id),
      type:          'chain',
      label:         d.label || 'Mother_' + d.wallet.slice(0, 6),
      wallet:        d.wallet,
      min_sol:       d.min_sol,
      max_sol:       d.max_sol,
      max_hops:      d.max_hops,
      fresh_only:    d.fresh_only,
      tradewiz_name: null,
    });

    logger.info(`[Wizard] add_chain: stratégie ${id} créée par ${ctx.from.id}`);

    ctx.scene.state.onCreate && ctx.scene.state.onCreate();

    await ctx.reply(
      `✅ *Chain Tracker créé* \\[ID: ${id}\\]\n\n` +
      `👛 \`${esc(d.wallet)}\`\n` +
      `🔗 Max Hops: ${d.max_hops}\n` +
      `🔍 Fresh Only: ${d.fresh_only ? '✅' : '❌'}`,
      {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('📡 Voir Stratégies', 'menu_status'),
            Markup.button.callback('🔗 Ajouter autre', 'menu_add_chain'),
          ],
          [Markup.button.callback('🔙 Menu', 'menu_start')],
        ]),
      }
    );

    return ctx.scene.leave();
  }
);

// Helper interne
async function _askChainLabel(ctx) {
  await ctx.reply(
    '*Étape 4/5 — Label \\(optionnel\\)*\n\nEnvoie un nom ou clique Passer :',
    {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('⏭️ Passer', 'wizard_skip_label')],
        [Markup.button.callback('❌ Annuler', 'wizard_cancel')],
      ]),
    }
  );
}

module.exports = { addStandardWizard, addChainWizard };
