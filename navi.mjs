/**
 * navi.mjs
 * Money Coach v2 — NAVI API wrapper
 * Exposes pool data fetching for use by other modules (e.g. bot-commands.js)
 */

import axios from "axios";

const API = "https://open-api.naviprotocol.io/api/navi/pools?env=prod&sdk=1.4.3&market=main";

function parseLTV(raw) { return Number(raw || 0) / 1e27; }

export async function getPoolData() {
  const { data } = await axios.get(API, { timeout: 15000 });
  return data.data.map((p) => ({
    symbol: p.token.symbol,
    supplyApy: parseFloat(p.supplyIncentiveApyInfo?.apy || p.supplyApy || 0),
    borrowApy: parseFloat(p.borrowIncentiveApyInfo?.apy || p.borrowApy || 0),
    ltv: parseLTV(p.ltv),
    totalSupply: parseFloat(p.totalSupply || 0) / 1e9,
    organicSupplyApy: (() => {
      const treasury = parseFloat(p.supplyIncentiveApyInfo?.treasuryApy || 0);
      const staking  = parseFloat(p.supplyIncentiveApyInfo?.stakingYieldApy || 0);
      return treasury + staking;
    })(),
    incentivizedSupplyApr: (() => {
      const total = parseFloat(p.supplyIncentiveApyInfo?.apy || 0);
      const treasury = parseFloat(p.supplyIncentiveApyInfo?.treasuryApy || 0);
      const staking  = parseFloat(p.supplyIncentiveApyInfo?.stakingYieldApy || 0);
      return Math.max(0, total - treasury - staking);
    })(),
    organicBorrowApy: parseFloat(p.borrowIncentiveApyInfo?.underlyingApy || p.borrowApy || 0),
  }));
}
