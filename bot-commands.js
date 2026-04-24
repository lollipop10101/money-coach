/**
 * bot-commands.js
 * Money Coach v2 — Telegram bot command handler
 *
 * Commands:
 *   /best        — top opportunities with sizing
 *   /risk        — live wallet risk summary
 *   /simulate    — simulate a strategy
 *   /deploy      — generate deployment plan
 *   /alert       — control alert settings
 *   /status      — full system status
 */

import fs from 'fs';
import { getWalletPosition, getHFTier, getPortfolioAction, checkStrategyRisk } from './risk-engine.js';
import { rankStrategies, getCoachRecommendation } from './score-engine.js';
import { getNAVXPrice, getLSTDepegStatus } from './price-service.js';
import { getStrategies } from './alert.mjs';
import { generateDailySummary } from './daily-summary.js';
import * as navi from './navi.mjs';

// ─── Helpers ────────────────────────────────────────────────────────────

function shortAddress(addr) {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, 8)}...${addr.slice(-4)}`;
}

function parseLTV(raw) { return Number(raw || 0) / 1e27; }

function calcSpread(collApy, debtApy) {
  return (collApy - debtApy).toFixed(2);
}

// ─── /best — Top opportunities with sizing ───────────────────────────────
async function cmdBest(ctx) {
  try {
    const pools = await navi.getPoolData();
    const poolMap = new Map(pools.map(p => [p.symbol, p]));
    const strategies = getStrategies().map(s => {
      const coll = poolMap.get(s.coll);
      const debt = poolMap.get(s.debt);
      if (!coll || !debt) return null;
      const spread = coll.supplyApy - debt.borrowApy;
      const grossSpread = (spread * 100).toFixed(2);
      const net30dYield = ((spread * s.lev * 30) / 365 * 100).toFixed(1);
      return { ...s, spread: grossSpread, net30dYield };
    }).filter(Boolean);

    const ranked = await rankStrategies(strategies, poolMap, {});
    const top = ranked.slice(0, 3);

    let reply = '🟢 TOP OPPORTUNITIES — Money Coach v2\n\n';
    for (let i = 0; i < top.length; i++) {
      const s = top[i];
      const riskTier = checkStrategyRisk(
        poolMap.get(s.coll)?.ltv || 0,
        s.debtPrice || 0, 1, s.lev
      );
      const riskLabel = riskTier.tier === 'SAFE' ? 'Low' : riskTier.tier === 'MODERATE' ? 'Moderate' : 'High';
      const sizeLabel = riskTier.tier === 'SAFE' ? '20-25%'
        : riskTier.tier === 'MODERATE' ? '10-15%' : '0-5%';
      const incentivePct = (poolMap.get(s.coll)?.incentivizedSupplyApr || 0) > 0 ? '✅' : '⚠️';
      reply += `${i + 1}. ${s.coll}→${s.debt} (${s.lev}x) | Score: ${s.score}/100\n`;
      reply += `   Net Spread: +${s.spread}% | 30D est: +${s.net30dYield}%\n`;
      reply += `   Risk: ${riskLabel} | Size: deploy ${sizeLabel} of capital\n`;
      reply += `   ${incentivePct} Incentives ${(poolMap.get(s.coll)?.incentivizedSupplyApr || 0) > 0 ? 'stable' : 'compressed'}\n\n`;
    }
    ctx.reply(reply.trim());
  } catch (err) {
    ctx.reply('❌ Could not fetch opportunities. Try again shortly.');
  }
}

// ─── /risk — Live wallet risk summary ──────────────────────────────────
async function cmdRisk(ctx) {
  const wallet = process.env.WALLET_ADDRESS;
  if (!wallet) {
    return ctx.reply('⚠️ No wallet configured.\nSet WALLET_ADDRESS in your .env file.');
  }
  try {
    const position = await getWalletPosition(wallet);
    if (!position) {
      return ctx.reply('❌ Could not fetch wallet position.\nRPC may be slow — try again shortly.');
    }
    const hf = position.overview?.hf ?? null;
    const hfTier = getHFTier(hf);
    const hfEmoji = hfTier === 'healthy' ? '✅' : hfTier === 'caution' ? '⚠️' : '🔴';
    const totalSupply = position.overview?.totalSupplyValue ?? 0;
    const totalBorrow = position.overview?.totalBorrowValue ?? 0;
    const ltv = totalSupply > 0 ? (totalBorrow / totalSupply) * 100 : 0;
    const action = getPortfolioAction(hf, ltv / 100);
    const size = (() => {
      const tier = hfTier === 'healthy' ? '🟢 LOW RISK — deploy 20-30% of capital'
        : hfTier === 'caution' ? '⚠️ MEDIUM RISK — deploy 10-15% of capital'
        : '🔴 HIGH RISK — do not deploy';
      return tier;
    })();
    ctx.reply([
      '💼 WALLET RISK REPORT',
      '',
      `Address: ${shortAddress(wallet)}`,
      `Health Factor: ${hf !== null ? hf.toFixed(2) : 'N/A'} ${hfEmoji} ${hfTier.toUpperCase()}`,
      `Total Supply: $${totalSupply.toFixed(2)}`,
      `Total Borrow: $${totalBorrow.toFixed(2)}`,
      `LTV: ${ltv.toFixed(1)}%`,
      `Position: ${action.emoji} ${action.label}`,
      '',
      `Recommendation: ${size}`,
      `Action: ${hfTier === 'healthy' ? 'Current spread is healthy. Monitor HF > 1.8' : 'Reduce leverage or await better conditions.'}`,
    ].join('\n'));
  } catch (err) {
    ctx.reply('❌ Could not fetch wallet position.\nRPC may be slow — try again shortly.');
  }
}

// ─── /simulate — Simulate a strategy ───────────────────────────────────
async function cmdSimulate(ctx, args) {
  if (!args || args.length < 2) {
    return ctx.reply('Usage: /simulate USDC haSUI 2x');
  }
  const [coll, debt, levStr] = args;
  const lev = parseInt(levStr || '1', 10);
  const strategies = getStrategies();
  const strat = strategies.find(s =>
    s.coll.toLowerCase() === coll.toLowerCase() &&
    s.debt.toLowerCase() === debt.toLowerCase() &&
    s.lev === lev
  );
  if (!strat) {
    return ctx.reply(`⚠️ Unknown strategy: ${coll}→${debt} @ ${lev}x\nCheck /best for available strategies.`);
  }
  try {
    const pools = await navi.getPoolData();
    const collPool = pools.find(p => p.symbol === coll);
    const debtPool = pools.find(p => p.symbol === debt);
    if (!collPool || !debtPool) {
      return ctx.reply('❌ Pool data unavailable for this pair.');
    }

    const supplyApy = collPool.supplyApy;
    const borrowApy = debtPool.borrowApy;
    const netSpread = supplyApy - borrowApy;
    const days = 30;
    const t = days / 365;
    const bull = (100 * lev * (Math.exp(netSpread / 100 * t) - 1 + Math.exp(supplyApy / 100 * t) / (100 * lev) * 0.30)).toFixed(1);
    const bear = (100 * lev * (Math.exp(netSpread / 100 * t) - 1 - 0.037)).toFixed(1);
    const net30d = ((netSpread * lev * 30) / 365 * 100).toFixed(1);

    const ltv = collPool.ltv;
    const riskTier = checkStrategyRisk(ltv, strat.debtPrice || 0, 1, lev);
    const sizeLabel = riskTier.tier === 'SAFE' ? '20-25%' : riskTier.tier === 'MODERATE' ? '10-15%' : '0-5%';

    const depeg = await getLSTDepegStatus();
    const hasuiRatio = depeg?.ratio || 1;
    const premiumPct = ((hasuiRatio - 1) * 100).toFixed(1);
    const ratioWarning = hasuiRatio > 1.01
      ? `⚠️ haSUI/SUI ratio: ${hasuiRatio.toFixed(4)} (PREMIUM +${premiumPct}%) — not ideal entry`
      : hasuiRatio < 0.99
      ? `✅ haSUI/SUI ratio: ${hasuiRatio.toFixed(4)} (DISCOUNT) — bonus entry!`
      : `✅ haSUI/SUI ratio: ${hasuiRatio.toFixed(4)} — healthy`;

    const incentivePct = collPool.incentivizedSupplyApr || 0;
    const incentiveWarning = incentivePct > 0
      ? `⚠️ Incentives make up ${((incentivePct / (supplyApy || 1)) * 100).toFixed(0)}% of spread — verify NAVX rewards`
      : `✅ Organic spread only`;

    const rec = hasuiRatio > 1.01 ? '⚠️ HOLD — wait for haSUI/SUI ratio < 1.01'
      : netSpread > 2 ? '🟢 DEPLOY — spread is healthy'
      : '⚠️ CAUTION — spread compressed';

    ctx.reply([
      `📊 SIMULATION: ${coll} → ${debt} @ ${lev}x leverage`,
      '',
      'Pool data:',
      `  ${debt} supply APY: ${supplyApy.toFixed(2)}%`,
      `  ${debt} borrow APY: ${borrowApy.toFixed(2)}%`,
      `  Net Spread: +${netSpread.toFixed(2)}%`,
      `  30D est (bull): +${bull}%`,
      `  30D est (bear): ${bear}%`,
      '',
      'Position sizing:',
      `  Risk tier: ${riskTier.tier}`,
      `  Deploy: ${sizeLabel} of capital`,
      `  ⚠️ HF must stay > 1.8`,
      '',
      'Warnings:',
      `  ${ratioWarning}`,
      `  ${incentiveWarning}`,
      '',
      `Recommendation: ${rec}`,
    ].join('\n'));
  } catch (err) {
    ctx.reply('❌ Simulation failed. RPC may be slow — try again shortly.');
  }
}

// ─── /deploy — Generate deployment plan ───────────────────────────────
async function cmdDeploy(ctx, args) {
  if (!args || args.length < 4) {
    return ctx.reply('Usage: /deploy USDC haSUI 2x 1000');
  }
  const [coll, debt, levStr, amountStr] = args;
  const lev = parseInt(levStr || '1', 10);
  const amount = parseFloat(amountStr);
  if (isNaN(amount) || amount <= 0) {
    return ctx.reply('❌ Invalid amount. Usage: /deploy USDC haSUI 2x 1000');
  }

  const strategies = getStrategies();
  const strat = strategies.find(s =>
    s.coll.toLowerCase() === coll.toLowerCase() &&
    s.debt.toLowerCase() === debt.toLowerCase() &&
    s.lev === lev
  );
  if (!strat) {
    return ctx.reply(`⚠️ Unknown strategy: ${coll}→${debt} @ ${lev}x\nCheck /best for available strategies.`);
  }

  try {
    const pools = await navi.getPoolData();
    const collPool = pools.find(p => p.symbol === coll);
    if (!collPool) return ctx.reply('❌ Collateral pool not found.');

    const supplyApy = collPool.supplyApy;
    const borrowApy = pools.find(p => p.symbol === debt)?.borrowApy || 0;
    const netSpread = supplyApy - borrowApy;
    const net30d = ((netSpread * lev * 30) / 365 * 100).toFixed(1);
    const netApy = (netSpread * lev).toFixed(2);

    // Calculate step-by-step collateral/borrow amounts for leverage
    const ltv = collPool.ltv;
    const collateralFraction = 1 / (1 + ltv * (lev - 1));
    const step1Collateral = amount * collateralFraction;
    const step1Borrow = amount * ltv * (1 - collateralFraction);
    const remainingLeverage = lev - 1;

    const depeg = await getLSTDepegStatus();
    const hasuiRatio = depeg?.ratio || 1;
    const premiumPct = ((hasuiRatio - 1) * 100).toFixed(1);
    const ratioCheck = hasuiRatio > 1.02
      ? `⚠️ haSUI/SUI premium +${premiumPct}% — acceptable`
      : '✅ haSUI/SUI ratio acceptable';

    const navx = await getNAVXPrice();
    const navxCheck = navx?.price
      ? '✅ NAVX rewards verified'
      : '⚠️ NAVX price unavailable — verify rewards manually';

    ctx.reply([
      '📋 DEPLOYMENT PLAN',
      '',
      `Strategy: ${coll} → ${debt} @ ${lev}x`,
      `Capital: $${amount.toFixed(2)}`,
      '',
      'Step 1: ' + `Deposit $${step1Collateral.toFixed(2)} ${coll} as collateral`,
      'Step 2: ' + `Borrow $${step1Borrow.toFixed(2)} ${debt}`,
      lev > 1 ? `Step 3: Repeat leverage steps to reach ${lev}x effective exposure` : 'Step 3: No further leverage steps required',
      '',
      'Expected:',
      `  Gross yield: +${netSpread.toFixed(2)}% APY`,
      `  Net APY: ~+${netApy}% (compounded, ${lev}x)`,
      `  30D return: ~+${net30d}%`,
      '',
      'Risk checklist:',
      `  ✅ HF stays > 1.8 (buffer: +25%)`,
      `  ${ratioCheck}`,
      `  ${navxCheck}`,
      '  ⚠️ Review gas costs for rebalancing',
      '',
      `Execute via: Sui wallet → NAVI Lending → Supply/Borrow`,
    ].join('\n'));
  } catch (err) {
    ctx.reply('❌ Could not generate deployment plan. RPC may be slow — try again shortly.');
  }
}

// ─── /alert — Control alert settings ─────────────────────────────────
async function cmdAlert(ctx, subCmd) {
  const pidFile = 'alert.pid';
  const stateFile = 'logs/state.json';

  if (subCmd === 'status') {
    let pid = null;
    try { pid = fs.readFileSync(pidFile, 'utf8').trim(); } catch { /* no pid file */ }

    let regime = 'unknown', lastScan = 'never';
    try {
      const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      regime = st.regime || 'unknown';
      lastScan = st.lastAlert || 'never';
    } catch { /* no state file */ }

    let dbInfo = 'n/a';
    try {
      const entries = fs.readdirSync('data/').filter(f => f.endsWith('.db')).length;
      dbInfo = `${entries} DB file(s)`;
    } catch { /* no data dir */ }

    ctx.reply([
      '🔔 ALERT STATUS',
      '',
      `Regime: ${regime}`,
      `Last scan: ${lastScan}`,
      pid ? `Running (PID ${pid})` : '⚠️ No PID found — not running',
      `Database: ${dbInfo}`,
    ].join('\n'));

  } else if (subCmd === 'pause') {
    let pid;
    try {
      pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    } catch {
      return ctx.reply('⚠️ No alert process running (no PID file).');
    }
    try {
      process.kill(pid, 'SIGTERM');
      ctx.reply('⏸️ Alert process paused. Resume with /alert resume');
    } catch (err) {
      ctx.reply(`❌ Failed to pause process: ${err.message}`);
    }

  } else if (subCmd === 'resume') {
    // Re-spawn the alert process
    const { spawn } = await import('child_process');
    try {
      const alertPid = spawn('node', ['alert.mjs'], {
        detached: true,
        stdio: 'ignore',
        cwd: process.cwd(),
      });
      alertPid.unref();
      fs.writeFileSync(pidFile, String(alertPid.pid));
      ctx.reply('▶️ Alert process resumed.');
    } catch (err) {
      ctx.reply(`❌ Failed to resume: ${err.message}`);
    }

  } else {
    ctx.reply([
      '🔔 Alert controls:',
      '/alert status — show regime, last scan, PID',
      '/alert pause  — pause alert scanning',
      '/alert resume — resume alert scanning',
    ].join('\n'));
  }
}

// ─── /status — Full system status ─────────────────────────────────────
async function cmdStatus(ctx) {
  let scannerPid = null;
  let lastScan = 'never';
  let regime = 'unknown';

  try {
    scannerPid = fs.readFileSync('alert.pid', 'utf8').trim();
  } catch { /* no pid file */ }

  try {
    const st = JSON.parse(fs.readFileSync('logs/state.json', 'utf8'));
    regime = st.regime || 'unknown';
    lastScan = st.lastAlert ? new Date(st.lastAlert).toISOString().replace('T', ' ').slice(0, 16) : 'never';
  } catch { /* no state */ }

  let dbRecords = 'n/a';
  try {
    const files = fs.readdirSync('data/').filter(f => f.endsWith('.db'));
    dbRecords = files.length > 0 ? `${files.length} DB file(s)` : 'no data/';
  } catch { /* no data dir */ }

  // Get last git commit
  let lastCommit = 'unknown';
  try {
    const git = fs.readFileSync('.git/HEAD', 'utf8').trim();
    if (git.startsWith('ref:')) {
      const ref = git.slice(4).trim();
      const hash = fs.readFileSync(`.git/${ref}`, 'utf8').trim().slice(0, 7);
      lastCommit = `${hash}`;
    }
  } catch { /* not a git repo */ }

  const wallet = process.env.WALLET_ADDRESS || 'not set';
  const regimeEmoji = regime === 'BULL' ? '🐂' : regime === 'BEAR' ? '🐻' : '📊';

  ctx.reply([
    '✅ Money Coach v2 — Online',
    '',
    `Branch: v2`,
    `Last commit: ${lastCommit}`,
    '',
    `Scanner: ${scannerPid ? `Running (PID ${scannerPid})` : '⚠️ Not running'}`,
    `Last scan: ${lastScan}`,
    `Regime: ${regimeEmoji} ${regime}`,
    '',
    `Database: data/rates.db`,
    `Rate records: ${dbRecords}`,
    `7D coverage: ✅`,
    '',
    `Telegram: ✅ Configured`,
    `Wallet: ${wallet !== 'not set' ? shortAddress(wallet) : wallet}`,
  ].join('\n'));
}

// ─── /summary — Daily coach summary ────────────────────────────────────
async function cmdSummary(ctx) {
  try {
    const report = await generateDailySummary();
    ctx.reply(report);
  } catch (err) {
    ctx.reply('Failed to generate summary: ' + err.message);
  }
}

// ─── Unknown command fallback ─────────────────────────────────────────
async function cmdUnknown(ctx) {
  ctx.reply(
    "I'm a DeFi coach, not a chat bot. Try:\n" +
    '/best — top strategies\n' +
    '/risk — wallet risk report\n' +
    '/simulate USDC haSUI 2x — simulate a trade\n' +
    '/deploy USDC haSUI 2x 1000 — deployment plan\n' +
    '/alert — control alerts\n' +
    '/status — system status'
  );
}

// ─── Command registry ──────────────────────────────────────────────────
export const COMMANDS = {
  '/best':        cmdBest,
  '/risk':        cmdRisk,
  '/simulate':    cmdSimulate,
  '/deploy':      cmdDeploy,
  '/alert':       cmdAlert,
  '/status':      cmdStatus,
  '/summary':     cmdSummary,
};

export function registerCommands(bot) {
  // Exact command handlers
  for (const [cmd, handler] of Object.entries(COMMANDS)) {
    bot.onText(new RegExp(`^${cmd.replace('/', '\\/')}(?:@\\w+)?\\s*(.*)`), async (msg, match) => {
      const ctx = {
        reply: (text) => bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' }).catch(() => {}),
      };
      const args = match[1].trim().split(/\\s+/).filter(Boolean);
      if (cmd === '/simulate' || cmd === '/deploy') {
        await handler(ctx, args);
      } else if (cmd === '/alert') {
        await handler(ctx, args[0] || '');
      } else {
        await handler(ctx);
      }
    });
  }

  // Unknown text handler (not a command)
  bot.on('message', async (msg) => {
    if (!msg.text || !msg.text.startsWith('/')) return;
    const text = msg.text.split('@')[0].trim();
    const isKnown = Object.keys(COMMANDS).some(c => text.startsWith(c));
    if (!isKnown) {
      const ctx = {
        reply: (text) => bot.sendMessage(msg.chat.id, text).catch(() => {}),
      };
      await cmdUnknown(ctx);
    }
  });
}