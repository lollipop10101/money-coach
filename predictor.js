/**
 * predictor.js
 * Fetches BTC/ETH/SUI prices, computes technical indicators,
 * and calls Ollama for regime classification.
 *
 * Returns structured prediction output for use by selector.js.
 */

import axios from "axios";

const API = "https://api.coingecko.com/api/v3/simple/price";
const BINANCE_API = "https://api.binance.com/api/v3";
const OLLAMA_URL = "http://localhost:11434/api/generate";
const MODEL = "qwen2.5:7b";

/**
 * Fetch current spot prices from CoinGecko
 * Includes 24h price change data
 */
async function fetchSpotPrices() {
  try {
    const res = await axios.get(API, {
      params: {
        ids: "bitcoin,sui,ethereum",
        vs_currencies: "usd",
        include_24hr_change: true,
      },
      timeout: 15000,
    });
    return res.data;
  } catch (e) {
    console.error("CoinGecko price fetch failed:", e.message);
    return null;
  }
}

/**
 * Fetch Binance kline data for BTC
 */
async function fetchBinanceKlines() {
  try {
    const res = await axios.get(`${BINANCE_API}/klines?symbol=BTCUSDT&interval=1h&limit=100`, { timeout: 15000 });
    return res.data;
  } catch (e) {
    console.error("Binance klines fetch failed:", e.message);
    return null;
  }
}

/**
 * Calculate Moving Average
 */
function calculateMA(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((sum, v) => sum + v, 0) / period;
}

/**
 * Calculate RSI (Wilder's smoothed)
 * Returns a value between 0-100
 */
function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const changes = [];
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    changes.push({
      price: closes[i],
      diff,
      gain: diff > 0 ? diff : 0,
      loss: diff < 0 ? Math.abs(diff) : 0,
    });
  }

  if (changes.length < period) return null;

  let avgGain = changes.slice(0, period).reduce((s, c) => s + c.gain, 0) / period;
  let avgLoss = changes.slice(0, period).reduce((s, c) => s + c.loss, 0) / period;

  for (let i = period; i < changes.length; i++) {
    avgGain = (avgGain * (period - 1) + changes[i].gain) / period;
    avgLoss = (avgLoss * (period - 1) + changes[i].loss) / period;
  }

  const rs = avgLoss > 0 ? avgGain / avgLoss : 100;
  return 100 - 100 / (1 + rs);
}

/**
 * Calculate MACD (12, 26, 9)
 * Returns { macd, signal, histogram }
 */
function calculateMACD(closes, fast = 12, slow = 26, signalPeriod = 9) {
  if (closes.length < Math.max(fast, slow) + signalPeriod) return null;

  const ema = (prices, period) => {
    if (prices.length < period) return [];
    const multiplier = 2 / (period + 1);

    let emaValues = [];
    let sum = 0;
    for (let i = 0; i < period; i++) sum += prices[i];
    let emaValue = sum / period;
    emaValues.push(emaValue);

    for (let i = period; i < prices.length; i++) {
      emaValue = (prices[i] - emaValue) * multiplier + emaValue;
      emaValues.push(emaValue);
    }
    return emaValues;
  };

  const fastEMA = ema(closes, fast);
  const slowEMA = ema(closes, slow);
  const macdLine = fastEMA.map((v, i) => v - slowEMA[i]);

  // Signal line is EMA of MACD line
  const signalLine = ema(macdLine, signalPeriod);

  const histogram = macdLine.map((v, i) => v - signalLine[i]);

  return {
    macd: macdLine[macdLine.length - 1] || macdLine[macdLine.length - 2] || 0,
    signal: signalLine[signalPeriod - 1] || 0,
    histogram: histogram[histogram.length - 1] || histogram[histogram.length - 2] || 0,
  };
}

/**
 * Call Ollama for regime classification
 */
async function callOllama(prompt) {
  try {
    const res = await axios.post(
      OLLAMA_URL,
      { model: MODEL, prompt, stream: false },
      { timeout: 30000, headers: { "Content-Type": "application/json" } }
    );

    const text = res.data?.result || "";
    // Try to extract JSON from response
    try {
      const parsed = JSON.parse(text);
      return parsed;
    } catch {
      // Try to extract JSON-like content
      const jsonStr = text.match(/\{[^}]*\}/s)?.[0] || "{}";
      const parsed = JSON.parse(jsonStr);
      return parsed;
    }
  } catch (e) {
    console.error("Ollama call failed:", e.message);
    return null;
  }
}

/**
 * Main prediction function
 * Fetches price data, computes technical indicators,
 * calls Ollama for regime classification.
 */
