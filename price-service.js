/**
 * price-service.js
 * Fetches NAVX and haSUI prices for slippage-adjusted reward calculation.
 */

const COINGECKO_API = 'https://api.coingecko.net/api/v3';

// NAVX coin ID on CoinGecko (to be confirmed — may need search)
const COINGECKO_IDS = {
  NAVX: 'navi',                 // confirmed: https://www.coingecko.com/en/coins/navi
  haSUI: 'haedal-staked-sui',   // confirmed via CoinGecko search API
  SUI: 'sui'
};

let priceCache = { navx: null, hasui: null, sui: null, navxChange24h: null };
let priceCacheTime = 0;
const CACHE_TTL_MS = 60_000; // 1 minute

/**
 * Fetch NAVX price in USDC.
 * @returns {Promise<{price: number|null, change24h: number|null}>}
 */
export async function getNAVXPrice() {
  if (Date.now() - priceCacheTime < CACHE_TTL_MS && priceCache.navx) {
    return { price: priceCache.navx, change24h: priceCache.navxChange24h };
  }
  try {
    const data = await fetch(`${COINGECKO_API}/simple/price?ids=${COINGECKO_IDS.NAVX}&vs_currencies=usd&include_24hr_change=true`)
      .then(r => r.json());
    priceCache.navx = data[COINGECKO_IDS.NAVX]?.usd || null;
    priceCache.navxChange24h = data[COINGECKO_IDS.NAVX]?.usd_24h_change || null;
    priceCacheTime = Date.now();
    return { price: priceCache.navx, change24h: priceCache.navxChange24h };
  } catch (e) {
    console.error('[price-service] NAVX fetch failed:', e.message);
    return { price: priceCache.navx || null, change24h: priceCache.navxChange24h || null };
  }
}

/**
 * Fetch haSUI price in USDC.
 * @returns {Promise<number|null>}
 */
export async function gethaSUIPrice() {
  if (Date.now() - priceCacheTime < CACHE_TTL_MS && priceCache.hasui) {
    return priceCache.hasui;
  }
  try {
    // First try CoinGecko
    const data = await fetch(`${COINGECKO_API}/simple/price?ids=${COINGECKO_IDS.haSUI}&vs_currencies=usd&include_24hr_change=true`)
      .then(r => r.json());
    if (data[COINGECKO_IDS.haSUI]?.usd) {
      priceCache.hasui = data[COINGECKO_IDS.haSUI].usd;
      priceCacheTime = Date.now();
      return priceCache.hasui;
    }
  } catch (e) {
    console.log('[price-service] CoinGecko haSUI failed, trying fallback...');
  }

  // Fallback: approximate with SUI price (haSUI tracks SUI 1:1)
  try {
    const suiPrice = await getSUIPrice();
    return suiPrice; // placeholder until BlueMove API confirmed
  } catch (e) {
    return null;
  }
}

/**
 * Fetch SUI price in USDC.
 * @returns {Promise<number>}
 */
export async function getSUIPrice() {
  try {
    const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=SUIUSDT`).then(r => r.json());
    return parseFloat(res.price);
  } catch (e) {
    // Fallback to CoinGecko
    const data = await fetch(`${COINGECKO_API}/simple/price?ids=${COINGECKO_IDS.SUI}&vs_currencies=usd`)
      .then(r => r.json());
    return data[COINGECKO_IDS.SUI]?.usd || 0;
  }
}

/**
 * Get LST depeg status (haSUI vs SUI).
 * @returns {Promise<{ratio: number, status: 'premium'|'par'|'discount', premium_bps: number}>}
 */
export async function getLSTDepegStatus() {
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

/**
 * NAVX slippage-adjusted reward calculation.
 * Applies conservative 2% sell pressure factor.
 * @param {number} weeklyRewardPerDollar - NAVX rewards earned per USDC supplied per week
 * @returns {Promise<number|null>}
 */
export async function getNAVXSlippageAdjustedReward(weeklyRewardPerDollar) {
  const navxData = await getNAVXPrice();
  if (!navxData.price) return null;

  const SLIPPAGE_FACTOR = 0.98; // 2% sell pressure
  const grossAnnual = weeklyRewardPerDollar * 52 * navxData.price;
  return grossAnnual * SLIPPAGE_FACTOR;
}
