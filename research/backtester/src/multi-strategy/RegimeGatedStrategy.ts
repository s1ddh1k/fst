import type { Strategy, StrategyContext, StrategySignal } from "../../../../packages/shared/src/index.js";
import type { CompositeBenchmarkContext } from "../../../strategies/src/types.js";

type MarketRegime = CompositeBenchmarkContext["regime"];
type RegimeSource = "composite" | "benchmark";

export type RegimeGateConfig = {
  regimeSource?: RegimeSource;
  allowedRegimes?: MarketRegime[];
  blockedRegimes?: MarketRegime[];
  allowUnknownRegime?: boolean;
  minRiskOnScore?: number;
  maxRiskOnScore?: number;
  minCompositeTrendScore?: number;
  maxCompositeTrendScore?: number;
  minAboveTrendRatio?: number;
  maxAboveTrendRatio?: number;
  minLiquidityScore?: number;
  maxHistoricalVolatility?: number;
  minHistoricalVolatility?: number;
  minDispersionScore?: number;
  maxDispersionScore?: number;
  exitOnDisallow?: boolean;
};

type GateMetrics = {
  regimeSource: RegimeSource;
  regime: MarketRegime;
  riskOnScore: number;
  compositeTrendScore: number;
  aboveTrendRatio: number;
  liquidityScore: number;
  historicalVolatility: number;
  dispersionScore: number;
};

function resolveGateMetrics(
  context: StrategyContext,
  gate: RegimeGateConfig | undefined
): GateMetrics {
  const marketState = (context.marketState as {
    breadth?: {
      riskOnScore?: number;
      aboveTrendRatio?: number;
      liquidityScore?: number;
      dispersionScore?: number;
    };
    composite?: {
      regime?: MarketRegime;
      trendScore?: number;
      historicalVolatility?: number | null;
    };
    benchmark?: {
      regime?: MarketRegime;
      trendScore?: number;
      historicalVolatility?: number | null;
    };
  } | undefined) ?? {};
  const regimeSource = gate?.regimeSource ?? "composite";
  const regimeContext =
    regimeSource === "benchmark"
      ? marketState.benchmark ?? marketState.composite
      : marketState.composite;

  return {
    regimeSource,
    regime: regimeContext?.regime ?? "unknown",
    riskOnScore: Number(marketState.breadth?.riskOnScore ?? 0),
    compositeTrendScore: Number(regimeContext?.trendScore ?? marketState.breadth?.riskOnScore ?? 0),
    aboveTrendRatio: Number(marketState.breadth?.aboveTrendRatio ?? 0),
    liquidityScore: Number(marketState.breadth?.liquidityScore ?? 0),
    historicalVolatility: Number(regimeContext?.historicalVolatility ?? 0),
    dispersionScore: Number(marketState.breadth?.dispersionScore ?? 0)
  };
}

function buildGateMetadata(metrics: GateMetrics, allowed: boolean, reason: string) {
  return {
    regimeGateAllowed: allowed,
    regimeGateReason: reason,
    regimeGateSource: metrics.regimeSource,
    regimeGateRegime: metrics.regime,
    regimeGateRiskOnScore: metrics.riskOnScore,
    regimeGateCompositeTrendScore: metrics.compositeTrendScore,
    regimeGateAboveTrendRatio: metrics.aboveTrendRatio,
    regimeGateLiquidityScore: metrics.liquidityScore,
    regimeGateHistoricalVolatility: metrics.historicalVolatility,
    regimeGateDispersionScore: metrics.dispersionScore
  };
}

