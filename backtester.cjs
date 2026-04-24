// backtester.js — Core NAVI Carry Trade Backtester Engine
// Simulates depositing SUI as collateral and borrowing USDC-equivalent on NAVI Protocol

const config = require("./config.cjs");
const fs = require("fs");
const path = require("path");

class Backtester {
  constructor(userConfig = {}) {
    // Merge user config with defaults
    this.params = { ...config.simulation, ...userConfig };
    this.apiData = config.apiData;
    this.fees = config.fees;

    // State
    this.state = {
      day: 0,
      capital: this.params.startingCapital,       // Starting capital in USD
      depositedCollateral: 0,                     // USD value of deposited SUI collateral
      borrowedAmount: 0,                          // USD value of borrowed USDC
      totalInterestEarned: 0,                      // Total interest earned from deposits
      totalInterestOwed: 0,                      // Total interest owed on borrowings
      totalFeesPaid: 0,                          // Total fees paid
      rebalanceCount: 0,                         // Number of rebalances
      healthFactorHistory: [],                     // HF recorded each day
      trades: [],                                // Log of all trades
      dailyStates: [],                           // Full state per day for reporting
    };

    // Pre-compute daily rates from APY (APY → daily rate)
    // APY = (1 + r)^365 - 1  →  daily_rate = (1 + APY)^(1/365) - 1
    this.dailySupplyRate = Math.pow(1 + this.apiData.supplyApy, 1 / 365) - 1;
    this.dailyBorrowRate = Math.pow(1 + this.apiData.borrowApy, 1 / 365) - 1;

    // Compute fees
    this.borrowFeeAmount = this.params.startingCapital * (this.params.depositAmount / 100) * this.fees.borrowFee;

    // Gas cost per transaction
    this.gasCostPerTx = this.fees.gasPerTx;
  }

  // ─── Day 0: Initialize positions ───
  initialize() {
    const depositAmountUSD = this.params.startingCapital * (this.params.depositAmount / 100);
    const borrowValue = depositAmountUSD * this.params.borrowPercent / 100;

    // Record deposit
    this.state.depositedCollateral = depositAmountUSD;
    this.state.borrowedAmount = borrowValue;

    // Deduct borrow fee
    this.state.totalFeesPaid += this.borrowFeeAmount;
    this.state.capital -= this.borrowFeeAmount;

    // Record deposit trade
    this.state.trades.push({
      day: 0,
      type: "DEPOSIT",
      timestamp: new Date().toISOString(),
      description: `Deposit ${depositAmountUSD.toFixed(2)} SUI as collateral`,
      amountUSD: depositAmountUSD,
      fee: this.gasCostPerTx,
      capitalAfter: this.state.capital,
    });

    this.state.totalFeesPaid += this.gasCostPerTx;

    // Record borrow trade
    this.state.trades.push({
      day: 0,
      type: "BORROW",
      timestamp: new Date().toISOString(),
      description: `Borrow ${borrowValue.toFixed(2)} USDC (USDSUI pool)`,
      amountUSD: borrowValue,
      fee: this.borrowFeeAmount + this.gasCostPerTx,
      capitalAfter: this.state.capital - this.borrowFeeAmount - this.gasCostPerTx,
    });

    this.state.totalFeesPaid += this.gasCostPerTx;

    // Calculate initial health factor
    this.state.healthFactorHistory.push(this.healthFactor());

    // Log
    console.log(`[Day 0] INITIALIZE | Capital: $${this.state.capital.toFixed(2)} | Collateral: $${depositAmountUSD.toFixed(2)} | Borrowed: $${borrowValue.toFixed(2)} | HF: ${this.state.healthFactorHistory[0].toFixed(2)} | Fees: $${this.state.totalFeesPaid.toFixed(2)}`);

    return this.state;
  }

  // ─── Health Factor Calculation ───
  healthFactor() {
    // HF = Collateral Value / (Accrued Borrowed Amount)
    // Collateral value stays constant; borrow amount compounds with daily interest
    const collateralValue = this.state.depositedCollateral;
    const currentBorrowValue = this.state.borrowedAmount * Math.pow(1 + this.dailyBorrowRate, this.state.day);
    return collateralValue / currentBorrowValue;
  }

