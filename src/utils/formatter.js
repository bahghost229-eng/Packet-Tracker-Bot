/**
 * formatter.js
 * Templates de messages Telegram (MarkdownV2).
 */

'use strict';

/**
 * Escape les caractères spéciaux pour MarkdownV2 Telegram.
 */
function esc(text) {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

/**
 * Message d'alerte Standard Mode.
 */
function formatStandardAlert({ strategy, signature, from, to, amountSol, isFresh }) {
  const freshTag = isFresh ? '🟢 FRESH' : '🔴 NON\\-FRESH';
  return (
    `🚨 *ALERTE STANDARD* — ${esc(strategy.label || 'Wallet Watch')}\n` +
    `\n` +
    `📤 *From:* \`${esc(from)}\`\n` +
    `📥 *To:*   \`${esc(to)}\`\n` +
    `💰 *Amount:* ${esc(amountSol.toFixed(6))} SOL\n` +
    `🔍 *Fresh:* ${freshTag}\n` +
    `\n` +
    `🔗 [Voir sur Solscan](https://solscan.io/tx/${esc(signature)})\n` +
    `⚡ *Copy Trade Wallet:* \`${esc(to)}\``
  );
}

/**
 * Message d'alerte Chain Tracker Mode (wallet final identifié).
 */
function formatChainAlert({ strategy, signature, motherWallet, finalWallet, amountSol, hop, isFresh }) {
  const freshTag = isFresh ? '🟢 FRESH' : '🔴 NON\\-FRESH';
  return (
    `🔗 *CHAIN TRACKER* — Hop ${esc(hop)}/${esc(strategy.max_hops)}\n` +
    `📌 *Mother Wallet:* \`${esc(motherWallet)}\`\n` +
    `\n` +
    `🎯 *Dev Wallet Final:* \`${esc(finalWallet)}\`\n` +
    `💰 *Amount:* ${esc(amountSol.toFixed(6))} SOL\n` +
    `🔍 *Fresh:* ${freshTag}\n` +
    `\n` +
    `🔗 [Voir sur Solscan](https://solscan.io/tx/${esc(signature)})\n` +
    `\n` +
    `⚡ *Copy Trade Wallet:* \`${esc(finalWallet)}\` \\| Montant: ${esc(amountSol.toFixed(6))} SOL \\| Fresh: ${isFresh ? 'Oui' : 'Non'}`
  );
}

/**
 * Message /status
 */
function formatStatus(strategies) {
  if (!strategies.length) {
    return '📋 *Aucune stratégie configurée\\.*\nUtilisez /add\\_standard ou /add\\_chain\\.';
  }

  let msg = '📋 *Stratégies actives:*\n\n';
  for (const s of strategies) {
    const state = s.active ? '✅' : '⏸️';
    const type  = s.type === 'standard' ? 'Standard' : 'Chain Tracker';
    msg += `${state} *\\[${esc(s.id)}\\]* ${esc(type)} — ${esc(s.label || 'Sans nom')}\n`;
    msg += `   Wallet: \`${esc(s.wallet)}\`\n`;
    if (s.type === 'standard') {
      msg += `   Range: ${esc(s.min_sol)} — ${esc(s.max_sol)} SOL\n`;
    } else {
      msg += `   Max hops: ${esc(s.max_hops)}\n`;
    }
    msg += `   Fresh only: ${s.fresh_only ? 'Oui' : 'Non'}\n\n`;
  }
  return msg;
}

module.exports = { esc, formatStandardAlert, formatChainAlert, formatStatus };
