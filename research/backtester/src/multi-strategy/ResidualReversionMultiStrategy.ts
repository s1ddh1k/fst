import { createResidualReversionStrategy } from "../../../strategies/src/residual-reversion-strategy.js";
import { adaptScoredStrategy } from "./StrategyAdapter.js";

export function createResidualReversionMultiStrategy(params?: {
  strategyId?: string;
  sleeveId?: "micro";
  entryThreshold?: number;
  exitThreshold?: number;
  stopLossPct?: number;
  maxHoldBars?: number;
}) {
  return adaptScoredStrategy({
    strategyId: params?.strategyId ?? "residual-reversion-hourly",
    sleeveId: params?.sleeveId ?? "micro",
    family: "meanreversion",
    decisionTimeframe: "1h",
    executionTimeframe: "5m",
    scoredStrategy: createResidualReversionStrategy({
      entryThreshold: params?.entryThreshold,
      exitThreshold: params?.exitThreshold,
      stopLossPct: params?.stopLossPct,
      maxHoldBars: params?.maxHoldBars
    })
  });
}
