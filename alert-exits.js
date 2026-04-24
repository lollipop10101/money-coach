/**
 * alert-exits.js
 * Exit and rebalance alert detection
 * Triggers: spread < threshold, borrow APY spike >2%/7d, haSUI depeg >0.5%, NAVX drop >10%/day
 */

import { get7dAvg } from './db.js';
import { getNAVXPrice, getLSTDepegStatus } from './price-service.js';

/**
 * Check exit/rebalance conditions for a given pool
 * @param {object} pool - pool data including { symbol, netSpread, borrowApy, supplyApy }
 * @param {object} thresholds - optional override thresholds
 * @returns {Array<{type, severity, message, action}>}
 */
export async function checkExitConditions(pool, thresholds = {}) {
  const {
    minSpread = 0.5,         // % — exit if spread below this
    borrowSpikePct = 2,      // % — exit if borrow rises by this much in 7 days
    depegThreshold = 0.5,    // % — exit if haSUI depeg beyond this
    navxDropThreshold = 10,  // % — exit if NAVX drops this much in 24h
  } = thresholds;

  const alerts = [];

  // 1. Spread compressed
  if (pool.netSpread !== undefined && pool.netSpread < minSpread) {
    alerts.push({
      type: 'SPREAD_COMPRESSED',
      severity: 'HIGH',
      message: `Spread dropped to ${pool.netSpread.toFixed(2)}% (threshold: ${minSpread}%) — consider exiting`,
      action: 'EXIT_OR_REBALANCE',
    });
  }

  // 2. Borrow APY spike (compare current to 7d average)
  const db7d = pool.symbol ? get7dAvg(pool.symbol) : null;
  if (db7d && db7d.avg_borrow && pool.borrowApy !== undefined) {
    const borrowChange = pool.borrowApy - db7d.avg_borrow;
    if (borrowChange * 100 > borrowSpikePct) {
      alerts.push({
        type: 'BORROW_SPIKE',
        severity: 'HIGH',
        message: `Borrow APY spiked +${(borrowChange * 100).toFixed(2)}% vs 7D avg (threshold: ${borrowSpikePct}%)`,
        action: 'REDUCE_POSITION',
      });
    }
  }

  // 3. haSUI depeg
  const lstStatus = await getLSTDepegStatus();
  if (lstStatus && lstStatus.ratio !== undefined) {
    const depeg = Math.abs(1 - lstStatus.ratio) * 100;
    if (depeg > depegThreshold) {
      alerts.push({
        type: 'LST_DEPEG',
        severity: 'HIGH',
        message: `haSUI depeg: ${depeg.toFixed(2)}% (threshold: ${depegThreshold}%)`,
        action: 'EXIT_HASUI_POSITION',
      });
    }
  }

  // 4. NAVX drop
  const navx = await getNAVXPrice();
  if (navx && navx.change24h !== undefined) {
    if (Math.abs(navx.change24h) > navxDropThreshold) {
      alerts.push({
        type: 'NAVX_DROP',
        severity: 'MEDIUM',
        message: `NAVX ${navx.change24h > 0 ? '+' : ''}${navx.change24h.toFixed(2)}% (24h) — reward reliability affected`,
        action: navx.change24h < 0 ? 'VERIFY_REWARDS' : 'HOLD',
      });
    }
  }

  return alerts;
}