  // ─── Advance one day ───
  advanceDay() {
    this.state.day += 1;

    // 1. Accrue deposit interest (compounding daily)
    const dailyEarned = this.state.depositedCollateral * this.dailySupplyRate;
    this.state.depositedCollateral += dailyEarned;
    this.state.totalInterestEarned += dailyEarned;

    // 2. Accrue borrow interest (compounding daily)
    this.state.borrowedAmount = this.state.borrowedAmount * Math.pow(1 + this.dailyBorrowRate, 1);

    // 3. Check health factor
    const hf = this.healthFactor();
    this.state.healthFactorHistory.push(hf);

    // 4. Check for rebalance trigger
    const initialHF = this.state.healthFactorHistory[0];
    const threshold = initialHF * (1 - this.params.rebalanceThreshold);

    if (hf < threshold && this.state.rebalanceCount === 0) {
      // Auto-rebalance: deposit additional collateral equal to borrow interest accrued
      const additionalCollateral = dailyEarned * 0.5;
      this.state.depositedCollateral += additionalCollateral;
      this.state.totalInterestEarned += additionalCollateral;
      this.state.rebalanceCount += 1;

      this.state.trades.push({
        day: this.state.day,
        type: "REBALANCE",
        timestamp: new Date().toISOString(),
        description: `HF dropped to ${hf.toFixed(2)} (threshold: ${threshold.toFixed(2)}). Added collateral: $${additionalCollateral.toFixed(2)}`,
        amountUSD: additionalCollateral,
        fee: this.gasCostPerTx,
        capitalAfter: this.state.capital - additionalCollateral,
      });
      this.state.totalFeesPaid += this.gasCostPerTx;

      console.log(`[Day ${this.state.day}] REBALANCE | HF dropped to ${hf.toFixed(2)} | Additional collateral: $${additionalCollateral.toFixed(2)} | Rebalance count: ${this.state.rebalanceCount}`);
    }

    // Log daily state
    const logEntry = `Day ${this.state.day}: HF=${hf.toFixed(2)} | Collateral=$${this.state.depositedCollateral.toFixed(2)} | Borrowed=$${this.state.borrowedAmount.toFixed(2)} | Earned=$${this.state.totalInterestEarned.toFixed(2)} | HF threshold=$${threshold.toFixed(2)} | Rebalances=${this.state.rebalanceCount}`;
    console.log(logEntry);

    this.state.dailyStates.push({
      day: this.state.day,
      healthFactor: hf,
      collateralValue: this.state.depositedCollateral,
      borrowedValue: this.state.borrowedAmount,
      dailyReturn: dailyEarned,
      cumulativeReturn: this.state.totalInterestEarned,
    });

    return {
      day: this.state.day,
      healthFactor: hf,
      collateralValue: this.state.depositedCollateral,
      borrowedValue: this.state.borrowedAmount,
    };
  }

  // ─── Run full simulation ───
  run() {
    console.log("\n" + "=".repeat(55));
    console.log("  NAVI CARRY TRADE BACKTEST SIMULATION");
    console.log("=".repeat(55));
    console.log(`Starting capital: $${this.params.startingCapital}`);
    console.log(`Strategy: Deposit SUI → Borrow USDSUI`);
    console.log(`Supply APY: ${(this.apiData.supplyApy * 100).toFixed(2)}% | Borrow APY: ${(this.apiData.borrowApy * 100).toFixed(2)}%`);
    console.log(`LTV: ${(this.apiData.ltv * 100)}% | Borrow Fee: ${(this.fees.borrowFee * 100).toFixed(1)}%`);
    console.log("-".repeat(55));

    // Initialize
    this.initialize();

    // Run simulation days
    for (let i = 1; i <= this.params.simulationDays; i++) {
      this.advanceDay();
    }

    // Calculate final results
    const finalHF = this.state.healthFactorHistory[this.state.healthFactorHistory.length - 1];
    const finalCollateralValue = this.state.depositedCollateral;
    const finalBorrowValue = this.state.borrowedAmount;
    const netValue = finalCollateralValue - finalBorrowValue;

    // Total return
    const totalReturn = ((netValue - this.params.startingCapital) / this.params.startingCapital) * 100;

    // Net APR
    const netApr = (totalReturn / this.params.simulationDays * (365 / 100));

    // Max drawdown (HF dropped below initial)
    const minHF = Math.min(...this.state.healthFactorHistory);
    const maxDrawdown = ((this.state.healthFactorHistory[0] - minHF) / this.state.healthFactorHistory[0]) * 100;

    // Compare to holding SUI only (just deposit, no borrowing)
    const holdReturn = (Math.pow(1 + this.dailySupplyRate, this.params.simulationDays) - 1) * 100;
    const strategyAlpha = totalReturn - holdReturn;

    // Save trades
    this.saveTrades();

    // Print summary
    this.printSummary({ netValue, totalReturn, netApr, minHF, finalHF, maxDrawdown, strategyAlpha, holdReturn });

    return this.state;
  }

  // ─── Save trades ───
  saveTrades() {
    const tradesPath = path.join(__dirname, "data", "backtest_trades.json");
    fs.writeFileSync(tradesPath, JSON.stringify(this.state.trades, null, 2));
    console.log(`Trades saved to: ${tradesPath}`);
  }

  // ─── Print summary report ───
  printSummary(results) {
    const { netValue, totalReturn, netApr, minHF, finalHF, maxDrawdown, strategyAlpha, holdReturn } = results;

    console.log("\n" + "═".repeat(55));
    console.log("  NAVI CARRY TRADE BACKTEST REPORT");
    console.log("═".repeat(55));
    console.log(`  Strategy: Deposit SUI → Borrow USDSUI`);
    console.log(`  Period: ${this.params.simulationDays} days`);
    console.log(`  Starting Capital: $${this.params.startingCapital}`);
    console.log("─".repeat(55));
    console.log("  RESULTS:");
    console.log(`  Final Net Value: $${netValue.toFixed(2)}`);
    console.log(`  Net Return: ${totalReturn > 0 ? '+' : ''}${totalReturn.toFixed(2)}%`);
    console.log(`  Net APR: ${netApr.toFixed(2)}%`);
    console.log(`  Max Drawdown: ${maxDrawdown.toFixed(2)}%`);
    console.log(`  Total Fees: $${this.state.totalFeesPaid.toFixed(2)}`);
    console.log(`  Rebalances: ${this.state.rebalanceCount}`);
    console.log("─".repeat(55));
    console.log(`  vs Hold SUI Only: ${holdReturn > 0 ? '+' : ''}${holdReturn.toFixed(2)}%`);
    console.log(`  Strategy Alpha: ${strategyAlpha > 0 ? '+' : ''}${strategyAlpha.toFixed(2)}%`);
    console.log("─".repeat(55));
    console.log(`  Health Factor History: min=${minHF.toFixed(2)}, end=${finalHF.toFixed(2)}`);
    console.log("═".repeat(55));
  }
}

module.exports = { Backtester };
