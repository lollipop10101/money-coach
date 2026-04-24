/**
 * bot-commands.js
 * Money Coach v2 — Telegram bot command handler
 *
 * Commands:
 *   /opportunities  — ranked strategy list
 *   /risk           — wallet risk summary (needs WALLET_ADDRESS set)
 *   /add-wallet     — add a wallet to track (future)
 *   /set-max-ltv   — set max LTV threshold
 *   /deploy-plan    — generate deployment plan
 *   /pause          — pause alerts
 *   /resume         — resume alerts
 *   /status         — bot status + last scan time
 */

import { getWalletPosition, getHFTier, getPortfolioAction } from './risk-engine.js';
import { rankStrategies, getCoachRecommendation } from './score-engine.js';
import { getNAVXPrice, getLSTDepegStatus } from './price-service.js';
import { getStrategies } from './alert.mjs';
import * as navi from './navi.mjs';

const COMMANDS = {
  '/opportunities': async (ctx) => {
    const pools = await navi.getPoolData();
    const poolMap = new Map(pools.map(p => [p.symbol, p]));
    const strategies = getStrategies().map(s => {
      const coll = pools.find(p => p.symbol === s.coll);
      const debt = pools.find(p => p.symbol === s.debt);
      if (!coll || !debt) return null;
      // Estimate net30dYield from pool data
      const grossSpread = coll.supplyApy - debt.borrowApy;
      const net30dYield = ((grossSpread * s.lev * 30) / 365).toFixed(2);
      return {
        ...s,
        net30dYield,
        debtVolatility: s.debtAsset ? 20 : 0,
      };
    }).filter(Boolean);
    const ranked = await rankStrategies(strategies, poolMap, {});
    const coach = await getCoachRecommendation(ranked, null, {});
    let reply = '🟢 TOP OPPORTUNITIES\n\n';
    ranked.slice(0, 3).forEach((s, i) => {
      reply += `${i+1}. ${s.name} — Score: ${s.score}\n`;
      reply += `   Spread: ${s.spread} | 30D: ${s.net30dYield}\n`;
      reply += `   ${s.scoreDetails?.warnings?.join(', ') || 'No warnings'}\n\n`;
    });
    ctx.reply(reply);
  },

  '/risk': async (ctx) => {
    const wallet = process.env.WALLET_ADDRESS;
    if (!wallet) {
      return ctx.reply('No wallet configured. Set WALLET_ADDRESS in .env');
    }
    const position = await getWalletPosition(wallet);
    if (!position) {
      return ctx.reply('Could not fetch position. Check wallet address.');
    }
    const hf = position.overview.hf;
    const hfTier = getHFTier(hf);
    const action = getPortfolioAction(hf, position.overview.totalBorrowValue / position.overview.totalSupplyValue);
    const reply = [
      `💼 WALLET RISK REPORT`,
      `Address: ${wallet.slice(0, 8)}...${wallet.slice(-4)}`,
      `Health Factor: ${hf?.toFixed(2) ?? 'N/A'} (${hfTier})`,
      `Total Supply: $${position.overview.totalSupplyValue?.toFixed(2) ?? 'N/A'}`,
      `Total Borrow: $${position.overview.totalBorrowValue?.toFixed(2) ?? 'N/A'}`,
      `Recommendation: ${action.emoji} ${action.label}`,
    ].join('\n');
    ctx.reply(reply);
  },

  '/status': async (ctx) => {
    const state = JSON.parse(require('fs').readFileSync('logs/state.json', 'utf8'));
    ctx.reply([
      '✅ Money Coach v2 — Online',
      `Last scan: ${new Date(state.lastScan || 0).toISOString()}`,
      `Mode: ${state.regime || 'unknown'}`,
      `PID: ${require('fs').readFileSync('alert.pid', 'utf8').trim()}`,
    ].join('\n'));
  },
};

export function registerCommands(bot) {
  for (const [cmd, handler] of Object.entries(COMMANDS)) {
    bot.onText(new RegExp(cmd), handler);
  }
}

export { COMMANDS };
