// Auto-generated strategy: 5m CCI Volume Scalp Reversion
// Thesis: CCI extreme + volume spike on 5m = micro-capitulation. Fast recovery in 15-60min.
// Tighter params than 1h version — smaller moves, faster exits.
// Generated at: 2026-03-26T00:00:00.000Z

import type {
  Strategy,
  StrategyContext,
  StrategySignal,
  StrategyTimeframe
} from "../../../../packages/shared/src/index.js";
import type { GeneratedStrategyMetadata } from "../auto-research/strategy-template.js";

import {
  getCci, getVolumeSpikeRatio, getAtr
} from "../../../../research/strategies/src/factors/index.js";

export const metadata: GeneratedStrategyMetadata = {
  familyId: "generated:block:cci-volume-reversion-5m",
  strategyName: "generated-block-cci-volume-reversion-5m",
  title: "5m CCI Volume Scalp Reversion",
  thesis: "CCI extreme + volume spike on 5m = micro-capitulation, fast 15-60min reversion.",
  family: "meanreversion",
  sleeveId: "micro",
  decisionTimeframe: "5m" as StrategyTimeframe,
  executionTimeframe: "5m" as StrategyTimeframe,
  parameterSpecs: [
    { name: "cciPeriod", description: "CCI calculation period", min: 8, max: 20 },
    { name: "cciEntry", description: "CCI extreme entry threshold", min: -200, max: -80 },
    { name: "cciExit", description: "CCI mean reversion exit target", min: -20, max: 20 },
    { name: "volSpikeLookback", description: "Volume average lookback", min: 10, max: 30 },
    { name: "volSpikeMin", description: "Minimum volume spike ratio", min: 1.2, max: 3.0 },
    { name: "atrPeriod", description: "ATR period for stop-loss", min: 8, max: 18 },
    { name: "atrStopMult", description: "ATR stop multiplier", min: 1.0, max: 2.5 }
  ],
  regimeGate: { allowedRegimes: ["trend_up", "range", "trend_down", "volatile"] }
};

export function createStrategy(params: {
  strategyId: string;
  parameters: Record<string, number>;
}): Strategy {
  const p = {
    cciPeriod: Math.round(params.parameters.cciPeriod ?? 12),
    cciEntry: params.parameters.cciEntry ?? -130,
    cciExit: params.parameters.cciExit ?? 0,
    volSpikeLookback: Math.round(params.parameters.volSpikeLookback ?? 20),
    volSpikeMin: params.parameters.volSpikeMin ?? 1.5,
    atrPeriod: Math.round(params.parameters.atrPeriod ?? 12),
    atrStopMult: params.parameters.atrStopMult ?? 1.8
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
      const close = candles[idx].closePrice;

      if (idx < 35) {
        return mk(params.strategyId, market, "HOLD", 0, "warmup", context.decisionTime);
      }

      const cciNow = getCci(candles, idx, p.cciPeriod);
      const cciPrev = getCci(candles, idx - 1, p.cciPeriod);
      const volSpike = getVolumeSpikeRatio(candles, idx, p.volSpikeLookback);
      const atr = getAtr(candles, idx, p.atrPeriod);

      if (cciNow === null || cciPrev === null || volSpike === null || !atr) {
        return mk(params.strategyId, market, "HOLD", 0, "indicator null", context.decisionTime);
      }

      let signal: "BUY" | "SELL" | "HOLD" = "HOLD";
      let conviction = 0;
      let reason = "no signal";

      if (!hasPosition) {
        const extreme = cciPrev < p.cciEntry;
        const recovering = cciNow > cciPrev;
        const volConfirm = volSpike >= p.volSpikeMin;
        const stillOversold = cciNow < p.cciExit;

        if (extreme && recovering && volConfirm && stillOversold) {
          const depth = Math.min(1.0, Math.abs(cciPrev - p.cciEntry) / 100);
          conviction = Math.min(1.0, Math.max(0.3, 0.4 + depth * 0.4));
          signal = "BUY";
          reason = `5m CCI ${cciPrev.toFixed(0)}→${cciNow.toFixed(0)}, vol ${volSpike.toFixed(1)}x`;
        }
      } else {
        const stop = entryPrice - p.atrStopMult * atr;
        const reverted = cciNow >= p.cciExit;
        const overshoot = cciNow > 80;

        if (close < stop) {
          signal = "SELL"; conviction = 1.0;
          reason = `stop (${close.toFixed(0)} < ${stop.toFixed(0)})`;
        } else if (overshoot) {
          signal = "SELL"; conviction = 0.9;
          reason = `CCI overshoot ${cciNow.toFixed(0)}`;
        } else if (reverted) {
          signal = "SELL"; conviction = 0.7;
          reason = `mean reverted CCI=${cciNow.toFixed(0)}`;
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
