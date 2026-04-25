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

function isLSTDebt(symbol) {
  return ["haSUI", "vSUI", "stSUI"].includes(symbol);
}

export function scoreStrategy({ spread, organicSpread, incentiveApr = 0, navxChange24h = null, navxAvailable = true, depegBps = 0, ltv = 0, stabilityScore = 50, debt }) {
  let rawScore = 50;
  rawScore += organicSpread * 6;
  rawScore += Math.min(incentiveApr, 5) * 1.5;
  rawScore += spread * 2;
  let riskPenalty = 0;
  if (!navxAvailable && incentiveApr > 0) riskPenalty += 20;
  if (navxChange24h !== null && navxChange24h < -8) riskPenalty += 15;
  // Only penalise depeg for LST debt strategies
  if (debt && isLSTDebt(debt)) {
    if (Math.abs(depegBps) > 50) riskPenalty += 15;
    if (Math.abs(depegBps) > 100) riskPenalty += 30;
  }
  if (ltv > 0.6) riskPenalty += 15;
  if (ltv > 0.7) riskPenalty += 30;
  rawScore += (stabilityScore - 50) * 0.25;
  const finalScore = rawScore - riskPenalty;
  return {
    rawScore: Math.max(0, Math.min(100, Math.round(rawScore))),
    riskPenalty,
    finalScore: Math.max(0, Math.min(100, Math.round(finalScore)))
  };
}


function assessRisk({ ltv, healthFactor, depegBps, navxChange24h, debt }, policy) {
  if (_assessRisk) return _assessRisk({ ltv, healthFactor, depegBps, navxChange24h, debt }, policy);
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

  // Only block on actual depeg (discount, ratio < 1). Premium is not a depeg — warn only.
  if (depegBps < -(policy?.depegBlockBps || 100)) {
    blocked = true;
    warnings.push(`Depeg ${Math.abs(depegBps).toFixed(0)}bps exceeds block threshold`);
  }

  // haSUI premium warning — only for LST debt strategies
  if (debt && isLSTDebt(debt) && depegBps > (policy?.depegWarningBps || 50)) {
    warnings.push(`haSUI premium ${depegBps.toFixed(0)}bps — avoid LST entry`);
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
    if (depegBlock && strategy.debt && isLSTDebt(strategy.debt)) {
      parts.push('haSUI depeg detected');
    }
    const premiumWarn = risk.warnings.find(w => w.includes('premium'));
    if (premiumWarn && strategy.debt && isLSTDebt(strategy.debt)) {
      parts.push('haSUI premium elevated');
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
  // Only show LST premium warning for LST debt strategies
  const filteredWarnings = risk.warnings.filter(w => {
    if (w.includes('premium') || w.includes('LST')) {
      return strategy.debt && isLSTDebt(strategy.debt);
    }
    return true;
  });
  if (filteredWarnings.length) parts.push(filteredWarnings.join('; '));
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
    const { finalScore, riskPenalty } = scoreStrategy({
      spread: s.spread,
      organicSpread: s.organicSpread,
      incentiveApr: s.incentiveApr || 0,
      navxChange24h,
      depegBps,
      ltv: s.ltv,
      stabilityScore: s.stabilityScore || 50,
      debt: s.debt
    });

    // For stable/stable strategies (same coll and debt), use lower LTV for risk
    // For directional strategies, use collateral LTV
    const isStableStable = s.debt === s.coll || ['USDC','USDY'].includes(s.coll);
    const effectiveLtv = isStableStable
      ? Math.min(s.ltv, s.debtLtv || s.ltv)
      : s.ltv;

    const risk = assessRisk({
      ltv: effectiveLtv,
      healthFactor: s.healthFactor,
      depegBps,
      navxChange24h,
      debt: s.debt
    }, pol);

    const sizing = suggestPositionSize({
      score: finalScore,
      riskLevel: risk.riskLevel,
      totalCapital,
      cashAvailable
    }, pol);

    return {
      strategy: s.name,
      score: finalScore,
      riskLevel: risk.riskLevel,
      action: risk.blocked ? 'BLOCKED' : sizing.action,
      amountUsd: risk.blocked ? 0 : sizing.amountUsd,
      warnings: risk.warnings,
      reason: buildReason(s, finalScore, risk)
    };
  });

  return recommendations.sort((a, b) => b.score - a.score);
}