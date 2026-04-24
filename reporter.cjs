// reporter.js — Format and save backtest report to Markdown
const fs = require("fs");
const path = require("path");

class Reporter {
  constructor(backtester) {
    this.bt = backtester;
  }

  generateReport() {
    const { params, state, apiData, dailySupplyRate } = this.bt;

    // Calculate metrics
    const finalCollateralValue = state.depositedCollateral;
    const finalBorrowValue = state.borrowedAmount;
    const netValue = finalCollateralValue - finalBorrowValue;
    const totalReturn = ((netValue - params.startingCapital) / params.startingCapital) * 100;
    const netApr = (totalReturn / params.simulationDays) * (365 / 100);
    const minHF = Math.min(...state.healthFactorHistory);
    const maxDrawdown = ((state.healthFactorHistory[0] - minHF) / state.healthFactorHistory[0]) * 100;
    const holdReturn = (Math.pow(1 + dailySupplyRate, params.simulationDays) - 1) * 100;
    const strategyAlpha = totalReturn - holdReturn;

    const report = `# NAVI Carry Trade Backtest Report

**Date:** ${new Date().toISOString().split('T')[0]}
**Source:** NAVI Protocol API (https://open-api.naviprotocol.io/api/navi/pools)

---

## Strategy Overview

| Parameter | Value |
|---|---|
| Strategy | Deposit SUI → Borrow USDC (USDSUI) |
| Period | ${params.simulationDays} days |
| Starting Capital | \$${params.startingCapital} |
| Collateral Asset | SUI |
| Borrow Asset | USDC (USDSUI on NAVI) |
| Collateral Ratio | ${params.depositAmount}% of capital |
| Borrow Ratio | ${params.borrowPercent}% of collateral value (LTV) |
| Supply APY | ${(apiData.supplyApy * 100).toFixed(2)}% |
| Borrow APY | ${(apiData.borrowApy * 100).toFixed(2)}% |
| LTV | ${(apiData.ltv * 100)}% |
| Borrow Fee | ${(params.borrowFeeAmount / (params.startingCapital * params.depositAmount / 100) * 100).toFixed(1)}% |

---

## Results

\`\`\`
╔══════════════════════════════════════════════════════╗
║  NAVI CARRY TRADE BACKTEST REPORT                     ║
╠══════════════════════════════════════════════════════╣
║  Strategy: Deposit SUI → Borrow USDC                  ║
║  Period: ${params.simulationDays} days                                      ║
║  Starting Capital: $${params.startingCapital}                                    ║
║                                                        ║
║  RESULTS:                                             ║
║  Final Net Value: $${netValue.toFixed(2)}                          ║
║  Net Return: ${totalReturn > 0 ? '+' : ''}${totalReturn.toFixed(2)}%                                     ║
║  Net APR: ${netApr.toFixed(2)}%                                      ║
║  Max Drawdown: ${maxDrawdown.toFixed(2)}%                                    ║
║  Total Fees: $${state.totalFeesPaid.toFixed(2)}                           ║
║  Rebalances: ${state.rebalanceCount}                                    ║
║                                                        ║
║  vs Hold SUI Only: ${holdReturn > 0 ? '+' : ''}${holdReturn.toFixed(2)}%                                    ║
║  Strategy Alpha: ${strategyAlpha > 0 ? '+' : ''}${strategyAlpha.toFixed(2)}%                                    ║
║                                                        ║
║  Health Factor: min=${minHF.toFixed(2)}, end=${state.healthFactorHistory[state.healthFactorHistory.length - 1].toFixed(2)}            ║
╚══════════════════════════════════════════════════════╝
\`\`\`

---

## Analysis

### Carry Trade Spread
- **Net Carry Spread:** ${(apiData.supplyApy - apiData.borrowApy) * 100}% (supply APY - borrow APY)
- **Effective Return:** ${totalReturn.toFixed(2)}% over ${params.simulationDays} days
- **Annualized:** ${netApr.toFixed(2)}% APR

### Interpretation
${strategyAlpha > 0 ? "✅ The carry trade **outperforms** holding SUI alone by **${strategyAlpha.toFixed(2)}%** over ${params.simulationDays} days." : "❌ The carry trade **underperforms** holding SUI alone."}

${netValue > params.startingCapital ? "🟢 Net value exceeds starting capital." : "🟡 Net value is close to starting capital."}

---

## Trade Log

| Day | Type | Description | Amount | Fee |
|-----|------|-------------|--------|-----|
${state.trades.map(t => `| ${t.day} | ${t.type} | ${t.description} | \$${t.amountUSD.toFixed(2)} | \$${t.fee.toFixed(2)} |`).join("\n")}

---

## Daily State History

| Day | Health Factor | Collateral Value | Borrowed Amount | Daily Return | Cumulative Return |
|-----|--------------|-------------------|----------------|-------------|------------------|
${state.dailyStates.map(d => `| ${d.day} | ${d.healthFactor.toFixed(4)} | \$${d.collateralValue.toFixed(2)} | \$${d.borrowedValue.toFixed(2)} | \$${d.dailyReturn.toFixed(2)} | \$${d.cumulativeReturn.toFixed(2)} |`).join("\n")}

---

## Methodology

1. **Supply APY Conversion:** ${'APY = (1 + r)^365 - 1' } → daily_rate = (1 + APY)^(1/365) - 1
2. **Health Factor:** HF = Collateral Value / Accrued Borrow Amount (grows with borrow APY)
3. **Rebalance:** Triggered when HF drops below ${params.rebalanceThreshold * 100}% of initial HF
4. **Fees:** Borrow fee applied once at initialization; gas costs tracked per transaction

---

*Report generated by NAVI Carry Trade Backtester*
*Data source: NAVI Protocol API*
`;

    return report;
  }

  saveReport(report, filename = "backtest.md") {
    const reportsDir = path.join(__dirname, "reports");
    fs.mkdirSync(reportsDir, { recursive: true });
    const reportPath = path.join(reportsDir, filename);
    fs.writeFileSync(reportPath, report);
    console.log(`Report saved to: ${reportPath}`);
  }
}

module.exports = { Reporter };
