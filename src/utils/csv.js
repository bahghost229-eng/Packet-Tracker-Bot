/**
 * csv.js
 * Génère un export CSV des transactions trackées pour une stratégie donnée.
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const logger = require('./logger');

/**
 * Génère un fichier CSV des tx trackées et retourne le chemin du fichier.
 *
 * @param {Array}  rows       - Lignes issues de la DB (tracked_txs JOIN strategies)
 * @param {string} label      - Nom de la stratégie (pour le nom de fichier)
 * @returns {string} filePath - Chemin absolu du CSV généré
 */
function generateCsv(rows, label = 'export') {
  const dir      = path.resolve('./data/exports');
  fs.mkdirSync(dir, { recursive: true });

  const safeName = label.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
  const ts       = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filePath = path.join(dir, `${safeName}_${ts}.csv`);

  const headers = [
    'hop',
    'from_wallet',
    'to_wallet',
    'amount_sol',
    'is_fresh',
    'signature',
    'detected_at',
  ];

  const lines = [headers.join(',')];

  for (const row of rows) {
    const line = [
      row.hop ?? 0,
      row.from_wallet  || '',
      row.to_wallet    || '',
      row.amount_sol   != null ? row.amount_sol.toFixed(9) : '',
      row.is_fresh ? 'FRESH' : 'NON-FRESH',
      row.signature    || '',
      row.detected_at  || '',
    ]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(',');

    lines.push(line);
  }

  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  logger.info(`[CSV] Exporté: ${filePath} (${rows.length} lignes)`);

  return filePath;
}

module.exports = { generateCsv };
