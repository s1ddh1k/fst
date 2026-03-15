import { createExplicitStrategy } from "./decision-pipeline.js";
import { createThresholdRiskModel } from "./threshold-risk-model.js";
import type { StrategyGate } from "./threshold-risk-model.js";
import { createWeightedScoreAlphaModel } from "./weighted-score-alpha-model.js";
import type { WeightedScoreFactor } from "./weighted-score-alpha-model.js";
import type { MarketStateConfig, Strategy } from "./types.js";

export type { StrategyGate, WeightedScoreFactor };

export function createWeightedScoreStrategy(params: {
  name: string;
  parameters: Record<string, number>;
  entryFactors: WeightedScoreFactor[];
  exitFactors: WeightedScoreFactor[];
  filterRules?: StrategyGate[];
  riskExitRules?: StrategyGate[];
  entryThreshold: number;
  exitThreshold: number;
  entryMinFactors?: number;
  exitMinFactors?: number;
  stopLossPct?: number;
  maxHoldBars?: number;
  contextConfig?: MarketStateConfig;
}): Strategy {
  return createExplicitStrategy({
    name: params.name,
    parameters: params.parameters,
    contextConfig: params.contextConfig,
    alphaModel: createWeightedScoreAlphaModel({
      name: `${params.name}-alpha`,
      entryFactors: params.entryFactors,
      exitFactors: params.exitFactors
    }),
    riskModel: createThresholdRiskModel({
      name: `${params.name}-risk`,
      filterRules: params.filterRules,
      riskExitRules: params.riskExitRules,
      entryThreshold: params.entryThreshold,
      exitThreshold: params.exitThreshold,
      entryMinFactors: params.entryMinFactors,
      exitMinFactors: params.exitMinFactors,
      stopLossPct: params.stopLossPct,
      maxHoldBars: params.maxHoldBars
    })
  });
}
