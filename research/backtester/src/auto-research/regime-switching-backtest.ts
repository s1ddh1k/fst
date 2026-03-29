/**
 * Regime-switching backtester.
 *
 * Runs a backtest where the active strategy changes based on detected market regime.
 * This tests the hypothesis: "if we knew the regime, could we switch strategies for max return?"
 *
 * Modes:
 *   1. oracle   — uses future data to pick regime (upper bound, not achievable)
 *   2. lagged   — detects regime from past N bars (realistic, delayed)
 *   3. manual   — user specifies regime periods (for testing specific date ranges)
 *
 * Usage:
 *   runRegimeSwitchingBacktest({
 *     strategies: {
 *       trend_up: null,        // B&H (no active trading)
 *       trend_down: createVolumeExhaustionBounceStrategy({ ... }),
 *       range: createSimpleRsiReversionStrategy({ ... }),
 *     },
 *     candles: { "KRW-BTC": [...] },
 *     timeframe: "1h",
 *     regimeDetector: "lagged",
 *     initialCapital: 1_000_000,
 *   })
 */

import type { Candle } from "../types.js";
import type { ScoredStrategy, StrategyContext, SignalResult } from "../../../strategies/src/types.js";
import { buildMarketStateContexts } from "../../../strategies/src/market-state.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RegimeType = "trend_up" | "trend_down" | "range" | "volatile";

export type RegimeStrategyEntry = {
  strategy: ScoredStrategy | null; // null = B&H
  timeframe: "1h" | "15m" | "5m";
} | null; // null = B&H on 1h

export type RegimeStrategyMap = Partial<Record<RegimeType, RegimeStrategyEntry>>;
// null or { strategy: null } = B&H
// undefined = stay in cash
// { strategy: ..., timeframe: "15m" } = run strategy on 15m candles

export type RegimeDetectorMode = "oracle" | "sma" | "trailing-stop" | "momentum" | "microstructure" | "momentum-micro" | "adaptive" | "adaptive-v2";

export type RegimeSwitchingConfig = {
  strategies: RegimeStrategyMap;
  /** Candles by timeframe by market. E.g. { "1h": { "KRW-BTC": [...] }, "15m": { "KRW-BTC": [...] } } */
  candlesByTimeframeAndMarket: Record<string, Record<string, Candle[]>>;
  /** Primary timeframe for regime detection and bar-by-bar stepping */
  primaryTimeframe: "1h" | "15m";
  regimeDetector: RegimeDetectorMode;
  /** Trailing stop: switch from bull to bear when price drops this % from peak */
  trailingStopDropPct?: number;  // default: 0.15 (15%)
  /** Trailing stop: switch from bear to bull when price rises this % from trough */
  trailingStopRecoverPct?: number; // default: 0.20 (20%)
  initialCapital: number;
  feePct?: number; // per-side fee (default: 0.025%)
  switchCooldownBars?: number; // min bars between regime switches (default: 168 = 1 week on 1h)
  /** Portfolio trailing stop: force to cash if equity drops this % from peak (default: disabled) */
  portfolioStopPct?: number;
  /** Bars to wait before re-entering after portfolio stop (default: 72) */
  portfolioStopCooldown?: number;
};

export type RegimeSwitchingResult = {
  netReturn: number;
  grossReturn: number;
  maxDrawdown: number;
  totalTrades: number;
  regimeSwitches: number;
  feesPaid: number;
  periods: Array<{
    startBar: number;
    endBar: number;
    regime: RegimeType;
    strategy: string | "B&H" | "cash";
    periodReturn: number;
  }>;
  equityCurve: number[];
  buyAndHoldReturn: number;
};

// ---------------------------------------------------------------------------
// Regime detection
// ---------------------------------------------------------------------------

function sma(candles: Candle[], endIndex: number, period: number): number | null {
  if (endIndex < period - 1) return null;
  let sum = 0;
  for (let i = endIndex - period + 1; i <= endIndex; i++) {
    sum += candles[i].closePrice;
  }
  return sum / period;
}

