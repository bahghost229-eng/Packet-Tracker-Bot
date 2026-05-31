/**
 * standardEngine.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Moteur de détection "Standard Mode".
 *
 * Logique:
 *   1. Écoute les events "tx" émis par rpcSubscriber pour les wallets surveillés.
 *   2. Récupère et parse la transaction complète via HTTP RPC.
 *   3. Filtre: transfert SOL sortant dans la fourchette [min_sol, max_sol].
 *   4. Vérifie si le wallet de destination est "fresh".
 *   5. Émet une notification Telegram formatée.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const pLimit                  = require('p-limit');
const rpcSubscriber           = require('./rpcSubscriber');
const { getParsedTransaction,
        extractParsedInstructions,
        isFreshWallet }       = require('../utils/solana');
const { logTrackedTx,
        isTxAlreadyTracked }  = require('../db/database');
const { formatStandardAlert } = require('../utils/formatter');
const logger                  = require('../utils/logger');

// Limite de concurrence pour les appels RPC (évite de flood le RPC)
const limit = pLimit(5);

class StandardEngine {
  /**
   * @param {import('telegraf').Telegraf} bot  - Instance Telegraf
   */
  constructor(bot) {
    this.bot = bot;
    this._handler = null;
  }

  /**
   * Active le moteur standard sur un ensemble de stratégies.
   * @param {Array} strategies - Stratégies de type 'standard'
   */
  start(strategies) {
    const standardStrategies = strategies.filter((s) => s.type === 'standard' && s.active);
    if (!standardStrategies.length) return;

    // Index wallets → stratégies pour lookup O(1)
    this._strategyMap = new Map();
    for (const s of standardStrategies) {
      if (!this._strategyMap.has(s.wallet)) {
        this._strategyMap.set(s.wallet, []);
      }
      this._strategyMap.get(s.wallet).push(s);
      rpcSubscriber.subscribe(s.wallet);
    }

    // Enregistre le handler sur l'event emitter du subscriber
    this._handler = (event) => {
      if (this._strategyMap.has(event.walletAddress)) {
        limit(() => this._processTx(event));
      }
    };

    rpcSubscriber.on('tx', this._handler);
    logger.info(`[StandardEngine] Démarré — ${standardStrategies.length} stratégie(s)`);
  }

  stop() {
    if (this._handler) {
      rpcSubscriber.removeListener('tx', this._handler);
      this._handler = null;
    }
  }

  // ──────────────────────────────────────────────────────────────────────────

  async _processTx({ walletAddress, signature }) {
    try {
      // Déduplique
      if (isTxAlreadyTracked(signature)) return;

      const tx = await getParsedTransaction(signature);
      if (!tx) return;

      const transfers = extractParsedInstructions(tx);

      for (const transfer of transfers) {
        if (transfer.from !== walletAddress) continue;

        const strategies = this._strategyMap.get(walletAddress) || [];
        for (const strategy of strategies) {
          if (!strategy.active) continue;

          const { min_sol, max_sol } = strategy;
          if (transfer.amountSol < min_sol || transfer.amountSol > max_sol) continue;

          // Vérification Fresh Wallet
          const fresh = await isFreshWallet(transfer.to, signature);
          if (strategy.fresh_only && !fresh) continue;

          logger.info(
            `[StandardEngine] 🎯 Match! ${walletAddress} → ${transfer.to} | ` +
            `${transfer.amountSol.toFixed(6)} SOL | Fresh: ${fresh}`
          );

          // Persist
          logTrackedTx({
            strategy_id: strategy.id,
            signature,
            from_wallet:  transfer.from,
            to_wallet:    transfer.to,
            amount_sol:   transfer.amountSol,
            hop:          0,
            is_fresh:     fresh ? 1 : 0,
          });

          // Notifie Telegram
          const msg = formatStandardAlert({
            strategy,
            signature,
            from:      transfer.from,
            to:        transfer.to,
            amountSol: transfer.amountSol,
            isFresh:   fresh,
          });

          await this.bot.telegram.sendMessage(strategy.user_id, msg, {
            parse_mode: 'MarkdownV2',
            disable_web_page_preview: true,
          });
        }
      }
    } catch (err) {
      logger.error(`[StandardEngine] _processTx erreur (${signature}): ${err.message}`);
    }
  }
}

module.exports = StandardEngine;
