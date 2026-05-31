/**
 * database.js
 * Initialisation et ORM léger pour SQLite via sql.js (pur JS, pas de native binding).
 * Compatible Debian, Termux, et tout environnement sans compilation native.
 *
 * Note: sql.js stocke la DB en mémoire et la persiste sur disque manuellement.
 * On sauvegarde après chaque écriture pour garantir la durabilité.
 */

'use strict';

const initSqlJs = require('sql.js');
const path      = require('path');
const fs        = require('fs');
const logger    = require('../utils/logger');

const DB_PATH = process.env.DB_PATH || './data/tracker.db';
fs.mkdirSync(path.dirname(path.resolve(DB_PATH)), { recursive: true });

let db = null; // Instance sql.js (synchrone après init)

/**
 * Persiste la DB sur disque (appelé après chaque écriture).
 */
function persistDB() {
  try {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  } catch (err) {
    logger.warn('[DB] persistDB erreur: ' + err.message);
  }
}

/**
 * Initialise la DB (async car sql.js charge le WASM).
 * À appeler une seule fois au boot, avant tout accès DB.
 */
async function initDB() {
  const SQL = await initSqlJs();

  // Charge la DB existante si elle existe
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
    logger.info(`[DB] Base chargée depuis: ${DB_PATH}`);
  } else {
    db = new SQL.Database();
    logger.info('[DB] Nouvelle base créée');
  }

  // Création des tables
  db.run(`
    CREATE TABLE IF NOT EXISTS strategies (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     TEXT    NOT NULL,
      type        TEXT    NOT NULL,
      label       TEXT,
      wallet      TEXT    NOT NULL,
      min_sol     REAL,
      max_sol     REAL,
      max_hops    INTEGER DEFAULT 5,
      fresh_only  INTEGER DEFAULT 0,
      active      INTEGER DEFAULT 1,
      created_at  TEXT    DEFAULT (datetime('now')),
      updated_at  TEXT    DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tracked_txs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      strategy_id INTEGER,
      signature   TEXT    NOT NULL UNIQUE,
      from_wallet TEXT    NOT NULL,
      to_wallet   TEXT    NOT NULL,
      amount_sol  REAL,
      hop         INTEGER DEFAULT 0,
      is_fresh    INTEGER DEFAULT 0,
      detected_at TEXT    DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_strategies_user   ON strategies(user_id);
    CREATE INDEX IF NOT EXISTS idx_strategies_wallet ON strategies(wallet);
    CREATE INDEX IF NOT EXISTS idx_txs_sig          ON tracked_txs(signature);
  `);

  persistDB();
  logger.info('[DB] Tables initialisées');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _all(sql, params = []) {
  try {
    const stmt   = db.prepare(sql);
    const rows   = [];
    stmt.bind(params);
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  } catch (err) {
    logger.warn('[DB] _all erreur: ' + err.message);
    return [];
  }
}

function _get(sql, params = []) {
  const rows = _all(sql, params);
  return rows[0] || null;
}

function _run(sql, params = []) {
  try {
    db.run(sql, params);
    persistDB();
  } catch (err) {
    logger.warn('[DB] _run erreur: ' + err.message);
  }
}

// ─── CRUD Stratégies ──────────────────────────────────────────────────────────

function addStrategy({ user_id, type, label, wallet, min_sol, max_sol, max_hops, fresh_only }) {
  _run(
    `INSERT INTO strategies (user_id, type, label, wallet, min_sol, max_sol, max_hops, fresh_only)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [user_id, type, label || '', wallet, min_sol ?? 0, max_sol ?? 9999, max_hops ?? 5, fresh_only ?? 0]
  );
  const row = _get('SELECT last_insert_rowid() as id');
  return row ? row.id : null;
}

function getStrategies(userId = null) {
  if (userId) {
    return _all('SELECT * FROM strategies WHERE user_id = ? ORDER BY id DESC', [String(userId)]);
  }
  return _all('SELECT * FROM strategies ORDER BY id DESC');
}

function getActiveStrategies() {
  return _all('SELECT * FROM strategies WHERE active = 1');
}

function getStrategyById(id) {
  return _get('SELECT * FROM strategies WHERE id = ?', [id]);
}

function toggleStrategy(id, active) {
  _run(
    `UPDATE strategies SET active = ?, updated_at = datetime('now') WHERE id = ?`,
    [active ? 1 : 0, id]
  );
}

function deleteStrategy(id) {
  _run('DELETE FROM strategies WHERE id = ?', [id]);
}

// ─── Transactions trackées ────────────────────────────────────────────────────

function logTrackedTx({ strategy_id, signature, from_wallet, to_wallet, amount_sol, hop, is_fresh }) {
  try {
    _run(
      `INSERT OR IGNORE INTO tracked_txs
        (strategy_id, signature, from_wallet, to_wallet, amount_sol, hop, is_fresh)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [strategy_id, signature, from_wallet, to_wallet, amount_sol, hop, is_fresh]
    );
  } catch (err) {
    logger.warn('[DB] logTrackedTx: ' + err.message);
  }
}

function isTxAlreadyTracked(signature) {
  const row = _get('SELECT id FROM tracked_txs WHERE signature = ?', [signature]);
  return !!row;
}

module.exports = {
  initDB,
  addStrategy,
  getStrategies,
  getActiveStrategies,
  getStrategyById,
  toggleStrategy,
  deleteStrategy,
  logTrackedTx,
  isTxAlreadyTracked,
};
