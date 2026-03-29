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

export type RegimeDetectorMode = "oracle" | "sma" | "trailing-stop" | "momentum" | "microstructure" | "momentum-micro";

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

  // Helper: open position
  const openPosition = (price: number) => {
    if (hasPosition) return;
    const investable = cash * 0.95; // keep 5% buffer
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
