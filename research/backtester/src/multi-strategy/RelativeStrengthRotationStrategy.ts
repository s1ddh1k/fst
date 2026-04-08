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
  reEntryCooldownBars?: number;
  skipInternalRegimeCheck?: boolean;
  momentumWeight?: number;
  returnWeight?: number;
  spreadWeight?: number;
  liquidityWeight?: number;
  trendWeight?: number;
  aboveTrendWeight?: number;
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
  const reEntryCooldownBars = params?.reEntryCooldownBars ?? 3;
  const skipInternalRegimeCheck = params?.skipInternalRegimeCheck ?? false;
  const momentumWeight = params?.momentumWeight ?? 0.45;
  const returnWeight = params?.returnWeight ?? 0.35;
  const spreadWeight = params?.spreadWeight ?? 0.2;
  const liquidityWeight = params?.liquidityWeight ?? 0;
  const trendWeight = params?.trendWeight ?? 0;
  const aboveTrendWeight = params?.aboveTrendWeight ?? 0;
  const totalWeight = momentumWeight + returnWeight + spreadWeight + liquidityWeight + trendWeight + aboveTrendWeight;
  const safeTotalWeight = totalWeight > 0 ? totalWeight : 1;
  let lastSellDecisionIndex = -Infinity;

  return {
    id: strategyId,
    sleeveId,
    family: "trend",
    decisionTimeframe: "1h",
    executionTimeframe: "1h",
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
      const spreadScore = clamp01((compositeMomentumSpread + 1) / 2);
      const trendQuality = clamp01((compositeTrendScore + 1) / 2);
      const aboveTrendQuality = clamp01(aboveTrendRatio);
      const score = clamp01(
        (
          momentumWeight * momentumPercentile +
          returnWeight * returnPercentile +
          spreadWeight * spreadScore +
          liquidityWeight * liquidityScore +
          trendWeight * trendQuality +
          aboveTrendWeight * aboveTrendQuality
        ) / safeTotalWeight
      );

      const rebalancePass = context.featureView.decisionIndex % rebalanceBars === 0;
      // Use composite regime from market state as primary gate.
      // When adaptive regime is enabled, this correctly uses SMA(720) classification.
      // aboveTrendRatio and compositeTrendScore are secondary — too strict with adaptive.
      const compositeRegime = (marketState as any)?.composite?.regime;
      const regimePass = skipInternalRegimeCheck
        ? true
        : compositeRegime === "trend_up" ||
          (regimeScore >= 0 && aboveTrendRatio >= minAboveTrendRatio && compositeTrendScore >= minCompositeTrend);
      const liquidityPass = liquidityScore >= minLiquidityScore || compositeRegime === "trend_up";
      const heldScore = existingPosition ? score : undefined;

      let signal: StrategySignal["signal"] = "HOLD";
      let reason = "no_setup";

      const cooldownActive = context.featureView.decisionIndex - lastSellDecisionIndex < reEntryCooldownBars;

      if (existingPosition?.market === context.market) {
        // Exit only on regime breakdown or score deterioration.
        // Do NOT exit on momentumSpread < 0 alone — it flips too rapidly on 15m,
        // causing massive turnover that destroys gross returns with costs.
        if (!regimePass || score < exitFloor) {
          signal = "SELL";
          reason = "rotation_exit";
          lastSellDecisionIndex = context.featureView.decisionIndex;
        }
      } else if (!cooldownActive && rebalancePass && regimePass && liquidityPass && score >= entryFloor) {
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
        decisionTimeframe: "1h",
        executionTimeframe: "1h",
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
