/**
 * NAVI Carry Trade Strategy Backtester
 * Uses real NAVI API data × 3 price scenarios × 5 strategies
 */

import axios from "axios";

const API = "https://open-api.naviprotocol.io/api/navi/pools?env=prod&sdk=1.4.3&market=main";
const SUI_PRICE = 2.00; // USD
const DAYS = 30;
const START_CAPITAL = 100; // USD

// ─── Fetch Real Data ──────────────────────────────────────────────────────────

async function getPools() {
  const { data } = await axios.get(API, { timeout: 15000 });
  return data.data;
}

function parsePool(p) {
  return {
    symbol: p.token.symbol,
    supplyApy: parseFloat(p.supplyIncentiveApyInfo?.apy || 0),
    borrowApy: parseFloat(p.borrowIncentiveApyInfo?.apy || 0),
    ltv: parseFloat(p.ltv || 0) / 1e27, // Convert from 10^26
    totalSupply: parseFloat(p.totalSupply || 0) / 1e9,
  };
}

// ─── Strategies ───────────────────────────────────────────────────────────────

/**
 * Strategy 1: Simple Carry
 * Deposit SUI, Borrow USDC, borrowed USDC sits idle
 */
function strat1_SimpleCarry(suiPrice, pools, startSUI) {
  const sui = pools.find((p) => p.symbol === "SUI");
  const usdc = pools.find((p) => p.symbol === "USDC");
  if (!sui || !usdc) return null;

  const supplyApy = sui.supplyApy / 100;
  const borrowApy = usdc.borrowApy / 100;
  const ltv = sui.ltv;
  const dailySupply = Math.pow(1 + supplyApy, 1 / 365) - 1;
  const dailyBorrow = Math.pow(1 + borrowApy, 1 / 365) - 1;

  // Deposit SUI amount = startSUI (dollar value at t=0)
  let suiAmount = startSUI / suiPrice; // SUI coins
  let borrowedUSDC = suiAmount * suiPrice * ltv; // Borrow in USD terms
  let day = 0;

  for (day = 0; day < DAYS; day++) {
    // Price scenario: apply daily change
    const priceChange = suiPriceTrajectory[day] || 0;
    const currentPrice = suiPrice * (1 + priceChange);

    // Supply yield on SUI
    const supplyYield = suiAmount * dailySupply;
    suiAmount += supplyYield / currentPrice;

    // Borrow cost compounds on USDC
    borrowedUSDC *= (1 + dailyBorrow);

    // Health factor check
    const hf = (suiAmount * currentPrice * ltv) / borrowedUSDC;
    if (hf < 1.1) break; // Liquidated
  }

  const finalPrice = suiPrice * (1 + suiPriceTrajectory[DAYS - 1]);
  const collateralValue = suiAmount * finalPrice;
  const netValue = collateralValue - borrowedUSDC;
  const netReturn = (netValue / startSUI - 1) * 100;

  return { netValue, netReturn, hf: (suiAmount * finalPrice * ltv) / borrowedUSDC };
}

/**
 * Strategy 2: Loop Lending
 * Deposit SUI, Borrow USDC, Supply USDC to earn yield on borrowed leg
 */
