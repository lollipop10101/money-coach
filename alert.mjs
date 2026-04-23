/**
 * NAVI Yield Alert System v3
 * - Checks every hour (or on big moves)
 * - Full APY scan every 12 hours to adjust tracking
 * - Monitors USDY→USDC and USDC→LBTC carry trades
 */

import axios from "axios";
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "fs";
import { getMarketPrediction } from './predictor.js';
import { getNAVXPrice, getLSTDepegStatus } from './price-service.js';

const API = "https://open-api.naviprotocol.io/api/navi/pools?env=prod&sdk=1.4.3&market=main";
const WALLET_FILE = "config/wallet.json";
const LOG_FILE = "logs/alerts.log";
const STATE_FILE = "logs/state.json";
const LAST_FULL_SCAN_FILE = "logs/last_full_scan.json";

// ─── Regime advice map ─────────────────────────────────────────────────────────
const REGIME_ADVICE = {
  BULL:     "Avoid SUI/LST borrows. Focus Stable-to-Stable carry.",
  BEAR:     "High efficiency. Borrowing haSUI subsidized by price. Scale to 2.5x.",
  SIDEWAYS: "Incentive harvest. Focus on highest NAVX/SUI reward pools. Tighten stops."
};

// Telegram
const TELEGRAM_BOT_TOKEN = "7203668783:AAFUUXWvMEExKeYGWgQOfCblesFn_it2S-k";
const TELEGRAM_CHAT_ID = "387074917";

// ─── Load state ────────────────────────────────────────────────────────────────
let state = { lastAlert: null, lastFullScan: null, previousRates: {} };
try {
  if (existsSync(STATE_FILE)) state = JSON.parse(readFileSync(STATE_FILE));
} catch (e) {}

// ─── Fetch pools ─────────────────────────────────────────────────────────────
async function getPools() {
  const { data } = await axios.get(API, { timeout: 15000 });
  return data.data.map((p) => ({
    symbol: p.token.symbol,
    // Legacy aliases
    supplyApy: parseFloat(p.supplyIncentiveApyInfo?.apy || p.supplyApy || 0),
    borrowApy: parseFloat(p.borrowIncentiveApyInfo?.apy || p.borrowApy || 0),
    ltv: parseFloat(p.ltv || 0) / 1e27,
    totalSupply: parseFloat(p.totalSupply || 0) / 1e9,
    // Phase 2: separated organic / incentivized
    organicSupplyApy: (() => {
      const total = parseFloat(p.supplyIncentiveApyInfo?.apy || p.supplyApy || 0);
      const boosted = parseFloat(p.supplyIncentiveApyInfo?.boostedApr || 0);
      const vault   = parseFloat(p.supplyIncentiveApyInfo?.vaultApr || 0);
      const volo    = parseFloat(p.supplyIncentiveApyInfo?.voloApy || 0);
      return total - boosted - vault - volo;
    })(),
    incentivizedSupplyApr: (() => {
      const boosted = parseFloat(p.supplyIncentiveApyInfo?.boostedApr || 0);
      const vault   = parseFloat(p.supplyIncentiveApyInfo?.vaultApr || 0);
      const volo    = parseFloat(p.supplyIncentiveApyInfo?.voloApy || 0);
      return boosted + vault + volo;
    })(),
    boostedSupplyApr: parseFloat(p.supplyIncentiveApyInfo?.boostedApr || 0),
    vaultSupplyApr: parseFloat(p.supplyIncentiveApyInfo?.vaultApr || 0),
    voloSupplyApr: parseFloat(p.supplyIncentiveApyInfo?.voloApy || 0),
    totalSupplyApy: parseFloat(p.supplyIncentiveApyInfo?.apy || p.supplyApy || 0),
    organicBorrowApy: parseFloat(p.borrowIncentiveApyInfo?.underlyingApy || p.borrowApy || 0),
    totalBorrowApy: parseFloat(p.borrowIncentiveApyInfo?.apy || p.borrowApy || 0),
    organicSpread: (() => {
      const total = parseFloat(p.supplyIncentiveApyInfo?.apy || p.supplyApy || 0);
      const boosted = parseFloat(p.supplyIncentiveApyInfo?.boostedApr || 0);
      const vault   = parseFloat(p.supplyIncentiveApyInfo?.vaultApr || 0);
      const volo    = parseFloat(p.supplyIncentiveApyInfo?.voloApy || 0);
      const organic = total - boosted - vault - volo;
      const organicBorrow = parseFloat(p.borrowIncentiveApyInfo?.underlyingApy || p.borrowApy || 0);
      return organic - organicBorrow;
    })(),
    grossSpread: (() => {
      const total  = parseFloat(p.supplyIncentiveApyInfo?.apy || p.supplyApy || 0);
      const totalB = parseFloat(p.borrowIncentiveApyInfo?.apy || p.borrowApy || 0);
      return total - totalB;
    })(),
  }));
}

