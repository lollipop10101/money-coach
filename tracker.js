/**
 * NAVI DeFi Yield Tracker v5 (Final)
 * Uses NAVI open API: open-api.naviprotocol.io/api/navi/pools
 * Real-time APY from incentive data.
 * 
 * Strategy: Positive spread = supply APY > borrow APY
 *           Cross-asset: Deposit A → Borrow B = earn net spread
 */

import axios from "axios";

const API_BASE = "https://open-api.naviprotocol.io/api/navi";
const WALLET = "0x0eb41ba9b08b07a45aef2459a3a192ff4de2f6ccc4a41bc85febc1a10e75a908";
const SDK_VERSION = "1.4.3";

function parseLTV(raw) { return Number(raw || 0) / 1e27; }

/** Fetch all pool data */
async function getAllPools() {
  const url = `${API_BASE}/pools?env=prod&sdk=${SDK_VERSION}&market=main`;
  const { data } = await axios.get(url, { timeout: 15000 });
  return data.data; // Array of pool objects
}

/** Parse pool into reserve */
function parsePool(pool) {
  // ── Organic vs incentivized decomposition ──────────────────────────────
  const totalSupplyApy     = parseFloat(pool.supplyIncentiveApyInfo?.apy || pool.supplyApy || 0);
  const boostedSupplyApr  = parseFloat(pool.supplyIncentiveApyInfo?.boostedApr || 0);
  const vaultSupplyApr    = parseFloat(pool.supplyIncentiveApyInfo?.vaultApr || 0);
  const voloSupplyApr     = parseFloat(pool.supplyIncentiveApyInfo?.voloApy || 0);
  const incentivizedSupplyApr = boostedSupplyApr + vaultSupplyApr + voloSupplyApr;
  const organicSupplyApy  = totalSupplyApy - incentivizedSupplyApr;

  const totalBorrowApy    = parseFloat(pool.borrowIncentiveApyInfo?.apy || pool.borrowApy || 0);
  const organicBorrowApy  = parseFloat(pool.borrowIncentiveApyInfo?.underlyingApy || pool.borrowApy || 0);

  // ── Legacy aliases (for backward compat) ──────────────────────────────
  const supplyApy = totalSupplyApy;
  const borrowApy = totalBorrowApy;
  const vaultApy  = vaultSupplyApr;
  const boostedApy = boostedSupplyApr;
  const borrowVaultApy  = parseFloat(pool.borrowIncentiveApyInfo?.vaultApr || 0);
  const borrowBoostedApy = parseFloat(pool.borrowIncentiveApyInfo?.boostedApr || 0);

  const netApy = totalSupplyApy - totalBorrowApy;
  const totalSupply = parseFloat(pool.totalSupply || 0) / 1e9;
  const totalBorrow = parseFloat(pool.totalBorrow || 0) / 1e9;
  const leftSupply = parseFloat(pool.leftSupply || 0) / 1e9;

  return {
    symbol: pool.token?.symbol || "???",
    name: pool.token?.name || "",
    supplyApy,           // Total supply APY (base + incentive) — legacy alias
    borrowApy,           // Total borrow APY — legacy alias
    vaultApy,            // Vault reward APR — legacy alias
    boostedApy,          // Incentive bonus APR — legacy alias
    borrowVaultApy,
    borrowBoostedApy,
    netApy,              // Supply - Borrow
    totalSupply,
    totalBorrow,
    leftSupply,
    ltv: parseLTV(pool.ltv),
    positive: supplyApy > borrowApy,
    // ── Phase 2: separated organic / incentivized ──────────────────────
    organicSupplyApy,
    incentivizedSupplyApr,
    boostedSupplyApr,
    vaultSupplyApr,
    voloSupplyApr,
    totalSupplyApy,
    organicBorrowApy,
    totalBorrowApy,
    organicSpread: organicSupplyApy - organicBorrowApy,
    grossSpread: totalSupplyApy - totalBorrowApy,
  };
}

/** Same-asset carry trades */
function findSameAssetCarries(pools) {
  return pools
    .filter((p) => p.symbol !== "???")
    .sort((a, b) => b.netApy - a.netApy);
}

