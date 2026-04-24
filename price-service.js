/**
 * price-service.js
 * Fetches NAVX, haSUI, and SUI prices for slippage-adjusted reward calculation.
 * Uses: CoinGecko (primary), Binance (SUI fallback)
 */

import axios from "axios";

const CACHE_TTL_MS = 60_000;
let priceCache = { navx: null, hasui: null, sui: null, navxChange24h: null };
let priceCacheTime = 0;

async function fetchJSON(url) {
  const { data } = await axios.get(url, { timeout: 15000 });
  return data;
}

async function getNAVXPrice() {
  if (Date.now() - priceCacheTime < CACHE_TTL_MS && priceCache.navx) {
    return { price: priceCache.navx, change24h: priceCache.navxChange24h };
  }
  try {
    const cg = await fetchJSON('https://api.coingecko.com/api/v3/simple/price?ids=navi&vs_currencies=usd&include_24hr_change=true');
    const price = cg?.navi?.usd || null;
    const change24h = cg?.navi?.usd_24h_change || null;
    priceCache.navx = price;
    priceCache.navxChange24h = change24h;
    priceCacheTime = Date.now();
    return { price, change24h };
  } catch (e) {
    console.error('[price-service] CoinGecko NAVX failed:', e.message);
    return { price: priceCache.navx, change24h: priceCache.navxChange24h };
  }
}

async function gethaSUIPrice() {
  if (Date.now() - priceCacheTime < CACHE_TTL_MS && priceCache.hasui) {
    return priceCache.hasui;
  }
  try {
    const cg = await fetchJSON('https://api.coingecko.com/api/v3/simple/price?ids=haedal-staked-sui&vs_currencies=usd&include_24hr_change=true');
    if (cg?.['haedal-staked-sui']?.usd) {
      priceCache.hasui = cg['haedal-staked-sui'].usd;
      priceCacheTime = Date.now();
      return priceCache.hasui;
    }
  } catch (e) {
    console.log('[price-service] CoinGecko haSUI failed, proxying from SUI');
  }
  return getSUIPrice();
}

async function getSUIPrice() {
  if (Date.now() - priceCacheTime < CACHE_TTL_MS && priceCache.sui) {
    return priceCache.sui;
  }
  try {
    const data = await fetchJSON('https://api.binance.com/api/v3/ticker/price?symbol=SUIUSDT');
    const price = parseFloat(data?.price) || null;
    priceCache.sui = price;
    priceCacheTime = Date.now();
    return price;
  } catch (e) {
    console.error('[price-service] SUI Binance failed:', e.message);
    return priceCache.sui || 0;
  }
}

async function getLSTDepegStatus() {
  const [hasuiPrice, suiPrice] = await Promise.all([gethaSUIPrice(), getSUIPrice()]);
  if (!hasuiPrice || !suiPrice) return { ratio: 1, status: 'unknown', premium_bps: 0 };
  const ratio = hasuiPrice / suiPrice;
  const premiumBps = (ratio - 1) * 10000;
  return {
    ratio,
    status: ratio > 1.001 ? 'premium' : ratio < 0.999 ? 'discount' : 'par',
    premium_bps: Math.round(premiumBps)
  };
}

async function getNAVXSlippageAdjustedReward(weeklyRewardPerDollar) {
  const navxData = await getNAVXPrice();
  if (!navxData.price) return null;
  const SLIPPAGE_FACTOR = 0.98;
  return weeklyRewardPerDollar * 52 * navxData.price * SLIPPAGE_FACTOR;
}

export {
  getNAVXPrice,
  gethaSUIPrice,
  getSUIPrice,
  getLSTDepegStatus,
  getNAVXSlippageAdjustedReward
};