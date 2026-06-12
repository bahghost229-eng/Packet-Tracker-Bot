/**
 * jupiter.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Exécute un swap SOL → token via Jupiter API v6.
 *
 * Flow:
 *   1. GET /quote   — obtient le meilleur chemin de swap
 *   2. POST /swap   — génère la transaction sérialisée
 *   3. Signe + envoie la transaction via @solana/web3.js
 *   4. Confirme la transaction
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const axios                                      = require('axios');
const { VersionedTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { getConnection }                          = require('./solana');
const { getKeypair }                             = require('./wallet');
const logger                                     = require('./logger');

const JUPITER_API    = 'https://quote-api.jup.ag/v6';
const SOL_MINT       = 'So11111111111111111111111111111111111111112';

// Slippage en basis points (100 = 1%)
const SLIPPAGE_BPS   = parseInt(process.env.JUPITER_SLIPPAGE_BPS || '100', 10);

// Priority fee en microlamports (0 = auto)
const PRIORITY_FEE   = parseInt(process.env.JUPITER_PRIORITY_FEE || '100000', 10);

/**
 * Effectue un swap SOL → tokenMint.
 *
 * @param {string} tokenMint   - Adresse du token à acheter
 * @param {number} amountSol   - Montant SOL à dépenser
 * @returns {Promise<{success: boolean, signature?: string, error?: string, inAmount?: number, outAmount?: number}>}
 */
async function swapSolForToken(tokenMint, amountSol) {
  const lamports = Math.floor(amountSol * LAMPORTS_PER_SOL);

  logger.info(`[Jupiter] Swap ${amountSol} SOL → ${tokenMint} (${lamports} lamports)`);

  try {
    // ── 1. Quote ────────────────────────────────────────────────────────────
    const quoteRes = await axios.get(`${JUPITER_API}/quote`, {
      params: {
        inputMint:   SOL_MINT,
        outputMint:  tokenMint,
        amount:      lamports,
        slippageBps: SLIPPAGE_BPS,
        onlyDirectRoutes: false,
        asLegacyTransaction: false,
      },
      timeout: 10_000,
    });

    const quote = quoteRes.data;
    if (!quote || !quote.outAmount) {
      return { success: false, error: 'Pas de route Jupiter disponible pour ce token' };
    }

    logger.info(
      `[Jupiter] Quote: ${lamports} lamports → ${quote.outAmount} tokens ` +
      `(priceImpact: ${quote.priceImpactPct}%)`
    );

    // ── 2. Swap transaction ──────────────────────────────────────────────────
    const keypair = getKeypair();

    const swapRes = await axios.post(
      `${JUPITER_API}/swap`,
      {
        quoteResponse:              quote,
        userPublicKey:              keypair.publicKey.toString(),
        wrapAndUnwrapSol:           true,
        dynamicComputeUnitLimit:    true,
        prioritizationFeeLamports:  PRIORITY_FEE,
      },
      {
        headers:  { 'Content-Type': 'application/json' },
        timeout:  15_000,
      }
    );

    const { swapTransaction } = swapRes.data;
    if (!swapTransaction) {
      return { success: false, error: 'Jupiter n\'a pas retourné de transaction' };
    }

    // ── 3. Désérialise, signe, envoie ────────────────────────────────────────
    const txBuf = Buffer.from(swapTransaction, 'base64');
    const tx    = VersionedTransaction.deserialize(txBuf);
    tx.sign([keypair]);

    const connection = getConnection();
    const rawTx      = tx.serialize();

    const signature = await connection.sendRawTransaction(rawTx, {
      skipPreflight:       false,
      preflightCommitment: 'confirmed',
      maxRetries:          3,
    });

    logger.info(`[Jupiter] Transaction envoyée: ${signature}`);

    // ── 4. Confirmation ──────────────────────────────────────────────────────
    const { value: status } = await connection.confirmTransaction(
      { signature, ...( await connection.getLatestBlockhash('confirmed') ) },
      'confirmed'
    );

    if (status?.err) {
      logger.error(`[Jupiter] Transaction échouée: ${JSON.stringify(status.err)}`);
      return {
        success:   false,
        signature,
        error:     `Transaction on-chain échouée: ${JSON.stringify(status.err)}`,
      };
    }

    logger.info(`[Jupiter] ✅ Swap confirmé! Sig: ${signature}`);

    return {
      success:   true,
      signature,
      inAmount:  lamports,
      outAmount: parseInt(quote.outAmount, 10),
    };

  } catch (err) {
    const msg = err.response?.data?.error || err.message;
    logger.error(`[Jupiter] Erreur swap: ${msg}`);
    return { success: false, error: msg };
  }
}

module.exports = { swapSolForToken };