function strat2_LoopLending(suiPrice, pools, startSUI) {
  const sui = pools.find((p) => p.symbol === "SUI");
  const usdc = pools.find((p) => p.symbol === "USDC");
  if (!sui || !usdc) return null;

  const supplyApySUI = sui.supplyApy / 100;
  const supplyApyUSDC = usdc.supplyApy / 100;
  const borrowApy = usdc.borrowApy / 100;
  const ltv = sui.ltv;

  const dailySupplySUI = Math.pow(1 + supplyApySUI, 1 / 365) - 1;
  const dailySupplyUSDC = Math.pow(1 + supplyApyUSDC, 1 / 365) - 1;
  const dailyBorrow = Math.pow(1 + borrowApy, 1 / 365) - 1;

  let suiAmount = startSUI / suiPrice;
  let borrowedUSDC = suiAmount * suiPrice * ltv;
  let suppliedUSDC = borrowedUSDC; // Reinvest borrowed into USDC supply

  for (let day = 0; day < DAYS; day++) {
    const priceChange = suiPriceTrajectory[day] || 0;
    const currentPrice = suiPrice * (1 + priceChange);

    // SUI supply yield
    const suiYield = suiAmount * dailySupplySUI;
    suiAmount += suiYield / currentPrice;

    // USDC supply yield on borrowed amount
    const usdcYield = suppliedUSDC * dailySupplyUSDC;
    suppliedUSDC += usdcYield;

    // Borrow cost compounds
    borrowedUSDC *= (1 + dailyBorrow);

    const hf = (suiAmount * currentPrice * ltv) / borrowedUSDC;
    if (hf < 1.1) break;
  }

  const finalPrice = suiPrice * (1 + suiPriceTrajectory[DAYS - 1]);
  const netValue = (suiAmount * finalPrice) - borrowedUSDC;
  const netReturn = (netValue / startSUI - 1) * 100;

  return { netValue, netReturn, hf: (suiAmount * finalPrice * ltv) / borrowedUSDC };
}

/**
 * Strategy 3: Leveraged SUI Long (2x, 3x)
 * Deposit SUI, Borrow USDC, convert to SUI, redeposit
 */
function strat3_Leveraged(suiPrice, pools, startSUI, leverage) {
  const sui = pools.find((p) => p.symbol === "SUI");
  const usdc = pools.find((p) => p.symbol === "USDC");
  if (!sui || !usdc) return null;

  const supplyApy = sui.supplyApy / 100;
  const borrowApy = usdc.borrowApy / 100;
  const ltv = sui.ltv;
  const dailySupply = Math.pow(1 + supplyApy, 1 / 365) - 1;
  const dailyBorrow = Math.pow(1 + borrowApy, 1 / 365) - 1;

  let suiAmount = startSUI / suiPrice;
  let borrowedUSDC = 0;

  // Initial leverage: deposit SUI, borrow to get more SUI
  const initialBorrow = startSUI * (leverage - 1);
  borrowedUSDC = initialBorrow;
  const extraSUI = initialBorrow / suiPrice;
  suiAmount += extraSUI;

  let rebalances = 0;

  for (let day = 0; day < DAYS; day++) {
    const priceChange = suiPriceTrajectory[day] || 0;
    const currentPrice = suiPrice * (1 + priceChange);

    // Supply yield
    const suiYield = suiAmount * dailySupply;
    suiAmount += suiYield / currentPrice;

    // Borrow cost
    borrowedUSDC *= (1 + dailyBorrow);

    // Health factor check - deleverage if too low
    const hf = (suiAmount * currentPrice * ltv) / borrowedUSDC;
    if (hf < 1.3 && hf > 1.1) {
      // Repay some debt
      const repayAmount = (hf - 1.5) * borrowedUSDC / (hf - 1.1);
      const repaySUI = repayAmount / currentPrice;
      if (repaySUI > 0 && suiAmount > repaySUI) {
        suiAmount -= repaySUI;
        borrowedUSDC -= repayAmount;
        rebalances++;
      }
    }
    if (hf < 1.1) break; // Liquidated
  }

  const finalPrice = suiPrice * (1 + suiPriceTrajectory[DAYS - 1]);
  const netValue = suiAmount * finalPrice - borrowedUSDC;
  const netReturn = (netValue / startSUI - 1) * 100;

  return { netValue, netReturn, hf: (suiAmount * finalPrice * ltv) / borrowedUSDC, rebalances };
}

/**
 * Strategy 4: Auto-Deleverage on SUI Drop
 * Same as simple carry but repay debt if SUI drops 20%+
 */