function evaluateRegimeGate(context: StrategyContext, gate: RegimeGateConfig | undefined) {
  const metrics = resolveGateMetrics(context, gate);
  if (!gate) {
    return {
      allowed: true,
      reason: "regime_gate_disabled",
      metrics
    };
  }

  const reasons: string[] = [];
  const allowUnknownRegime = gate.allowUnknownRegime ?? false;

  if (gate.allowedRegimes?.length) {
    const regimeAllowed =
      gate.allowedRegimes.includes(metrics.regime) ||
      (metrics.regime === "unknown" && allowUnknownRegime);
    if (!regimeAllowed) {
      reasons.push("regime_not_allowed");
    }
  }

  if (gate.blockedRegimes?.includes(metrics.regime)) {
    reasons.push("regime_blocked");
  }
  if (gate.minRiskOnScore !== undefined && metrics.riskOnScore < gate.minRiskOnScore) {
    reasons.push("risk_on_below_min");
  }
  if (gate.maxRiskOnScore !== undefined && metrics.riskOnScore > gate.maxRiskOnScore) {
    reasons.push("risk_on_above_max");
  }
  if (
    gate.minCompositeTrendScore !== undefined &&
    metrics.compositeTrendScore < gate.minCompositeTrendScore
  ) {
    reasons.push("trend_score_below_min");
  }
  if (
    gate.maxCompositeTrendScore !== undefined &&
    metrics.compositeTrendScore > gate.maxCompositeTrendScore
  ) {
    reasons.push("trend_score_above_max");
  }
  if (gate.minAboveTrendRatio !== undefined && metrics.aboveTrendRatio < gate.minAboveTrendRatio) {
    reasons.push("above_trend_below_min");
  }
  if (gate.maxAboveTrendRatio !== undefined && metrics.aboveTrendRatio > gate.maxAboveTrendRatio) {
    reasons.push("above_trend_above_max");
  }
  if (gate.minLiquidityScore !== undefined && metrics.liquidityScore < gate.minLiquidityScore) {
    reasons.push("liquidity_below_min");
  }
  if (
    gate.maxHistoricalVolatility !== undefined &&
    metrics.historicalVolatility > gate.maxHistoricalVolatility
  ) {
    reasons.push("volatility_above_max");
  }
  if (
    gate.minHistoricalVolatility !== undefined &&
    metrics.historicalVolatility < gate.minHistoricalVolatility
  ) {
    reasons.push("volatility_below_min");
  }
  if (gate.minDispersionScore !== undefined && metrics.dispersionScore < gate.minDispersionScore) {
    reasons.push("dispersion_below_min");
  }
  if (gate.maxDispersionScore !== undefined && metrics.dispersionScore > gate.maxDispersionScore) {
    reasons.push("dispersion_above_max");
  }

  return {
    allowed: reasons.length === 0,
    reason: reasons.length === 0 ? "regime_gate_pass" : reasons.join("|"),
    metrics
  };
}

export function withRegimeGate(params: { strategy: Strategy; gate?: RegimeGateConfig }): Strategy {
  const strategy = params.strategy;
  const gateParameters = Object.fromEntries(
    Object.entries({
      minRiskOnGate: params.gate?.minRiskOnScore,
      maxRiskOnGate: params.gate?.maxRiskOnScore,
      minTrendScoreGate: params.gate?.minCompositeTrendScore,
      maxTrendScoreGate: params.gate?.maxCompositeTrendScore,
      minAboveTrendGate: params.gate?.minAboveTrendRatio,
      maxAboveTrendGate: params.gate?.maxAboveTrendRatio,
      minLiquidityGate: params.gate?.minLiquidityScore,
      minVolatilityGate: params.gate?.minHistoricalVolatility,
      maxVolatilityGate: params.gate?.maxHistoricalVolatility
    }).filter(([, value]) => value !== undefined)
  ) as Record<string, number>;

  return {
    ...strategy,
    parameters: {
      ...strategy.parameters,
      ...gateParameters
    },
    generateSignal(context: StrategyContext): StrategySignal {
      const gate = evaluateRegimeGate(context, params.gate);

      if (!gate.allowed) {
        const forceExit = Boolean(context.existingPosition) && (params.gate?.exitOnDisallow ?? true);
        return {
          strategyId: strategy.id,
          sleeveId: strategy.sleeveId,
          family: strategy.family,
          market: context.market,
          signal: forceExit ? "SELL" : "HOLD",
          conviction: forceExit ? 0.5 : 0,
          decisionTime: context.decisionTime,
          decisionTimeframe: strategy.decisionTimeframe,
          executionTimeframe: strategy.executionTimeframe,
          reason: forceExit ? "regime_gate_exit" : "regime_gate_block",
          stages: {
            universe_eligible: true,
            regime_pass: false,
            trigger_pass: forceExit
          },
          metadata: buildGateMetadata(gate.metrics, false, gate.reason)
        };
      }

      const signal = strategy.generateSignal(context);
      return {
        ...signal,
        stages: {
          ...signal.stages,
          regime_pass: signal.stages.regime_pass ?? true
        },
        metadata: {
          ...signal.metadata,
          ...buildGateMetadata(gate.metrics, true, gate.reason)
        }
      };
    }
  };
}
