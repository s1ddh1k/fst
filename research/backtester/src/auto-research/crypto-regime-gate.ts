/**
 * Crypto-optimized regime gate — replaces the broken market-state.ts regime
 * detection for strategy gating WITHOUT modifying market-state.ts.
 *
 * Uses the proven adaptive scoring logic:
 *   - SMA(50/200) golden/death cross
 *   - Volume-price divergence (OBV)
 *   - Monthly momentum
 *   - Candle structure (wicks)
 *
 * Usage:
 *   withCryptoRegimeGate({
 *     strategy: myStrategy,
 *     allowedRegimes: ["trend_up"],
 *     exitOnDisallow: true
 *   })
 */

import type { Strategy, StrategyContext, StrategySignal } from "../../../../packages/shared/src/index.js";

type CryptoRegime = "trend_up" | "trend_down" | "range";

export type CryptoRegimeGateConfig = {
  strategy: Strategy;
  allowedRegimes: CryptoRegime[];
  exitOnDisallow?: boolean;
  /** Use BTC candles for regime detection instead of per-market candles */
  benchmarkCandles?: Array<{ closePrice: number; openPrice: number; highPrice: number; lowPrice: number; volume: number; candleTimeUtc: Date }>;
};

function sma(candles: Array<{ closePrice: number }>, endIndex: number, period: number): number | null {
  if (endIndex < period - 1) return null;
  let sum = 0;
  for (let i = endIndex - period + 1; i <= endIndex; i++) sum += candles[i].closePrice;
  return sum / period;
}

function detectCryptoRegime(candles: Array<{ closePrice: number; openPrice: number; highPrice: number; lowPrice: number; volume: number }>, index: number): CryptoRegime {
  if (index < 720) return "range";

  const close = candles[index].closePrice;

  // SMA structure
  const sma50 = sma(candles, index, 50)!;
  const sma200 = sma(candles, index, 200)!;
  const goldenCross = sma50 > sma200;

  // OBV divergence (2-week lookback)
  const lookback = 336;
  let obvNow = 0, obvHalf = 0;
  for (let j = index - lookback + 1; j <= index; j++) {
    const dir = candles[j].closePrice > candles[j - 1]?.closePrice ? 1 : -1;
    if (j <= index - 168) obvHalf += dir * candles[j].volume;
    obvNow += dir * candles[j].volume;
  }
  const priceSlope = close - (candles[index - lookback]?.closePrice ?? close);
  const bearishDiv = priceSlope > 0 && (obvNow - obvHalf) < 0;
  const bullishDiv = priceSlope < 0 && (obvNow - obvHalf) > 0;

  // Momentum
  const weekAgo = candles[index - 168]?.closePrice ?? close;
  const monthAgo = candles[index - 720]?.closePrice ?? close;
  const weekReturn = (close - weekAgo) / weekAgo;
  const monthReturn = (close - monthAgo) / monthAgo;

  // Volatility
  let atr24h = 0;
  for (let j = index - 23; j <= index; j++) atr24h += candles[j].highPrice - candles[j].lowPrice;
  atr24h /= 24;
  let atr7d = 0;
  for (let j = index - 167; j <= index; j++) atr7d += candles[j].highPrice - candles[j].lowPrice;
  atr7d /= 168;
  const volAccel = atr7d > 0 ? atr24h / atr7d : 1;

  // Candle structure
  let upperW = 0, lowerW = 0, bodyS = 0;
  for (let j = index - 47; j <= index; j++) {
    bodyS += Math.abs(candles[j].closePrice - candles[j].openPrice);
    upperW += candles[j].highPrice - Math.max(candles[j].openPrice, candles[j].closePrice);
    lowerW += Math.min(candles[j].openPrice, candles[j].closePrice) - candles[j].lowPrice;
  }

  // Scoring
  let score = 0;
  if (close > sma200 && goldenCross) score += 2;
  else if (close < sma200 && !goldenCross) score -= 2;
  if (bullishDiv) score += 3;
  if (bearishDiv) score -= 3;
  if (weekReturn > 0.03 && monthReturn > 0.05) score += 2;
  else if (weekReturn < -0.03 && monthReturn < -0.05) score -= 2;
  if (bodyS > 0 && lowerW > upperW * 1.5) score += 1;
  if (bodyS > 0 && upperW > lowerW * 1.5) score -= 1;
  if (volAccel > 2.0 && weekReturn < -0.02) score -= 2;
  if (volAccel > 2.0 && weekReturn > 0.02) score += 1;

  if (score >= 4) return "trend_up";
  if (score <= -2) return "trend_down";
  return "range";
}