// Stateful detector for trailing-stop mode
type TrailingStopState = {
  peak: number;
  trough: number;
  currentRegime: RegimeType;
};

let trailingState: TrailingStopState | null = null;
let adaptiveScore = 0; // exposed for confidence weighting in main loop

function resetTrailingState() {
  trailingState = null;
}

function detectRegimeAtBar(
  candles: Candle[],
  index: number,
  candlesByMarket: Record<string, Candle[]>,
  mode: RegimeDetectorMode,
  config?: RegimeSwitchingConfig
): RegimeType {
  const close = candles[index].closePrice;

  if (mode === "oracle") {
    if (index < 56) return "range";
    const lookForward = Math.min(72, candles.length - index - 1);
    if (lookForward < 24) return "range";
    const futureReturn = (candles[index + lookForward].closePrice - close) / close;
    if (futureReturn > 0.08) return "trend_up";
    if (futureReturn < -0.08) return "trend_down";
    return "range";
  }

  if (mode === "trailing-stop") {
    const dropPct = config?.trailingStopDropPct ?? 0.15;
    const recoverPct = config?.trailingStopRecoverPct ?? 0.20;

    if (!trailingState) {
      trailingState = { peak: close, trough: close, currentRegime: "trend_up" };
    }

    // Update peak and trough
    if (close > trailingState.peak) trailingState.peak = close;
    if (close < trailingState.trough) trailingState.trough = close;

    const dropFromPeak = (trailingState.peak - close) / trailingState.peak;
    const riseFromTrough = (close - trailingState.trough) / trailingState.trough;

    if (trailingState.currentRegime === "trend_up" && dropFromPeak >= dropPct) {
      // Bull → Bear: price dropped enough from peak
      trailingState.currentRegime = "trend_down";
      trailingState.trough = close; // reset trough
    } else if (trailingState.currentRegime === "trend_down" && riseFromTrough >= recoverPct) {
      // Bear → Bull: price recovered enough from trough
      trailingState.currentRegime = "trend_up";
      trailingState.peak = close; // reset peak
    }

    return trailingState.currentRegime;
  }

  if (mode === "momentum") {
    if (index < 168) return "range";

    // 7-day ROC
    const weekAgo = candles[index - 168]?.closePrice;
    // 30-day ROC
    const monthAgo = candles[index - Math.min(720, index)]?.closePrice;
    if (!weekAgo || !monthAgo) return "range";

    const weekRoc = (close - weekAgo) / weekAgo;
    const monthRoc = (close - monthAgo) / monthAgo;

    // Both positive and strong → trend_up
    if (weekRoc > 0.03 && monthRoc > 0.10) return "trend_up";
    // Both negative and strong → trend_down
    if (weekRoc < -0.03 && monthRoc < -0.10) return "trend_down";
    return "range";
  }

  if (mode === "microstructure") {
    if (index < 336) return "range"; // need 2 weeks history

    const close = candles[index].closePrice;

    // 1. Volume acceleration: compare recent 24h avg volume to 7d avg volume
    let vol24h = 0, vol7d = 0;
    for (let j = index - 23; j <= index; j++) vol24h += candles[j].volume;
    for (let j = index - 167; j <= index; j++) vol7d += candles[j].volume;
    vol24h /= 24;
    vol7d /= 168;
    const volumeAccel = vol7d > 0 ? vol24h / vol7d : 1;

    // 2. Buying pressure: (close - low) / (high - low), averaged over 24 bars
    let buyPressure = 0;
    for (let j = index - 23; j <= index; j++) {
      const range = candles[j].highPrice - candles[j].lowPrice;
      buyPressure += range > 0 ? (candles[j].closePrice - candles[j].lowPrice) / range : 0.5;
    }
    buyPressure /= 24;

    // 3. Trend strength: 7d return + 30d return
    const weekAgo = candles[index - 168]?.closePrice ?? close;
    const monthAgo = candles[index - Math.min(720, index)]?.closePrice ?? close;
    const weekReturn = (close - weekAgo) / weekAgo;
    const monthReturn = (close - monthAgo) / monthAgo;

    // 4. Volatility compression: 24h range vs 7d range
    let high24 = 0, low24 = Infinity, high7d = 0, low7d = Infinity;
    for (let j = index - 23; j <= index; j++) {
      high24 = Math.max(high24, candles[j].highPrice);
      low24 = Math.min(low24, candles[j].lowPrice);
    }
    for (let j = index - 167; j <= index; j++) {
      high7d = Math.max(high7d, candles[j].highPrice);
      low7d = Math.min(low7d, candles[j].lowPrice);
    }
    const range24 = close > 0 ? (high24 - low24) / close : 0;
    const range7d = close > 0 ? (high7d - low7d) / close : 0;
    const volCompression = range7d > 0 ? range24 / range7d : 1;

    // 5. Consecutive direction: count recent up vs down bars (48h)
    let upBars = 0;
    for (let j = index - 47; j <= index; j++) {
      if (candles[j].closePrice > candles[j].openPrice) upBars++;
    }
    const upRatio = upBars / 48;

    // Scoring: combine signals
    let bullScore = 0;
    let bearScore = 0;

    // Volume spike + buying pressure = accumulation (bullish)
    if (volumeAccel > 1.5 && buyPressure > 0.6) bullScore += 2;
    // Volume spike + selling pressure = distribution (bearish)
    if (volumeAccel > 1.5 && buyPressure < 0.4) bearScore += 2;

    // Trend confirmation
    if (weekReturn > 0.03 && monthReturn > 0.05) bullScore += 2;
    if (weekReturn < -0.03 && monthReturn < -0.05) bearScore += 2;

    // Momentum
    if (upRatio > 0.6) bullScore += 1;
    if (upRatio < 0.4) bearScore += 1;

    // Volatility compression = range-bound
    if (volCompression < 0.3) return "range";

    // Strong signals needed for trend calls
    if (bullScore >= 3 && bearScore <= 1) return "trend_up";
    if (bearScore >= 3 && bullScore <= 1) return "trend_down";
    return "range";
  }

  if (mode === "adaptive-v2" as string) { // disabled — breadth signals hurt performance
    if (index < 720) return "range";

    const close = candles[index].closePrice;

    // ── 1. MULTI-MARKET BREADTH (strongest leading signal) ──
    // Count how many markets are above/below their own SMA(168)
    const allMarkets = Object.entries(candlesByMarket);
    let marketsAboveSma = 0;
    let marketsTotal = 0;
    let marketMomentumSum = 0;
    for (const [, mktCandles] of allMarkets) {
      if (mktCandles.length < 200) continue;
      // Find the candle at or before current time
      const currentTime = candles[index].candleTimeUtc.getTime();
      let mktIdx = -1;
      for (let j = Math.min(index, mktCandles.length - 1); j >= 0; j--) {
        if (mktCandles[j].candleTimeUtc.getTime() <= currentTime) { mktIdx = j; break; }
      }
      if (mktIdx < 168) continue;

      const mktClose = mktCandles[mktIdx].closePrice;
      const mktSma168 = sma(mktCandles, mktIdx, 168);
      if (!mktSma168) continue;

      marketsTotal++;
      if (mktClose > mktSma168) marketsAboveSma++;

      const mktWeekAgo = mktCandles[mktIdx - 168]?.closePrice;
      if (mktWeekAgo) marketMomentumSum += (mktClose - mktWeekAgo) / mktWeekAgo;
    }
    const breadthRatio = marketsTotal > 0 ? marketsAboveSma / marketsTotal : 0.5;
    const avgMarketMomentum = marketsTotal > 0 ? marketMomentumSum / marketsTotal : 0;

    // ── 2. BTC-specific signals (same as adaptive v1) ──
    const sma50 = sma(candles, index, 50)!;
    const sma200 = sma(candles, index, 200)!;
    const priceAboveSma200 = close > sma200;
    const goldenCross = sma50 > sma200;

    // Volume-price divergence
    const lookback = 336;
    const halfLookback = 168;
    let obvNow = 0, obvHalf = 0;
    for (let j = index - lookback + 1; j <= index; j++) {
      const dir = candles[j].closePrice > candles[j - 1]?.closePrice ? 1 : -1;
      if (j <= index - halfLookback) obvHalf += dir * candles[j].volume;
      obvNow += dir * candles[j].volume;
    }
    const obvSlope = obvNow - obvHalf;
    const priceSlope = close - (candles[index - lookback]?.closePrice ?? close);
    const bearishDivergence = priceSlope > 0 && obvSlope < 0;
    const bullishDivergence = priceSlope < 0 && obvSlope > 0;

    // Volatility
    let atr24h = 0, atr7d = 0;
    for (let j = index - 23; j <= index; j++) atr24h += candles[j].highPrice - candles[j].lowPrice;
    for (let j = index - 167; j <= index; j++) atr7d += candles[j].highPrice - candles[j].lowPrice;
    atr24h /= 24; atr7d /= 168;
    const volAccel = atr7d > 0 ? atr24h / atr7d : 1;

    // Momentum
    const weekAgo = candles[index - 168]?.closePrice ?? close;
    const monthAgo = candles[index - 720]?.closePrice ?? close;
    const weekReturn = (close - weekAgo) / weekAgo;
    const monthReturn = (close - monthAgo) / monthAgo;

    // Candle structure
    let upperWickSum = 0, lowerWickSum = 0, bodySum = 0;
    for (let j = index - 47; j <= index; j++) {
      const body = Math.abs(candles[j].closePrice - candles[j].openPrice);
      upperWickSum += candles[j].highPrice - Math.max(candles[j].openPrice, candles[j].closePrice);
      lowerWickSum += Math.min(candles[j].openPrice, candles[j].closePrice) - candles[j].lowPrice;
      bodySum += body;
    }
    const upperWickRatio = bodySum > 0 ? upperWickSum / bodySum : 1;
    const lowerWickRatio = bodySum > 0 ? lowerWickSum / bodySum : 1;

    // ── SCORING (v2: breadth signal added with high weight) ──
    let score = 0;

    // Market breadth (+/- 2, pure confirmation — most markets agree)
    if (breadthRatio > 0.60 && avgMarketMomentum > 0.01) score += 2;
    else if (breadthRatio < 0.40 && avgMarketMomentum < -0.01) score -= 2;

    // Volume divergence (+/- 3)
    if (bullishDivergence) score += 3;
    if (bearishDivergence) score -= 3;

    // Price structure (+/- 2)
    if (priceAboveSma200 && goldenCross) score += 2;
    else if (!priceAboveSma200 && !goldenCross) score -= 2;

    // Momentum (+/- 2)
    if (weekReturn > 0.03 && monthReturn > 0.05) score += 2;
    else if (weekReturn < -0.03 && monthReturn < -0.05) score -= 2;

    // Candle structure (+/- 1)
    if (lowerWickRatio > upperWickRatio * 1.5) score += 1;
    if (upperWickRatio > lowerWickRatio * 1.5) score -= 1;

    // Vol spike warning (+/- 2)
    if (volAccel > 2.0 && weekReturn < -0.02) score -= 2;
    if (volAccel > 2.0 && weekReturn > 0.02) score += 1;

    // Asymmetric: fast exit, slow entry
    if (score >= 5) return "trend_up";
    if (score <= -2) return "trend_down";
    return "range";
  }

  if (mode === "adaptive") {
    if (index < 720) return "range";

    const close = candles[index].closePrice;

    // ── 1. PRICE STRUCTURE (lagging but reliable) ──
    const sma50 = sma(candles, index, 50)!;
    const sma200 = sma(candles, index, 200)!;
    const priceAboveSma200 = close > sma200;
    const goldenCross = sma50 > sma200;

    // ── 2. VOLUME-PRICE DIVERGENCE (leading) ──
    // Compare price slope vs OBV slope over 2 weeks
    const lookback = 336; // 14 days
    const halfLookback = 168;
    let obvNow = 0, obvHalf = 0;
    for (let j = index - lookback + 1; j <= index; j++) {
      const dir = candles[j].closePrice > candles[j - 1]?.closePrice ? 1 : -1;
      if (j <= index - halfLookback) obvHalf += dir * candles[j].volume;
      obvNow += dir * candles[j].volume;
    }
    const obvSlope = obvNow - obvHalf; // positive = volume supporting price move
    const priceSlope = close - (candles[index - lookback]?.closePrice ?? close);
    // Divergence: price up but OBV down = distribution (bearish leading)
    const bearishDivergence = priceSlope > 0 && obvSlope < 0;
    // Divergence: price down but OBV up = accumulation (bullish leading)
    const bullishDivergence = priceSlope < 0 && obvSlope > 0;

    // ── 3. VOLATILITY REGIME (leading for transitions) ──
    // Bollinger width compression: low = squeeze = breakout imminent
    let sumClose = 0, sumSq = 0;
    for (let j = index - 19; j <= index; j++) { sumClose += candles[j].closePrice; }
    const mean20 = sumClose / 20;
    for (let j = index - 19; j <= index; j++) { sumSq += (candles[j].closePrice - mean20) ** 2; }
    const bbWidth = (2 * Math.sqrt(sumSq / 19)) / mean20; // normalized BB width

    // ATR acceleration: current 7d ATR vs 30d ATR
    let atr7d = 0, atr30d = 0;
    for (let j = index - 167; j <= index; j++) {
      const tr = Math.max(
        candles[j].highPrice - candles[j].lowPrice,
        Math.abs(candles[j].highPrice - (candles[j-1]?.closePrice ?? candles[j].openPrice)),
        Math.abs(candles[j].lowPrice - (candles[j-1]?.closePrice ?? candles[j].openPrice))
      );
      if (j > index - 168) atr7d += tr;
      atr30d += tr;
    }
    atr7d /= 168; atr30d /= 168;
    // Use more recent 24h for 7d approximation
    let atr24h = 0;
    for (let j = index - 23; j <= index; j++) {
      atr24h += Math.max(candles[j].highPrice - candles[j].lowPrice, 0);
    }
    atr24h /= 24;
    const volAccel = atr30d > 0 ? atr24h / atr30d : 1;

    // ── 4. CANDLE STRUCTURE (micro-leading) ──
    // Upper wick ratio = distribution, lower wick ratio = accumulation
    let upperWickSum = 0, lowerWickSum = 0, bodySum = 0;
    for (let j = index - 47; j <= index; j++) {
      const body = Math.abs(candles[j].closePrice - candles[j].openPrice);
      const upper = candles[j].highPrice - Math.max(candles[j].openPrice, candles[j].closePrice);
      const lower = Math.min(candles[j].openPrice, candles[j].closePrice) - candles[j].lowPrice;
      upperWickSum += upper;
      lowerWickSum += lower;
      bodySum += body;
    }
    const upperWickRatio = bodySum > 0 ? upperWickSum / bodySum : 1;
    const lowerWickRatio = bodySum > 0 ? lowerWickSum / bodySum : 1;

    // ── 5. MOMENTUM (confirmation) ──
    const weekAgo = candles[index - 168]?.closePrice ?? close;
    const monthAgo = candles[index - 720]?.closePrice ?? close;
    const weekReturn = (close - weekAgo) / weekAgo;
    const monthReturn = (close - monthAgo) / monthAgo;

    // ── SCORING ──
    let score = 0;

    // Price structure (+/- 2)
    if (priceAboveSma200 && goldenCross) score += 2;
    else if (!priceAboveSma200 && !goldenCross) score -= 2;

    // Volume divergence (+/- 3, leading signal gets higher weight)
    if (bullishDivergence) score += 3;
    if (bearishDivergence) score -= 3;

    // Momentum (+/- 2)
    if (weekReturn > 0.03 && monthReturn > 0.05) score += 2;
    else if (weekReturn < -0.03 && monthReturn < -0.05) score -= 2;

    // Candle structure (+/- 1)
    if (lowerWickRatio > upperWickRatio * 1.5) score += 1; // accumulation
    if (upperWickRatio > lowerWickRatio * 1.5) score -= 1; // distribution

    // Volatility warning: extreme vol acceleration = transition happening
    if (volAccel > 2.0) {
      // High vol + negative momentum = crash
      if (weekReturn < -0.02) score -= 2;
      // High vol + positive momentum = breakout
      if (weekReturn > 0.02) score += 1;
    }

    // ── ASYMMETRIC THRESHOLDS ──
    // Bull→Bear: fast (score <= -2, protect capital)
    // Bear→Bull: medium (score >= +4)
    // Range is default for uncertain signals
    adaptiveScore = score;
    if (score >= 4) return "trend_up";
    if (score <= -2) return "trend_down";
    return "range";
  }

  if (mode === "momentum-micro") {
    // Hybrid: momentum for primary direction, micro for confirmation
    if (index < 336) return "range";

    const close = candles[index].closePrice;
    const weekAgo = candles[index - 168]?.closePrice ?? close;
    const monthAgo = candles[index - Math.min(720, index)]?.closePrice ?? close;
    const weekRoc = (close - weekAgo) / weekAgo;
    const monthRoc = (close - monthAgo) / monthAgo;

    // Micro signals for confirmation
    let vol24h = 0, vol7d = 0;
    for (let j = index - 23; j <= index; j++) vol24h += candles[j].volume;
    for (let j = index - 167; j <= index; j++) vol7d += candles[j].volume;
    vol24h /= 24; vol7d /= 168;
    const volumeAccel = vol7d > 0 ? vol24h / vol7d : 1;

    let buyPressure = 0;
    for (let j = index - 47; j <= index; j++) {
      const range = candles[j].highPrice - candles[j].lowPrice;
      buyPressure += range > 0 ? (candles[j].closePrice - candles[j].lowPrice) / range : 0.5;
    }
    buyPressure /= 48;

    // Momentum says trend_up: need micro confirmation (buying pressure > 0.5)
    if (weekRoc > 0.03 && monthRoc > 0.10 && buyPressure > 0.5) return "trend_up";
    // Momentum says trend_up but micro says caution: stay range
    if (weekRoc > 0.03 && monthRoc > 0.10 && buyPressure <= 0.5) return "range";

    // Momentum says trend_down: confirm with selling pressure OR volume spike
    if (weekRoc < -0.03 && monthRoc < -0.10 && (buyPressure < 0.5 || volumeAccel > 1.5)) return "trend_down";
    // Momentum says trend_down but micro says buying: possibly bottoming → range
    if (weekRoc < -0.03 && monthRoc < -0.10 && buyPressure >= 0.5 && volumeAccel <= 1.5) return "range";

    // Early warning: volume spike + momentum divergence = potential transition
    // Momentum still neutral but volume exploding + strong selling = early bear signal
    if (volumeAccel > 2.0 && buyPressure < 0.35 && weekRoc < 0) return "trend_down";
    // Volume spike + strong buying + positive week = early bull signal
    if (volumeAccel > 2.0 && buyPressure > 0.65 && weekRoc > 0) return "trend_up";

    return "range";
  }

  // "sma" mode: original SMA-based detection
  if (index < 200) return "range";

  const smaLong = sma(candles, index, 168);
  const smaMid = sma(candles, index, 72);
  if (!smaLong || !smaMid) return "range";

  const monthAgoClose = candles[index - Math.min(720, index)]?.closePrice;
  if (!monthAgoClose) return "range";
  const monthReturn = (close - monthAgoClose) / monthAgoClose;

  if (close > smaLong && close > smaMid && smaMid > smaLong && monthReturn > 0.10) return "trend_up";
  if (close < smaLong && close < smaMid && smaMid < smaLong && monthReturn < -0.10) return "trend_down";
  return "range";
}

