/**
 * portfolio-engine.mjs
 * Money Coach v2 — Portfolio-level analysis
 * 
 * Provides holistic portfolio view: aggregate LTV, risk attribution,
 * rebalancing recommendations, and NAVX exposure check.
 */

import riskPolicy from '../config/risk-policy.json' with { type: 'json' };
import { getHFTier, getPortfolioAction, calcLiqBuffer } from './risk-engine.mjs';
import { suggestPositionSize } from './position-sizing.mjs';

/**
 * Analyse portfolio health and generate rebalancing recommendations
 * @param {object} walletPosition - UserPositions object from @naviprotocol/lending
 * @param {object[]} activeStrategies - Array of strategy positions
 * @param {number} totalCapitalUSD - Total available capital in USD
 * @returns {object} Portfolio analysis
 */
export function analysePortfolio(walletPosition, activeStrategies, totalCapitalUSD) {
  const hf = walletPosition?.overview?.hf ?? null;
  const hfTier = getHFTier(hf);
  const currentLtv = walletPosition ? (walletPosition.overview.totalBorrowValue / walletPosition.overview.totalSupplyValue) : 0;

  // Risk attribution: which strategies contribute most to risk
  const strategyRisks = (activeStrategies || []).map(s => ({
    name: s.name,
    ltv: s.ltv,
    liqBuffer: calcLiqBuffer(s.ltv),
    weight: s.deployedUSD / totalCapitalUSD,
    riskContrib: (s.deployedUSD / totalCapitalUSD) * s.ltv,
  }));

  // NAVX exposure check
  const navxExposure = strategyRisks
    .filter(s => s.name.includes('NAVX') || s.name.includes('haSUI'))
    .reduce((sum, s) => sum + s.weight, 0);

  // Rebalancing: any strategy exceeding maxSingleStrategyWeight
  const rebalanceNeeded = strategyRisks
    .filter(s => s.weight > riskPolicy.maxSingleStrategyWeight)
    .map(s => ({
      name: s.name,
      currentWeight: (s.weight * 100).toFixed(1),
      maxWeight: (riskPolicy.maxSingleStrategyWeight * 100).toFixed(1),
      action: 'REDUCE',
    }));

  // Depeg warning
  const depegWarning = activeStrategies?.some(s => s.hasuiSuiRatio < riskPolicy.depegWarningBps / 10000);

  // Cash buffer check
  const cashBalance = (totalCapitalUSD - (walletPosition?.overview?.totalSupplyValue || 0));
  const cashBufferRatio = cashBalance / totalCapitalUSD;
  const lowCashBuffer = cashBufferRatio < riskPolicy.minCashBuffer;

  // Portfolio action
  const action = getPortfolioAction(hf, currentLtv, riskPolicy.maxLtv);

  return {
    healthFactor: hf,
    hfTier,
    currentLtv: (currentLtv * 100).toFixed(1),
    totalCapitalUSD,
    deployedUSD: walletPosition?.overview?.totalSupplyValue || 0,
    borrowedUSD: walletPosition?.overview?.totalBorrowValue || 0,
    cashBufferUSD: cashBalance.toFixed(2),
    cashBufferPct: (cashBufferRatio * 100).toFixed(1),
    navxExposurePct: (navxExposure * 100).toFixed(1),
    strategyRisks,
    rebalanceNeeded,
    depegWarning,
    lowCashBuffer,
    action,
    warnings: [
      ...(hfTier === 'danger' ? ['⚠️ HEALTH FACTOR CRITICAL — reduce exposure immediately'] : []),
      ...(lowCashBuffer ? [`⚠️ Cash buffer ${(cashBufferRatio * 100).toFixed(1)}% below ${(riskPolicy.minCashBuffer * 100).toFixed(0)}% minimum`] : []),
      ...(navxExposure > 0.5 ? [`⚠️ NAVX/haSUI exposure ${(navxExposure * 100).toFixed(0)}% — monitor depeg risk`] : []),
      ...(rebalanceNeeded.length ? [`⚠️ Rebalancing needed: ${rebalanceNeeded.map(r => r.name).join(', ')}`] : []),
    ],
  };
}
