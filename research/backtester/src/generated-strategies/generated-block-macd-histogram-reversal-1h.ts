// Auto-generated strategy: MACD Histogram Momentum Reversal
// Thesis: MACD histogram turning from negative to positive while price is above EMA signals
// momentum shift from bearish to bullish. Entry on histogram zero-cross with EMA trend filter
// captures early trend continuation moves of 2-5% per window.
// Generated at: 2026-03-26T00:00:00.000Z

import type {
  Strategy,
  StrategyContext,
  StrategySignal,
  StrategyTimeframe
} from "../../../../packages/shared/src/index.js";
import type { GeneratedStrategyModule, GeneratedStrategyMetadata } from "../auto-research/strategy-template.js";

import {
  getMacd, getEma, getAtr
} from "../../../../research/strategies/src/factors/index.js";

export const metadata: GeneratedStrategyMetadata = {
  familyId: "generated:block:macd-histogram-reversal-1h",
  strategyName: "generated-block-macd-histogram-reversal-1h",
  title: "MACD Histogram Momentum Reversal",
  thesis: "MACD histogram crosses zero from below while price holds above EMA = bearish-to-bullish momentum shift. ATR trailing stop protects gains. Captures 2-5% trend continuation per window.",
  family: "trend",
  sleeveId: "trend",
  decisionTimeframe: "1h" as StrategyTimeframe,
  executionTimeframe: "1h" as StrategyTimeframe,
  parameterSpecs: [
    { name: "macdFast", description: "MACD fast EMA window", min: 8, max: 16 },
    { name: "macdSlow", description: "MACD slow EMA window", min: 20, max: 32 },
    { name: "macdSignal", description: "MACD signal smoothing window", min: 6, max: 12 },
    { name: "emaTrendPeriod", description: "EMA period for trend filter (price must be above)", min: 20, max: 60 },
    { name: "atrPeriod", description: "ATR period for trailing stop", min: 10, max: 20 },
    { name: "atrTrailMult", description: "ATR multiplier for trailing stop distance", min: 1.5, max: 3.5 },
    { name: "histMinStrength", description: "Minimum histogram value after zero-cross to confirm strength", min: 0, max: 50 }
  ],
  regimeGate: { allowedRegimes: ["trend_up", "breakout"] }
};

export function createStrategy(params: {
  strategyId: string;
  parameters: Record<string, number>;
}): Strategy {
  const p = {
    macdFast: Math.round(params.parameters.macdFast ?? 12),
    macdSlow: Math.round(params.parameters.macdSlow ?? 26),
    macdSignal: Math.round(params.parameters.macdSignal ?? 9),
    emaTrendPeriod: Math.round(params.parameters.emaTrendPeriod ?? 40),
    atrPeriod: Math.round(params.parameters.atrPeriod ?? 14),
    atrTrailMult: params.parameters.atrTrailMult ?? 2.5,
    histMinStrength: params.parameters.histMinStrength ?? 10
  };

  return {
    id: params.strategyId,
    sleeveId: metadata.sleeveId,
    family: metadata.family,
    decisionTimeframe: metadata.decisionTimeframe,
    executionTimeframe: metadata.executionTimeframe,
    parameters: params.parameters,

    generateSignal(context: StrategyContext): StrategySignal {
      const candles = context.featureView.candles;
      const idx = context.featureView.decisionIndex;
      const market = context.market;
      const hasPosition = context.existingPosition != null;
      const entryPrice = context.existingPosition?.entryPrice ?? 0;
      const barsHeld = hasPosition && context.existingPosition?.entryTime
        ? Math.floor((context.decisionTime.getTime() - context.existingPosition.entryTime.getTime()) / (3600 * 1000))
        : 0;

      if (idx < p.macdSlow + p.macdSignal + 5) {
        return makeSignal(params.strategyId, market, "HOLD", 0, "warmup", context.decisionTime);
      }

      const close = candles[idx].closePrice;
      const macdNow = getMacd(candles, idx, { fastWindow: p.macdFast, slowWindow: p.macdSlow, signalWindow: p.macdSignal });
      const macdPrev = getMacd(candles, idx - 1, { fastWindow: p.macdFast, slowWindow: p.macdSlow, signalWindow: p.macdSignal });
      const ema = getEma(candles, idx, p.emaTrendPeriod);
      const atr = getAtr(candles, idx, p.atrPeriod);

      if (!macdNow || !macdPrev || ema === null || !atr) {
        return makeSignal(params.strategyId, market, "HOLD", 0, "indicator null", context.decisionTime);
      }

      let signal: "BUY" | "SELL" | "HOLD" = "HOLD";
      let conviction = 0;
      let reason = "no signal";

      if (!hasPosition) {
        // ENTRY: Histogram crosses zero from below + price above EMA trend
        const histCrossUp = macdPrev.histogram < 0 && macdNow.histogram >= 0;
        const histStrong = macdNow.histogram >= p.histMinStrength;
        const aboveTrend = close > ema;
        // Also accept: histogram was negative and now rising strongly (early signal)
        const histAccelerating = macdNow.histogram > macdPrev.histogram && macdNow.histogram > -p.histMinStrength;

        if (aboveTrend && (histCrossUp || (histStrong && histAccelerating))) {
          signal = "BUY";
          // Stronger histogram = higher conviction
          const histNorm = Math.min(Math.abs(macdNow.histogram) / (atr * 0.5), 1.0);
          conviction = Math.min(1.0, Math.max(0.3, 0.4 + histNorm * 0.5));
          reason = histCrossUp
            ? `MACD hist zero-cross (${macdNow.histogram.toFixed(1)}), above EMA${p.emaTrendPeriod}`
            : `MACD hist strong+rising (${macdNow.histogram.toFixed(1)}), above EMA${p.emaTrendPeriod}`;
        }
      } else {
        // EXIT: Trailing stop or histogram reversal
        // Trailing stop: track highest close since entry
        let highestClose = close;
        for (let i = Math.max(0, idx - barsHeld); i <= idx; i++) {
          if (candles[i].closePrice > highestClose) highestClose = candles[i].closePrice;
        }
        const trailingStop = highestClose - p.atrTrailMult * atr;

        // Histogram reversal: turns negative after being positive
        const histReversed = macdNow.histogram < 0 && macdPrev.histogram >= 0;
        // Price below EMA = trend broken
        const belowTrend = close < ema;

        if (close < trailingStop) {
          signal = "SELL";
          conviction = 0.9;
          reason = `trailing stop (${close.toFixed(0)} < ${trailingStop.toFixed(0)}, high=${highestClose.toFixed(0)})`;
        } else if (histReversed && belowTrend) {
          signal = "SELL";
          conviction = 0.8;
          reason = `MACD hist reversed negative + below EMA`;
        } else if (close < entryPrice - p.atrTrailMult * atr) {
          signal = "SELL";
          conviction = 1.0;
          reason = `hard stop loss hit`;
        }
      }

      return makeSignal(params.strategyId, market, signal, conviction, reason, context.decisionTime);
    }
  };
}

function makeSignal(
  strategyId: string, market: string, signal: "BUY" | "SELL" | "HOLD",
  conviction: number, reason: string, decisionTime: Date
): StrategySignal {
  return {
    strategyId, sleeveId: metadata.sleeveId, family: metadata.family, market, signal, conviction,
    decisionTime, decisionTimeframe: metadata.decisionTimeframe, executionTimeframe: metadata.executionTimeframe,
    reason, stages: { setup_pass: signal !== "HOLD", trigger_pass: signal !== "HOLD" }
  };
}
