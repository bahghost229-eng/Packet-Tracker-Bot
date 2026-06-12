/**
 * chainEngine.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Moteur "Chain Tracker Mode" — Suivi multi-sauts (hops) de fonds.
 *
 * Algorithme:
 *   Hop 0: Mother Wallet envoie X SOL dans la fourchette → on détecte → wallet B
 *   Hop 1: Wallet B renvoie des fonds → on suit → wallet C
 *   ...
 *   Hop N: On atteint le wallet final (dev wallet) → alerte Telegram
 *
 * Architecture:
 *   - Un "ChainContext" par transfert suivi, stocké en mémoire (Map).
 *   - Timeout par hop pour éviter les chaînes infinies/bloquées.
 *   - onLogs dynamique : dès qu'on détecte un hop, on souscrit le prochain wallet.
 *   - Garde-fous anti-boucle : on ne suit pas un wallet déjà vu dans la chaîne.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const { EventEmitter }         = require('events');
const { PublicKey }            = require('@solana/web3.js');
const pLimit                   = require('p-limit');

const rpcSubscriber            = require('./rpcSubscriber');
const { getParsedTransaction,
        extractParsedInstructions,
        isFreshWallet,
        extractBoughtTokenMint,
        getConnection }        = require('../utils/solana');
const { swapSolForToken }      = require('../utils/jupiter');
const { logTrackedTx,
        isTxAlreadyTracked }   = require('../db/database');
const { formatChainAlert }         = require('../utils/formatter');
const { sendTradeWizCopyTrade }    = require('../utils/tradewiz');
const logger                       = require('../utils/logger');

const HOP_TIMEOUT_MS = parseInt(process.env.CHAIN_HOP_TIMEOUT_MS || '30000', 10);
const limit          = pLimit(3);

// ─────────────────────────────────────────────────────────────────────────────
// ChainContext : représente un suivi en cours
// ─────────────────────────────────────────────────────────────────────────────

class ChainContext {
  /**
   * @param {object} params
   * @param {object} params.strategy     - Stratégie DB
   * @param {string} params.motherWallet - Adresse du Mother Wallet
   * @param {string} params.currentWallet - Wallet à surveiller au prochain hop
   * @param {number} params.hop           - Numéro du hop courant
   * @param {number} params.amountSol     - Montant transféré depuis le mother
   * @param {string} params.originSig     - Signature de la tx initiale
   * @param {Set<string>} params.visited  - Wallets déjà vus dans la chaîne
   */
  constructor({ strategy, motherWallet, currentWallet, hop, amountSol, originSig, visited }) {
    this.strategy      = strategy;
    this.motherWallet  = motherWallet;
    this.currentWallet = currentWallet;
    this.hop           = hop;
    this.amountSol     = amountSol;
    this.originSig     = originSig;
    this.visited       = visited || new Set();
    this.timeoutHandle = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ChainEngine
// ─────────────────────────────────────────────────────────────────────────────

class ChainEngine {
  /**
   * @param {import('telegraf').Telegraf} bot
   */
  constructor(bot) {
    this.bot    = bot;

    /**
     * Map<walletAddress, ChainContext[]>
     * Un wallet peut être suivi par plusieurs contextes simultanément.
     */
    this._pendingChains = new Map();

    /**
     * Map<walletAddress, stratégies[]> — pour le Mother Wallet (hop 0)
     */
    this._motherMap = new Map();

    this._motherHandler     = null;
    this._chainHopHandler   = null;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // PUBLIC
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Démarre le moteur avec les stratégies Chain Tracker actives.
   * @param {Array} strategies
   */
  start(strategies) {
    const chainStrategies = strategies.filter((s) => s.type === 'chain' && s.active);
    if (!chainStrategies.length) return;

    for (const s of chainStrategies) {
      if (!this._motherMap.has(s.wallet)) {
        this._motherMap.set(s.wallet, []);
      }
      this._motherMap.get(s.wallet).push(s);
      rpcSubscriber.subscribe(s.wallet);
    }

    // Handler global pour les events "tx"
    this._globalHandler = (event) => {
      // Hop 0 : Mother Wallet
      if (this._motherMap.has(event.walletAddress)) {
        limit(() => this._processMotherTx(event));
        return;
      }

      // Hop N > 0 : wallets intermédiaires suivis dynamiquement
      if (this._pendingChains.has(event.walletAddress)) {
        limit(() => this._processHopTx(event));
      }
    };

    rpcSubscriber.on('tx', this._globalHandler);
    logger.info(`[ChainEngine] Démarré — ${chainStrategies.length} mother wallet(s)`);
  }

  stop() {
    if (this._globalHandler) {
      rpcSubscriber.removeListener('tx', this._globalHandler);
      this._globalHandler = null;
    }

    // Clear tous les timeouts en cours
    for (const contexts of this._pendingChains.values()) {
      for (const ctx of contexts) {
        if (ctx.timeoutHandle) clearTimeout(ctx.timeoutHandle);
      }
    }
    this._pendingChains.clear();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // PRIVATE — Hop 0 (Mother Wallet)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Traite une transaction détectée depuis le Mother Wallet.
   * Si le montant correspond à la fourchette, démarre le suivi de chaîne.
   */
  async _processMotherTx({ walletAddress, signature }) {
    try {
      if (isTxAlreadyTracked(signature)) return;

      const tx = await getParsedTransaction(signature);
      if (!tx) return;

      const transfers = extractParsedInstructions(tx);

      for (const transfer of transfers) {
        if (transfer.from !== walletAddress) continue;

        const strategies = this._motherMap.get(walletAddress) || [];

        for (const strategy of strategies) {
          if (!strategy.active) continue;

          const { min_sol, max_sol } = strategy;

          // Filtre sur la fourchette SOL (optionnel en chain mode, mais configurable)
          if (min_sol != null && transfer.amountSol < min_sol) continue;
          if (max_sol != null && transfer.amountSol > max_sol) continue;

          const targetWallet = transfer.to;

          logger.info(
            `[ChainEngine] 🔗 Hop 0 détecté! ${walletAddress} → ${targetWallet} | ` +
            `${transfer.amountSol.toFixed(6)} SOL`
          );

          // Si max_hops = 0, le wallet de destination est directement le dev wallet
          if (strategy.max_hops <= 0) {
            await this._finalizeChain({
              strategy,
              signature,
              motherWallet:  walletAddress,
              finalWallet:   targetWallet,
              amountSol:     transfer.amountSol,
              hop:           0,
            });
            continue;
          }

          // Sinon, démarre le suivi dynamique
          const ctx = new ChainContext({
            strategy,
            motherWallet:  walletAddress,
            currentWallet: targetWallet,
            hop:           1,
            amountSol:     transfer.amountSol,
            originSig:     signature,
            visited:       new Set([walletAddress, targetWallet]),
          });

          this._registerChainContext(targetWallet, ctx, signature);
        }
      }
    } catch (err) {
      logger.error(`[ChainEngine] _processMotherTx erreur (${signature}): ${err.message}`);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // PRIVATE — Hop N (Wallets intermédiaires)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Traite une transaction détectée sur un wallet intermédiaire.
   */
  async _processHopTx({ walletAddress, signature }) {
    try {
      if (isTxAlreadyTracked(signature)) return;

      const contexts = this._pendingChains.get(walletAddress);
      if (!contexts || contexts.length === 0) return;

      const tx = await getParsedTransaction(signature);
      if (!tx) return;

      const transfers = extractParsedInstructions(tx);

      for (const transfer of transfers) {
        if (transfer.from !== walletAddress) continue;

        // On traite chaque contexte en attente sur ce wallet
        for (const ctx of [...contexts]) {
          if (ctx.visited.has(transfer.to)) {
            logger.warn(`[ChainEngine] Boucle détectée! ${transfer.to} déjà vu — abandon de ce chemin`);
            continue;
          }

          const nextWallet  = transfer.to;
          const currentHop  = ctx.hop;
          const { strategy } = ctx;

          logger.info(
            `[ChainEngine] 🔗 Hop ${currentHop}/${strategy.max_hops} | ` +
            `${walletAddress} → ${nextWallet} | ${transfer.amountSol.toFixed(6)} SOL`
          );

          // Clear le timeout du contexte courant
          if (ctx.timeoutHandle) clearTimeout(ctx.timeoutHandle);

          // Retire le contexte du wallet actuel
          this._unregisterChainContext(walletAddress, ctx);

          // Cas terminal : max_hops atteint
          if (currentHop >= strategy.max_hops) {
            await this._finalizeChain({
              strategy,
              signature,
              motherWallet:  ctx.motherWallet,
              finalWallet:   nextWallet,
              amountSol:     transfer.amountSol,
              hop:           currentHop,
            });
            continue;
          }

          // Continue la chaîne
          const newCtx = new ChainContext({
            strategy,
            motherWallet:  ctx.motherWallet,
            currentWallet: nextWallet,
            hop:           currentHop + 1,
            amountSol:     transfer.amountSol,
            originSig:     ctx.originSig,
            visited:       new Set([...ctx.visited, nextWallet]),
          });

          this._registerChainContext(nextWallet, newCtx, signature);
        }
      }
    } catch (err) {
      logger.error(`[ChainEngine] _processHopTx erreur (${signature}): ${err.message}`);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // PRIVATE — Helpers
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Enregistre un ChainContext sur un wallet et souscrit le WSS si nécessaire.
   * @param {string} walletAddress
   * @param {ChainContext} ctx
   * @param {string} triggerSignature - Signature de la tx qui a créé ce contexte
   */
  _registerChainContext(walletAddress, ctx, triggerSignature) {
    if (!this._pendingChains.has(walletAddress)) {
      this._pendingChains.set(walletAddress, []);
    }
    this._pendingChains.get(walletAddress).push(ctx);

    // Souscrit dynamiquement ce wallet au WSS
    rpcSubscriber.subscribe(walletAddress);

    // Timeout de sécurité: si aucun hop détecté dans X ms → abandon
    ctx.timeoutHandle = setTimeout(() => {
      logger.warn(
        `[ChainEngine] ⏰ Timeout hop ${ctx.hop} pour ${walletAddress} ` +
        `(chainId: ${ctx.originSig.slice(0, 8)}...)`
      );
      this._unregisterChainContext(walletAddress, ctx);

      // Si plus aucun contexte sur ce wallet, on peut se désabonner
      // SAUF si c'est un mother wallet
      const remaining = this._pendingChains.get(walletAddress) || [];
      if (remaining.length === 0 && !this._motherMap.has(walletAddress)) {
        rpcSubscriber.unsubscribe(walletAddress);
      }
    }, HOP_TIMEOUT_MS);

    logger.debug(
      `[ChainEngine] Context enregistré: ${walletAddress} hop=${ctx.hop} ` +
      `(origin: ${triggerSignature.slice(0, 8)}...)`
    );
  }

  /**
   * Retire un ChainContext du map.
   */
  _unregisterChainContext(walletAddress, ctx) {
    const contexts = this._pendingChains.get(walletAddress);
    if (!contexts) return;

    const idx = contexts.indexOf(ctx);
    if (idx !== -1) contexts.splice(idx, 1);

    if (contexts.length === 0) {
      this._pendingChains.delete(walletAddress);
    }
  }

  /**
   * Finalise une chaîne : vérifie le fresh wallet, persiste et notifie.
   */
  async _finalizeChain({ strategy, signature, motherWallet, finalWallet, amountSol, hop }) {
    try {
      const fresh = await isFreshWallet(finalWallet, signature);
      if (strategy.fresh_only && !fresh) {
        logger.info(`[ChainEngine] Wallet non-fresh filtré: ${finalWallet}`);
        return;
      }

      logger.info(
        `[ChainEngine] 🎯 Dev Wallet Final identifié!\n` +
        `  Mother: ${motherWallet}\n` +
        `  Final:  ${finalWallet}\n` +
        `  Hops:   ${hop} | Amount: ${amountSol.toFixed(6)} SOL | Fresh: ${fresh}`
      );

      // Persist
      logTrackedTx({
        strategy_id: strategy.id,
        signature,
        from_wallet:  motherWallet,
        to_wallet:    finalWallet,
        amount_sol:   amountSol,
        hop,
        is_fresh:     fresh ? 1 : 0,
      });

      // Notification Telegram
      const msg = formatChainAlert({
        strategy,
        signature,
        motherWallet,
        finalWallet,
        amountSol,
        hop,
        isFresh: fresh,
      });

      await this.bot.telegram.sendMessage(strategy.user_id, msg, {
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: true,
      });

      // ── Jupiter auto-buy ───────────────────────────────────────────────────
      // Le dev wallet final vient de recevoir des fonds → il va lancer un token
      // Si JUPITER_AUTO_BUY=true, on tente d'acheter le token qu'il a lancé
      if (process.env.JUPITER_AUTO_BUY === 'true') {
        // Récupère la tx pour chercher un éventuel token acheté par le dev wallet
        const tx = await getParsedTransaction(signature).catch(() => null);
        const tokenMint = tx ? extractBoughtTokenMint(tx, finalWallet) : null;

        if (tokenMint) {
          const buyAmount = parseFloat(process.env.JUPITER_BUY_AMOUNT_SOL || '0.05');
          logger.info(`[ChainEngine] 🛒 Auto-buy dev wallet: ${buyAmount} SOL → ${tokenMint}`);

          const swapResult = await swapSolForToken(tokenMint, buyAmount);

          const buyMsg = swapResult.success
            ? `✅ *Auto\\-buy exécuté\\!*\n\n` +
              `🔗 Dev Wallet: \`${finalWallet.slice(0, 8)}\\.\\.\\.\`\n` +
              `🪙 Token: \`${tokenMint}\`\n` +
              `💰 Dépensé: ${buyAmount} SOL\n` +
              `📈 Reçu: ${swapResult.outAmount?.toLocaleString() || '?'} tokens\n` +
              `🔗 Sig: [voir](https://solscan.io/tx/${swapResult.signature})`
            : `❌ *Auto\\-buy échoué*\n\n` +
              `🪙 Token: \`${tokenMint}\`\n` +
              `⚠️ Erreur: ${swapResult.error}`;

          await this.bot.telegram.sendMessage(strategy.user_id, buyMsg, {
            parse_mode:               'MarkdownV2',
            disable_web_page_preview: true,
          });
        }
      }

      // TradeWiz copy trade (si tradewiz_name configuré)
      if (strategy.tradewiz_name) {
        await sendTradeWizCopyTrade(this.bot, {
          walletAddress: finalWallet,
          copyTradeName: strategy.tradewiz_name,
          amountSol,
          isFresh:       fresh,
          userId:        strategy.user_id,
        });
      }
    } catch (err) {
      logger.error(`[ChainEngine] _finalizeChain erreur: ${err.message}`);
    }
  }
}

module.exports = ChainEngine;
