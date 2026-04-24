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

// Placeholder imports — actual implementations come from score-engine and risk-engine
// when analysePortfolio is called from alert.mjs
let _scoreStrategy = null;
let _assessRisk = null;

function scoreStrategy({ spread, organicSpread, incentiveApr, navxChange24h, depegBps, ltv, stabilityScore }) {
  if (_scoreStrategy) return _scoreStrategy({ spread, organicSpread, incentiveApr, navxChange24h, depegBps, ltv, stabilityScore });
  // Inline fallback: simple weighted score
  const base = spread * 10;
  const penalty = Math.max(0, ltv - 0.5) * 20;
  const navxPenalty = navxChange24h < -8 ? 10 : 0;
  const depegPenalty = Math.abs(depegBps) > 50 ? 5 : 0;
  return Math.max(0, Math.min(100, base - penalty - navxPenalty - depegPenalty + (stabilityScore || 0) / 10));
}

function assessRisk({ ltv, healthFactor, depegBps, navxChange24h }, policy) {
  if (_assessRisk) return _assessRisk({ ltv, healthFactor, depegBps, navxChange24h }, policy);
  // Inline fallback
  const warnings = [];
  let riskLevel = 'LOW';
  let blocked = false;

  if (ltv > (policy?.maxLtv || 0.6)) { riskLevel = 'HIGH'; }
  else if (ltv > 0.45) { riskLevel = 'MEDIUM'; }

  if (healthFactor && healthFactor < (policy?.minHealthFactor || 1.8)) {
    blocked = true;
    warnings.push(`HF ${healthFactor.toFixed(2)} below minimum`);
  }

  if (Math.abs(depegBps) > (policy?.depegBlockBps || 100)) {
    blocked = true;
    warnings.push(`Depeg ${depegBps.toFixed(0)}bps exceeds block threshold`);
  } else if (Math.abs(depegBps) > (policy?.depegWarningBps || 50)) {
    warnings.push(`Depeg ${depegBps.toFixed(0)}bps — monitor closely`);
  }

  if (navxChange24h < (policy?.navxDailyDropWarning || -8)) {
    warnings.push(`NAVX down ${navxChange24h.toFixed(1)}% — incentive value dropping`);
  }

  return { riskLevel, blocked, warnings };
}

function buildReason(strategy, score, risk) {
  // Friendly messaging for common block reasons
  if (risk.blocked) {
    const parts = [`Score ${score}/100`, `Spread ${strategy.spread.toFixed(2)}%`, `Risk ${risk.riskLevel}`];
    const depegBlock = risk.warnings.find(w => w.includes('Depeg'));
    if (depegBlock) {
      const bps = parseFloat(depegBlock.match(/[\d.]+/)?.[0] || 0);
      if (bps > 0) parts.push(`haSUI ${bps > 200 ? 'significant' : ''} premium`);
    }
    const hfBlock = risk.warnings.find(w => w.includes('HF'));
    if (hfBlock) parts.push(hfBlock);
    const navxBlock = risk.warnings.find(w => w.includes('NAVX'));
    if (navxBlock) parts.push('NAVX weak');
    return parts.join(' | ');
  }

  const parts = [
    `Score ${score}/100`,
    `Spread ${strategy.spread.toFixed(2)}%`,
    `Organic ${strategy.organicSpread?.toFixed(2) || '0.00'}%`,
    `Risk ${risk.riskLevel}`
  ];
  if (risk.warnings.length) parts.push(risk.warnings.join('; '));
  return parts.join(' | ');
}

/**
 * Analyse portfolio and generate per-strategy recommendations
 * @param {object} params
 * @param {object} params.portfolio - { cash: {USDC, SUI}, positions: [{name, amountUsd}] }
 * @param {object[]} params.strategies - Strategy definitions
 * @param {object} params.market - { depeg: {premium_bps}, navx: {change24h} }
 * @param {object} [params.policy] - Risk policy (defaults to risk-policy.json)
 */
export function analysePortfolio({ portfolio, strategies, market, policy }) {
  const pol = policy || riskPolicy;
  const totalPositionValue = (portfolio?.positions || []).reduce((s, p) => s + (p.amountUsd || 0), 0);
  const cashAvailable = Object.values(portfolio?.cash || {}).reduce((s, v) => s + (v || 0), 0);
  const totalCapital = totalPositionValue + cashAvailable;

  const depegBps = market?.depeg?.premium_bps || 0;
  const navxChange24h = market?.navx?.change24h || 0;

  const recommendations = (strategies || []).map((s) => {
    const score = scoreStrategy({
      spread: s.spread,
      organicSpread: s.organicSpread,
      incentiveApr: s.incentiveApr || 0,
      navxChange24h,
      depegBps,
      ltv: s.ltv,
      stabilityScore: s.stabilityScore || 50
    });

    const risk = assessRisk({
      ltv: s.ltv,
      healthFactor: s.healthFactor,
      depegBps,
      navxChange24h
    }, pol);

    const sizing = suggestPositionSize({
      score,
      riskLevel: risk.riskLevel,
      totalCapital,
      cashAvailable
    }, pol);

    return {
      strategy: s.name,
      score,
      riskLevel: risk.riskLevel,
      action: risk.blocked ? 'BLOCKED' : sizing.action,
      amountUsd: risk.blocked ? 0 : sizing.amountUsd,
      warnings: risk.warnings,
      reason: buildReason(s, score, risk)
    };
  });

  return recommendations.sort((a, b) => b.score - a.score);
}