// Auto-generated strategy: 5m Stochastic RSI Scalp Reversion
// Thesis: On 5m bars, stochastic oversold + RSI confirmation catches micro-dips that
// revert within 1-3 hours. Faster exits, tighter stops than 1h version.
// Generated at: 2026-03-26T00:00:00.000Z

import type {
  Strategy,
  StrategyContext,
  StrategySignal,
  StrategyTimeframe
} from "../../../../packages/shared/src/index.js";
import type { GeneratedStrategyMetadata } from "../auto-research/strategy-template.js";

import {
  getRsi, getStochasticOscillator, getAtr
} from "../../../../research/strategies/src/factors/index.js";

export const metadata: GeneratedStrategyMetadata = {
  familyId: "generated:block:stochastic-rsi-reversion-5m",
  strategyName: "generated-block-stochastic-rsi-reversion-5m",
  title: "5m Stochastic RSI Scalp Reversion",
  thesis: "5m oversold stochastic + RSI bounce = micro-reversion scalp. Tight stop, fast exit.",
  family: "meanreversion",
  sleeveId: "micro",
  decisionTimeframe: "5m" as StrategyTimeframe,
  executionTimeframe: "5m" as StrategyTimeframe,
  parameterSpecs: [
    { name: "stochPeriod", description: "Stochastic lookback period", min: 8, max: 21 },
    { name: "stochOversold", description: "Stochastic %K oversold threshold", min: 12, max: 25 },
    { name: "rsiPeriod", description: "RSI confirmation period", min: 8, max: 18 },
    { name: "rsiOversold", description: "RSI oversold threshold", min: 25, max: 40 },
    { name: "atrPeriod", description: "ATR period for stop-loss", min: 8, max: 18 },
    { name: "atrStopMult", description: "ATR multiplier for stop distance", min: 1.0, max: 2.5 },
    { name: "exitOverbought", description: "Stochastic %K take-profit level", min: 60, max: 80 }
  ],
  regimeGate: { allowedRegimes: ["trend_up", "range", "trend_down", "volatile"] }
};

export function createStrategy(params: {
  strategyId: string;
  parameters: Record<string, number>;
}): Strategy {
  const p = {
    stochPeriod: Math.round(params.parameters.stochPeriod ?? 14),
    stochOversold: params.parameters.stochOversold ?? 20,
    rsiPeriod: Math.round(params.parameters.rsiPeriod ?? 12),
    rsiOversold: params.parameters.rsiOversold ?? 33,
    atrPeriod: Math.round(params.parameters.atrPeriod ?? 12),
    atrStopMult: params.parameters.atrStopMult ?? 1.8,
    exitOverbought: params.parameters.exitOverbought ?? 70
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

      if (idx < 30) {
        return mk(params.strategyId, market, "HOLD", 0, "warmup", context.decisionTime);
      }

      const stoch = getStochasticOscillator(candles, idx, p.stochPeriod);
      const stochPrev = getStochasticOscillator(candles, idx - 1, p.stochPeriod);
      const rsi = getRsi(candles, idx, p.rsiPeriod);
      const atr = getAtr(candles, idx, p.atrPeriod);
      const close = candles[idx].closePrice;

      if (!stoch || !stochPrev || rsi === null || !atr) {
        return mk(params.strategyId, market, "HOLD", 0, "indicator null", context.decisionTime);
      }

      if (!hasPosition) {
        const oversold = stoch.k < p.stochOversold && stoch.d < p.stochOversold && rsi < p.rsiOversold;
        const bounce = stoch.k > stoch.d && stochPrev.k <= stochPrev.d;

        if (oversold && bounce) {
          signal = "BUY";
          conviction = Math.min(1.0, Math.max(0.3, (p.stochOversold - stoch.k) / 20 + (p.rsiOversold - rsi) / 30));
          reason = `5m stoch K=${stoch.k.toFixed(1)} bounce, RSI=${rsi.toFixed(1)}`;
        }
      } else {
        const stop = entryPrice - p.atrStopMult * atr;
        const overbought = stoch.k > p.exitOverbought;
        const kCrossDown = stoch.k < stoch.d && stochPrev.k >= stochPrev.d;

        if (close < stop) {
          signal = "SELL"; conviction = 1.0;
          reason = `stop hit (${close.toFixed(0)} < ${stop.toFixed(0)})`;
        } else if (overbought && kCrossDown) {
          signal = "SELL"; conviction = 0.8;
          reason = `overbought reversal K=${stoch.k.toFixed(1)}`;
        } else if (overbought) {
          signal = "SELL"; conviction = 0.6;
          reason = `overbought K=${stoch.k.toFixed(1)}`;
        }
      }

      return mk(params.strategyId, market, signal, conviction, reason, context.decisionTime);
    }
  };
}

function mk(
  strategyId: string, market: string, signal: "BUY" | "SELL" | "HOLD",
  conviction: number, reason: string, decisionTime: Date
): StrategySignal {
  return {
    strategyId, sleeveId: metadata.sleeveId, family: metadata.family, market, signal, conviction,
    decisionTime, decisionTimeframe: metadata.decisionTimeframe, executionTimeframe: metadata.executionTimeframe,
    reason, stages: { setup_pass: signal !== "HOLD", trigger_pass: signal !== "HOLD" }
  };
}
