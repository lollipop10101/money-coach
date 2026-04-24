/**
 * position-sizing.mjs
 * Money Coach v2 — Kelly Criterion position sizing
 *
 * Two calling conventions:
 * 1. Old (Kelly): { netOdds, winRate, availableCapital, currentLtv, strategyLtv, poolData, walletPosition }
 * 2. New (Portfolio): { score, riskLevel, totalCapital, cashAvailable } with policy
 */

import { calcLiqBuffer, getHFTier } from './risk-engine.mjs';
import riskPolicy from '../config/risk-policy.json' with { type: 'json' };

/**
 * New calling convention — used by analysePortfolio
 */
export function suggestPositionSize({ score, riskLevel, totalCapital, cashAvailable }, policy) {
  const pol = policy || riskPolicy;

  if (!score || isNaN(score)) {
    return { action: 'WAIT', amountUsd: 0, reason: 'Invalid score' };
  }

  if (score < (pol.minScoreToDeploy || 70)) {
    return { action: 'WAIT', amountUsd: 0, reason: `Score ${score.toFixed(0)} below minimum ${pol.minScoreToDeploy}` };
  }

  let basePct = 0;
  if (riskLevel === 'LOW') basePct = 0.25;
  else if (riskLevel === 'MEDIUM') basePct = 0.15;
  else if (riskLevel === 'HIGH') basePct = 0.05;

  // Scale by score above threshold
  const scoreHeadroom = (score - (pol.minScoreToDeploy || 70)) / 30; // 0-1 scale above min
  const scaleFactor = 0.5 + scoreHeadroom * 0.5;
  const sizePct = basePct * scaleFactor;

  const amountUsd = Math.round(totalCapital * sizePct);

  const action = amountUsd >= 50 ? 'DEPLOY' : 'WAIT';
  return { action, amountUsd, sizePct: (sizePct * 100).toFixed(1) };
}

/**
 * Old calling convention — kept for backward compatibility
 */
export function suggestPositionSizeKelly({ netOdds, winRate, availableCapital, currentLtv, strategyLtv, poolData, walletPosition }) {
  // Kelly fraction: f = (b × p - q) / b
  const b = netOdds;
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