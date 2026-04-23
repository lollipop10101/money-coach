// NAVI Carry Trade Backtester Configuration
// All simulation parameters in one place

const config = {
  // Simulation Parameters
  simulation: {
    startingCapital: 100,       // USD value of initial SUI deposit
    depositAsset: "SUI",        // Collateral asset
    borrowAsset: "USDSUI",      // Debt asset (USDC-like on NAVI)
    depositAmount: 80,          // % of capital used as collateral (80%)
    borrowPercent: 50,          // % of collateral value to borrow (50% LTV)
    simulationDays: 30,         // How many days to simulate
    compounding: true,          // Compound profits daily
    rebalanceThreshold: 0.05,   // Rebalance if health factor drops 5% below initial
  },

  // Real API Data (from NAVI API - https://open-api.naviprotocol.io/api/navi/pools)
  apiData: {
    // Using USDSUI pool (ID: 34) as both deposit (collateral) and borrow market
    supplyApy: 0.07791,       // 7.791% — supply APY on USDSUI (boosted)
    borrowApy: 0.03547,       // 3.547% — borrow APY on USDSUI (vault)
    ltv: 0.75,               // 75% Loan-to-Value ratio
    liquidationThreshold: 0.78,
    totalSupply: 1561041103940010,
    totalBorrow: 29599962308531,
  },

  // Fees
  fees: {
    depositFee: 0,          // NAVI deposit fee: 0%
    borrowFee: 0.002,        // NAVI borrow fee: 0.2% (one-time)
    withdrawFee: 0,         // NAVI withdraw fee: 0%
    gasPerTx: 0.01,         // Sui gas per transaction (~0.005 SUI at ~$2)
  },

  // Paths
  paths: {
    config: "config/wallet.json",
    trades: "data/backtest_trades.json",
    log: "logs/backtest.log",
    report: "reports/backtest.md",
  },

  // Derived constants
  get borrowFeeUSD() {
    return this.simulation.startingCapital * (this.simulation.depositAmount / 100) * this.fees.borrowFee;
  },

  // Get current simulation date
  get date() {
    return new Date().toISOString().split('T')[0];
  },
};

module.exports = config;
