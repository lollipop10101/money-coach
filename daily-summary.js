/**
 * daily-summary.js
 * Money Coach v2 — Daily scheduled coach summary
 * Run: node daily-summary.js
 * Designed to run once daily via cron or setInterval
 */

import * as navi from './navi.mjs';
import { rankStrategies } from './score-engine.js';
import { getHFTier, getPortfolioAction, getWalletPosition, getPositionSize } from './risk-engine.js';
import { checkExitConditions } from './alert-exits.js';
import { get7dAvg } from './db.js';
import { getNAVXPrice, getLSTDepegStatus } from './price-service.js';
import { getStrategies } from './alert.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Compute 24h portfolio return by comparing current total supply value
 * against the 7-day average baseline stored in db.
 */
function calc24hReturn(currentValueUSD, poolSymbol = 'USDC') {
  const avg = get7dAvg(poolSymbol);
  if (!avg || !avg.avg_supply || avg.avg_supply === 0) return null;
  // Approximation: use organic supply apy as baseline yield rate
  const dailyYieldRate = avg.avg_supply / 365;
  const baselineValue = currentValueUSD / (1 + dailyYieldRate);
  const pnl = currentValueUSD - baselineValue;
  return (pnl / baselineValue) * 100;
}

/**
 * Build the daily summary string.
 */
export async function generateDailySummary() {
  const pools = await navi.getPoolData();
  const strategies = getStrategies();
  const walletAddress = process.env.WALLET_ADDRESS;
  const SUMMARY_TIME = process.env.SUMMARY_TIME || '09:00';

  // ── Wallet position ──────────────────────────────────────────────────────
  let wallet = null;
  let portfolioReturn = null;
  let hf = null;
  let hfTier = 'unknown';

  if (walletAddress) {
    wallet = await getWalletPosition(walletAddress).catch(() => null);
    if (wallet) {
      hf = wallet.overview?.hf ?? null;
      hfTier = getHFTier(hf);
      const totalSupply = wallet.overview?.totalSupplyValue ?? 0;
      if (totalSupply > 0) {
        portfolioReturn = calc24hReturn(totalSupply, 'USDC');
      }
    }
  }

  // ── Pool map for scoring (keyed by symbol for pool data) ─────────────────
  const poolMap = new Map(pools.map(p => [p.symbol, p]));

  // ── Build strategy pool map for rankStrategies (keyed by strategy name) ───
  const stratPoolMap = new Map(strategies.map(strat => {
    const collPool = poolMap.get(strat.coll);
    const debtPool = poolMap.get(strat.debt);
    return [strat.name, { ...collPool, debtPool }];
  }));

  // ── Market data for scoring ──────────────────────────────────────────────
  const navxData = await getNAVXPrice().catch(() => ({ price: null, change24h: null }));
  const depegData = await getLSTDepegStatus().catch(() => ({ ratio: 1 }));
  const marketData = {
    navxPrice: navxData?.price ?? null,
    navxChange24h: navxData?.change24h ?? null,
    navxPriceConfirmed: !!navxData?.price,
    hasuiSuiRatio: depegData?.ratio ?? 1,
  };

  // ── Top opportunity via rankStrategies ──────────────────────────────────
  const ranked = await rankStrategies(strategies, stratPoolMap, marketData);
  const best = ranked[0] ?? null;

  // ── Risk alerts — check top 3 strategies ──────────────────────────────────
  const alerts = [];
  for (const s of ranked.slice(0, 3)) {
    const pool = poolMap.get(s.coll);
    if (!pool) continue;
    const exits = await checkExitConditions({
      symbol: s.coll,
      netSpread: pool.netSpread ?? (pool.supplyApy - pool.borrowApy),
      borrowApy: pool.borrowApy,
    });
    for (const e of exits) {
      if (e.severity === 'HIGH') {
        alerts.push(`⚠️ ${e.type}: ${e.message}`);
      }
    }
  }

  // ── Action recommendation ────────────────────────────────────────────────
  let action = 'HOLD';
  let reason = 'No urgent alerts. Markets stable.';

  if (alerts.length > 0) {
    action = 'REDUCE';
    reason = alerts[0];
  } else if (best) {
    const pool = poolMap.get(best.coll);
    if (pool) {
      const sizing = getPositionSize(best.name, pool, wallet);
      if (sizing.riskTier === 'SAFE') {
        action = 'DEPLOY';
        reason = `${best.name} is a low-risk opportunity. Spread: ${best.spread ?? best.netSpread ?? 'n/a'}%, Score: ${best.score}/100`;
      }
    }
  } else if (wallet && hf !== null) {
    const action2 = getPortfolioAction(hf, wallet.overview?.totalBorrowValue / (wallet.overview?.totalSupplyValue || 1));
    action = action2.label;
    reason = action2.emoji + ' ' + action2.label;
  }

  // ── Format portfolio return line ──────────────────────────────────────────
  let portfolioLine;
  if (walletAddress && portfolioReturn !== null) {
    const sign = portfolioReturn >= 0 ? '+' : '';
    portfolioLine = `Portfolio: ${sign}${portfolioReturn.toFixed(2)}% (24h)`;
  } else if (walletAddress && !wallet) {
    portfolioLine = 'Portfolio: Unable to fetch wallet data';
  } else {
    portfolioLine = 'Portfolio: No wallet — configure WALLET_ADDRESS';
  }

  // ── Best opportunity line ────────────────────────────────────────────────
  let bestLine;
  if (best) {
    const spreadStr = best.spread ?? best.netSpread ?? 'n/a';
    bestLine = `Best opportunity: ${best.name} | Score: ${best.score}/100 | Spread: ${spreadStr}%`;
  } else {
    bestLine = 'Best opportunity: N/A';
  }

  // ── Next review ───────────────────────────────────────────────────────────
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const nextReview = `${tomorrow.toISOString().split('T')[0]} ${SUMMARY_TIME}`;

  // ── Compose output ────────────────────────────────────────────────────────
  const lines = [
    `📊 DAILY COACH SUMMARY — ${now.toISOString().split('T')[0]}`,
    '',
    portfolioLine,
    bestLine,
    '',
    'Risk alerts:',
    alerts.length > 0 ? alerts.map(a => `  ${a}`).join('\n') : '  None — all clear ✅',
    '',
    `Action today: ${action}`,
    `  ${reason}`,
    '',
    `Next review: tomorrow ${SUMMARY_TIME}`,
  ];

  return lines.join('\n');
}

// ── CLI run ──────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  generateDailySummary().then(report => {
    console.log(report);
    const logsDir = path.join(__dirname, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const filePath = path.join(logsDir, `summary_${new Date().toISOString().split('T')[0]}.txt`);
    fs.writeFileSync(filePath, report);
    console.log(`\nSaved to: ${filePath}`);
  }).catch(err => {
    console.error('Summary generation failed:', err.message);
    process.exit(1);
  });
}