// Auto-generated strategy: CCI Extreme + Volume Spike Mean Reversion
// Thesis: CCI < -100 indicates extreme oversold. Combined with volume spike (>1.5x avg),
// this signals capitulation selling that reliably reverses. Enter when CCI starts recovering
// from extreme, exit at CCI 0 (mean) or on stop. Captures 1-4% per reversion.
// Generated at: 2026-03-26T00:00:00.000Z

import type {
  Strategy,
  StrategyContext,
  StrategySignal,
  StrategyTimeframe
} from "../../../../packages/shared/src/index.js";
import type { GeneratedStrategyModule, GeneratedStrategyMetadata } from "../auto-research/strategy-template.js";

import {
  getCci, getVolumeSpikeRatio, getAtr, getRsi
} from "../../../../research/strategies/src/factors/index.js";

export const metadata: GeneratedStrategyMetadata = {
  familyId: "generated:block:cci-volume-reversion-1h",
  strategyName: "generated-block-cci-volume-reversion-1h",
  title: "CCI Extreme + Volume Spike Mean Reversion",
  thesis: "CCI < -100 with volume spike > 1.5x average = capitulation selling. Enter when CCI starts recovering, exit at CCI near zero (mean reversion complete) or on ATR stop. Captures 1-4% per trade.",
  family: "meanreversion",
  sleeveId: "micro",
  decisionTimeframe: "1h" as StrategyTimeframe,
  executionTimeframe: "1h" as StrategyTimeframe,
  parameterSpecs: [
    { name: "cciPeriod", description: "CCI calculation period", min: 10, max: 25 },
    { name: "cciEntry", description: "CCI extreme threshold for entry (negative value)", min: -200, max: -80 },
    { name: "cciExit", description: "CCI target for mean reversion exit", min: -20, max: 30 },
    { name: "volSpikeLookback", description: "Volume average lookback for spike detection", min: 10, max: 30 },
    { name: "volSpikeMin", description: "Minimum volume spike ratio to confirm capitulation", min: 1.2, max: 3.0 },
    { name: "atrPeriod", description: "ATR period for stop-loss", min: 10, max: 20 },
    { name: "atrStopMult", description: "ATR multiplier for stop-loss distance", min: 1.5, max: 3.5 }
  ],
  regimeGate: { allowedRegimes: ["trend_up", "range", "trend_down", "volatile"] }
};

export function createStrategy(params: {
  strategyId: string;
  parameters: Record<string, number>;
}): Strategy {
  const p = {
    cciPeriod: Math.round(params.parameters.cciPeriod ?? 14),
    cciEntry: params.parameters.cciEntry ?? -120,
    cciExit: params.parameters.cciExit ?? 0,
    volSpikeLookback: Math.round(params.parameters.volSpikeLookback ?? 20),
    volSpikeMin: params.parameters.volSpikeMin ?? 1.5,
    atrPeriod: Math.round(params.parameters.atrPeriod ?? 14),
    atrStopMult: params.parameters.atrStopMult ?? 2.5
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

      if (idx < 35) {
        return makeSignal(params.strategyId, market, "HOLD", 0, "warmup", context.decisionTime);
      }

      const close = candles[idx].closePrice;
      const cciNow = getCci(candles, idx, p.cciPeriod);
      const cciPrev = getCci(candles, idx - 1, p.cciPeriod);
      const volSpike = getVolumeSpikeRatio(candles, idx, p.volSpikeLookback);
      const atr = getAtr(candles, idx, p.atrPeriod);

      if (cciNow === null || cciPrev === null || volSpike === null || !atr) {
        return makeSignal(params.strategyId, market, "HOLD", 0, "indicator null", context.decisionTime);
      }

      let signal: "BUY" | "SELL" | "HOLD" = "HOLD";
      let conviction = 0;
      let reason = "no signal";

      if (!hasPosition) {
        // ENTRY: CCI was extreme oversold and is now recovering + volume confirms capitulation
        const cciExtreme = cciPrev < p.cciEntry;
        const cciRecovering = cciNow > cciPrev; // CCI turning up
        const volumeConfirms = volSpike >= p.volSpikeMin;

        // Also check: CCI still in oversold territory but rising (don't enter after full recovery)
        const stillOversold = cciNow < p.cciExit;

        if (cciExtreme && cciRecovering && volumeConfirms && stillOversold) {
          signal = "BUY";
          // Deeper CCI = more extreme = higher conviction
          const depthScore = Math.min(1.0, Math.abs(cciPrev - p.cciEntry) / 100);
          const volScore = Math.min(1.0, (volSpike - p.volSpikeMin) / 2);
          conviction = Math.min(1.0, Math.max(0.3, 0.4 + depthScore * 0.35 + volScore * 0.25));
          reason = `CCI recovering from ${cciPrev.toFixed(0)}→${cciNow.toFixed(0)}, vol spike ${volSpike.toFixed(1)}x`;
        }
      } else {
        // EXIT: Mean reversion target reached, or stop loss
        const stopPrice = entryPrice - p.atrStopMult * atr;
        const meanReverted = cciNow >= p.cciExit;
        // Overshoot exit: CCI goes strongly positive (reversion overshot)
        const overshoot = cciNow > 100;

        if (close < stopPrice) {
          signal = "SELL";
          conviction = 1.0;
          reason = `stop loss (${close.toFixed(0)} < ${stopPrice.toFixed(0)})`;
        } else if (overshoot) {
          signal = "SELL";
          conviction = 0.9;
          reason = `CCI overshoot exit (${cciNow.toFixed(0)} > 100)`;
        } else if (meanReverted) {
          signal = "SELL";
          conviction = 0.7;
          reason = `mean reversion target: CCI=${cciNow.toFixed(0)} >= ${p.cciExit}`;
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