// ─── Calculate carry return ─────────────────────────────────────────────────
// Carry trade model: deposit collateral C, borrow debt D.
// Collateral (USDC) earns supply APY, compounds at continuous rate over 30 days.
// Debt principal is FIXED in nominal terms (you owe exactly D haSUI/LBTC units).
// Dollar value of debt changes with price of the debt asset.
// Borrow cost accrues on the debt principal via continuous compounding.
// This correctly models NAVI's interest accrual (interest-on-interest avoided).
function calc30d(supplyApy, borrowApy, ltv, debtPriceChange = 0, lev = 1) {
  const days = 30;
  const t = days / 365;

  // Compound collateral (continuous compounding approximation)
  const collateralFinal = 100 * lev * Math.exp(supplyApy / 100 * t);

  // Fixed debt principal (you owe exactly this much in debt asset units)
  const debtPrincipal = 100 * lev * ltv;

  // Debt dollar value changes with price of debt asset
  const debtValue = debtPrincipal * (1 + debtPriceChange);

  // Borrow cost: continuous compounding on debt principal
  // cost = principal × (e^(rate × t) - 1)
  const borrowCost = debtPrincipal * (Math.exp(borrowApy / 100 * t) - 1);

  const net = collateralFinal - debtValue - borrowCost;
  return ((net / (100 * lev)) * 100).toFixed(1);
}

// ─── Find best carry pair ────────────────────────────────────────────────────
function findCarryPairs(pools) {
  const pairs = [];
  for (const c of pools) {
    for (const b of pools) {
      if (c.symbol !== b.symbol && c.supplyApy > 0 && b.borrowApy > 0) {
        const spread = c.supplyApy - b.borrowApy;
        if (spread > 0) {
          pairs.push({
            coll: c.symbol,
            debt: b.symbol,
            collApy: c.supplyApy,
            debtApy: b.borrowApy,
            spread,
            ltv: c.ltv,
            tvl: c.totalSupply,
          });
        }
      }
    }
  }
  return pairs.sort((a, b) => b.spread - a.spread);
}

// ─── Monitored strategies ───────────────────────────────────────────────────
const STRATEGIES = [
  { name: "USDY→USDC", coll: "USDY", debt: "USDC", lev: 1, debtPrice: 1 },
  { name: "USDC→LBTC", coll: "USDC", debt: "LBTC", lev: 2, debtPrice: 95000, debtAsset: true },
  { name: "USDC→haSUI", coll: "USDC", debt: "haSUI", lev: 2, debtPrice: 2.5, debtAsset: true },
  { name: "USDC→USDC", coll: "USDC", debt: "USDC", lev: 1, debtPrice: 1 },
];

// ─── Per-strategy liquidation buffer ────────────────────────────────────────
function calcLiqBuffer(ltv) {
  if (!ltv || ltv <= 0) return null;
  const bufferPct = (1 / ltv - 1) * 100;
  return {
    bufferPct: parseFloat(bufferPct.toFixed(1)),
    tierLabel: bufferPct > 50 ? '✅ SAFE' : bufferPct > 25 ? '⚠️ MODERATE' : '🔴 RISKY'
  };
}

// ─── Telegram ────────────────────────────────────────────────────────────────
async function sendAlert(message) {
  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      { chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: "Markdown", disable_notification: false },
      { timeout: 10000 }
    );
    return true;
  } catch (e) {
    console.error("Telegram error:", e.message);
    return false;
  }
}

function log(msg, type = "INFO") {
  const ts = new Date().toISOString();
  appendFileSync(LOG_FILE, `[${ts}] [${type}] ${msg}\n`);
}

