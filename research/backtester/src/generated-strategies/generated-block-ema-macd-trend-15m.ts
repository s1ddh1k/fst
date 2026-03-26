// Auto-generated strategy: 15m EMA + MACD Trend Following
// Thesis: On 15m bars, EMA20/50 golden cross + MACD histogram positive = confirmed trend.
// 15m gives 4x more signals than 1h while still filtering noise vs 5m.
// Generated at: 2026-03-26T00:00:00.000Z

import type {
  Strategy,
  StrategyContext,
  StrategySignal,
  StrategyTimeframe
} from "../../../../packages/shared/src/index.js";
import type { GeneratedStrategyMetadata } from "../auto-research/strategy-template.js";

import {
  getEma, getMacd, getAtr
} from "../../../../research/strategies/src/factors/index.js";

export const metadata: GeneratedStrategyMetadata = {
  familyId: "generated:block:ema-macd-trend-15m",
  strategyName: "generated-block-ema-macd-trend-15m",
  title: "15m EMA + MACD Trend Following",
  thesis: "EMA20 > EMA50 + MACD histogram positive = 15m uptrend confirmed. Trail with ATR stop.",
  family: "trend",
  sleeveId: "trend",
  decisionTimeframe: "15m" as StrategyTimeframe,
  executionTimeframe: "15m" as StrategyTimeframe,
  parameterSpecs: [
    { name: "emaFast", description: "Fast EMA period", min: 10, max: 25 },
    { name: "emaSlow", description: "Slow EMA period", min: 30, max: 60 },
    { name: "macdFast", description: "MACD fast window", min: 8, max: 16 },
    { name: "macdSlow", description: "MACD slow window", min: 20, max: 32 },
    { name: "atrPeriod", description: "ATR for trailing stop", min: 10, max: 20 },
    { name: "atrTrailMult", description: "ATR trailing stop multiplier", min: 1.5, max: 3.5 },
    { name: "minGapPct", description: "Min EMA gap as % of price to confirm trend", min: 0.001, max: 0.01 }
  ],
  regimeGate: { allowedRegimes: ["trend_up", "breakout"] }
};

export function createStrategy(params: {
  strategyId: string;
  parameters: Record<string, number>;
}): Strategy {
  const p = {
    emaFast: Math.round(params.parameters.emaFast ?? 20),
    emaSlow: Math.round(params.parameters.emaSlow ?? 50),
    macdFast: Math.round(params.parameters.macdFast ?? 12),
    macdSlow: Math.round(params.parameters.macdSlow ?? 26),
    atrPeriod: Math.round(params.parameters.atrPeriod ?? 14),
    atrTrailMult: params.parameters.atrTrailMult ?? 2.5,
    minGapPct: params.parameters.minGapPct ?? 0.003
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
        ? Math.floor((context.decisionTime.getTime() - context.existingPosition.entryTime.getTime()) / (15 * 60 * 1000))
        : 0;

      if (idx < p.emaSlow + 5) {
        return mk(params.strategyId, market, "HOLD", 0, "warmup", context.decisionTime);
      }

      const close = candles[idx].closePrice;
      const emaFast = getEma(candles, idx, p.emaFast);
      const emaSlow = getEma(candles, idx, p.emaSlow);
      const emaFastPrev = getEma(candles, idx - 1, p.emaFast);
      const emaSlowPrev = getEma(candles, idx - 1, p.emaSlow);
      const macd = getMacd(candles, idx, { fastWindow: p.macdFast, slowWindow: p.macdSlow });
      const atr = getAtr(candles, idx, p.atrPeriod);

      if (emaFast === null || emaSlow === null || emaFastPrev === null || emaSlowPrev === null || !macd || !atr) {
        return mk(params.strategyId, market, "HOLD", 0, "indicator null", context.decisionTime);
      }

      let signal: "BUY" | "SELL" | "HOLD" = "HOLD";
      let conviction = 0;
      let reason = "no signal";

      if (!hasPosition) {
        // Entry: EMA golden cross + MACD histogram positive + minimum gap
        const goldenCross = emaFast > emaSlow && emaFastPrev <= emaSlowPrev;
        const trendEstablished = emaFast > emaSlow && (emaFast - emaSlow) / emaSlow > p.minGapPct;
        const macdConfirm = macd.histogram > 0;
        const priceAboveEma = close > emaFast;

        if ((goldenCross || trendEstablished) && macdConfirm && priceAboveEma) {
          const gapStrength = Math.min(1.0, ((emaFast - emaSlow) / emaSlow) / (p.minGapPct * 3));
          conviction = Math.min(1.0, Math.max(0.3, 0.4 + gapStrength * 0.4));
          signal = "BUY";
          reason = goldenCross
            ? `15m golden cross EMA${p.emaFast}/${p.emaSlow}, MACD+`
            : `15m trend gap ${((emaFast - emaSlow) / emaSlow * 100).toFixed(2)}%, MACD+`;
        }
      } else {
        // Exit: trailing stop or death cross
        let highestClose = close;
        for (let i = Math.max(0, idx - barsHeld); i <= idx; i++) {
          if (candles[i].closePrice > highestClose) highestClose = candles[i].closePrice;
        }
        const trailingStop = highestClose - p.atrTrailMult * atr;
        const deathCross = emaFast < emaSlow && emaFastPrev >= emaSlowPrev;
        const hardStop = entryPrice - p.atrTrailMult * atr;

        if (close < hardStop) {
          signal = "SELL"; conviction = 1.0;
          reason = `hard stop (${close.toFixed(0)} < ${hardStop.toFixed(0)})`;
        } else if (close < trailingStop) {
          signal = "SELL"; conviction = 0.9;
          reason = `trail stop (${close.toFixed(0)} < ${trailingStop.toFixed(0)})`;
        } else if (deathCross && macd.histogram < 0) {
          signal = "SELL"; conviction = 0.8;
          reason = `death cross + MACD negative`;
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
