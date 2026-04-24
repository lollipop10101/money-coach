/**
 * db.js
 * APY Stability Tracker — SQLite persistence for pool rate history
 * Tracks net_spread, supply_apy, borrow_apy per pool over 7 days
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'rates.db');

// Ensure data directory exists
mkdirSync(DATA_DIR, { recursive: true });

let _db = null;

export function getDb() {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.exec(`
      CREATE TABLE IF NOT EXISTS rates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        pool_symbol TEXT NOT NULL,
        supply_apy REAL,
        borrow_apy REAL,
        incentive_apy REAL,
        net_spread REAL,
        tvl_usd REAL
      );
      CREATE INDEX IF NOT EXISTS idx_pool_time ON rates(pool_symbol, timestamp);
    `);
  }
  return _db;
}

/**
 * Record current pool rates for all pools
 * @param {Array<{symbol, supplyApy, borrowApy, incentivizedSupplyApr, netSpread, tvlUsd}>} pools
 */
export function recordRates(pools) {
  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO rates (timestamp, pool_symbol, supply_apy, borrow_apy, incentive_apy, net_spread, tvl_usd)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    const now = Math.floor(Date.now() / 1000);
    for (const p of pools) {
      // Only record if we have a symbol and at least one rate
      if (p.symbol && (p.supplyApy !== undefined || p.borrowApy !== undefined)) {
        insert.run(
          now,
          p.symbol,
          p.supplyApy ?? null,
          p.borrowApy ?? null,
          p.incentivizedSupplyApr ?? p.incentiveApy ?? null,
          p.netSpread ?? null,
          p.tvlUsd ?? p.totalSupply ?? null
        );
      }
    }
  });
  tx();
}

/**
 * Get 7-day average rates for a pool symbol
 * @param {string} symbol
 * @returns {{ avg_net: number|null, avg_supply: number|null, avg_borrow: number|null }}
 */
export function get7dAvg(symbol) {
  const db = getDb();
  const cutoff = Math.floor(Date.now() / 1000) - 7 * 86400;
  const row = db.prepare(`
    SELECT
      AVG(net_spread)  as avg_net,
      AVG(supply_apy)  as avg_supply,
      AVG(borrow_apy)  as avg_borrow
    FROM rates
    WHERE pool_symbol = ? AND timestamp > ?
  `).get(symbol, cutoff);
  return row;
}
