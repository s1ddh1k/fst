import { createLeaderPullbackStateMachineStrategy } from "../../../strategies/src/leader-pullback-state-machine.js";
import { adaptScoredStrategy } from "./StrategyAdapter.js";

export function createLeaderPullbackStateMachineMultiStrategy(params?: {
  strategyId?: string;
  sleeveId?: "trend";
  strengthFloor?: number;
  pullbackAtr?: number;
  setupExpiryBars?: number;
  trailAtrMult?: number;
}) {
  return adaptScoredStrategy({
    strategyId: params?.strategyId ?? "leader-pullback-state-machine",
    sleeveId: params?.sleeveId ?? "trend",
    family: "trend",
    decisionTimeframe: "1h",
    executionTimeframe: "5m",
    scoredStrategy: createLeaderPullbackStateMachineStrategy({
      strengthFloor: params?.strengthFloor,
      pullbackAtr: params?.pullbackAtr,
      setupExpiryBars: params?.setupExpiryBars,
      trailAtrMult: params?.trailAtrMult
    })
  });
}