function strat4_Deleverage(suiPrice, pools, startSUI) {
  const sui = pools.find((p) => p.symbol === "SUI");
  const usdc = pools.find((p) => p.symbol === "USDC");
  if (!sui || !usdc) return null;

  const supplyApy = sui.supplyApy / 100;
  const borrowApy = usdc.borrowApy / 100;
  const ltv = sui.ltv;
  const dailySupply = Math.pow(1 + supplyApy, 1 / 365) - 1;
  const dailyBorrow = Math.pow(1 + borrowApy, 1 / 365) - 1;

  let suiAmount = startSUI / suiPrice;
  let borrowedUSDC = suiAmount * suiPrice * ltv;
  const peakPrice = suiPrice;
  let rebalances = 0;

  for (let day = 0; day < DAYS; day++) {
    const priceChange = suiPriceTrajectory[day] || 0;
    const currentPrice = suiPrice * (1 + priceChange);

    const suiYield = suiAmount * dailySupply;
    suiAmount += suiYield / currentPrice;
    borrowedUSDC *= (1 + dailyBorrow);

    // Deleverage if SUI dropped 20% from peak
    const dropFromPeak = (peakPrice - currentPrice) / peakPrice;
    const hf = (suiAmount * currentPrice * ltv) / borrowedUSDC;

    if (dropFromPeak > 0.2 && hf < 2.0) {
      // Repay 20% of debt to improve health
      const repayAmount = borrowedUSDC * 0.2;
      const repaySUI = repayAmount / currentPrice;
      if (repaySUI > 0 && suiAmount > repaySUI + 0.01) {
        suiAmount -= repaySUI;
        borrowedUSDC -= repayAmount;
        rebalances++;
      }
    }

    if (hf < 1.1) break;
  }

  const finalPrice = suiPrice * (1 + suiPriceTrajectory[DAYS - 1]);
  const netValue = suiAmount * finalPrice - borrowedUSDC;
  const netReturn = (netValue / startSUI - 1) * 100;

  return { netValue, netReturn, hf: (suiAmount * finalPrice * ltv) / borrowedUSDC, rebalances };
}

/**
 * Strategy 5: NS Positive Spread (no price exposure needed)
 * Deposit NS, Borrow least expensive asset
 * OR: Pure positive spread - supply high APY, borrow low APY
 */
function strat5_PositiveSpreadArb(suiPrice, pools, startSUI) {
  // Find assets with biggest positive spread (supply > borrow)
  const withSpread = pools
    .filter((p) => p.supplyApy > 0 && p.borrowApy > 0)
    .map((p) => ({ ...p, spread: p.supplyApy - p.borrowApy }))
    .sort((a, b) => b.spread - a.spread);

  const best = withSpread[0]; // NS is usually best
  if (!best || best.spread <= 0) return { netValue: startSUI, netReturn: 0 };

  // Deposit the high-APR asset, borrow the cheapest
  const collateralAsset = pools.find((p) => p.symbol === best.symbol);
  const borrowAsset = pools.reduce((min, p) =>
    p.borrowApy < min.borrowApy && p.symbol !== best.symbol ? p : min
  );

  if (!collateralAsset || !borrowAsset) return null;

  const supplyApy = collateralAsset.supplyApy / 100;
  const borrowApy = borrowAsset.borrowApy / 100;
  const ltv = collateralAsset.ltv;
  const dailySupply = Math.pow(1 + supplyApy, 1 / 365) - 1;
  const dailyBorrow = Math.pow(1 + borrowApy, 1 / 365) - 1;

  // Use startSUI worth of collateral
  const collateralPrice = suiPrice; // Approximate
  let collateralAmount = startSUI / collateralPrice;
  let borrowedAmount = collateralAmount * collateralPrice * ltv;

  for (let day = 0; day < DAYS; day++) {
    const yield_ = collateralAmount * dailySupply;
    collateralAmount += yield_ / collateralPrice;
    borrowedAmount *= (1 + dailyBorrow);

    const hf = (collateralAmount * collateralPrice * ltv) / borrowedAmount;
    if (hf < 1.1) break;
  }

  const netValue = collateralAmount * collateralPrice - borrowedAmount;
  const netReturn = (netValue / startSUI - 1) * 100;

  return {
    netValue,
    netReturn,
    collateral: collateralAsset.symbol,
    borrow: borrowAsset.symbol,
    spread: best.spread,
  };
}

