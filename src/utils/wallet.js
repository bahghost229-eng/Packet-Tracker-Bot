/**
 * wallet.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Charge le Keypair Solana depuis la variable d'env WALLET_PRIVATE_KEY.
 *
 * Formats acceptés:
 *   - Base58 string  : "4wBqpZM9xXNe...abc"
 *   - JSON array     : "[12,34,56,...]"  (format Phantom / solana-keygen)
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const { Keypair } = require('@solana/web3.js');
const bs58        = require('bs58');
const logger      = require('./logger');

let _keypair = null;

/**
 * Retourne le Keypair signataire.
 * Charge une seule fois depuis WALLET_PRIVATE_KEY.
 * @returns {Keypair}
 */
function getKeypair() {
  if (_keypair) return _keypair;

  const raw = process.env.WALLET_PRIVATE_KEY;
  if (!raw) {
    throw new Error('WALLET_PRIVATE_KEY manquant dans .env — requis pour les swaps Jupiter');
  }

  try {
    // Tentative JSON array [1,2,3,...]
    if (raw.trim().startsWith('[')) {
      const arr = JSON.parse(raw);
      _keypair  = Keypair.fromSecretKey(Uint8Array.from(arr));
    } else {
      // Base58
      _keypair = Keypair.fromSecretKey(bs58.decode(raw.trim()));
    }

    logger.info(`[Wallet] Keypair chargé: ${_keypair.publicKey.toString()}`);
    return _keypair;
  } catch (err) {
    throw new Error(`WALLET_PRIVATE_KEY invalide: ${err.message}`);
  }
}

/**
 * Retourne la clé publique du wallet signataire (string).
 * @returns {string}
 */
function getPublicKey() {
  return getKeypair().publicKey.toString();
}

module.exports = { getKeypair, getPublicKey };
