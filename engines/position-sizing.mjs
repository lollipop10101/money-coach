/**
 * position-sizing.mjs
 * Money Coach v2 — Kelly Criterion position sizing
 * 
 * Formula (Kelly Criterion simplified):
 *   f = (b × p - q) / b
 *   where b = net odds, p = win probability, q = loss probability (1-p)
 * 
 * Adjusted for:
 *   - Available capital
 *   - Current portfolio LTV
 *   - Risk policy constraints
 */

import { calcLiqBuffer, getHFTier } from './risk-engine.mjs';
import riskPolicy from '../config/risk-policy.json' with { type: 'json' };

/**
 * Suggest position size for a strategy
 * @param {object} params
 * @param {number} params.netOdds - Net spread as decimal (e.g. 0.03 for 3%)
 * @param {number} params.winRate - Estimated win probability (0-1)
 * @param {number} params.availableCapital - Available capital in USD
 * @param {number} params.currentLtv - Current portfolio LTV (0-1)
 * @param {number} params.strategyLtv - Strategy LTV (0-1)
 * @param {object} [params.poolData] - Optional pool data for risk check
 * @param {object} [params.walletPosition] - Optional live wallet position
 * @returns {{ sizePct: number, sizeUSD: number, kellyFrac: number, recommendation: string }}
 */
export function suggestPositionSize({ netOdds, winRate, availableCapital, currentLtv, strategyLtv, poolData, walletPosition }) {
  // Kelly fraction: f = (b × p - q) / b
  const b = netOdds; // net odds = net spread
  const p = winRate;
  const q = 1 - p;
  const kellyFrac = Math.max(0, (b * p - q) / b);

  // Cap Kelly at 25% (1/2 Kelly for risk management)
  const kellyCapped = Math.min(kellyFrac, 0.25);

  // Adjust for available capital
  const capitalLimit = availableCapital * kellyCapped;

  // Adjust for current LTV headroom
  const maxLtv = riskPolicy.maxLtv;
  const ltvHeadroom = Math.max(0, maxLtv - currentLtv);
  const ltvAdjusted = Math.min(capitalLimit, availableCapital * ltvHeadroom * 0.8);

  // Hard block: never deploy if HF < minHealthFactor
  if (walletPosition && walletPosition.overview?.hf < riskPolicy.minHealthFactor) {
    return {
      sizePct: 0,
      sizeUSD: 0,
      kellyFrac: 0,
      recommendation: `BLOCKED — HF ${walletPosition.overview.hf.toFixed(2)} below ${riskPolicy.minHealthFactor} minimum`,
    };
  }

  // Size as % of available capital
  const sizePct = ltvAdjusted / availableCapital;
  const sizeUSD = ltvAdjusted;

  return {
    sizePct: (sizePct * 100).toFixed(1),
    sizeUSD: sizeUSD.toFixed(2),
    kellyFrac: kellyCapped.toFixed(3),
    recommendation: sizePct > 0.05
      ? `Deploy ~${(sizePct * 100).toFixed(0)}% of capital (Kelly ${(kellyCapped * 100).toFixed(1)}%)`
      : 'Position too small or insufficient LTV headroom',
  };
}
