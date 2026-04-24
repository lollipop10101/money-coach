#!/usr/bin/env node
// run-backtest.js — Run the NAVI Carry Trade Backtest

import { Backtester } from "./backtester.cjs";
import { Reporter } from "./reporter.cjs";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Ensure directories exist
["data", "logs", "reports"].forEach(dir => {
  const dirPath = path.join(__dirname, dir);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
});

// Run the backtest
console.log("Initializing NAVI Carry Trade Backtester...\n");

const bt = new Backtester();

// Run simulation
bt.run();

// Generate and save report
const reporter = new Reporter(bt);
const report = reporter.generateReport();
reporter.saveReport(report, `backtest_${new Date().toISOString().split('T')[0]}.md`);

// Save trades data
const tradesPath = path.join(__dirname, "data", "backtest_trades.json");
fs.writeFileSync(tradesPath, JSON.stringify(bt.state.trades, null, 2));

// Also save a full state JSON for debugging
const statePath = path.join(__dirname, "data", "backtest_state.json");
fs.writeFileSync(statePath, JSON.stringify(bt.state, null, 2));

console.log("\nDone! Results saved to:");
console.log(`  - data/backtest_trades.json`);
console.log(`  - data/backtest_state.json`);
console.log(`  - reports/backtest_${new Date().toISOString().split('T')[0]}.md`);