/** Cross-asset carry: deposit collateral → borrow debt */
function findCrossAssetCarries(pools) {
  const results = [];
  for (const collateral of pools) {
    for (const debt of pools) {
      if (collateral.symbol === debt.symbol) continue;
      if (collateral.supplyApy === 0 || debt.borrowApy === 0) continue;

      const netApy = collateral.supplyApy - debt.borrowApy;
      const maxLTV = collateral.ltv; // Fraction user can borrow

      results.push({
        collateral: collateral.symbol,
        debt: debt.symbol,
        collateralApy: collateral.supplyApy,
        debtApy: debt.borrowApy,
        netApy,
        netApyBps: Math.round(netApy * 100),
        maxLTV,
        positive: netApy > 0,
      });
    }
  }
  return results.sort((a, b) => b.netApy - a.netApy);
}

/** Format Telegram alert */
function formatAlert(pools, same, cross) {
  const lines = [];

  lines.push("🔥 *NAVI YIELD SCAN*");
  lines.push(`_${new Date().toLocaleString()}_\n`);

  lines.push("📊 *Same-Asset Net APR*");
  lines.push("_(Supply APY - Borrow APY = Net)_\n");

  for (const p of same.slice(0, 6)) {
    const emoji = p.positive ? "✅" : "⚠️";
    const sign = p.positive ? "+" : "";
    const tvl = p.totalSupply > 1e6
      ? `$${(p.totalSupply / 1e6).toFixed(1)}M`
      : `$${(p.totalSupply / 1e3).toFixed(0)}K`;
    lines.push(
      `${emoji} ${p.symbol}: Supply ${p.supplyApy.toFixed(2)}% | Borrow ${p.borrowApy.toFixed(2)}% | Net ${sign}${p.netApy.toFixed(2)}% | TVL ${tvl}`
    );
  }

  lines.push("\n🔀 *Cross-Asset Carry*");
  lines.push("_(Deposit A, Borrow B — net APY spread)_\n");

  const topPos = cross.filter((c) => c.positive);
  if (topPos.length > 0) {
    for (const c of topPos.slice(0, 5)) {
      lines.push(
        `✅ ${c.collateral}(${c.collateralApy.toFixed(2)}%) → ${c.debt}(${c.debtApy.toFixed(2)}%) | Net +${c.netApy.toFixed(2)}%`
      );
    }
  } else {
    lines.push("_(No positive spread opportunities right now)_");
    for (const c of cross.slice(0, 3)) {
      const sign = c.positive ? "+" : "";
      lines.push(
        `⚠️ ${c.collateral}(${c.collateralApy.toFixed(2)}%) → ${c.debt}(${c.debtApy.toFixed(2)}%) | Net ${sign}${c.netApy.toFixed(2)}%`
      );
    }
  }

  lines.push("\n💡 *Top carry:* USDC supply + boosted → borrow USDSUI");
  lines.push("💡 *Tip:* Watch vault + boosted APY for real yield");

  lines.push(`\n👛 _${WALLET.slice(0, 8)}...${WALLET.slice(-4)}_`);
  return lines.join("\n");
}

/** Main scan */
async function runScan() {
  console.log("\n🔍 NAVI Yield Scan —", new Date().toISOString());

  let pools = [];
  try {
    const raw = await getAllPools();
    pools = raw.map(parsePool);
  } catch (e) {
    console.error("❌ API Error:", e.message);
    return;
  }

  const same = findSameAssetCarries(pools);
  const cross = findCrossAssetCarries(pools);

  console.log("\n📊 Same-Asset Net APR:");
  console.table(
    same.map((p) => ({
      Symbol: p.symbol,
      Supply: p.supplyApy.toFixed(2) + "%",
      Borrow: p.borrowApy.toFixed(2) + "%",
      Net: (p.positive ? "+" : "") + p.netApy.toFixed(2) + "%",
      TVL: p.totalSupply > 1e6 ? `$${(p.totalSupply / 1e6).toFixed(1)}M` : `$${(p.totalSupply / 1e3).toFixed(0)}K`,
    }))
  );

  console.log("\n🔀 Top Cross-Asset Carries:");
  const topPos = cross.filter((c) => c.positive);
  if (topPos.length > 0) {
    console.table(
      topPos.slice(0, 5).map((c) => ({
        "Coll → Debt": `${c.collateral} → ${c.debt}`,
        "Coll.APY": c.collateralApy.toFixed(2) + "%",
        "Debt.APY": c.debtApy.toFixed(2) + "%",
        "Net": `+${c.netApy.toFixed(2)}%`,
        "MaxLTV": `${(c.maxLTV * 100).toFixed(0)}%`,
      }))
    );
  } else {
    console.log("No positive spread opportunities");
  }

  const alert = formatAlert(pools, same, cross);
  console.log("\n" + alert);
}

runScan().catch(console.error);

// Poll every 3 minutes
setInterval(runScan, 180000);
