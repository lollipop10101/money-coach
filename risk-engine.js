/**
 * risk-engine.js
 * Money Coach v2 — Wallet-aware risk analysis
 * 
 * Uses @naviprotocol/lending SDK to fetch real positions.
 * Run standalone: node risk-engine.js
 */

import { getLendingPositions, UserPositions, getHealthFactor } from '@naviprotocol/lending';

// ─── Risk Thresholds ────────────────────────────────────────────
const HARD_RULES = {
  MAX_LTV: 0.60,          // Never borrow above 60% LTV
  MIN_HEALTH_FACTOR: 1.8, // Never deploy if HF < 1.8
  MIN_HASUI_RATIO: 0.995, // Alert if haSUI/SUI ratio drops below
  MAX_BORROW_APY_SPIKE: 2.0, // % increase in 1h that triggers alert
};

// ─── Liquidation Buffer Tiers ──────────────────────────────────
const BUFFER_TIERS = [
  { threshold: 0.50, label: 'SAFE',    emoji: '✅' },
  { threshold: 0.25, label: 'MODERATE', emoji: '⚠️' },
  { threshold: 0,    label: 'RISKY',   emoji: '🔴' },
];

// ─── Action Recommendations ─────────────────────────────────────
const ACTIONS = {
  WAIT:   { label: 'WAIT',   emoji: '⏸️', color: '⚪' },
  DEPLOY: { label: 'DEPLOY', emoji: '🟢', color: '🟢' },
  REDUCE: { label: 'REDUCE', emoji: '🟡', color: '🟡' },
  EXIT:   { label: 'EXIT',   emoji: '🔴', color: '🔴' },
};

// ─── Core Functions ──────────────────────────────────────────────

/**
 * Calculate liquidation buffer: (1/LTV - 1) × 100
 * Higher buffer = safer position
 */
export function calcLiqBuffer(ltv) {
  if (!ltv || ltv <= 0) return null;
  return (1 / ltv - 1) * 100;
}

/**
 * Calculate liquidation price for a collateral asset
 * Price at which HF drops to 1.0
 */
export function calcLiqPrice(collateralValueUSD, debtValueUSD, ltv, currentPrice) {
  if (!collateralValueUSD || !debtValueUSD || !ltv) return null;
  const liqThreshold = 1 / ltv;
  return currentPrice * ((debtValueUSD / collateralValueUSD) * liqThreshold - (liqThreshold - 1));
}

/**
 * Get health factor tier
 */
export function getHFTier(hf) {
  if (hf === null || hf === undefined) return 'unknown';
  if (hf >= 2.0) return 'healthy';
  if (hf >= 1.5) return 'caution';
  if (hf >= 1.0) return 'warning';
  return 'danger';
}

/**
 * Calculate portfolio-level action recommendation
 */
export function getPortfolioAction(hf, currentLtv, maxLtv = HARD_RULES.MAX_LTV) {
  if (hf === null || hf === undefined) return ACTIONS.WAIT;
  if (hf < 1.0) return ACTIONS.EXIT;           // Liquidatable NOW
  if (hf < HARD_RULES.MIN_HEALTH_FACTOR) return ACTIONS.WAIT; // Too risky to deploy
  if (currentLtv > maxLtv) return ACTIONS.REDUCE; // Over-leveraged
  if (hf >= 2.5) return ACTIONS.DEPLOY;        // Healthy enough to deploy more
  return ACTIONS.WAIT;
}

/**
 * Get current wallet position from NAVI
 */
export async function getWalletPosition(walletAddress) {
  try {
    const positions = await getLendingPositions(walletAddress);
    if (!positions || positions.length === 0) return null;
    return new UserPositions(positions);
  } catch (e) {
    console.error('[risk-engine] Failed to fetch wallet position:', e.message);
    return null;
  }
}

/**
 * Check a strategy's liquidation risk
 */
export function checkStrategyRisk(collateralLTV, debtPrice, collateralPrice, leverage = 1) {
  const effectiveLTV = Math.min(collateralLTV * leverage, 0.95);
  const buffer = calcLiqBuffer(effectiveLTV);
  const tier = BUFFER_TIERS.find(t => buffer >= t.threshold);
  return {
    bufferPct: buffer?.toFixed(1) ?? null,
    tier: tier?.label ?? 'UNKNOWN',
    emoji: tier?.emoji ?? '⚪',
    effectiveLTV: (effectiveLTV * 100).toFixed(1),
  };
}

/**
 * getPositionSize — auto-calculate recommended deployment size
 * @param {string} strategyName
 * @param {object} pool - pool data
 * @param {object} walletPosition - optional live wallet position
 * @returns {{ sizePct: number, minPct: number, maxPct: number, maxDeploy: number, recommendation: string, riskTier: string }}
 */
