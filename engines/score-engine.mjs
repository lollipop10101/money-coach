/**
 * score-engine.mjs
 * Money Coach v2 — Multi-factor strategy scoring
 * 
 * Score = net_30d_yield
 *        - liquidation_risk_penalty
 *        - reward_token_risk
 *        - depeg_risk
 *        - volatility_risk
 *        - low_liquidity_penalty
 *        - gas_cost_penalty
 *        + stability_bonus
 * 
 * All components expressed in percentage points (%)
 */

import { getNAVXPrice } from '../price-service.js';

// ─── Component Weights (tunable) ───────────────────────────────
const WEIGHTS = {
  liquidation_risk_penalty: 3.0,  // Higher LTV = bigger score deduction
  reward_token_risk: 2.0,         // NAVX volatility penalty
  depeg_risk: 1.5,                // haSUI depeg risk
  volatility_risk: 1.0,           // Borrow asset volatility
  low_liquidity_penalty: 1.0,     // TVL penalty
  gas_cost_penalty: 0.5,          // Gas/slippage cost in %
  stability_bonus: 0.5,           // Consistent spread bonus
};

// ─── Liquidity TVL Thresholds (USD) ────────────────────────────
const TVL_TIERS = [
  { min: 10_000_000, penalty: 0 },     // >$10M = no penalty
  { min: 1_000_000,  penalty: 0.5 },   // $1M–$10M = small penalty
  { min: 100_000,    penalty: 1.5 },    // $100K–$1M = moderate
  { min: 0,          penalty: 3.0 },    // <$100K = high penalty
];

// ─── Core Scoring ────────────────────────────────────────────────

/**
 * Compute total strategy score
 * Returns { score, breakdown, warnings[] }
 */
export async function computeScore(strategy, poolData, marketData) {
  const breakdown = {};
  const warnings = [];

  // 1. Net 30D yield (base score)
  const net30d = parseFloat(strategy.net30dYield ?? 0);
  breakdown.net_30d_yield = net30d;

  // 2. Liquidation risk penalty
  const ltv = parseFloat(poolData?.ltv || 0);
  const lev = parseFloat(strategy.lev || 1);
  const effectiveLTV = Math.min(ltv * lev, 0.95);
  const liqPenalty = Math.max(0, (effectiveLTV - 0.50) * WEIGHTS.liquidation_risk_penalty * 100);
  breakdown.liquidation_risk_penalty = -liqPenalty;

  // 3. Reward token risk (NAVX volatility)
  let rewardTokenPenalty = 0;
  if (marketData?.navxPrice && marketData?.navxChange24h !== undefined) {
    const navxDrop = Math.abs(marketData.navxChange24h);
    if (navxDrop > 20) rewardTokenPenalty = WEIGHTS.reward_token_risk * 1.5;
    else if (navxDrop > 10) rewardTokenPenalty = WEIGHTS.reward_token_risk;
    else rewardTokenPenalty = WEIGHTS.reward_token_risk * 0.25;
    if (!marketData.navxPriceConfirmed) warnings.push('NAVX price unconfirmed — incentivized APY unreliable');
  } else {
    rewardTokenPenalty = WEIGHTS.reward_token_risk * 2;
    warnings.push('NAVX price unavailable — full incentive penalty applied');
  }
  breakdown.reward_token_risk = -rewardTokenPenalty;

  // 4. Depeg risk (haSUI/SUI ratio)
  let depegPenalty = 0;
  if (marketData?.hasuiSuiRatio !== undefined) {
    const ratio = marketData.hasuiSuiRatio;
    if (ratio < 0.98) depegPenalty = WEIGHTS.depeg_risk * 2;
    else if (ratio < 0.995) depegPenalty = WEIGHTS.depeg_risk;
    else depegPenalty = WEIGHTS.depeg_risk * 0.25;
    if (ratio < 0.99) warnings.push('haSUI/SUI ratio < 0.99 — bonus entry opportunity!');
  }
  breakdown.depeg_risk = -depegPenalty;

  // 5. Volatility risk (7D price volatility of debt asset)
  const debtVol = parseFloat(strategy.debtVolatility || 0); // Annualized %
  const volPenalty = Math.min(debtVol * WEIGHTS.volatility_risk * 0.05, WEIGHTS.volatility_risk * 2);
  breakdown.volatility_risk = -volPenalty;

  // 6. Low liquidity penalty (TVL-based)
  const tvl = parseFloat(poolData?.tvlUSD || 0);
  const tvlPenalty = TVL_TIERS.find(t => tvl >= t.min)?.penalty ?? WEIGHTS.low_liquidity_penalty;
  breakdown.low_liquidity_penalty = -tvlPenalty;

  // 7. Gas/slippage cost penalty (static per operation type)
  const gasPenalty = WEIGHTS.gas_cost_penalty;
  breakdown.gas_cost_penalty = -gasPenalty;

  // 8. Stability bonus (low spread volatility over 7D)
  const spreadStability = parseFloat(poolData?.spreadStd7d || 0);
  const stabilityBonus = Math.max(0, WEIGHTS.stability_bonus * (1 - spreadStability / 10));
  breakdown.stability_bonus = stabilityBonus;

  // Sum all components
  const score = net30d + liqPenalty + rewardTokenPenalty + depegPenalty + volPenalty + tvlPenalty + gasPenalty - stabilityBonus;

  return {
    score: score.toFixed(2),
    breakdown,
    warnings,
    components: {
      net30d,
      penalties: (liqPenalty + rewardTokenPenalty + depegPenalty + volPenalty + tvlPenalty + gasPenalty).toFixed(2),
      bonuses: stabilityBonus.toFixed(2),
    },
  };
}

