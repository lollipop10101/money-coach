# Money Coach — Project Summary

**Version:** 1.0 | **Date:** April 2026 | **Status:** Active

---

## What Is This?

**Money Coach** is an automated DeFi lending opportunity tracker for SUI ecosystem. It monitors NAVI protocol lending pools, calculates carry trade spreads, and sends Telegram alerts when profitable opportunities are detected.

**Use case:** Find the best yield-farming opportunities in the SUI lending market — where you can supply stablecoins and earn more than you pay to borrow.

---

## How It Works

```
1. FETCH  → Pull current supply/borrow rates from NAVI protocol API
2. SCORE  → Calculate carry trade spread (supply APY minus borrow APY)
3. REGIME → BTC/SUI market regime via technical analysis (bull/bear/sideways)
4. ALERT  → Telegram message with opportunity details + 30D projection
```

---

## Alert Output Example

```
🔍 Hourly NAVI Scan SIDEWAYS 30%
✅ USDY→USDC (1x) w1.5
   Spread: +2.8% | Supply: 6.59% | Borrow: 3.78%
   30D: 🐂 +30.3% | 🐻 +30.3% | 📊 +30.3%

✅ USDC→haSUI (2x) w1.0
   Spread: +4.4% | Supply: 4.65% | Borrow: 0.28%
   30D: 🐂 -20.1% | 🐻 +59.5% | 📊 +18.8%
```

---

## Key Metrics Tracked

| Metric | Description |
|--------|-------------|
| Supply APY | What you earn for supplying liquidity |
| Borrow APY | What you pay to borrow |
| Spread | Supply minus Borrow (positive = opportunity) |
| 30D Return | Estimated 30-day return for carry trade |
| Regime | Bull / Bear / Sideways market classification |

---

## Carry Trade Logic

**USDC → haSUI strategy:**
- Supply USDC on NAVI, earn ~4.65% APY
- Borrow haSUI at ~0.28% APY
- Convert borrowed haSUI back to USDC and re-supply
- Net yield = supply APY minus borrow cost
- In bull market (SUI price up): borrow cost increases, strategy suffers
- In bear market (SUI price down): borrow cost decreases, strategy gains

---

## Tools & Stack

| Tool | Purpose |
|------|---------|
| NAVI Open API | Real-time lending pool data |
| Ollama (qwen) | Market regime prediction |
| SQLite | Opportunity history logging |
| Telegram | Alert delivery to Mark |

---

## Files

| File | Purpose |
|------|---------|
| alert.mjs | Main alert loop (hourly + 12h full scan) |
| tracker.js | NAVI API fetcher |
| predictor.js | BTC/SUI regime classifier |
| strategies.mjs | Carry trade strategy definitions + backtester |
| navi-alert.sh | Start/stop/status script |
| logs/alerts.log | All alert history |

---

## Status

- Alert process: **Running** (watchdog cron active)
- Regime model: **Sideways** (last scan)
- Last alert: Check logs at `logs/alerts.log`

---

## Next Steps

- [ ] Add more SUI ecosystem pools (Typus, Cetus)
- [ ] Backtest carry trade strategies against historical data
- [ ] Add leverage optimization per regime
- [ ] Alert on anomalous rate changes (sudden borrow spike = opportunity)
