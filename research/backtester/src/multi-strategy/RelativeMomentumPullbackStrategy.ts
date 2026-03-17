import { createRelativeMomentumPullbackStrategy } from "../../../strategies/src/relative-momentum-pullback.js";
import { adaptScoredStrategy } from "./StrategyAdapter.js";

export function createRelativeMomentumPullbackMultiStrategy(params?: {
  strategyId?: string;
  sleeveId?: "trend";
  minStrengthPct?: number;
  minRiskOn?: number;
  pullbackZ?: number;
  trailAtrMult?: number;
}) {
  return adaptScoredStrategy({
    strategyId: params?.strategyId ?? "relative-momentum-pullback",
    sleeveId: params?.sleeveId ?? "trend",
    family: "trend",
    decisionTimeframe: "1h",
    executionTimeframe: "5m",
    scoredStrategy: createRelativeMomentumPullbackStrategy({
      minStrengthPct: params?.minStrengthPct,
      minRiskOn: params?.minRiskOn,
      pullbackZ: params?.pullbackZ,
      trailAtrMult: params?.trailAtrMult
    })
  });
}
