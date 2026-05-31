/**
 * pattern.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Analyse le pattern comportemental d'un dev wallet à partir du résultat
 * d'un backtest ou d'une signature initiale.
 *
 * Analyse :
 *   1.  Timing inter-hop (délai moyen entre chaque transfert)
 *   2.  Montants conservés à chaque hop (% du montant initial)
 *   3.  Nombre de hops avant wallet final
 *   4.  Fresh wallets vs réutilisés
 *   5.  Wallet financeur récurrent (qui a envoyé au mother wallet)
 *   6.  Heure de la journée (UTC) où le dev est actif
 *   7.  Tokens lancés depuis le dev wallet final (Helius / RPC)
 *   8.  Score de confiance global (0–100)
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const {
  getParsedTransaction,
  extractParsedInstructions,
  getConnection,
} = require('./solana');
const { PublicKey } = require('@solana/web3.js');
const logger = require('./logger');

// ─── Constantes ──────────────────────────────────────────────────────────────

const JITO_TIP_ACCOUNTS = new Set([
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1IfygL5kd9',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
]);

// Token programs connus sur Solana
const TOKEN_PROGRAM_ID       = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM_ID  = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const SPL_MEMO_PROGRAM       = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

// ─── Utilitaires ─────────────────────────────────────────────────────────────

function _fmt(addr) {
  return addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : '?';
}

function _sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Récupère le timestamp UTC d'une transaction.
 * @param {object} tx - ParsedTransaction
 * @returns {number|null} - epoch seconds
 */
function _getTxTimestamp(tx) {
  return tx?.blockTime ?? null;
}

/**
 * Heure UTC (0–23) d'un timestamp epoch seconds.
 */
function _utcHour(epochSec) {
  return new Date(epochSec * 1000).getUTCHours();
}

/**
 * Convertit des secondes en string lisible (ex: "2m 30s").
 */
