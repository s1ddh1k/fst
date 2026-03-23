import type { GeneratedStrategyMetadata } from "./strategy-template.js";

export type StrategyDesign = {
  familyId: string;
  strategyName: string;
  title: string;
  thesis: string;
  family: "trend" | "breakout" | "micro" | "meanreversion";
  sleeveId: string;
  decisionTimeframe: string;
  executionTimeframe: string;
  parameterSpecs: Array<{ name: string; description: string; min: number; max: number }>;
  regimeGate: { allowedRegimes: string[] };
  signalLogicDescription: string;
  indicators: string[];
};

const AVAILABLE_INDICATORS = `
// Mean reversion
import { getRsi, getZScore } from "@fst/strategies/factors";
// Moving averages
import { getEma, getSma } from "@fst/strategies/factors";
// Momentum
import { getMomentum, getPriceSlope, getRateOfChange } from "@fst/strategies/factors";
// Oscillators
import { getBollingerBands, getCci, getStochasticOscillator } from "@fst/strategies/factors";
// Regime detection
import { detectMarketRegime, matchesRegime } from "@fst/strategies/factors";
// Trend
import { getAdx, getDonchianChannel, getMacd } from "@fst/strategies/factors";
// Volatility
import { getAtr, getHistoricalVolatility, getRangeExpansionScore } from "@fst/strategies/factors";
// Volume
import { getAverageVolume, getVolumeSpikeRatio } from "@fst/strategies/factors";
// Volume trend
import { getObv, getObvSlope } from "@fst/strategies/factors";
`.trim();

export function generateStrategyScaffold(design: StrategyDesign): string {
  const paramDefaults = design.parameterSpecs
    .map((p) => `    ${p.name}: params.parameters.${p.name} ?? ${(p.min + p.max) / 2}`)
    .join(",\n");

  const paramTypes = design.parameterSpecs
    .map((p) => `  // ${p.description} (${p.min} - ${p.max})`)
    .join("\n");

  return `// Auto-generated strategy: ${design.title}
// Thesis: ${design.thesis}
// Generated at: ${new Date().toISOString()}

import type {
  Strategy,
  StrategyContext,
  StrategySignal,
  StrategyTimeframe
} from "../../../../packages/shared/src/index.js";
import type { Candle } from "../../types.js";
import type { GeneratedStrategyModule, GeneratedStrategyMetadata } from "../auto-research/strategy-template.js";

// Available indicator functions:
${design.indicators.map((ind) => `// - ${ind}`).join("\n")}

// Parameter specifications:
${paramTypes}

export const metadata: GeneratedStrategyMetadata = {
  familyId: ${JSON.stringify(design.familyId)},
  strategyName: ${JSON.stringify(design.strategyName)},
  title: ${JSON.stringify(design.title)},
  thesis: ${JSON.stringify(design.thesis)},
  family: ${JSON.stringify(design.family)},
  sleeveId: ${JSON.stringify(design.sleeveId)},
  decisionTimeframe: ${JSON.stringify(design.decisionTimeframe)} as StrategyTimeframe,
  executionTimeframe: ${JSON.stringify(design.executionTimeframe)} as StrategyTimeframe,
  parameterSpecs: ${JSON.stringify(design.parameterSpecs, null, 2)},
  regimeGate: ${JSON.stringify(design.regimeGate)}
};

export function createStrategy(params: {
  strategyId: string;
  parameters: Record<string, number>;
}): Strategy {
  const p = {
${paramDefaults}
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

      // ============================================================
      // TODO: LLM fills in signal generation logic here
      // Strategy: ${design.signalLogicDescription}
      //
      // Must return signal: "BUY", "SELL", or "HOLD"
      // conviction: 0.0 to 1.0
      // ============================================================

      let signal: "BUY" | "SELL" | "HOLD" = "HOLD";
      let conviction = 0;
      let reason = "no signal";

      // --- YOUR SIGNAL LOGIC HERE ---

      return {
        strategyId: params.strategyId,
        sleeveId: metadata.sleeveId,
        family: metadata.family,
        market,
        signal,
        conviction,
        decisionTime: context.decisionTime,
        decisionTimeframe: metadata.decisionTimeframe,
        executionTimeframe: metadata.executionTimeframe,
        reason,
        stages: {
          setup_pass: signal !== "HOLD",
          trigger_pass: signal !== "HOLD"
        }
      };
    }
  };
}
`;
}

export function getAvailableIndicators(): string {
  return AVAILABLE_INDICATORS;
}

export function getStrategyInterfaceReference(): string {
  return `
Strategy interface:
  id: string
  sleeveId: string
  family: "trend" | "breakout" | "micro" | "meanreversion"
  decisionTimeframe: StrategyTimeframe ("1m" | "5m" | "15m" | "1h" | "1d")
  executionTimeframe: StrategyTimeframe
  parameters: Record<string, number>
  generateSignal(context: StrategyContext): StrategySignal

StrategyContext:
  strategyId: string
  market: string (e.g. "KRW-BTC")
  decisionTime: Date
  featureView.candles: Candle[] (OHLCV array, oldest first)
  featureView.decisionIndex: number (current bar index)
  existingPosition?: { entryPrice, quantity, barsHeld }
  universeSnapshot?: { markets, benchmark }
  marketState?: Record<string, unknown>

Candle: { open, high, low, close, volume, candleTimeUtc }

StrategySignal:
  signal: "BUY" | "SELL" | "HOLD"
  conviction: 0.0 to 1.0
  reason: string (human-readable explanation)
`.trim();
}
