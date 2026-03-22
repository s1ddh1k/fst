import { createBollingerMeanReversionStrategy } from "../../../strategies/src/bollinger-mean-reversion.js";
import { adaptScoredStrategy } from "./StrategyAdapter.js";

export function createBollingerMeanReversionMultiStrategy(params?: {
  strategyId?: string;
  sleeveId?: "micro";
  bbWindow?: number;
  bbMultiplier?: number;
  rsiPeriod?: number;
  exitRsi?: number;
  stopLossPct?: number;
  maxHoldBars?: number;
  entryPercentB?: number;
  entryRsiThreshold?: number;
  requireRsiConfirmation?: boolean;
  requireReclaimConfirmation?: boolean;
  reclaimLookbackBars?: number;
  reclaimPercentBThreshold?: number;
  reclaimMinCloseBouncePct?: number;
  reclaimBandWidthFactor?: number;
  deepTouchEntryPercentB?: number;
  deepTouchRsiThreshold?: number;
  minBandWidth?: number;
  trendUpExitRsiOffset?: number;
  trendDownExitRsiOffset?: number;
  rangeExitRsiOffset?: number;
  trendUpExitBandFraction?: number;
  trendDownExitBandFraction?: number;
  volatileExitBandFraction?: number;
  profitTakePnlThreshold?: number;
  profitTakeBandWidthFactor?: number;
  trendDownProfitTargetScale?: number;
  volatileProfitTargetScale?: number;
  profitTakeRsiFraction?: number;
  entryBenchmarkLeadWeight?: number;
  entryBenchmarkLeadMinScore?: number;
  softExitScoreThreshold?: number;
  softExitMinPnl?: number;
  softExitMinBandFraction?: number;
  exitVolumeFadeWeight?: number;
  exitReversalWeight?: number;
  exitMomentumDecayWeight?: number;
  exitBenchmarkWeaknessWeight?: number;
  exitRelativeFragilityWeight?: number;
  exitTimeDecayWeight?: number;
}) {
  return adaptScoredStrategy({
    strategyId: params?.strategyId ?? "bollinger-mean-reversion",
    sleeveId: params?.sleeveId ?? "micro",
    family: "meanreversion",
    decisionTimeframe: "1h",
    executionTimeframe: "5m",
    scoredStrategy: createBollingerMeanReversionStrategy({
      bbWindow: params?.bbWindow,
      bbMultiplier: params?.bbMultiplier,
      rsiPeriod: params?.rsiPeriod,
      exitRsi: params?.exitRsi,
      stopLossPct: params?.stopLossPct,
      maxHoldBars: params?.maxHoldBars,
      entryPercentB: params?.entryPercentB,
      entryRsiThreshold: params?.entryRsiThreshold,
      requireRsiConfirmation: params?.requireRsiConfirmation,
      requireReclaimConfirmation: params?.requireReclaimConfirmation,
      reclaimLookbackBars: params?.reclaimLookbackBars,
      reclaimPercentBThreshold: params?.reclaimPercentBThreshold,
      reclaimMinCloseBouncePct: params?.reclaimMinCloseBouncePct,
      reclaimBandWidthFactor: params?.reclaimBandWidthFactor,
      deepTouchEntryPercentB: params?.deepTouchEntryPercentB,
      deepTouchRsiThreshold: params?.deepTouchRsiThreshold,
      minBandWidth: params?.minBandWidth,
      trendUpExitRsiOffset: params?.trendUpExitRsiOffset,
      trendDownExitRsiOffset: params?.trendDownExitRsiOffset,
      rangeExitRsiOffset: params?.rangeExitRsiOffset,
      trendUpExitBandFraction: params?.trendUpExitBandFraction,
      trendDownExitBandFraction: params?.trendDownExitBandFraction,
      volatileExitBandFraction: params?.volatileExitBandFraction,
      profitTakePnlThreshold: params?.profitTakePnlThreshold,
      profitTakeBandWidthFactor: params?.profitTakeBandWidthFactor,
      trendDownProfitTargetScale: params?.trendDownProfitTargetScale,
      volatileProfitTargetScale: params?.volatileProfitTargetScale,
      profitTakeRsiFraction: params?.profitTakeRsiFraction,
      entryBenchmarkLeadWeight: params?.entryBenchmarkLeadWeight,
      entryBenchmarkLeadMinScore: params?.entryBenchmarkLeadMinScore,
      softExitScoreThreshold: params?.softExitScoreThreshold,
      softExitMinPnl: params?.softExitMinPnl,
      softExitMinBandFraction: params?.softExitMinBandFraction,
      exitVolumeFadeWeight: params?.exitVolumeFadeWeight,
      exitReversalWeight: params?.exitReversalWeight,
      exitMomentumDecayWeight: params?.exitMomentumDecayWeight,
      exitBenchmarkWeaknessWeight: params?.exitBenchmarkWeaknessWeight,
      exitRelativeFragilityWeight: params?.exitRelativeFragilityWeight,
      exitTimeDecayWeight: params?.exitTimeDecayWeight
    })
  });
}
