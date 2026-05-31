/**
 * backtest.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Simule le Chain Tracker en mode "replay" à partir d'une signature connue.
 * Permet de valider une stratégie avant de l'activer en live.
 *
 * Algorithme:
 *   1. Parse la tx de la signature fournie
 *   2. Extrait les transferts SOL depuis le wallet cible
 *   3. Suit récursivement chaque wallet de destination (jusqu'à max_hops)
 *   4. Retourne le chemin complet + wallet final
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const {
  getParsedTransaction,
  extractParsedInstructions,
  isFreshWallet,
  getConnection,
} = require('./solana');
const { PublicKey } = require('@solana/web3.js');
const logger = require('./logger');

const MAX_HOPS_BACKTEST = 10;

/**
 * Lance un backtest à partir d'un wallet source et d'une signature de tx.
 *
 * @param {string} walletAddress  - Adresse du Mother Wallet
 * @param {string} signature      - Signature de la transaction initiale
 * @param {number} maxHops        - Nombre max de sauts à suivre (défaut: 10)
 * @returns {Promise<BacktestResult>}
 */
async function runBacktest(walletAddress, signature, maxHops = MAX_HOPS_BACKTEST) {
  const result = {
    success:     false,
    motherWallet: walletAddress,
    originSig:   signature,
    path:        [],   // [{hop, from, to, amountSol, signature, isFresh}]
    finalWallet: null,
    error:       null,
  };

  try {
    // Hop 0 : parse la tx initiale
    const tx = await getParsedTransaction(signature);
    if (!tx) {
      result.error = 'Transaction introuvable. Vérifie la signature.';
      return result;
    }

    const transfers = extractParsedInstructions(tx);
    const initialTransfer = transfers.find((t) => t.from === walletAddress);

    if (!initialTransfer) {
      result.error = `Aucun transfert SOL sortant de ${walletAddress} dans cette tx.`;
      return result;
    }

    // Démarre la chaîne
    let currentWallet = initialTransfer.to;
    let currentSig    = signature;
    let currentAmount = initialTransfer.amountSol;
    const visited     = new Set([walletAddress, currentWallet]);

    const fresh0 = await isFreshWallet(currentWallet, signature);
    result.path.push({
      hop:       0,
      from:      walletAddress,
      to:        currentWallet,
      amountSol: currentAmount,
      signature: currentSig,
      isFresh:   fresh0,
    });

    // Suit la chaîne hop par hop
    for (let hop = 1; hop <= maxHops; hop++) {
      const nextSig = await _findNextOutboundTx(currentWallet, currentSig);
      if (!nextSig) {
        // Pas de tx sortante trouvée → wallet final
        result.finalWallet = currentWallet;
        result.success = true;
        break;
      }

      const nextTx = await getParsedTransaction(nextSig);
      if (!nextTx) break;

      const nextTransfers = extractParsedInstructions(nextTx);
      const outbound = nextTransfers.find(
        (t) => t.from === currentWallet && !visited.has(t.to)
      );

      if (!outbound) {
        result.finalWallet = currentWallet;
        result.success = true;
        break;
      }

      const isFresh = await isFreshWallet(outbound.to, nextSig);
      result.path.push({
        hop,
        from:      currentWallet,
        to:        outbound.to,
        amountSol: outbound.amountSol,
        signature: nextSig,
        isFresh,
      });

      visited.add(outbound.to);
      currentWallet = outbound.to;
      currentSig    = nextSig;
      currentAmount = outbound.amountSol;

      if (hop === maxHops) {
        result.finalWallet = currentWallet;
        result.success = true;
      }
    }

    if (!result.finalWallet) {
      result.finalWallet = currentWallet;
      result.success = true;
    }

  } catch (err) {
    logger.error(`[Backtest] Erreur: ${err.message}`);
    result.error = err.message;
  }

  return result;
}

/**
 * Cherche la prochaine transaction sortante d'un wallet après une signature donnée.
 *
 * getSignaturesForAddress retourne les tx du plus récent au plus ancien.
 * - "before" = signature pivot → retourne les tx PLUS ANCIENNES que ce pivot
 * - "until"  = stop quand on atteint cette signature (ne l'inclut pas)
 *
 * On veut les tx APRÈS afterSignature (plus récentes).
 * Donc : on récupère un lot sans "before/after", et on filtre manuellement
 * en cherchant la tx juste après afterSignature dans la liste triée DESC.
 *
 * @param {string} walletAddress
 * @param {string} afterSignature - Signature de la tx précédente
 * @returns {Promise<string|null>}
 */
async function _findNextOutboundTx(walletAddress, afterSignature) {
  try {
    const connection = getConnection();
    const pubkey = new PublicKey(walletAddress);

    // Récupère les 20 tx les plus récentes du wallet
    // La liste est triée du plus récent (index 0) au plus ancien (index N)
    const sigs = await connection.getSignaturesForAddress(pubkey, { limit: 20 });

    if (!sigs || sigs.length === 0) return null;

    // Trouve l'index de afterSignature dans la liste
    const pivotIdx = sigs.findIndex((s) => s.signature === afterSignature);

    if (pivotIdx === -1) {
      // afterSignature pas dans les 20 dernières → trop vieux, prend la plus ancienne dispo
      for (let i = sigs.length - 1; i >= 0; i--) {
        if (!sigs[i].err) return sigs[i].signature;
      }
      return null;
    }

    // La tx "suivante" (plus récente que le pivot) est à l'index pivotIdx - 1
    // Car la liste est DESC (plus récent en premier)
    for (let i = pivotIdx - 1; i >= 0; i--) {
      if (!sigs[i].err) return sigs[i].signature;
    }

    // Aucune tx plus récente trouvée → wallet final
    return null;
  } catch (err) {
    logger.warn(`[Backtest] _findNextOutboundTx erreur: ${err.message}`);
    return null;
  }
}

/**
 * Formate le résultat du backtest pour Telegram (MarkdownV2).
 */
function formatBacktestResult(result) {
  const esc = (t) => String(t).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');

  if (!result.success) {
    return `❌ *Backtest échoué*\n\`${esc(result.error || 'Erreur inconnue')}\``;
  }

  let msg =
    `🔬 *Résultat Backtest*\n` +
    `📌 Mother: \`${esc(result.motherWallet)}\`\n\n` +
    `*Chemin suivi \\(${esc(result.path.length)} hop\\(s\\)\\):*\n`;

  for (const step of result.path) {
    const freshTag = step.isFresh ? '🟢' : '🔴';
    msg +=
      `\n*Hop ${esc(step.hop)}* ${freshTag}\n` +
      `  └ \`${esc(step.from.slice(0,8))}...\` → \`${esc(step.to)}\`\n` +
      `     ${esc(step.amountSol.toFixed(6))} SOL\n` +
      `     [Solscan](https://solscan.io/tx/${esc(step.signature)})\n`;
  }

  const finalFresh = result.path[result.path.length - 1]?.isFresh;
  const freshTag   = finalFresh ? '🟢 FRESH' : '🔴 NON\\-FRESH';

  msg +=
    `\n🎯 *Dev Wallet Final:*\n` +
    `\`${esc(result.finalWallet)}\`\n` +
    `${freshTag}\n` +
    `\n[Voir sur Solscan](https://solscan.io/address/${esc(result.finalWallet)})`;

  return msg;
}

module.exports = { runBacktest, formatBacktestResult };