// ---------------------------------------------------------------------------
// Backtest engine
// ---------------------------------------------------------------------------

export function runRegimeSwitchingBacktest(config: RegimeSwitchingConfig): RegimeSwitchingResult {
  const feePct = config.feePct ?? 0.00025; // 0.025%
  const cooldown = config.switchCooldownBars ?? 168; // 1 week on 1h bars
  const primaryCandles = config.candlesByTimeframeAndMarket[config.primaryTimeframe];
  if (!primaryCandles) throw new Error(`No candles for primary timeframe ${config.primaryTimeframe}`);
  const market = Object.keys(primaryCandles)[0];
  const candles = primaryCandles[market];
  if (!candles || candles.length < 100) {
    throw new Error("Need at least 100 candles");
  }
  resetTrailingState();

  // Helper: get candles for a specific timeframe and market
  const getCandlesForTimeframe = (tf: string): Candle[] => {
    return config.candlesByTimeframeAndMarket[tf]?.[market] ?? candles;
  };

  let cash = config.initialCapital;
  let positionQty = 0;
  let positionEntryPrice = 0;
  let currentRegime: RegimeType = "range";
  let currentStrategyEntry: RegimeStrategyEntry | undefined = undefined;
  let barsSinceSwitch = cooldown; // allow immediate first switch
  let hasPosition = false;
  let totalTrades = 0;
  let peakEquity = config.initialCapital;
  let portfolioStopUntilBar = 0;
  let regimeSwitches = 0;
  let feesPaid = 0;
  const equityCurve: number[] = [config.initialCapital];
  const periods: RegimeSwitchingResult["periods"] = [];
  let periodStart = 56;

  // Helper: close position
  const closePosition = (price: number) => {
    if (!hasPosition) return;
    const notional = positionQty * price;
    const fee = notional * feePct;
    cash += notional - fee;
    feesPaid += fee;
    hasPosition = false;
    positionQty = 0;
    totalTrades++;
  };

  // Helper: open position with confidence-weighted allocation
  const openPosition = (price: number, allocationPct?: number) => {
    if (hasPosition) return;
    const pct = allocationPct ?? 0.95;
    const investable = cash * pct;
    const fee = investable * feePct;
    const qty = (investable - fee) / price;
    positionQty = qty;
    positionEntryPrice = price;
    cash -= investable;
    feesPaid += fee;
    hasPosition = true;
    totalTrades++;
  };

  // Main loop
  for (let i = 56; i < candles.length; i++) {
    const close = candles[i].closePrice;

    // Detect regime
    const detectedRegime = detectRegimeAtBar(candles, i, primaryCandles, config.regimeDetector, config);

    // Regime switch?
    if (detectedRegime !== currentRegime && barsSinceSwitch >= cooldown) {
      // Record period
      if (i > periodStart) {
        const startPrice = candles[periodStart].closePrice;
        const periodReturn = (close - startPrice) / startPrice;
        const isBH = currentStrategyEntry === null || (currentStrategyEntry && currentStrategyEntry.strategy === null);
  const stratName = isBH ? "B&H" : (currentStrategyEntry?.strategy?.name ?? "cash");
        periods.push({
          startBar: periodStart,
          endBar: i,
          regime: currentRegime,
          strategy: stratName,
          periodReturn
        });
      }

      // Close any active strategy position before switching
      if (hasPosition && currentStrategyEntry !== null) {
        closePosition(close);
      }

      currentRegime = detectedRegime;
      currentStrategyEntry = config.strategies[detectedRegime];
      barsSinceSwitch = 0;
      regimeSwitches++;
      periodStart = i;

      // Resolve: null entry or { strategy: null } = B&H
      const isBuyAndHold = currentStrategyEntry === null ||
        (currentStrategyEntry && currentStrategyEntry.strategy === null);
      const isNone = currentStrategyEntry === undefined;

      if (isBuyAndHold && !hasPosition) {
        openPosition(close);
      }
      if (isNone && hasPosition) {
        closePosition(close);
      }
    }

    barsSinceSwitch++;

    // Execute active strategy (may use different timeframe candles)
    const activeStrategy = currentStrategyEntry && currentStrategyEntry.strategy;
    if (activeStrategy) {
      const stratTf = currentStrategyEntry!.timeframe ?? config.primaryTimeframe;
      const stratCandles = getCandlesForTimeframe(stratTf);

      // Find the candle index in strategy's timeframe that corresponds to current time
      const currentTime = candles[i].candleTimeUtc.getTime();
      let stratIndex = -1;
      for (let j = stratCandles.length - 1; j >= 0; j--) {
        if (stratCandles[j].candleTimeUtc.getTime() <= currentTime) {
          stratIndex = j;
          break;
        }
      }

      if (stratIndex >= 0) {
        const ctx: StrategyContext = {
          candles: stratCandles,
          index: stratIndex,
          hasPosition,
          currentPosition: hasPosition ? {
            entryPrice: positionEntryPrice,
            barsHeld: barsSinceSwitch,
            quantity: positionQty
          } : undefined
        };

        const signal: SignalResult = activeStrategy.generateSignal(ctx);

        if (signal.signal === "BUY" && !hasPosition) {
          openPosition(close);
        } else if (signal.signal === "SELL" && hasPosition) {
          closePosition(close);
        }
      }
    }

    // Portfolio trailing stop: force to cash if equity drops from peak
    const equity = cash + (hasPosition ? positionQty * close : 0);
    if (config.portfolioStopPct && equity > peakEquity) peakEquity = equity;
    if (config.portfolioStopPct && hasPosition && peakEquity > 0) {
      const drawdown = (peakEquity - equity) / peakEquity;
      if (drawdown >= config.portfolioStopPct) {
        closePosition(close);
        portfolioStopUntilBar = i + (config.portfolioStopCooldown ?? 72);
      }
    }
    // Block re-entry during portfolio stop cooldown
    if (portfolioStopUntilBar > 0 && i < portfolioStopUntilBar && hasPosition) {
      closePosition(close);
    }

    equityCurve.push(equity);
  }

  // Close final position
  if (hasPosition) {
    closePosition(candles[candles.length - 1].closePrice);
  }

  // Final period
  const lastClose = candles[candles.length - 1].closePrice;
  const periodStartPrice = candles[periodStart].closePrice;
  const isBH = currentStrategyEntry === null || (currentStrategyEntry && currentStrategyEntry.strategy === null);
  const stratName = isBH ? "B&H" : (currentStrategyEntry?.strategy?.name ?? "cash");
  periods.push({
    startBar: periodStart,
    endBar: candles.length - 1,
    regime: currentRegime,
    strategy: stratName,
    periodReturn: (lastClose - periodStartPrice) / periodStartPrice
  });

  // Calculate results
  const finalEquity = cash;
  const netReturn = (finalEquity - config.initialCapital) / config.initialCapital;
  const buyAndHoldReturn = (candles[candles.length - 1].closePrice - candles[56].closePrice) / candles[56].closePrice;

  // Max drawdown
  let peak = equityCurve[0];
  let maxDrawdown = 0;
  for (const eq of equityCurve) {
    if (eq > peak) peak = eq;
    const dd = (peak - eq) / peak;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  return {
    netReturn,
    grossReturn: netReturn + feesPaid / config.initialCapital,
    maxDrawdown,
    totalTrades,
    regimeSwitches,
    feesPaid,
    periods,
    equityCurve,
    buyAndHoldReturn
  };
}
