import { createRelativeBreakoutRotationStrategy } from "../../../strategies/src/relative-breakout-rotation.js";
import { adaptScoredStrategy } from "./StrategyAdapter.js";

export function createRelativeBreakoutRotationMultiStrategy(params?: {
  strategyId?: string;
  sleeveId?: "breakout";
  breakoutLookback?: number;
  strengthFloor?: number;
  maxExtensionAtr?: number;
  trailAtrMult?: number;
}) {
  return adaptScoredStrategy({
    strategyId: params?.strategyId ?? "relative-breakout-rotation-hourly",
    sleeveId: params?.sleeveId ?? "breakout",
    family: "breakout",
    decisionTimeframe: "1h",
    executionTimeframe: "5m",
    scoredStrategy: createRelativeBreakoutRotationStrategy({
      breakoutLookback: params?.breakoutLookback,
      strengthFloor: params?.strengthFloor,
      maxExtensionAtr: params?.maxExtensionAtr,
      trailAtrMult: params?.trailAtrMult
    })
  });
}