// Cache: compute regime once per bar, reuse for all markets
let cachedRegimeTime = 0;
let cachedRegime: CryptoRegime = "range";

export function resetCryptoRegimeCache() {
  cachedRegimeTime = 0;
  cachedRegime = "range";
}

export function withCryptoRegimeGate(config: CryptoRegimeGateConfig): Strategy {
  const { strategy, allowedRegimes, exitOnDisallow = true } = config;

  return {
    ...strategy,
    id: strategy.id,
    sleeveId: strategy.sleeveId,
    family: strategy.family,
    decisionTimeframe: strategy.decisionTimeframe,
    executionTimeframe: strategy.executionTimeframe,
    parameters: strategy.parameters,

    generateSignal(context: StrategyContext): StrategySignal {
      // Use benchmark (BTC) candles if provided, otherwise per-market
      const candles = config.benchmarkCandles ?? context.featureView?.candles ?? (context as any).candles;
      const index = context.featureView?.decisionIndex ?? (context as any).index;

      if (!candles || index === undefined) {
        return strategy.generateSignal(context);
      }

      // For benchmark mode: find the index matching current decision time
      let regimeIndex = index;
      if (config.benchmarkCandles) {
        const currentTime = context.decisionTime?.getTime() ?? 0;
        // Use cache: same time = same regime
        if (currentTime === cachedRegimeTime) {
          // reuse cached
        } else {
          // Find closest benchmark bar
          for (let j = Math.min(index, config.benchmarkCandles.length - 1); j >= 0; j--) {
            if (config.benchmarkCandles[j].candleTimeUtc.getTime() <= currentTime) {
              regimeIndex = j;
              break;
            }
          }
          cachedRegime = detectCryptoRegime(candles as any, regimeIndex);
          cachedRegimeTime = currentTime;
        }
      } else {
        cachedRegime = detectCryptoRegime(candles, regimeIndex);
      }

      const regime = cachedRegime;
      const allowed = allowedRegimes.includes(regime);

      if (!allowed) {
        // Block signal
        const hasPosition = context.existingPosition !== undefined;
        if (exitOnDisallow && hasPosition) {
          // Force exit
          return {
            strategyId: strategy.id,
            sleeveId: strategy.sleeveId,
            family: strategy.family,
            market: context.market ?? "",
            signal: "SELL",
            conviction: 0.8,
            decisionTime: context.decisionTime,
            decisionTimeframe: strategy.decisionTimeframe,
            executionTimeframe: strategy.executionTimeframe,
            reason: `crypto_regime_exit_${regime}`,
            stages: { universe_eligible: true, regime_pass: false, trigger_pass: true }
          };
        }
        return {
          strategyId: strategy.id,
          sleeveId: strategy.sleeveId,
          family: strategy.family,
          market: context.market ?? "",
          signal: "HOLD",
          conviction: 0,
          decisionTime: context.decisionTime,
          decisionTimeframe: strategy.decisionTimeframe,
          executionTimeframe: strategy.executionTimeframe,
          reason: `crypto_regime_blocked_${regime}`,
          stages: { universe_eligible: true, regime_pass: false, trigger_pass: false }
        };
      }

      // Regime allowed — delegate to strategy
      const result = strategy.generateSignal(context);
      return {
        ...result,
        stages: { ...result.stages, regime_pass: true }
      };
    }
  };
}