function _humanDuration(sec) {
  if (!sec || sec < 0) return '?';
  if (sec < 60)  return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

// ─── 1. Financeur (qui a envoyé au mother wallet) ─────────────────────────────

/**
 * Trouve qui a financé le mother wallet dans la tx d'origine.
 * Retourne { funderWallet, amountSol, isRecurring, totalFundedCount }
 *
 * "Récurrent" = le même funder est réapparu dans l'historique du mother wallet.
 *
 * @param {string} motherWallet
 * @param {string} originSignature
 * @returns {Promise<FunderInfo>}
 */
async function analyzeFunder(motherWallet, originSignature) {
  const info = {
    funderWallet:    null,
    amountSol:       null,
    isRecurring:     false,
    totalFundedCount: 0,
    previousSigs:    [],
  };

  try {
    const tx = await getParsedTransaction(originSignature);
    if (!tx) return info;

    const transfers = extractParsedInstructions(tx);
    // Cherche qui a envoyé au mother wallet
    const incoming = transfers
      .filter((t) => t.to === motherWallet && !JITO_TIP_ACCOUNTS.has(t.from))
      .sort((a, b) => b.amountSol - a.amountSol);

    if (!incoming.length) return info;

    info.funderWallet = incoming[0].from;
    info.amountSol    = incoming[0].amountSol;

    // Vérifie si ce funder a envoyé plusieurs fois au mother wallet
    const connection = getConnection();
    const pubkey     = new PublicKey(motherWallet);
    const sigs       = await connection.getSignaturesForAddress(pubkey, { limit: 50 });

    let count = 0;
    for (const s of sigs) {
      if (s.err) continue;
      try {
        const t = await getParsedTransaction(s.signature);
        if (!t) continue;
        const tr = extractParsedInstructions(t);
        const found = tr.some(
          (x) => x.to === motherWallet && x.from === info.funderWallet
        );
        if (found) {
          count++;
          if (s.signature !== originSignature) info.previousSigs.push(s.signature);
        }
      } catch (_) {}
      await _sleep(80); // rate-limit friendly
    }

    info.totalFundedCount = count;
    info.isRecurring      = count > 1;
  } catch (err) {
    logger.warn(`[Pattern] analyzeFunder erreur: ${err.message}`);
  }

  return info;
}

// ─── 2. Analyse du chemin (timing, montants, fresh) ──────────────────────────

/**
 * À partir du path backtest [{hop, from, to, amountSol, signature, isFresh}],
 * calcule les métriques timing + montants.
 *
 * @param {Array} path - result.path du backtest
 * @returns {Promise<PathMetrics>}
 */
async function analyzePathMetrics(path) {
  const metrics = {
    totalHops:       path.length,
    freshWallets:    0,
    reusedWallets:   0,
    freshPercent:    0,
    initialAmount:   null,
    finalAmount:     null,
    retainedPercent: null,
    hopDelays:       [],   // délai en secondes entre hop[i-1] et hop[i]
    avgDelayS:       null,
    minDelayS:       null,
    maxDelayS:       null,
    totalDurationS:  null,
    timestamps:      [],   // epoch seconds par hop
    hourPattern:     [],   // heure UTC par hop
    retentionByHop:  [],   // % montant conservé à chaque hop
  };

  if (!path.length) return metrics;

  metrics.initialAmount = path[0].amountSol;
  metrics.finalAmount   = path[path.length - 1].amountSol;

  if (metrics.initialAmount > 0) {
    metrics.retainedPercent = ((metrics.finalAmount / metrics.initialAmount) * 100).toFixed(1);
  }

  // Timestamps
  for (const step of path) {
    if (step.isFresh) metrics.freshWallets++;
    else metrics.reusedWallets++;

    try {
      const tx = await getParsedTransaction(step.signature);
      const ts = _getTxTimestamp(tx);
      metrics.timestamps.push(ts);
      if (ts) metrics.hourPattern.push(_utcHour(ts));
    } catch (_) {
      metrics.timestamps.push(null);
    }

    // % montant conservé par rapport au hop précédent
    if (path.indexOf(step) > 0) {
      const prev = path[path.indexOf(step) - 1];
      if (prev.amountSol > 0) {
        metrics.retentionByHop.push(
          ((step.amountSol / prev.amountSol) * 100).toFixed(1)
        );
      }
    }

    await _sleep(60);
  }

  metrics.freshPercent = path.length
    ? ((metrics.freshWallets / path.length) * 100).toFixed(0)
    : 0;

  // Délais inter-hops
  for (let i = 1; i < metrics.timestamps.length; i++) {
    const t0 = metrics.timestamps[i - 1];
    const t1 = metrics.timestamps[i];
    if (t0 && t1) {
      metrics.hopDelays.push(Math.abs(t1 - t0));
    }
  }

  if (metrics.hopDelays.length) {
    const sum = metrics.hopDelays.reduce((a, b) => a + b, 0);
    metrics.avgDelayS = Math.round(sum / metrics.hopDelays.length);
    metrics.minDelayS = Math.min(...metrics.hopDelays);
    metrics.maxDelayS = Math.max(...metrics.hopDelays);
  }

  if (
    metrics.timestamps[0] &&
    metrics.timestamps[metrics.timestamps.length - 1]
  ) {
    metrics.totalDurationS = Math.abs(
      metrics.timestamps[metrics.timestamps.length - 1] - metrics.timestamps[0]
    );
  }

  return metrics;
}

// ─── 3. Tokens lancés depuis le dev wallet final ──────────────────────────────

/**
 * Cherche si des tokens SPL ont été créés/lancés depuis le dev wallet final.
 * Utilise getSignaturesForAddress + getParsedTransaction pour filtrer
 * les tx qui contiennent une instruction "initializeMint".
 *
 * @param {string} devWallet
 * @param {number} limit - nb de tx à scanner
 * @returns {Promise<TokenLaunch[]>}
 */
async function findLaunchedTokens(devWallet, limit = 30) {
  const launches = [];

  try {
    const connection = getConnection();
    const pubkey     = new PublicKey(devWallet);
    const sigs       = await connection.getSignaturesForAddress(pubkey, { limit });

    for (const s of sigs) {
      if (s.err) continue;

      try {
        const tx = await getParsedTransaction(s.signature);
        if (!tx?.transaction?.message?.instructions) continue;

        const allInstrs = [
          ...tx.transaction.message.instructions,
          ...(tx.meta?.innerInstructions || []).flatMap((i) => i.instructions || []),
        ];

        for (const instr of allInstrs) {
          const progId = instr.programId?.toString?.() || instr.program || '';
          const type   = instr.parsed?.type || '';

          if (
            (progId === TOKEN_PROGRAM_ID || progId === TOKEN_2022_PROGRAM_ID) &&
            (type === 'initializeMint' || type === 'initializeMint2')
          ) {
            const mintAddr = instr.parsed?.info?.mint || '?';
            const decimals = instr.parsed?.info?.decimals ?? '?';

            launches.push({
              mint:      mintAddr,
              decimals,
              signature: s.signature,
              timestamp: _getTxTimestamp(tx),
            });
          }
        }
      } catch (_) {}

      await _sleep(60);
    }
  } catch (err) {
    logger.warn(`[Pattern] findLaunchedTokens erreur: ${err.message}`);
  }

  return launches;
}

// ─── 4. Score de confiance ────────────────────────────────────────────────────

/**
 * Calcule un score de confiance 0–100 basé sur les métriques.
 *
 * Points positifs :
 *   +30  tous les wallets sont fresh
 *   +20  financeur récurrent (même source plusieurs fois)
 *   +20  timing régulier (écart-type < 20% de la moyenne)
 *   +15  montant bien conservé (> 80% retained)
 *   +15  tokens lancés depuis le dev wallet
 *
 * @param {object} p - { pathMetrics, funderInfo, tokens }
 * @returns {number} score 0–100
 */
function computeConfidenceScore({ pathMetrics, funderInfo, tokens }) {
  let score = 0;

  // Fresh wallets
  const freshPct = parseFloat(pathMetrics.freshPercent || 0);
  if (freshPct === 100) score += 30;
  else if (freshPct >= 80) score += 20;
  else if (freshPct >= 50) score += 10;

  // Financeur récurrent
  if (funderInfo.isRecurring) score += 20;

  // Timing régulier
  const delays = pathMetrics.hopDelays;
  if (delays.length >= 2) {
    const avg = delays.reduce((a, b) => a + b, 0) / delays.length;
    const variance = delays.reduce((a, b) => a + (b - avg) ** 2, 0) / delays.length;
    const stdDev   = Math.sqrt(variance);
    const cv       = avg > 0 ? stdDev / avg : 1; // coefficient of variation
    if (cv < 0.15) score += 20;
    else if (cv < 0.30) score += 12;
    else if (cv < 0.50) score += 5;
  }

  // Montant retenu
  const retained = parseFloat(pathMetrics.retainedPercent || 0);
  if (retained > 90) score += 15;
  else if (retained > 80) score += 10;
  else if (retained > 60) score += 5;

  // Tokens lancés
  if (tokens.length > 0) score += 15;

  return Math.min(100, score);
}

// ─── 5. Heure active du dev ───────────────────────────────────────────────────

/**
 * À partir des heures UTC des hops, déduit la plage horaire principale.
 * @param {number[]} hours - tableau d'heures UTC (0–23)
 * @returns {{ peak: number|null, distribution: object }}
 */
function analyzeActiveHours(hours) {
  if (!hours.length) return { peak: null, distribution: {} };

  const dist = {};
  for (const h of hours) {
    dist[h] = (dist[h] || 0) + 1;
  }

  const peak = Object.entries(dist).sort((a, b) => b[1] - a[1])[0]?.[0];

  return { peak: peak !== undefined ? parseInt(peak) : null, distribution: dist };
}

// ─── 6. Analyse complète ─────────────────────────────────────────────────────

/**
 * Lance l'analyse complète du pattern dev.
 *
 * @param {object} backtestResult  - résultat de runBacktest()
 * @returns {Promise<PatternResult>}
 */
async function analyzePattern(backtestResult) {
  const pattern = {
    success:        false,
    motherWallet:   backtestResult.motherWallet,
    finalWallet:    backtestResult.finalWallet,
    funder:         null,
    pathMetrics:    null,
    activeHours:    null,
    tokens:         [],
    confidenceScore: 0,
    error:          null,
  };

  if (!backtestResult.success || !backtestResult.path?.length) {
    pattern.error = 'Backtest invalide ou path vide.';
    return pattern;
  }

  try {
    logger.info('[Pattern] Démarrage analyse pattern...');

    // Étape 1 : Financeur
    logger.info('[Pattern] Analyse financeur...');
    pattern.funder = await analyzeFunder(
      backtestResult.motherWallet,
      backtestResult.originSig
    );

    // Étape 2 : Métriques du chemin
    logger.info('[Pattern] Analyse métriques du chemin...');
    pattern.pathMetrics = await analyzePathMetrics(backtestResult.path);

    // Étape 3 : Heures actives
    pattern.activeHours = analyzeActiveHours(pattern.pathMetrics.hourPattern);

    // Étape 4 : Tokens lancés depuis le dev wallet
    if (backtestResult.finalWallet) {
      logger.info('[Pattern] Recherche tokens lancés...');
      pattern.tokens = await findLaunchedTokens(backtestResult.finalWallet);
    }

    // Étape 5 : Score
    pattern.confidenceScore = computeConfidenceScore({
      pathMetrics: pattern.pathMetrics,
      funderInfo:  pattern.funder,
      tokens:      pattern.tokens,
    });

    pattern.success = true;
    logger.info(`[Pattern] Analyse terminée. Score: ${pattern.confidenceScore}/100`);
  } catch (err) {
    logger.error(`[Pattern] Erreur: ${err.message}`);
    pattern.error = err.message;
  }

  return pattern;
}

// ─── 7. Formatage Telegram ────────────────────────────────────────────────────

/**
 * Formate le résultat du pattern pour Telegram (MarkdownV2).
 * @param {object} pattern - résultat de analyzePattern()
 * @returns {string}
 */
function formatPatternResult(pattern) {
  const esc = (t) => String(t).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
  const addr = (a) => a ? `\`${esc(a.slice(0, 8))}\\.\\.\\.\`` : '`?`';

  if (!pattern.success) {
    return `❌ *Analyse Pattern Échouée*\n\`${esc(pattern.error || 'Erreur inconnue')}\``;
  }

  const pm   = pattern.pathMetrics;
  const fun  = pattern.funder;
  const ah   = pattern.activeHours;
  const toks = pattern.tokens;
  const score = pattern.confidenceScore;

  // Score bar
  const scoreBar = (() => {
    const filled = Math.round(score / 10);
    return '🟩'.repeat(filled) + '⬜'.repeat(10 - filled);
  })();

  // Emoji score
  const scoreEmoji = score >= 80 ? '🔥' : score >= 60 ? '⚡' : score >= 40 ? '⚠️' : '❄️';

  let msg = `🧠 *Analyse Pattern Dev*\n\n`;

  // ── Score ──
  msg += `${scoreEmoji} *Score de confiance:* ${esc(score)}/100\n`;
  msg += `${esc(scoreBar)}\n\n`;

  // ── Financeur ──
  msg += `💰 *Wallet Financeur*\n`;
  if (fun?.funderWallet) {
    msg += `  Adresse: ${addr(fun.funderWallet)}\n`;
    msg += `  Montant envoyé: \`${esc(fun.amountSol?.toFixed(3) || '?')} SOL\`\n`;
    msg += `  Récurrent: ${fun.isRecurring ? `✅ *OUI* \\(${esc(fun.totalFundedCount)} fois\\)` : '❌ Non'}\n`;
    if (fun.isRecurring && fun.previousSigs.length) {
      msg += `  ⚠️ Ce financeur a déjà financé ${esc(fun.totalFundedCount - 1)} autre\\(s\\) opération\\(s\\)\n`;
    }
  } else {
    msg += `  Financeur non détecté\n`;
  }

  msg += `\n`;

  // ── Chemin ──
  msg += `🔗 *Analyse du Chemin*\n`;
  msg += `  Hops: \`${esc(pm.totalHops)}\`\n`;
  msg += `  Fresh wallets: \`${esc(pm.freshWallets)}/${esc(pm.totalHops)}\` \\(${esc(pm.freshPercent)}%\\)\n`;
  if (pm.reusedWallets > 0) {
    msg += `  ⚠️ ${esc(pm.reusedWallets)} wallet\\(s\\) réutilisé\\(s\\)\n`;
  }

  if (pm.initialAmount !== null) {
    msg += `  Montant initial: \`${esc(pm.initialAmount.toFixed(3))} SOL\`\n`;
    msg += `  Montant final: \`${esc(pm.finalAmount?.toFixed(3) || '?')} SOL\`\n`;
    if (pm.retainedPercent) {
      msg += `  Conservé: \`${esc(pm.retainedPercent)}%\`\n`;
    }
  }

  // Rétention par hop
  if (pm.retentionByHop?.length) {
    const retStr = pm.retentionByHop.map((r, i) => `H${i + 1}:${r}%`).join(' → ');
    msg += `  Rétention: \`${esc(retStr)}\`\n`;
  }

  msg += `\n`;

  // ── Timing ──
  msg += `⏱ *Timing*\n`;
  if (pm.avgDelayS !== null) {
    msg += `  Délai moyen: \`${esc(_humanDuration(pm.avgDelayS))}\`\n`;
    msg += `  Min / Max: \`${esc(_humanDuration(pm.minDelayS))} / ${esc(_humanDuration(pm.maxDelayS))}\`\n`;
  }
  if (pm.totalDurationS !== null) {
    msg += `  Durée totale: \`${esc(_humanDuration(pm.totalDurationS))}\`\n`;
  }

  // Délais par hop
  if (pm.hopDelays?.length) {
    const delStr = pm.hopDelays.map((d, i) => `H${i + 1}:${_humanDuration(d)}`).join(' → ');
    msg += `  Par hop: \`${esc(delStr)}\`\n`;
  }

  msg += `\n`;

  // ── Heures actives ──
  msg += `🕐 *Activité UTC*\n`;
  if (ah?.peak !== null) {
    msg += `  Pic d'activité: \`${esc(ah.peak)}h UTC\`\n`;
    const distStr = Object.entries(ah.distribution)
      .sort((a, b) => parseInt(a[0]) - parseInt(b[0]))
      .map(([h, c]) => `${h}h:${c}`)
      .join(' | ');
    msg += `  Distribution: \`${esc(distStr)}\`\n`;
  } else {
    msg += `  Données insuffisantes\n`;
  }

  msg += `\n`;

  // ── Tokens lancés ──
  msg += `🪙 *Tokens Lancés depuis Dev Wallet*\n`;
  if (toks.length === 0) {
    msg += `  Aucun token détecté dans les 30 dernières tx\n`;
  } else {
    for (const tok of toks.slice(0, 5)) {
      const ts   = tok.timestamp ? new Date(tok.timestamp * 1000).toISOString().slice(0, 16) : '?';
      msg += `  • Mint: \`${esc(tok.mint.slice(0, 12))}\\.\\.\\.\`\n`;
      msg += `    Decimals: ${esc(tok.decimals)} \\| Date: \`${esc(ts)}\`\n`;
      msg += `    [🔗 Birdeye](https://birdeye\\.so/token/${esc(tok.mint)})\n`;
    }
    if (toks.length > 5) {
      msg += `  _\\.\\.\\. et ${esc(toks.length - 5)} autre\\(s\\)_\n`;
    }
  }

  msg += `\n`;

  // ── Wallets clés ──
  msg += `📌 *Wallets Clés*\n`;
  msg += `  Financeur: [🔗 Solscan](https://solscan\\.io/address/${esc(fun?.funderWallet || '')})\n`;
  msg += `  Mother: [🔗 Solscan](https://solscan\\.io/address/${esc(pattern.motherWallet)})\n`;
  msg += `  Dev Final: [🔗 Solscan](https://solscan\\.io/address/${esc(pattern.finalWallet)})\n`;

  return msg;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  analyzePattern,
  formatPatternResult,
  analyzeFunder,
  analyzePathMetrics,
  findLaunchedTokens,
  computeConfidenceScore,
};