export function getPositionSize(strategyName, pool, walletPosition = null) {
  const riskTier = checkStrategyRisk(pool.ltv, pool.debtPrice || 0, 1, pool.lev || 1);

  // Base sizing by risk tier
  const sizingByTier = {
    'SAFE':    { min: 20, max: 30, label: 'Low risk — deploy 20-30% of capital' },
    'MODERATE': { min: 10, max: 15, label: 'Medium risk — deploy 10-15% of capital' },
    'RISKY':   { min: 0,  max: 5,  label: 'High risk — deploy 0-5% of capital' },
  };

  // Hard block: never deploy if HF < 1.8
  if (walletPosition && walletPosition.overview?.hf < 1.8) {
    return {
      sizePct: 0,
      minPct: 0,
      maxPct: 0,
      maxDeploy: 0,
      recommendation: 'BLOCKED — Health Factor below 1.8 minimum',
      reason: `Current HF ${walletPosition.overview.hf.toFixed(2)} < 1.8 safety threshold`,
      riskTier: riskTier.tier,
    };
  }

  const tier = sizingByTier[riskTier.tier] || sizingByTier['RISKY'];

  return {
    sizePct: (tier.min + tier.max) / 2,
    minPct: tier.min,
    maxPct: tier.max,
    maxDeploy: 0, // caller calculates from capital
    recommendation: tier.label,
    riskTier: riskTier.tier,
  };
}

/**
 * Build risk summary for a strategy
 */
export async function buildRiskSummary(strategy, walletAddress) {
  const position = await getWalletPosition(walletAddress);
  const hfTier = position ? getHFTier(position.overview.hf) : 'no-position';
  const action = getPortfolioAction(position?.overview.hf, strategy.ltv);

  return {
    strategy: strategy.name,
    action,
    healthFactor: position?.overview.hf ?? null,
    hfTier,
    totalSupplyUSD: position?.overview.totalSupplyValue ?? 0,
    totalBorrowUSD: position?.overview.totalBorrowValue ?? 0,
    liqBuffer: calcLiqBuffer(strategy.ltv),
    riskTier: checkStrategyRisk(strategy.ltv, strategy.debtPrice, 1, strategy.lev),
  };
}

// ─── Standalone test ─────────────────────────────────────────────
async function runTests() {
  console.log('=== risk-engine.js standalone test ===\n');

  // Test calcLiqBuffer
  console.log('calcLiqBuffer:');
  console.log('  LTV 0.50 →', calcLiqBuffer(0.50), '% (expect 100)');
  console.log('  LTV 0.25 →', calcLiqBuffer(0.25), '% (expect 300)');
  console.log('  LTV 0.80 →', calcLiqBuffer(0.80), '% (expect 25)');
  console.log('  LTV null →', calcLiqBuffer(null));

  // Test getHFTier
  console.log('\ngetHFTier:');
  console.log('  HF 2.5  →', getHFTier(2.5), '(expect healthy)');
  console.log('  HF 1.8  →', getHFTier(1.8), '(expect caution)');
  console.log('  HF 1.2  →', getHFTier(1.2), '(expect warning)');
  console.log('  HF 0.9  →', getHFTier(0.9), '(expect danger)');

  // Test getPortfolioAction
  console.log('\ngetPortfolioAction:');
  console.log('  HF 2.5, LTV 0.50 →', getPortfolioAction(2.5, 0.50).label, '(expect DEPLOY)');
  console.log('  HF 1.9, LTV 0.50 →', getPortfolioAction(1.9, 0.50).label, '(expect WAIT)');
  console.log('  HF 2.5, LTV 0.70 →', getPortfolioAction(2.5, 0.70).label, '(expect REDUCE)');
  console.log('  HF 0.9, LTV 0.50 →', getPortfolioAction(0.9, 0.50).label, '(expect EXIT)');

  // Test checkStrategyRisk
  console.log('\ncheckStrategyRisk:');
  console.log('  LTV 0.50, lev 1 →', JSON.stringify(checkStrategyRisk(0.50, 1, 1, 1)));
  console.log('  LTV 0.25, lev 2 →', JSON.stringify(checkStrategyRisk(0.25, 1, 1, 2)));
  console.log('  LTV 0.80, lev 1 →', JSON.stringify(checkStrategyRisk(0.80, 1, 1, 1)));

  // Test calcLiqPrice
  console.log('\ncalcLiqPrice:');
  console.log('  collateral=5000, debt=2500, ltv=0.50, price=100 →',
    calcLiqPrice(5000, 2500, 0.50, 100));

  // Test getWalletPosition with mock address (will fail gracefully)
  console.log('\ngetWalletPosition (with mock address):');
  const pos = await getWalletPosition('0x000000000000000000000000000000000000dEaD');
  console.log('  Result:', pos === null ? 'null (expected — no real position)' : pos);

  console.log('\n✅ risk-engine.js tests complete');
}

runTests().catch(console.error);
