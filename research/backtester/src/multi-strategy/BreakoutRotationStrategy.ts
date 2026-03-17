import { createRelativeBreakoutRotationStrategy } from "../../../strategies/src/relative-breakout-rotation.js";
import type { Strategy, StrategyContext } from "../../../../packages/shared/src/index.js";
import { adaptScoredStrategy } from "./StrategyAdapter.js";

export function createBreakoutRotationStrategy(params?: {
  breakoutLookback?: number;
  strengthFloor?: number;
  maxExtensionAtr?: number;
  trailAtrMult?: number;
}) {
  const base = adaptScoredStrategy({
    strategyId: "breakout-rotation",
    sleeveId: "breakout",
    family: "breakout",
    decisionTimeframe: "5m",
    executionTimeframe: "1m",
    scoredStrategy: createRelativeBreakoutRotationStrategy(params)
  });

  return {
    ...base,
    generateSignal(context: StrategyContext): ReturnType<Strategy["generateSignal"]> {
      const baseSignal = base.generateSignal(context);
      const state = (context.marketState as {
        breadth?: { riskOnScore?: number; liquidityScore?: number; averageVolumeSpike?: number };
      } | undefined) ?? {};
      const volumeSpike = Number(state.breadth?.averageVolumeSpike ?? 1);
      const riskOnScore = Number(state.breadth?.riskOnScore ?? 0);
      const liquidityScore = Number(state.breadth?.liquidityScore ?? 0);

      if (baseSignal.signal === "BUY" && (volumeSpike < 0.8 || riskOnScore < -0.05 || liquidityScore < 0.01)) {
        return {
          ...baseSignal,
          signal: "HOLD",
          conviction: 0,
          reason: "breakout_filtered",
          stages: {
            ...baseSignal.stages,
            setup_pass: false,
            trigger_pass: false
          },
          metadata: {
            ...(baseSignal.metadata ?? {}),
            liquidityScore,
            costPenalty: 1 - liquidityScore
          }
        };
      }

      return {
        ...baseSignal,
        metadata: {
          ...(baseSignal.metadata ?? {}),
          liquidityScore,
          volumeSpike,
          riskOnScore,
          costPenalty: 1 - liquidityScore
        }
      };
    }
  };
}