// ─── Check for big moves (rate changed significantly) ────────────────────────
function detectBigMoves(newPools, previousRates) {
  const moves = [];
  for (const p of newPools) {
    const prev = previousRates[p.symbol];
    if (prev) {
      const supplyDelta = Math.abs(p.supplyApy - prev.supplyApy);
      const borrowDelta = Math.abs(p.borrowApy - prev.borrowApy);
      if (supplyDelta > 1.0 || borrowDelta > 1.0) {
        moves.push({
          symbol: p.symbol,
          supplyDelta: p.supplyApy - prev.supplyApy,
          borrowDelta: p.borrowApy - prev.borrowApy,
          newSupply: p.supplyApy,
          newBorrow: p.borrowApy,
        });
      }
    }
  }
  return moves.sort((a, b) => Math.abs(b.supplyDelta + b.borrowDelta) - Math.abs(a.supplyDelta + a.borrowDelta));
}

// ─── Save state ───────────────────────────────────────────────────────────────
function saveState(pools) {
  const rates = {};
  for (const p of pools) {
    rates[p.symbol] = { supplyApy: p.supplyApy, borrowApy: p.borrowApy };
  }
  state.previousRates = rates;
  state.lastAlert = new Date().toISOString();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ─── Main scan (hourly) ─────────────────────────────────────────────────────
async function hourlyScan(pools) {
  // ── Regime prediction ──────────────────────────────────────────────────
  let regime = 'SIDEWAYS';
  let regimeConfidence = 50;
  try {
    const pred = await getMarketPrediction();
    regime = pred.prediction;
    regimeConfidence = pred.confidence;
    console.log(`[REGIME] ${regime} (${regimeConfidence}% confidence)`);
  } catch (e) {
    console.error('[REGIME] Prediction failed:', e.message);
  }

  // Regime-aware strategy weights
  const regimeWeights = {
    BULL:     { 'USDC→LBTC': 2.0, 'USDC→haSUI': 1.5, 'USDY→USDC': 1.0, 'USDC→USDC': 0.5 },
    BEAR:     { 'USDY→USDC': 2.0, 'USDC→USDC': 1.5, 'USDC→haSUI': 1.0, 'USDC→LBTC': 0.3 },
    SIDEWAYS: { 'USDY→USDC': 1.5, 'USDC→USDC': 1.5, 'USDC→haSUI': 1.0, 'USDC→LBTC': 0.8 },
  };
  const weights = regimeWeights[regime] || regimeWeights.SIDEWAYS;

  const time = new Date().toLocaleString();
  const lines = [];

  lines.push(`🔍 *Hourly NAVI Scan* [${regime} ${regimeConfidence}%]`);
  lines.push(`_${time}_`);
  lines.push("");

  let foundOpportunity = false;

  // Sort strategies by regime weight (highest first)
  const sortedStrategies = [...STRATEGIES].sort((a, b) => (weights[b.name] || 1) - (weights[a.name] || 1));

  for (const strat of sortedStrategies) {
    const collPool = pools.find((p) => p.symbol === strat.coll);
    const debtPool = pools.find((p) => p.symbol === strat.debt);
    if (!collPool || !debtPool) continue;

    const bull = parseFloat(calc30d(collPool.supplyApy, debtPool.borrowApy, collPool.ltv, strat.debtAsset ? 0.30 : 0, strat.lev));
    const bear = parseFloat(calc30d(collPool.supplyApy, debtPool.borrowApy, collPool.ltv, strat.debtAsset ? -0.30 : 0, strat.lev));
    const side = parseFloat(calc30d(collPool.supplyApy, debtPool.borrowApy, collPool.ltv, strat.debtAsset ? 0.02 : 0, strat.lev));
    const spread = collPool.supplyApy - debtPool.borrowApy;

    // Emoji based on SPREAD (yield differential), not 30D return
    const emoji = spread > 2 ? "✅" : spread > 0 ? "⚠️" : "❌";
    const stratWeight = weights[strat.name] || 1;

    const netSpread = (collPool.supplyApy - debtPool.borrowApy).toFixed(1);
    const organicSpread = collPool.supplyApy - debtPool.borrowApy;
    const organicPct = organicSpread.toFixed(1);
    const incentiveApr = collPool.incentivizedSupplyApr || 0;
    lines.push(`${emoji} ${strat.name} (${strat.lev}x) w${stratWeight.toFixed(1)}`);
    lines.push(`   Net Spread: +${netSpread}% (Incentives included)`);
    lines.push(`   ├─ Organic: +${organicPct}%`);
    if (incentiveApr > 0) {
      lines.push(`   └─ Incentives: +${incentiveApr.toFixed(2)}% ⚠️`);
    } else {
      lines.push(`   └─ Incentives: none`);
    }
    lines.push(`   30D: 🐂 ${bull > 0 ? "+" : ""}${bull}% | 🐻 ${bear > 0 ? "+" : ""}${bear}% | 📊 ${side > 0 ? "+" : ""}${side}%`);

    // Liquidation buffer for leveraged strategies
    if (strat.lev > 1) {
      const buf = calcLiqBuffer(collPool.ltv);
      if (buf) {
        lines.push(`   ⚠️ LIQUIDATION BUFFER: +${buf.bufferPct}% (${buf.tierLabel})`);
      }
    }
    lines.push("");

    // Alert if spread > 2% OR if 30D return > 10% in any scenario, weighted by regime
    if ((spread > 2 && stratWeight >= 1.0) || Math.abs(bull) > 10 || Math.abs(bear) > 10) {
      foundOpportunity = true;
    }
  }

  // ── NAVX price + LST depeg ────────────────────────────────────────────
  const [navxData, depeg] = await Promise.all([
    getNAVXPrice().catch(() => ({ price: null, change24h: null })),
    getLSTDepegStatus().catch(() => ({ status: 'unknown', premium_bps: 0 })),
  ]);

  // ── LST Depeg Block (after strategies, before regime advice) ─────────────
  if (depeg.status !== 'par' && depeg.status !== 'unknown') {
    const ratio = depeg.ratio || 1;
    const bps = depeg.premium_bps || 0;
    const bpsPct = (bps / 100).toFixed(2);
    let statusLabel, entrySignal;
    if (depeg.status === 'discount') {
      statusLabel = `DISCOUNT -${bpsPct}%`;
      if (bps > 50) {
        entrySignal = "✅ BONUS ENTRY — haSUI depegged";
      }
    } else if (depeg.status === 'premium') {
      statusLabel = `PREMIUM +${bpsPct}%`;
      if (bps > 50) {
        entrySignal = "⚠️ AVOID LST entry — premium";
      }
    }
    if (statusLabel) {
      lines.push(`💎 haSUI/SUI Ratio: ${ratio.toFixed(4)} (${statusLabel})`);
      if (entrySignal) lines.push(`   ${entrySignal}`);
      lines.push("");
    }
  }

  // ── NAVX price inline ───────────────────────────────────────────────────
  const navxChangeStr = navxData.change24h != null
    ? `${navxData.change24h > 0 ? '+' : ''}${navxData.change24h.toFixed(1)}%`
    : 'n/a';
  const navxPriceWarning = navxData.price ? '' : ' ⚠️ Incentive yield unconfirmed';
  lines.push(`NAVX: $${(navxData.price || 0).toFixed(4)} (${navxChangeStr} 24h)${navxPriceWarning}`);

  // ── Regime advice (after NAVX price) ───────────────────────────────────
  const regimeAdvice = REGIME_ADVICE[regime] || REGIME_ADVICE.SIDEWAYS;
  lines.push(`💡 ${regimeAdvice}`);
  lines.push("");
  lines.push("💡 *Bot wallet:* `0x772ba512d...`");
  lines.push("_\"H\" = hold | \"D\" = deploy_");

  const msg = lines.join("\n");

  // Only send if there's a real opportunity
  if (foundOpportunity) {
    const sent = await sendAlert(msg);
    if (sent) log("Alert sent", "ALERT");
  } else {
    log("Scan complete - no opportunity", "SCAN");
  }

  console.log(msg.replace(/[*_`]/g, ""));
}

// ─── Full scan (every 12 hours) ───────────────────────────────────────────────
async function fullScan(pools) {
  const time = new Date().toLocaleString();
  const allPairs = findCarryPairs(pools);
  const top5 = allPairs.slice(0, 5);

  const lines = [];
  lines.push(`📊 *Full NAVI APY Scan*\n_${time}_`);
  lines.push(`_Scanning ${pools.length} pools_\n`);

  // ── B3: NEW OPPORTUNITIES — pools with spread > 2% not in watched list ───
  const monitoredPairs = new Set(STRATEGIES.map(s => `${s.coll}→${s.debt}`));
  const newOpportunities = allPairs
    .filter(p => p.spread > 2 && !monitoredPairs.has(`${p.coll}→${p.debt}`))
    .slice(0, 3);
  if (newOpportunities.length > 0) {
    lines.push("*🔍 NEW OPPORTUNITIES:*");
    for (const p of newOpportunities) {
      const bull = parseFloat(calc30d(p.collApy, p.debtApy, p.ltv, 0.30));
      const bear = parseFloat(calc30d(p.collApy, p.debtApy, p.ltv, -0.30));
      const side = parseFloat(calc30d(p.collApy, p.debtApy, p.ltv, 0.02));
      lines.push(`✅ ${p.coll} → ${p.debt}  Spread: +${p.spread.toFixed(1)}%`);
      lines.push(`   30D: 🐂 ${bull > 0 ? "+" : ""}${bull}% | 🐻 ${bear > 0 ? "+" : ""}${bear}% | 📊 ${side > 0 ? "+" : ""}${side}%`);
    }
    lines.push("");
  }

  lines.push("*🏆 Top 5 Carry Trades (by spread):*");

  for (const p of top5) {
    const bull = parseFloat(calc30d(p.collApy, p.debtApy, p.ltv, 0.30));
    const bear = parseFloat(calc30d(p.collApy, p.debtApy, p.ltv, -0.30));
    const side = parseFloat(calc30d(p.collApy, p.debtApy, p.ltv, 0.02));
    const tvl = p.tvl > 1e6 ? `$${(p.tvl / 1e6).toFixed(1)}M` : `$${(p.tvl / 1e3).toFixed(0)}K`;
    const emoji = p.spread > 2 ? "✅" : p.spread > 0 ? "⚠️" : "❌";
    lines.push(
      `\n${emoji} *${p.coll} → ${p.debt}*\n   Spread: +${p.spread.toFixed(1)}% | TVL: ${tvl}`
    );
    lines.push(`   30D: 🐂 ${bull > 0 ? "+" : ""}${bull}% | 🐻 ${bear > 0 ? "+" : ""}${bear}% | 📊 ${side > 0 ? "+" : ""}${side}%`);
  }

  // Check big moves
  const bigMoves = detectBigMoves(pools, state.previousRates || {});
  if (bigMoves.length > 0) {
    lines.push("\n*⚡ Big Rate Moves:*");
    for (const m of bigMoves.slice(0, 5)) {
      const supEmoji = m.supplyDelta > 0 ? "🟢" : "🔴";
      const borEmoji = m.borrowDelta > 0 ? "🟢" : "🔴";
      lines.push(
        `   ${m.symbol}: Supply ${supEmoji}${m.supplyDelta > 0 ? "+" : ""}${m.supplyDelta.toFixed(1)}% | Borrow ${borEmoji}${m.borrowDelta > 0 ? "+" : ""}${m.borrowDelta.toFixed(1)}%`
      );
    }
  }

  lines.push("\n💡 *Analysis:* Compare top pairs vs monitored strategies above");

  const msg = lines.join("\n");
  const sent = await sendAlert(msg);
  if (sent) log("Full scan sent", "FULL_SCAN");

  // Update last full scan time
  state.lastFullScan = new Date().toISOString();
  saveState(pools);

  console.log("Full scan complete - report sent");
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const now = new Date();
  const lastFullScan = state.lastFullScan ? new Date(state.lastFullScan) : null;
  const hoursSinceFullScan = lastFullScan ? (now - lastFullScan) / 36e5 : 999;

  console.log(`\n⏰ ${now.toISOString()}`);
  console.log(`   Last full scan: ${hoursSinceFullScan > 24 ? "NEVER" : hoursSinceFullScan.toFixed(1) + "h ago"}`);

  let pools;
  try {
    pools = await getPools();
  } catch (e) {
    console.error("API error:", e.message);
    return;
  }

  console.log(`📊 ${pools.length} pools loaded`);

  // Full scan every 12 hours
  if (hoursSinceFullScan >= 12) {
    console.log("📊 Running full APY scan...");
    await fullScan(pools);
  }

  // Hourly scan
  await hourlyScan(pools);

  // Always save state
  saveState(pools);
}

// ─── Boot ────────────────────────────────────────────────────────────────────
async function boot() {
  console.log("🚀 NAVI Alert v3 started");
  console.log("   Monitored: USDY→USDC, USDC→LBTC 2x, USDC→haSUI 2x");
  console.log("   Regime-aware weighting via predictor.js/Ollama");
  console.log("   Full scan: every 12 hours + auto-pair discovery");
  console.log("   Alert: only on spread > 2% or big moves\n");

  await main();

  // Poll every 1 hour
  setInterval(main, 60 * 60 * 1000);
}

boot().catch(console.error);