export async function getMarketPrediction() {
  // Step 1: Fetch spot prices
  const spotData = await fetchSpotPrices();
  if (!spotData) {
    console.error("Failed to fetch spot prices");
    return { prediction: "SIDEWAYS", confidence: 0, btc_price: 0, error: "price_fetch_failed" };
  }

  const btcPrice = spotData.bitcoin?.usd || 0;
  const btc24hChange = spotData.bitcoin?.usd_24h_change || 0; // Use 24h change from CG
  const btc24hChangeRate = btc24hChange || 0; // percentage

  // Step 2: Fetch Binance klines for indicators
  const klines = await fetchBinanceKlines();
  if (!klines || klines.length < 50) {
    // Use spot prices only as fallback
    const fallback = {
      prediction: "SIDEWAYS",
      confidence: 30,
      btc_price: btcPrice,
      change_24h: btc24hChangeRate,
      rsi: 50,
      ma5: btcPrice,
      ma20: btcPrice,
      macd: { macd: 0, signal: 0, histogram: 0 },
      timestamp: new Date().toISOString(),
    };

    // Try deterministic scoring with spot data
    const deterministicPrediction = btc24hChangeRate > 0 ? "BULL" : btc24hChangeRate < 0 ? "BEAR" : "SIDEWAYS";
    const deterministicConfidence = Math.min(Math.abs(btc24hChangeRate) * 5, 50);

    const llmResult = await callOllama(fallback);
    if (llmResult && llmResult.regime) {
      return { ...fallback, prediction: llmResult.regime, confidence: llmResult.confidence || deterministicConfidence, reason: llmResult.reason };
    }
    return { ...fallback, prediction: deterministicPrediction, confidence: deterministicConfidence };
  }

  // Step 3: Extract closing prices from klines (column index 4 = close price)
  const closes = klines.map((k) => parseFloat(k[4])).filter((p) => !isNaN(p));

  // Step 4: Compute indicators
  const ma5 = calculateMA(closes, 5);
  const ma20 = calculateMA(closes, 20);
  const rsi = calculateRSI(closes, 14);
  const macd = calculateMACD(closes, 12, 26, 9);

  // Step 5: Compute deterministic score
  let score = 0;
  if (ma5 > ma20) score += 1;
  else score -= 1;

  if (macd && macd.histogram > 0) score += 1;
  else if (macd && macd.histogram <= 0) score -= 1;

  if (rsi && rsi > 60) score += 1;
  else if (rsi && rsi < 40) score -= 1;

  const deterministicPrediction = score >= 2 ? "BULL" : score <= -2 ? "BEAR" : "SIDEWAYS";
  const deterministicConfidence = Math.min(Math.abs(score) * 30, 100);

  // Step 6: Build prompt for Ollama
  const prompt = `You are a market regime classifier for cryptocurrency trading.
Analyze these BTC indicators and return ONLY a JSON object with regime, confidence, and reason.

BTC Price: ${btcPrice}
24h Change: ${btc24hChangeRate.toFixed(2)}%
MA5 (5h MA): ${ma5 ? ma5.toFixed(2) : "N/A"}
MA20 (20h MA): ${ma20 ? ma20.toFixed(2) : "N/A"}
RSI(14): ${rsi ? rsi.toFixed(1) : "N/A"}
MACD Histogram: ${macd ? macd.histogram.toFixed(2) : "N/A"}

Rules:
- MA5 > MA20 = bullish momentum, MA5 < MA20 = bearish momentum
- RSI > 60 = bullish, RSI < 40 = bearish, RSI 40-60 = neutral
- MACD histogram > 0 = bullish, MACD histogram < 0 = bearish
- Consider the overall trend direction, not just one indicator.

Return ONLY valid JSON with no markdown wrapping:
{"regime":"BULL|BEAR|SIDEWAYS","confidence":0-100,"reason":"short explanation"}
`;

  // Step 7: Call Ollama
  const llmResult = await callOllama(prompt);

  return {
    prediction: llmResult?.regime || deterministicPrediction,
    confidence: llmResult?.confidence || deterministicConfidence,
    btc_price: btcPrice,
    change_24h: btc24hChangeRate,
    rsi: rsi || 50,
    ma5: ma5 || btcPrice,
    ma20: ma20 || btcPrice,
    macd: macd || { macd: 0, signal: 0, histogram: 0 },
    reason: llmResult?.reason || "",
    timestamp: new Date().toISOString(),
  };
}

export { callOllama, calculateMA, calculateRSI, calculateMACD, fetchBinanceKlines };
