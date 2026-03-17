import type { Strategy, StrategyContext, StrategySignal } from "../../../../packages/shared/src/index.js";

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function createRelativeStrengthRotationStrategy(params?: {
  strategyId?: string;
  sleeveId?: "trend";
  rebalanceBars?: number;
  entryFloor?: number;
  exitFloor?: number;
  switchGap?: number;
  minAboveTrendRatio?: number;
  minLiquidityScore?: number;
  minCompositeTrend?: number;
}): Strategy {
  const strategyId = params?.strategyId ?? "relative-strength-rotation";
  const sleeveId = params?.sleeveId ?? "trend";
  const rebalanceBars = params?.rebalanceBars ?? 4;
  const entryFloor = params?.entryFloor ?? 0.62;
  const exitFloor = params?.exitFloor ?? 0.48;
  const switchGap = params?.switchGap ?? 0.08;
  const minAboveTrendRatio = params?.minAboveTrendRatio ?? 0.55;
  const minLiquidityScore = params?.minLiquidityScore ?? 0.05;
  const minCompositeTrend = params?.minCompositeTrend ?? 0;

  return {
    id: strategyId,
    sleeveId,
    family: "trend",
    decisionTimeframe: "15m",
    executionTimeframe: "5m",
    parameters: {
      rebalanceBars,
      entryFloor,
      exitFloor,
      switchGap,
      minAboveTrendRatio,
      minLiquidityScore,
      minCompositeTrend
    },
    generateSignal(context: StrategyContext): StrategySignal {
      const { marketState, existingPosition } = context;
      const state = (marketState as {
        breadth?: { riskOnScore?: number; aboveTrendRatio?: number; liquidityScore?: number; compositeTrendScore?: number };
        relativeStrength?: { momentumPercentile?: number; returnPercentile?: number; compositeMomentumSpread?: number };
      } | undefined) ?? {};
      const momentumPercentile = Number(state.relativeStrength?.momentumPercentile ?? 0);
      const returnPercentile = Number(state.relativeStrength?.returnPercentile ?? 0);
      const compositeMomentumSpread = Number(state.relativeStrength?.compositeMomentumSpread ?? 0);
      const regimeScore = Number(state.breadth?.riskOnScore ?? 0);
      const aboveTrendRatio = Number(state.breadth?.aboveTrendRatio ?? 0);
      const liquidityScore = Number(state.breadth?.liquidityScore ?? 0);
      const compositeTrendScore = Number(state.breadth?.compositeTrendScore ?? 0);
      const score = clamp01(
        0.45 * momentumPercentile + 0.35 * returnPercentile + 0.2 * clamp01((compositeMomentumSpread + 1) / 2)
      );

      const rebalancePass = context.featureView.decisionIndex % rebalanceBars === 0;
      const regimePass =
        regimeScore >= 0 &&
        aboveTrendRatio >= minAboveTrendRatio &&
        compositeTrendScore >= minCompositeTrend;
      const liquidityPass = liquidityScore >= minLiquidityScore;
      const heldScore = existingPosition ? score : undefined;

      let signal: StrategySignal["signal"] = "HOLD";
      let reason = "no_setup";

      if (existingPosition?.market === context.market) {
        if (!regimePass || score < exitFloor || compositeMomentumSpread < 0) {
          signal = "SELL";
          reason = "rotation_exit";
        }
      } else if (rebalancePass && regimePass && liquidityPass && score >= entryFloor) {
        if (!existingPosition || heldScore === undefined || score - heldScore >= switchGap) {
          signal = "BUY";
          reason = "rotation_entry";
        }
      }

      return {
        strategyId,
        sleeveId,
        family: "trend",
        market: context.market,
        signal,
        conviction: score,
        decisionTime: context.decisionTime,
        decisionTimeframe: "15m",
        executionTimeframe: "5m",
        reason,
        stages: {
          universe_eligible: true,
          regime_pass: regimePass,
          setup_pass: rebalancePass && liquidityPass,
          trigger_pass: signal !== "HOLD"
        },
        metadata: {
          liquidityScore,
          strengthScore: score,
          costPenalty: 1 - liquidityScore,
          aboveTrendRatio,
          compositeTrendScore
        }
      };
    }
  };
}
