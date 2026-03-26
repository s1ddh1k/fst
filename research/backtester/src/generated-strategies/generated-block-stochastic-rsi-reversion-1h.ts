// Auto-generated strategy: Stochastic RSI Mean Reversion
// Thesis: When Stochastic %K drops below 20 AND RSI confirms oversold (<35), price is at a short-term extreme.
// A bounce entry with ATR trailing stop captures 1-3% mean reversion per window, because crypto oversold
// conditions on 1h timeframe reliably snap back within 12-48 bars.
// Generated at: 2026-03-26T00:00:00.000Z

import type {
  Strategy,
  StrategyContext,
  StrategySignal,
  StrategyTimeframe
} from "../../../../packages/shared/src/index.js";
import type { GeneratedStrategyModule, GeneratedStrategyMetadata } from "../auto-research/strategy-template.js";

import {
  getRsi, getStochasticOscillator, getAtr, getEma
} from "../../../../research/strategies/src/factors/index.js";

export const metadata: GeneratedStrategyMetadata = {
  familyId: "generated:block:stochastic-rsi-reversion-1h",
  strategyName: "generated-block-stochastic-rsi-reversion-1h",
  title: "Stochastic RSI Mean Reversion",
  thesis: "Stochastic %K < 20 + RSI < 35 confirms oversold extreme. Enter on bounce confirmation (K crosses above D), exit on overbought or ATR stop. Captures 1-3% mean reversion per window.",
  family: "meanreversion",
  sleeveId: "micro",
  decisionTimeframe: "1h" as StrategyTimeframe,
  executionTimeframe: "1h" as StrategyTimeframe,
  parameterSpecs: [
    { name: "stochPeriod", description: "Stochastic lookback period", min: 8, max: 21 },
    { name: "stochOversold", description: "Stochastic %K oversold threshold for entry", min: 12, max: 25 },
    { name: "rsiPeriod", description: "RSI confirmation period", min: 10, max: 21 },
    { name: "rsiOversold", description: "RSI oversold threshold for entry confirmation", min: 25, max: 40 },
    { name: "atrPeriod", description: "ATR period for stop-loss calculation", min: 10, max: 20 },
    { name: "atrStopMult", description: "ATR multiplier for stop-loss distance", min: 1.5, max: 3.5 },
    { name: "exitOverbought", description: "Stochastic %K level to take profit", min: 65, max: 85 }
  ],
  regimeGate: { allowedRegimes: ["trend_up", "range", "trend_down", "volatile"] }
};

export function createStrategy(params: {
  strategyId: string;
  parameters: Record<string, number>;
}): Strategy {
  const p = {
    stochPeriod: params.parameters.stochPeriod ?? 14,
    stochOversold: params.parameters.stochOversold ?? 20,
    rsiPeriod: params.parameters.rsiPeriod ?? 14,
    rsiOversold: params.parameters.rsiOversold ?? 35,
    atrPeriod: params.parameters.atrPeriod ?? 14,
    atrStopMult: params.parameters.atrStopMult ?? 2.5,
    exitOverbought: params.parameters.exitOverbought ?? 75
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

      let signal: "BUY" | "SELL" | "HOLD" = "HOLD";
      let conviction = 0;
      let reason = "no signal";

      // Need enough warmup bars for indicators
      if (idx < 30) {
        return makeSignal(params.strategyId, market, "HOLD", 0, "warmup", context.decisionTime);
      }

      const close = candles[idx].closePrice;
      const stoch = getStochasticOscillator(candles, idx, p.stochPeriod);
      const stochPrev = getStochasticOscillator(candles, idx - 1, p.stochPeriod);
      const rsi = getRsi(candles, idx, p.rsiPeriod);
      const atr = getAtr(candles, idx, p.atrPeriod);

      if (!stoch || !stochPrev || rsi === null || !atr) {
        return makeSignal(params.strategyId, market, "HOLD", 0, "indicator null", context.decisionTime);
      }

      if (!hasPosition) {
        // ENTRY: Stochastic oversold + RSI confirms + K crosses above D (bounce)
        const stochOversold = stoch.k < p.stochOversold && stoch.d < p.stochOversold;
        const rsiOversold = rsi < p.rsiOversold;
        const kCrossAboveD = stoch.k > stoch.d && stochPrev.k <= stochPrev.d;

        if (stochOversold && rsiOversold && kCrossAboveD) {
          signal = "BUY";
          // Deeper oversold = higher conviction
          conviction = Math.min(1.0, Math.max(0.3, (p.stochOversold - stoch.k) / 20 + (p.rsiOversold - rsi) / 30));
          reason = `stoch K=${stoch.k.toFixed(1)} crossed D=${stoch.d.toFixed(1)}, RSI=${rsi.toFixed(1)} oversold`;
        }
      } else {
        // EXIT conditions
        const stopLoss = entryPrice - p.atrStopMult * atr;
        const overbought = stoch.k > p.exitOverbought;
        const kCrossBelowD = stoch.k < stoch.d && stochPrev.k >= stochPrev.d;

        if (close < stopLoss) {
          signal = "SELL";
          conviction = 1.0;
          reason = `stop loss hit (${close.toFixed(0)} < ${stopLoss.toFixed(0)})`;
        } else if (overbought && kCrossBelowD) {
          signal = "SELL";
          conviction = 0.8;
          reason = `overbought exit: stoch K=${stoch.k.toFixed(1)} crossed below D=${stoch.d.toFixed(1)}`;
        } else if (overbought) {
          signal = "SELL";
          conviction = 0.6;
          reason = `stoch overbought K=${stoch.k.toFixed(1)} > ${p.exitOverbought}`;
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
