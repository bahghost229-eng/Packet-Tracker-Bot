/**
 * solana.js
 * Utilitaires Solana : connexion RPC, parsing de transactions, vérification Fresh Wallet.
 */

'use strict';

const { Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const logger = require('./logger');

const HTTP_RPC  = process.env.HELIUS_RPC_HTTP  || process.env.FALLBACK_RPC_HTTP;
const WSS_RPC   = process.env.HELIUS_RPC_WSS   || process.env.FALLBACK_RPC_WSS;

// Connexion unique réutilisée partout
let _connection = null;

/**
 * Retourne (ou crée) la connexion Solana HTTP.
 * @returns {Connection}
 */
function getConnection() {
  if (!_connection) {
    _connection = new Connection(HTTP_RPC, {
      commitment: 'confirmed',
      wsEndpoint: WSS_RPC,
    });
    logger.info(`[Solana] Connexion RPC: ${HTTP_RPC}`);
  }
  return _connection;
}

/**
 * Valide qu'une string est une PublicKey Solana valide.
 * @param {string} address
 * @returns {boolean}
 */
function isValidPublicKey(address) {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

/**
 * Convertit des lamports en SOL (avec précision).
 * @param {number} lamports
 * @returns {number}
 */
function lamportsToSol(lamports) {
  return lamports / LAMPORTS_PER_SOL;
}

/**
 * Vérifie si un wallet est "fresh" (0 transaction avant la réception ciblée).
 * On utilise getSignaturesForAddress avec limit=2 : si on obtient <= 1 sig
 * (la tx courante elle-même), le wallet est considéré fresh.
 *
 * @param {string} address - Adresse du wallet de destination
 * @param {string} currentSignature - Signature de la tx déclenchante (à exclure)
 * @returns {Promise<boolean>}
 */
async function isFreshWallet(address, currentSignature = null) {
  try {
    const connection = getConnection();
    const pubkey = new PublicKey(address);

    // On demande les 2 premières signatures pour ce wallet
    const sigs = await connection.getSignaturesForAddress(pubkey, { limit: 2 });

    if (sigs.length === 0) return true;
    if (sigs.length === 1 && sigs[0].signature === currentSignature) return true;
    if (sigs.length === 1) return false; // 1 tx mais ce n'est pas la nôtre

    return false;
  } catch (err) {
    logger.warn(`[isFreshWallet] Erreur pour ${address}: ${err.message}`);
    return false; // Par défaut non-fresh en cas d'erreur
  }
}

/**
 * Récupère le détail d'une transaction confirmée.
 * @param {string} signature
 * @returns {Promise<import('@solana/web3.js').ParsedTransactionWithMeta|null>}
 */
async function getParsedTransaction(signature) {
  try {
    const connection = getConnection();
    const tx = await connection.getParsedTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    return tx;
  } catch (err) {
    logger.warn(`[getParsedTransaction] Erreur: ${err.message}`);
    return null;
  }
}

/**
 * Extrait les transferts SOL natifs d'une transaction parsée.
 * Retourne un tableau d'objets { from, to, amountSol }.
 *
 * @param {import('@solana/web3.js').ParsedTransactionWithMeta} tx
 * @returns {Array<{from: string, to: string, amountSol: number}>}
 */
function extractSolTransfers(tx) {
  const transfers = [];

  if (!tx?.meta || !tx?.transaction) return transfers;

  const accountKeys = tx.transaction.message.accountKeys.map((k) =>
    typeof k === 'string' ? k : k.pubkey.toString()
  );

  const preBalances  = tx.meta.preBalances  || [];
  const postBalances = tx.meta.postBalances || [];

  for (let i = 0; i < accountKeys.length; i++) {
    const diff = postBalances[i] - preBalances[i];
    if (diff > 0) {
      // Cherche qui a envoyé (balance diminuée)
      for (let j = 0; j < accountKeys.length; j++) {
        if (i === j) continue;
        const sent = preBalances[j] - postBalances[j];
        if (sent > 0 && Math.abs(sent - diff) < 10_000) {
          // Tolérance de 10000 lamports (fees)
          transfers.push({
            from:      accountKeys[j],
            to:        accountKeys[i],
            amountSol: lamportsToSol(diff),
          });
        }
      }
    }
  }

  return transfers;
}

/**
 * Extrait les transferts SOL via les instructions parsées (plus précis pour les transferts simples).
 * @param {import('@solana/web3.js').ParsedTransactionWithMeta} tx
 * @returns {Array<{from: string, to: string, amountSol: number}>}
 */
function extractParsedInstructions(tx) {
  const transfers = [];

  if (!tx?.transaction?.message?.instructions) return transfers;

  for (const instr of tx.transaction.message.instructions) {
    if (
      instr.program === 'system' &&
      instr.parsed?.type === 'transfer' &&
      instr.parsed?.info
    ) {
      const { source, destination, lamports } = instr.parsed.info;
      transfers.push({
        from:      source,
        to:        destination,
        amountSol: lamportsToSol(lamports),
      });
    }
  }

  // Inclut également les inner instructions
  for (const inner of tx.meta?.innerInstructions || []) {
    for (const instr of inner.instructions || []) {
      if (
        instr.program === 'system' &&
        instr.parsed?.type === 'transfer' &&
        instr.parsed?.info
      ) {
        const { source, destination, lamports } = instr.parsed.info;
        transfers.push({
          from:      source,
          to:        destination,
          amountSol: lamportsToSol(lamports),
        });
      }
    }
  }

  return transfers;
}

module.exports = {
  getConnection,
  isValidPublicKey,
  lamportsToSol,
  isFreshWallet,
  getParsedTransaction,
  extractSolTransfers,
  extractParsedInstructions,
};