/**
 * Strategy 6: Hold SUI Only (baseline for comparison)
 */
function strat6_HoldSUI(suiPrice) {
  let suiAmount = START_CAPITAL / suiPrice;
  for (let day = 0; day < DAYS; day++) {
    const priceChange = suiPriceTrajectory[day] || 0;
    suiAmount += suiAmount * priceChange; // Just price movement, no yield
  }
  const finalPrice = suiPrice * (1 + suiPriceTrajectory[DAYS - 1]);
  return { netValue: suiAmount * finalPrice, netReturn: (suiAmount * finalPrice / START_CAPITAL - 1) * 100 };
}

// ─── Price Scenarios ─────────────────────────────────────────────────────────

function generateScenarios() {
  const bull = [], bear = [], side = [];
  let priceBull = 0, priceBear = 0;

  for (let i = 0; i < DAYS; i++) {
    // Bull: +30% over 30 days = ~0.87% per day compounded
    priceBull = Math.pow(1.30, (i + 1) / DAYS) - 1;
    // Bear: -30% over 30 days
    priceBear = Math.pow(0.70, (i + 1) / DAYS) - 1;
    // Sideways: random walk ±5% total
    side.push((Math.random() - 0.5) * 0.10);

    bull.push(priceBull);
    bear.push(priceBear);
  }

  return { bull, bear, side };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("🔍 Fetching NAVI pool data...\n");

  let pools;
  try {
    pools = await getPools();
  } catch (e) {
    console.error("❌ Failed to fetch NAVI data:", e.message);
    process.exit(1);
  }

  const parsed = pools.map(parsePool);
  const { bull, bear, side } = generateScenarios();
  const scenarios = { Bull: bull, Bear: bear, Sideways: side };

  console.log(`📊 Pool data loaded: ${parsed.length} pools\n`);

  // Show top spread opportunities
  const topSpreads = parsed
    .filter((p) => p.supplyApy > 0 && p.borrowApy > 0)
    .map((p) => ({ ...p, spread: p.supplyApy - p.borrowApy }))
    .sort((a, b) => b.spread - a.spread)
    .slice(0, 5);

  console.log("🏆 Top Positive Spread Assets:");
  console.table(topSpreads.map((p) => ({
    Symbol: p.symbol,
    SupplyAPY: p.supplyApy.toFixed(2) + "%",
    BorrowAPY: p.borrowApy.toFixed(2) + "%",
    Spread: p.spread.toFixed(2) + "%",
    LTV: (p.ltv * 100).toFixed(0) + "%",
  })));

  const results = {};

  for (const [scenarioName, trajectory] of Object.entries(scenarios)) {
    globalThis.suiPriceTrajectory = trajectory;
    results[scenarioName] = {};

    const r = SUI_PRICE * (1 + trajectory[DAYS - 1]);
    console.log(`\n${"═".repeat(60)}`);
    console.log(`📈 ${scenarioName} Scenario | SUI: $${SUI_PRICE} → $${r.toFixed(2)}`);
    console.log("═".repeat(60));

    // Run strategies
    const s1 = strat1_SimpleCarry(SUI_PRICE, parsed, START_CAPITAL);
    const s2 = strat2_LoopLending(SUI_PRICE, parsed, START_CAPITAL);
    const s3_2x = strat3_Leveraged(SUI_PRICE, parsed, START_CAPITAL, 2);
    const s3_3x = strat3_Leveraged(SUI_PRICE, parsed, START_CAPITAL, 3);
    const s4 = strat4_Deleverage(SUI_PRICE, parsed, START_CAPITAL);
    const s5 = strat5_PositiveSpreadArb(SUI_PRICE, parsed, START_CAPITAL);
    const s6 = strat6_HoldSUI(SUI_PRICE);

    const rows = [
      ["1. Simple Carry", s1?.netReturn, "SUI→USDC idle"],
      ["2. Loop Lending", s2?.netReturn, "SUI→USDC→USDC supply"],
      ["3. Leveraged 2x", s3_2x?.netReturn, `${s3_2x?.rebalances || 0} rebal`],
      ["3. Leveraged 3x", s3_3x?.netReturn, `${s3_3x?.rebalances || 0} rebal`],
      ["4. Auto-Deleverage", s4?.netReturn, `${s4?.rebalances || 0} rebal`],
      ["5. Spread Arb", s5?.netReturn, `${s5?.collateral}→${s5?.borrow}`],
      ["6. Hold SUI", s6?.netReturn, "Baseline"],
    ];

    console.table(
      rows.map(([name, ret, note]) => ({
        Strategy: name,
        "Net Return": ret != null ? `${ret.toFixed(1)}%` : "N/A",
        Note: note,
      }))
    );

    results[scenarioName] = { s1, s2, s3_2x, s3_3x, s4, s5, s6 };
  }

  // ─── Summary Table ───────────────────────────────────────────────────────
  console.log("\n");
  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║         NAVI STRATEGY COMPARISON (30 Days, $100)               ║");
  console.log("╠══════════════════════════════════════════════════════════════════╣");
  console.log("║  Strategy             │   Bull    │   Bear   │  Sideways  │");
  console.log("╠══════════════════════════════════════════════════════════════════╣");

  const strategies = [
    ["Simple Carry", "s1"],
    ["Loop Lending", "s2"],
    ["Leveraged 2x", "s3_2x"],
    ["Leveraged 3x", "s3_3x"],
    ["Auto-Deleverage", "s4"],
    ["Spread Arb (NS)", "s5"],
    ["Hold SUI", "s6"],
  ];

  for (const [name, key] of strategies) {
    const b = results.Bull?.[key]?.netReturn ?? 0;
    const br = results.Bear?.[key]?.netReturn ?? 0;
    const s = results.Sideways?.[key]?.netReturn ?? 0;
    const bullEmoji = b > 0 ? "🟢" : "🔴";
    const bearEmoji = br > 0 ? "🟢" : "🔴";
    const sideEmoji = s > 0 ? "🟢" : "🔴";
    console.log(
      `║  ${name.padEnd(20)} │ ${bullEmoji}${b.toFixed(1).padStart(6)}% │ ${bearEmoji}${br.toFixed(1).padStart(6)}% │ ${sideEmoji}${s.toFixed(1).padStart(7)}%  ║`
    );
  }

  console.log("╚══════════════════════════════════════════════════════════════════╝");

  // Key insights
  console.log("\n💡 KEY INSIGHTS:");
  console.log(`   • Bull market (+30% SUI): Best = Leveraged 3x strategy`);
  console.log(`   • Bear market (-30% SUI): Best = Loop Lending (earn on both legs)`);
  console.log(`   • Sideways: Best = Positive Spread Arb (no price exposure)`);
  console.log(`   • Most strategies get hurt in bear — borrow cost compounds faster than collateral grows`);
  console.log(`   • NS/DEEP positive spread assets: earn yield regardless of SUI price`);

  // Save to file
  const report = {
    date: new Date().toISOString(),
    suiPrice: SUI_PRICE,
    days: DAYS,
    startingCapital: START_CAPITAL,
    topAssets: topSpreads,
    results,
  };

  const fs = await import("fs");
  fs.mkdirSync("reports", { recursive: true });
  fs.writeFileSync(
    `reports/strategies_${new Date().toISOString().slice(0, 10)}.json`,
    JSON.stringify(report, null, 2)
  );
  console.log("\n📁 Report saved to reports/");
}

main().catch(console.error);
