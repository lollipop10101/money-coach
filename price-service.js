import { spawn } from 'child_process';

const CACHE_TTL_MS = 10 * 60 * 1000;
let _navxCache = { price: null, change24h: null, ts: 0 };
let _suiCache = { price: null, change24h: null, ts: 0 };
let _lstCache = { ratio: null, ts: 0 };

function curl(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = spawn('/usr/bin/curl', [
      '-s', '-m', String(Math.floor(timeoutMs / 1000)),
      '-H', 'Accept: application/json', url
    ]);
    let out = '';
    req.stdout.on('data', d => (out += d));
    req.on('close', code => { if (code !== 0) return reject(new Error('curl exit ' + code)); resolve(out); });
    req.on('error', reject);
  });
}

export async function getNAVXPrice() {
  const now = Date.now();
  if (_navxCache.ts && now - _navxCache.ts < CACHE_TTL_MS)
    return { price: _navxCache.price, change24h: _navxCache.change24h, source: 'cache' };
  try {
    const raw = await curl('https://api.coingecko.com/api/v3/simple/price?ids=navi&vs_currencies=usd&include_24hr_change=true');
    const d = JSON.parse(raw);
    const price = d?.navi?.usd;
    const change24h = d?.navi?.usd_24h_change;
    if (price != null) { _navxCache = { price, change24h: change24h ?? null, ts: now }; return { price, change24h: change24h ?? null, source: 'coingecko' }; }
  } catch {}
  if (_navxCache.price != null) return { price: _navxCache.price, change24h: _navxCache.change24h, source: 'cache-stale' };
  return null;
}

export async function getSUIPrice() {
  const now = Date.now();
  if (_suiCache.ts && now - _suiCache.ts < CACHE_TTL_MS)
    return { price: _suiCache.price, change24h: _suiCache.change24h, source: 'cache' };
  try {
    const raw = await curl('https://api.binance.com/api/v3/ticker/price?symbol=SUIUSDT');
    const d = JSON.parse(raw);
    const price = parseFloat(d?.price);
    if (!price) throw new Error('no price');
    let change24h = null;
    try { const cr = await curl('https://api.binance.com/api/v3/ticker/24hr?symbol=SUIUSDT'); const cd = JSON.parse(cr); change24h = parseFloat(cd?.priceChangePercent); } catch {}
    _suiCache = { price, change24h: change24h ?? null, ts: now };
    return { price, change24h: change24h ?? null, source: 'binance' };
  } catch { return _suiCache.price != null ? { price: _suiCache.price, change24h: _suiCache.change24h, source: 'cache-stale' } : null; }
}

export async function getLSTDepegStatus() {
  const now = Date.now();
  if (_lstCache.ts && now - _lstCache.ts < CACHE_TTL_MS)
    return { ratio: _lstCache.ratio, ts: _lstCache.ts, source: 'cache' };
  try {
    const [hasuiRaw, suiRaw] = await Promise.all([
      curl('https://api.coingecko.com/api/v3/simple/price?ids=haedal-staked-sui&vs_currencies=usd'),
      curl('https://api.binance.com/api/v3/ticker/price?symbol=SUIUSDT')
    ]);
    const hd = JSON.parse(hasuiRaw) || {};
    const sd = JSON.parse(suiRaw) || {};
    const hasuiUsd = hd['haedal-staked-sui']?.usd;
    const suiUsd = parseFloat(sd.price);
    if (!hasuiUsd || !suiUsd) throw new Error('missing price');
    const ratio = hasuiUsd / suiUsd;
    const premium_bps = Math.round((ratio - 1) * 10000);
    let status = ratio > 1.001 ? 'PREMIUM' : ratio < 0.999 ? 'DISCOUNT' : 'PAR';
    _lstCache = { ratio, ts: now };
    return { ratio, status, premium_bps, source: 'coingecko+binance' };
  } catch { return _lstCache.ratio != null ? { ratio: _lstCache.ratio, ts: _lstCache.ts, source: 'cache-stale' } : null; }
}

export async function getAllPrices() {
  const [navx, sui, lst] = await Promise.all([getNAVXPrice(), getSUIPrice(), getLSTDepegStatus()]);
  return { navx, sui, lst };
}