/**
 * Rank strategies by score (descending)
 */
export async function rankStrategies(strategies, poolData, marketData) {
  const scored = await Promise.all(
    strategies.map(async (s) => {
      const result = await computeScore(s, poolData?.get(s.pool) || {}, marketData);
      return { ...s, score: result.score, scoreDetails: result };
    })
  );
  return scored.sort((a, b) => parseFloat(b.score) - parseFloat(a.score));
}

/**
 * Coach mode output: brief recommendation with reasoning
 */
export async function getCoachRecommendation(rankedStrategies, position, marketData) {
  if (!rankedStrategies || rankedStrategies.length === 0) {
    return { best: null, avoid: null };
  }

  const best = rankedStrategies[0];
  const avoid = rankedStrategies[rankedStrategies.length - 1];

  const bestName = best.name || best.pool || best.label;
  const bestOutput = `🟢 Best idea: ${bestName}
Risk: ${best.scoreDetails?.warnings?.length ? 'Medium' : 'Low'}
Expected 30D: ${best.net30dYield ?? 'N/A'}%
Reason: ${best.reason || 'Top score after risk adjustment'}`;

  const avoidName = avoid.name || avoid.pool || avoid.label;
  const avoidOutput = avoid.score < 0 ? `🔴 Avoid: ${avoidName}
Reason: ${avoid.scoreDetails?.warnings?.join(', ') || 'Negative score after penalties'}` : null;

  return { best: bestOutput, avoid: avoidOutput, all: rankedStrategies };
}

// ─── Standalone test ─────────────────────────────────────────────
async function runTests() {
  console.log('=== score-engine.mjs standalone test ===\n');

  // Mock data for testing
  const mockStrategies = [
    { name: 'Sui Max', net30dYield: '8.5', lev: 1, debtVolatility: 15 },
    { name: 'haSUI Leverage 2x', net30dYield: '12.0', lev: 2, debtVolatility: 8 },
    { name: 'Deep Water', net30dYield: '4.2', lev: 1, debtVolatility: 5 },
  ];

  const mockPoolData = new Map([
    ['Sui Max', { ltv: 0.50, tvlUSD: 15_000_000, spreadStd7d: 2 }],
    ['haSUI Leverage 2x', { ltv: 0.30, tvlUSD: 5_000_000, spreadStd7d: 4 }],
    ['Deep Water', { ltv: 0.60, tvlUSD: 800_000, spreadStd7d: 1 }],
  ]);

  const mockMarketData = {
    navxPrice: 4.2,
    navxChange24h: 5,
    navxPriceConfirmed: true,
    hasuiSuiRatio: 0.997,
  };

  // Test computeScore individually
  for (const strategy of mockStrategies) {
    const result = await computeScore(strategy, mockPoolData.get(strategy.name), mockMarketData);
    console.log(`Score for ${strategy.name}:`, result.score);
    console.log('  Breakdown:', JSON.stringify(result.breakdown, null, 2));
    if (result.warnings.length) console.log('  Warnings:', result.warnings);
    console.log();
  }

  // Test rankStrategies
  const ranked = await rankStrategies(mockStrategies, mockPoolData, mockMarketData);
  console.log('Ranked strategies:');
  ranked.forEach((s, i) => console.log(`  ${i + 1}. ${s.name} → score: ${s.score}`));

  // Test getCoachRecommendation
  console.log('\nCoach recommendation:');
  const coach = await getCoachRecommendation(ranked, null, mockMarketData);
  console.log(coach.best);
  if (coach.avoid) console.log(coach.avoid);

  console.log('\n✅ score-engine.mjs tests complete');
}

runTests().catch(console.error);
