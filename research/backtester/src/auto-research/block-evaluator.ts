import type { StrategyTimeframe } from "../../../../packages/shared/src/index.js";
import { loadCandlesForMarkets } from "../db.js";
import {
  normalizeToFullGrid,
  runMultiStrategyBacktest
} from "../multi-strategy/index.js";
import type { Candle } from "../types.js";
import { buildWalkForwardRanges, splitTrainTestByDays } from "../validation.js";
import { calculateAutoResearchMinimumLimit } from "./limit-resolution.js";
import { getBlockFamilyById } from "./block-families.js";
import {
  createMicroBreakoutStrategy,
  createLeaderPullbackStateMachineMultiStrategy,
  createRelativeBreakoutRotationMultiStrategy,
  createRelativeMomentumPullbackMultiStrategy,
  createResidualReversionMultiStrategy,
  createRelativeStrengthRotationStrategy,
  createBollingerMeanReversionMultiStrategy,
  withRegimeGate,
  adaptScoredStrategy
} from "../multi-strategy/index.js";
import {
  createEmaCrossoverStrategy,
  createDonchianBreakoutStrategy,
  createSimpleRsiReversionStrategy,
  createSimpleBbReversionStrategy,
  createMomentumRotationStrategy,
  createOversoldBounceScalpStrategy,
  createCrashDipBuyStrategy,
  createVolumeBreakoutRiderStrategy,
  createVolumeExhaustionBounceStrategy,
  createBbSqueezeScalpStrategy
} from "../../../strategies/src/simple-strategies.js";
import type { Strategy, StrategySleeveConfig } from "../../../../packages/shared/src/index.js";
import type { RegimeGateConfig } from "../multi-strategy/RegimeGatedStrategy.js";
import type {
  AutoResearchRunConfig,
  CandidateBacktestEvaluation,
  NormalizedCandidateProposal,
  WindowPerformanceRecord
} from "./types.js";
import { buildMarketStateContexts } from "../../../strategies/src/market-state.js";
import { summarizeReferenceCandleSpan } from "./walk-forward-config.js";

type CandleMap = Record<string, Candle[]>;
type CandleLoader = typeof loadCandlesForMarkets;

function universeSizeSummary(result: ReturnType<typeof runMultiStrategyBacktest>): {
  avg: number;
  min: number;
  max: number;
  observationCount: number;
} {
  if (result.universeCoverageSummary.observationCount > 0) {
    return result.universeCoverageSummary;
  }

  let total = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  let observationCount = 0;

  for (const snapshot of result.universeSnapshots) {
    const size = snapshot.markets.length;
    total += size;
    min = Math.min(min, size);
    max = Math.max(max, size);
    observationCount += 1;
  }

  return {
    avg: observationCount === 0 ? 0 : total / observationCount,
    min: Number.isFinite(min) ? min : 0,
    max: observationCount === 0 ? 0 : max,
    observationCount
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function finiteOrDefault(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function roundInt(value: number, min: number, max: number): number {
  return Math.round(clamp(value, min, max));
}

function isBbMeanReversionFamily(familyId: string): boolean {
  if (familyId.startsWith("block:simple-")) return false;
  return familyId.includes("bb-reversion") || familyId.includes("bb-rsi-confirmed-reversion");
}

function isBbRsiConfirmedFamily(familyId: string): boolean {
  return familyId.includes("bb-rsi-confirmed-reversion");
}

function isBbHourlyLikeFamily(familyId: string): boolean {
  return familyId.includes("hourly");
}

function isBbDailyLikeFamily(familyId: string): boolean {
  return familyId.includes("daily");
}

function resolveBbPortfolioControls(familyId: string, params: Record<string, number>): {
  cooldownBarsAfterLoss: number;
  minBarsBetweenEntries: number;
} {
  if (isBbHourlyLikeFamily(familyId)) {
    return {
      cooldownBarsAfterLoss: roundInt(finiteOrDefault(params.cooldownBarsAfterLoss, 8), 2, 24),
      minBarsBetweenEntries: roundInt(finiteOrDefault(params.minBarsBetweenEntries, 4), 1, 16)
    };
  }

  if (isBbDailyLikeFamily(familyId)) {
    return {
      cooldownBarsAfterLoss: roundInt(finiteOrDefault(params.cooldownBarsAfterLoss, 16), 4, 72),
      minBarsBetweenEntries: roundInt(finiteOrDefault(params.minBarsBetweenEntries, 8), 2, 48)
    };
  }

  return {
    cooldownBarsAfterLoss: roundInt(finiteOrDefault(params.cooldownBarsAfterLoss, 36), 8, 168),
    minBarsBetweenEntries: roundInt(finiteOrDefault(params.minBarsBetweenEntries, 16), 4, 96)
  };
}

function buildBlockGateConfig(familyId: string, params: Record<string, number>): RegimeGateConfig {
  const gate: RegimeGateConfig = {};

  // Simple strategies have no regime gate — they trade in all conditions
  if (familyId.startsWith("block:simple-")) {
    gate.allowedRegimes = ["trend_up", "trend_down", "range", "volatile"];
    gate.allowUnknownRegime = true;
    return gate;
  }

  if (isBbMeanReversionFamily(familyId)) {
    // BB mean reversion works in ALL regimes — oversold happens everywhere
    gate.allowedRegimes = ["trend_up", "trend_down", "range", "volatile"];
    gate.allowUnknownRegime = true;
    return gate;
  }

  if (familyId.includes("rangedown") || familyId.includes("reversion")) {
    gate.allowedRegimes = ["range", "trend_down", "volatile"];
    gate.maxRiskOnScore = clamp(finiteOrDefault(params.gateMaxRiskOnScore, 0.2), -0.2, 0.35);
    gate.maxCompositeTrendScore = clamp(finiteOrDefault(params.gateMaxTrendScore, 0.15), -0.2, 0.3);
    gate.maxHistoricalVolatility = clamp(finiteOrDefault(params.gateMaxVolatility, 0.06), 0.015, 0.08);
  } else if (familyId.includes("upvol") || familyId.includes("micro")) {
    gate.allowedRegimes = ["trend_up", "volatile"];
    gate.minRiskOnScore = clamp(finiteOrDefault(params.gateMinRiskOnScore, 0.02), -0.05, 0.2);
    gate.minLiquidityScore = clamp(finiteOrDefault(params.gateMinLiquidityScore, 0.04), 0.01, 0.25);
    gate.minHistoricalVolatility = clamp(finiteOrDefault(params.gateMinVolatility, 0.008), 0.003, 0.04);
  } else {
    gate.allowedRegimes = ["trend_up"];
    gate.minRiskOnScore = clamp(finiteOrDefault(params.gateMinRiskOnScore, 0.04), -0.08, 0.25);
    gate.minCompositeTrendScore = clamp(finiteOrDefault(params.gateMinTrendScore, 0.02), -0.05, 0.2);
    gate.minAboveTrendRatio = clamp(finiteOrDefault(params.gateMinAboveTrendRatio, 0.58), 0.45, 0.8);
    gate.minLiquidityScore = clamp(finiteOrDefault(params.gateMinLiquidityScore, 0.04), 0.01, 0.25);
  }

  return gate;
}

async function createBlockStrategy(familyId: string, candidateId: string, params: Record<string, number>): Promise<Strategy> {
  if (familyId.includes("rotation")) {
    return createRelativeStrengthRotationStrategy({
      strategyId: `${candidateId}-rotation`,
      rebalanceBars: roundInt(finiteOrDefault(params.rebalanceBars, 5), 4, 8),
      entryFloor: clamp(finiteOrDefault(params.entryFloor, 0.80), 0.72, 0.92),
      reEntryCooldownBars: 3,
      exitFloor: clamp(finiteOrDefault(params.exitFloor, 0.56), 0.42, 0.72),
      switchGap: clamp(finiteOrDefault(params.switchGap, 0.12), 0.06, 0.18),
      minAboveTrendRatio: clamp(finiteOrDefault(params.minAboveTrendRatio, 0.68), 0.55, 0.86),
      minLiquidityScore: clamp(finiteOrDefault(params.minLiquidityScore, 0.07), 0.02, 0.25),
      minCompositeTrend: clamp(finiteOrDefault(params.minCompositeTrend, 0.02), -0.05, 0.18)
    });
  }

  if (familyId.includes("leader")) {
    return createLeaderPullbackStateMachineMultiStrategy({
      strategyId: `${candidateId}-leader`,
      strengthFloor: clamp(finiteOrDefault(params.strengthFloor, 0.74), 0.55, 0.92),
      pullbackAtr: clamp(finiteOrDefault(params.pullbackAtr, 1), 0.4, 1.6),
      setupExpiryBars: roundInt(finiteOrDefault(params.setupExpiryBars, 5), 2, 10),
      trailAtrMult: clamp(finiteOrDefault(params.trailAtrMult, 2.2), 1.2, 3.4)
    });
  }

  if (familyId.includes("micro")) {
    return createMicroBreakoutStrategy({
      strategyId: `${candidateId}-micro`,
      lookbackBars: roundInt(finiteOrDefault(params.lookbackBars, 10), 5, 18),
      extensionThreshold: clamp(finiteOrDefault(params.extensionThreshold, 0.003), 0.0015, 0.009),
      holdingBarsMax: roundInt(finiteOrDefault(params.holdingBarsMax, 8), 4, 20),
      stopAtrMult: clamp(finiteOrDefault(params.stopAtrMult, 1.05), 0.8, 1.8),
      minVolumeSpike: clamp(finiteOrDefault(params.minVolumeSpike, 0.95), 0.8, 1.5),
      minRiskOnScore: clamp(finiteOrDefault(params.minRiskOnScore, 0.01), -0.02, 0.2),
      minLiquidityScore: clamp(finiteOrDefault(params.minLiquidityScore, 0.03), 0.02, 0.12),
      profitTarget: clamp(finiteOrDefault(params.profitTarget, 0.004), 0.0015, 0.012)
    });
  }

  if (familyId.includes("breakout") && !familyId.startsWith("block:simple-")) {
    return createRelativeBreakoutRotationMultiStrategy({
      strategyId: `${candidateId}-breakout`,
      breakoutLookback: roundInt(finiteOrDefault(params.breakoutLookback, 20), 12, 36),
      strengthFloor: clamp(finiteOrDefault(params.strengthFloor, 0.8), 0.65, 0.95),
      maxExtensionAtr: clamp(finiteOrDefault(params.maxExtensionAtr, 1.3), 0.8, 2.2),
      trailAtrMult: clamp(finiteOrDefault(params.trailAtrMult, 2.2), 1.2, 3.4)
    });
  }

  if (isBbMeanReversionFamily(familyId) && isBbHourlyLikeFamily(familyId)) {
    return createBollingerMeanReversionMultiStrategy({
      strategyId: `${candidateId}-bb-hourly`,
      bbWindow: roundInt(finiteOrDefault(params.bbWindow, 24), 12, 36),
      bbMultiplier: clamp(finiteOrDefault(params.bbMultiplier, 2.1), 1.6, 2.6),
      rsiPeriod: roundInt(finiteOrDefault(params.rsiPeriod, 14), 8, 24),
      entryRsiThreshold: clamp(finiteOrDefault(params.entryRsiThreshold, 30), 20, 40),
      requireRsiConfirmation: isBbRsiConfirmedFamily(familyId),
      requireReclaimConfirmation: true,
      reclaimLookbackBars: roundInt(finiteOrDefault(params.reclaimLookbackBars, 4), 1, 8),
      reclaimPercentBThreshold: clamp(finiteOrDefault(params.reclaimPercentBThreshold, 0.18), 0.06, 0.5),
      reclaimMinCloseBouncePct: clamp(finiteOrDefault(params.reclaimMinCloseBouncePct, 0.004), 0.0005, 0.015),
      reclaimBandWidthFactor: clamp(finiteOrDefault(params.reclaimBandWidthFactor, 0.12), 0.02, 0.6),
      deepTouchEntryPercentB: clamp(finiteOrDefault(params.deepTouchEntryPercentB, -0.05), -0.12, -0.005),
      deepTouchRsiThreshold: clamp(finiteOrDefault(params.deepTouchRsiThreshold, 18), 8, 28),
      exitRsi: clamp(finiteOrDefault(params.exitRsi, 40), 34, 46),
      stopLossPct: clamp(finiteOrDefault(params.stopLossPct, 0.09), 0.04, 0.16),
      maxHoldBars: roundInt(finiteOrDefault(params.maxHoldBars, 24), 12, 72),
      entryPercentB: clamp(finiteOrDefault(params.entryPercentB, -0.02), -0.08, 0.02),
      minBandWidth: clamp(finiteOrDefault(params.minBandWidth, 0.015), 0.003, 0.08),
      trendUpExitRsiOffset: clamp(finiteOrDefault(params.trendUpExitRsiOffset, 6), 2, 12),
      trendDownExitRsiOffset: clamp(finiteOrDefault(params.trendDownExitRsiOffset, -6), -12, -2),
      rangeExitRsiOffset: clamp(finiteOrDefault(params.rangeExitRsiOffset, -3), -8, 2),
      trendUpExitBandFraction: clamp(finiteOrDefault(params.trendUpExitBandFraction, 0.2), 0.05, 0.45),
      trendDownExitBandFraction: clamp(finiteOrDefault(params.trendDownExitBandFraction, 0.2), 0.05, 0.55),
      volatileExitBandFraction: clamp(finiteOrDefault(params.volatileExitBandFraction, 0.35), 0.08, 0.6),
      profitTakePnlThreshold: clamp(finiteOrDefault(params.profitTakePnlThreshold, 0.006), 0.002, 0.02),
      profitTakeBandWidthFactor: clamp(finiteOrDefault(params.profitTakeBandWidthFactor, 0.28), 0.08, 0.7),
      trendDownProfitTargetScale: clamp(finiteOrDefault(params.trendDownProfitTargetScale, 0.5), 0.2, 0.8),
      volatileProfitTargetScale: clamp(finiteOrDefault(params.volatileProfitTargetScale, 0.7), 0.25, 0.9),
      profitTakeRsiFraction: clamp(finiteOrDefault(params.profitTakeRsiFraction, 0.78), 0.6, 0.95),
      entryBenchmarkLeadWeight: clamp(finiteOrDefault(params.entryBenchmarkLeadWeight, 0), 0, 0.55),
      entryBenchmarkLeadMinScore: clamp(finiteOrDefault(params.entryBenchmarkLeadMinScore, 0), 0, 0.9),
      softExitScoreThreshold: clamp(finiteOrDefault(params.softExitScoreThreshold, 0.5), 0.3, 0.75),
      softExitMinPnl: clamp(finiteOrDefault(params.softExitMinPnl, 0.004), 0.0005, 0.02),
      softExitMinBandFraction: clamp(finiteOrDefault(params.softExitMinBandFraction, 0.18), 0.05, 0.75),
      exitVolumeFadeWeight: clamp(finiteOrDefault(params.exitVolumeFadeWeight, 0.24), 0, 0.55),
      exitReversalWeight: clamp(finiteOrDefault(params.exitReversalWeight, 0.28), 0, 0.65),
      exitMomentumDecayWeight: clamp(finiteOrDefault(params.exitMomentumDecayWeight, 0.22), 0, 0.55),
      exitBenchmarkWeaknessWeight: clamp(finiteOrDefault(params.exitBenchmarkWeaknessWeight, 0.12), 0, 0.45),
      exitRelativeFragilityWeight: clamp(finiteOrDefault(params.exitRelativeFragilityWeight, 0), 0, 0.6),
      exitTimeDecayWeight: clamp(finiteOrDefault(params.exitTimeDecayWeight, 0.14), 0, 0.45)
    });
  }

  if (isBbMeanReversionFamily(familyId) && isBbDailyLikeFamily(familyId)) {
    return createBollingerMeanReversionMultiStrategy({
      strategyId: `${candidateId}-bb-daily`,
      bbWindow: roundInt(finiteOrDefault(params.bbWindow, 72), 48, 120),
      bbMultiplier: clamp(finiteOrDefault(params.bbMultiplier, 2.5), 2.0, 3.0),
      rsiPeriod: roundInt(finiteOrDefault(params.rsiPeriod, 48), 24, 72),
      entryRsiThreshold: clamp(finiteOrDefault(params.entryRsiThreshold, 34), 20, 42),
      requireRsiConfirmation: isBbRsiConfirmedFamily(familyId),
      requireReclaimConfirmation: true,
      reclaimLookbackBars: roundInt(finiteOrDefault(params.reclaimLookbackBars, 6), 2, 16),
      reclaimPercentBThreshold: clamp(finiteOrDefault(params.reclaimPercentBThreshold, 0.16), 0.04, 0.4),
      reclaimMinCloseBouncePct: clamp(finiteOrDefault(params.reclaimMinCloseBouncePct, 0.003), 0.001, 0.02),
      reclaimBandWidthFactor: clamp(finiteOrDefault(params.reclaimBandWidthFactor, 0.12), 0.02, 0.45),
      deepTouchEntryPercentB: clamp(finiteOrDefault(params.deepTouchEntryPercentB, -0.11), -0.18, -0.02),
      deepTouchRsiThreshold: clamp(finiteOrDefault(params.deepTouchRsiThreshold, 24), 10, 32),
      exitRsi: clamp(finiteOrDefault(params.exitRsi, 45), 38, 50),
      stopLossPct: clamp(finiteOrDefault(params.stopLossPct, 0.15), 0.10, 0.25),
      maxHoldBars: roundInt(finiteOrDefault(params.maxHoldBars, 120), 48, 240),
      entryPercentB: clamp(finiteOrDefault(params.entryPercentB, -0.05), -0.15, 0.0),
      minBandWidth: clamp(finiteOrDefault(params.minBandWidth, 0.02), 0.005, 0.12),
      trendUpExitRsiOffset: clamp(finiteOrDefault(params.trendUpExitRsiOffset, 10), 2, 16),
      trendDownExitRsiOffset: clamp(finiteOrDefault(params.trendDownExitRsiOffset, -8), -16, -2),
      rangeExitRsiOffset: clamp(finiteOrDefault(params.rangeExitRsiOffset, -4), -10, 4),
      trendUpExitBandFraction: clamp(finiteOrDefault(params.trendUpExitBandFraction, 0.3), 0.1, 0.6),
      trendDownExitBandFraction: clamp(finiteOrDefault(params.trendDownExitBandFraction, 0.25), 0.05, 0.65),
      volatileExitBandFraction: clamp(finiteOrDefault(params.volatileExitBandFraction, 0.45), 0.1, 0.8),
      profitTakePnlThreshold: clamp(finiteOrDefault(params.profitTakePnlThreshold, 0.015), 0.004, 0.06),
      profitTakeBandWidthFactor: clamp(finiteOrDefault(params.profitTakeBandWidthFactor, 0.55), 0.15, 1.2),
      trendDownProfitTargetScale: clamp(finiteOrDefault(params.trendDownProfitTargetScale, 0.6), 0.25, 0.9),
      volatileProfitTargetScale: clamp(finiteOrDefault(params.volatileProfitTargetScale, 0.8), 0.3, 1.0),
      profitTakeRsiFraction: clamp(finiteOrDefault(params.profitTakeRsiFraction, 0.85), 0.65, 1.0),
      entryBenchmarkLeadWeight: clamp(finiteOrDefault(params.entryBenchmarkLeadWeight, 0), 0, 0.45),
      entryBenchmarkLeadMinScore: clamp(finiteOrDefault(params.entryBenchmarkLeadMinScore, 0), 0, 0.85),
      softExitScoreThreshold: clamp(finiteOrDefault(params.softExitScoreThreshold, 0.54), 0.35, 0.8),
      softExitMinPnl: clamp(finiteOrDefault(params.softExitMinPnl, 0.01), 0.001, 0.06),
      softExitMinBandFraction: clamp(finiteOrDefault(params.softExitMinBandFraction, 0.24), 0.08, 0.9),
      exitVolumeFadeWeight: clamp(finiteOrDefault(params.exitVolumeFadeWeight, 0.22), 0, 0.5),
      exitReversalWeight: clamp(finiteOrDefault(params.exitReversalWeight, 0.3), 0, 0.6),
      exitMomentumDecayWeight: clamp(finiteOrDefault(params.exitMomentumDecayWeight, 0.22), 0, 0.5),
      exitBenchmarkWeaknessWeight: clamp(finiteOrDefault(params.exitBenchmarkWeaknessWeight, 0.12), 0, 0.4),
      exitRelativeFragilityWeight: clamp(finiteOrDefault(params.exitRelativeFragilityWeight, 0), 0, 0.5),
      exitTimeDecayWeight: clamp(finiteOrDefault(params.exitTimeDecayWeight, 0.16), 0, 0.4)
    });
  }

  if (isBbMeanReversionFamily(familyId)) {
    return createBollingerMeanReversionMultiStrategy({
      strategyId: `${candidateId}-bb-weekly`,
      bbWindow: roundInt(finiteOrDefault(params.bbWindow, 336), 336, 504),
      bbMultiplier: clamp(finiteOrDefault(params.bbMultiplier, 3.0), 2.5, 3.5),
      rsiPeriod: roundInt(finiteOrDefault(params.rsiPeriod, 120), 72, 168),
      entryRsiThreshold: clamp(finiteOrDefault(params.entryRsiThreshold, 32), 18, 40),
      requireRsiConfirmation: isBbRsiConfirmedFamily(familyId),
      requireReclaimConfirmation: true,
      reclaimLookbackBars: roundInt(finiteOrDefault(params.reclaimLookbackBars, 12), 4, 48),
      reclaimPercentBThreshold: clamp(finiteOrDefault(params.reclaimPercentBThreshold, 0.12), 0.02, 0.35),
      reclaimMinCloseBouncePct: clamp(finiteOrDefault(params.reclaimMinCloseBouncePct, 0.006), 0.001, 0.03),
      reclaimBandWidthFactor: clamp(finiteOrDefault(params.reclaimBandWidthFactor, 0.1), 0.02, 0.35),
      deepTouchEntryPercentB: clamp(finiteOrDefault(params.deepTouchEntryPercentB, -0.16), -0.25, -0.02),
      deepTouchRsiThreshold: clamp(finiteOrDefault(params.deepTouchRsiThreshold, 22), 10, 32),
      exitRsi: clamp(finiteOrDefault(params.exitRsi, 50), 45, 60),
      stopLossPct: clamp(finiteOrDefault(params.stopLossPct, 0.30), 0.20, 0.35),
      maxHoldBars: roundInt(finiteOrDefault(params.maxHoldBars, 504), 336, 1008),
      entryPercentB: clamp(finiteOrDefault(params.entryPercentB, -0.1), -0.2, 0.0),
      minBandWidth: clamp(finiteOrDefault(params.minBandWidth, 0.025), 0.01, 0.18),
      trendUpExitRsiOffset: clamp(finiteOrDefault(params.trendUpExitRsiOffset, 10), 2, 18),
      trendDownExitRsiOffset: clamp(finiteOrDefault(params.trendDownExitRsiOffset, -10), -20, -2),
      rangeExitRsiOffset: clamp(finiteOrDefault(params.rangeExitRsiOffset, -5), -12, 4),
      trendUpExitBandFraction: clamp(finiteOrDefault(params.trendUpExitBandFraction, 0.3), 0.1, 0.7),
      trendDownExitBandFraction: clamp(finiteOrDefault(params.trendDownExitBandFraction, 0.2), 0.05, 0.7),
      volatileExitBandFraction: clamp(finiteOrDefault(params.volatileExitBandFraction, 0.45), 0.1, 0.9),
      profitTakePnlThreshold: clamp(finiteOrDefault(params.profitTakePnlThreshold, 0.025), 0.008, 0.12),
      profitTakeBandWidthFactor: clamp(finiteOrDefault(params.profitTakeBandWidthFactor, 0.8), 0.25, 1.8),
      trendDownProfitTargetScale: clamp(finiteOrDefault(params.trendDownProfitTargetScale, 0.55), 0.25, 1.0),
      volatileProfitTargetScale: clamp(finiteOrDefault(params.volatileProfitTargetScale, 0.75), 0.3, 1.1),
      profitTakeRsiFraction: clamp(finiteOrDefault(params.profitTakeRsiFraction, 0.85), 0.65, 1.0),
      entryBenchmarkLeadWeight: clamp(finiteOrDefault(params.entryBenchmarkLeadWeight, 0), 0, 0.35),
      entryBenchmarkLeadMinScore: clamp(finiteOrDefault(params.entryBenchmarkLeadMinScore, 0), 0, 0.85),
      softExitScoreThreshold: clamp(finiteOrDefault(params.softExitScoreThreshold, 0.6), 0.45, 0.85),
      softExitMinPnl: clamp(finiteOrDefault(params.softExitMinPnl, 0.02), 0.004, 0.12),
      softExitMinBandFraction: clamp(finiteOrDefault(params.softExitMinBandFraction, 0.34), 0.1, 1.0),
      exitVolumeFadeWeight: clamp(finiteOrDefault(params.exitVolumeFadeWeight, 0.18), 0, 0.45),
      exitReversalWeight: clamp(finiteOrDefault(params.exitReversalWeight, 0.28), 0, 0.55),
      exitMomentumDecayWeight: clamp(finiteOrDefault(params.exitMomentumDecayWeight, 0.18), 0, 0.45),
      exitBenchmarkWeaknessWeight: clamp(finiteOrDefault(params.exitBenchmarkWeaknessWeight, 0.12), 0, 0.35),
      exitRelativeFragilityWeight: clamp(finiteOrDefault(params.exitRelativeFragilityWeight, 0), 0, 0.45),
      exitTimeDecayWeight: clamp(finiteOrDefault(params.exitTimeDecayWeight, 0.14), 0, 0.35)
    });
  }

  // New generated simple strategies — must come before generic "reversion"/"breakout" checks
  if (familyId.includes("simple-stochastic-rsi-reversion-5m")) {
    const mod = await import("../generated-strategies/generated-block-stochastic-rsi-reversion-5m.js");
    return mod.createStrategy({ strategyId: candidateId, parameters: params });
  }

  if (familyId.includes("simple-stochastic-rsi-reversion")) {
    const mod = await import("../generated-strategies/generated-block-stochastic-rsi-reversion-1h.js");
    return mod.createStrategy({ strategyId: candidateId, parameters: params });
  }

  if (familyId.includes("simple-macd-histogram-reversal")) {
    const mod = await import("../generated-strategies/generated-block-macd-histogram-reversal-1h.js");
    return mod.createStrategy({ strategyId: candidateId, parameters: params });
  }

  if (familyId.includes("simple-ema-macd-trend-15m")) {
    const mod = await import("../generated-strategies/generated-block-ema-macd-trend-15m.js");
    return mod.createStrategy({ strategyId: candidateId, parameters: params });
  }

  if (familyId.includes("simple-cci-volume-reversion-5m")) {
    const mod = await import("../generated-strategies/generated-block-cci-volume-reversion-5m.js");
    return mod.createStrategy({ strategyId: candidateId, parameters: params });
  }

  if (familyId.includes("simple-cci-volume-reversion")) {
    const mod = await import("../generated-strategies/generated-block-cci-volume-reversion-1h.js");
    return mod.createStrategy({ strategyId: candidateId, parameters: params });
  }

  if (familyId.includes("reversion") && !familyId.startsWith("block:simple-")) {
    return createResidualReversionMultiStrategy({
      strategyId: `${candidateId}-reversion`,
      entryThreshold: clamp(finiteOrDefault(params.entryThreshold, 0.24), 0.15, 0.45),
      exitThreshold: clamp(finiteOrDefault(params.exitThreshold, 0.13), 0.05, 0.3),
      stopLossPct: clamp(finiteOrDefault(params.stopLossPct, 0.022), 0.01, 0.04),
      maxHoldBars: roundInt(finiteOrDefault(params.maxHoldBars, 20), 8, 48)
    });
  }

  if (familyId.includes("pullback")) {
    return createRelativeMomentumPullbackMultiStrategy({
      strategyId: `${candidateId}-pullback`,
      minStrengthPct: clamp(finiteOrDefault(params.minStrengthPct, 0.8), 0.6, 0.95),
      minRiskOn: clamp(finiteOrDefault(params.minRiskOn, 0.1), -0.05, 0.35),
      pullbackZ: clamp(finiteOrDefault(params.pullbackZ, 0.9), 0.4, 1.8),
      trailAtrMult: clamp(finiteOrDefault(params.trailAtrMult, 2.2), 1.2, 3.2)
    });
  }

  // Simple strategies — 5-6 params each, actually searchable
  if (familyId.includes("simple-ema-crossover")) {
    return adaptScoredStrategy({
      strategyId: `${candidateId}-ema`,
      sleeveId: "trend",
      family: "trend",
      decisionTimeframe: "1h",
      executionTimeframe: "1h",
      scoredStrategy: createEmaCrossoverStrategy({
        fastPeriod: roundInt(finiteOrDefault(params.fastPeriod, 12), 5, 20),
        slowPeriod: roundInt(finiteOrDefault(params.slowPeriod, 26), 20, 60),
        atrStopMult: clamp(finiteOrDefault(params.atrStopMult, 2.0), 1.0, 4.0),
        maxHoldBars: roundInt(finiteOrDefault(params.maxHoldBars, 72), 24, 168),
        minAtrPct: clamp(finiteOrDefault(params.minAtrPct, 0.005), 0.002, 0.02)
      })
    });
  }

  if (familyId.includes("simple-donchian-breakout")) {
    return adaptScoredStrategy({
      strategyId: `${candidateId}-donchian`,
      sleeveId: "breakout",
      family: "breakout",
      decisionTimeframe: "1h",
      executionTimeframe: "1h",
      scoredStrategy: createDonchianBreakoutStrategy({
        entryLookback: roundInt(finiteOrDefault(params.entryLookback, 20), 10, 48),
        exitLookback: roundInt(finiteOrDefault(params.exitLookback, 10), 5, 24),
        stopAtrMult: clamp(finiteOrDefault(params.stopAtrMult, 2.0), 1.0, 4.0),
        maxHoldBars: roundInt(finiteOrDefault(params.maxHoldBars, 96), 24, 168),
        minChannelWidth: clamp(finiteOrDefault(params.minChannelWidth, 0.02), 0.01, 0.06)
      })
    });
  }

  if (familyId.includes("simple-rsi-reversion")) {
    return adaptScoredStrategy({
      strategyId: `${candidateId}-rsi`,
      sleeveId: "micro",
      family: "meanreversion",
      decisionTimeframe: "1h",
      executionTimeframe: "1h",
      scoredStrategy: createSimpleRsiReversionStrategy({
        rsiPeriod: roundInt(finiteOrDefault(params.rsiPeriod, 14), 7, 28),
        oversold: roundInt(finiteOrDefault(params.oversold, 30), 15, 40),
        overbought: roundInt(finiteOrDefault(params.overbought, 70), 55, 85),
        stopLossPct: clamp(finiteOrDefault(params.stopLossPct, 0.05), 0.02, 0.10),
        maxHoldBars: roundInt(finiteOrDefault(params.maxHoldBars, 48), 12, 96)
      })
    });
  }

  if (familyId.includes("simple-bb-reversion")) {
    return adaptScoredStrategy({
      strategyId: `${candidateId}-simple-bb`,
      sleeveId: "micro",
      family: "meanreversion",
      decisionTimeframe: "1h",
      executionTimeframe: "1h",
      scoredStrategy: createSimpleBbReversionStrategy({
        bbWindow: roundInt(finiteOrDefault(params.bbWindow, 20), 10, 40),
        bbMultiplier: clamp(finiteOrDefault(params.bbMultiplier, 2.0), 1.5, 3.0),
        rsiPeriod: roundInt(finiteOrDefault(params.rsiPeriod, 14), 7, 28),
        entryRsi: roundInt(finiteOrDefault(params.entryRsi, 30), 15, 40),
        exitRsi: roundInt(finiteOrDefault(params.exitRsi, 50), 40, 65),
        stopLossPct: clamp(finiteOrDefault(params.stopLossPct, 0.05), 0.02, 0.10)
      })
    });
  }

  if (familyId.includes("simple-momentum")) {
    return adaptScoredStrategy({
      strategyId: `${candidateId}-momentum`,
      sleeveId: "trend",
      family: "trend",
      decisionTimeframe: "1h",
      executionTimeframe: "1h",
      scoredStrategy: createMomentumRotationStrategy({
        momentumLookback: roundInt(finiteOrDefault(params.momentumLookback, 20), 8, 48),
        entryMomentumPct: clamp(finiteOrDefault(params.entryMomentumPct, 0.03), 0.01, 0.08),
        exitMomentumPct: clamp(finiteOrDefault(params.exitMomentumPct, -0.01), -0.03, 0.01),
        maxHoldBars: roundInt(finiteOrDefault(params.maxHoldBars, 48), 12, 96),
        stopLossPct: clamp(finiteOrDefault(params.stopLossPct, 0.05), 0.02, 0.10)
      })
    });
  }

  if (familyId.includes("simple-oversold-bounce")) {
    return adaptScoredStrategy({
      strategyId: `${candidateId}-bounce`,
      sleeveId: "micro",
      family: "meanreversion",
      decisionTimeframe: "1h",
      executionTimeframe: "1h",
      scoredStrategy: createOversoldBounceScalpStrategy({
        rsiPeriod: roundInt(finiteOrDefault(params.rsiPeriod, 14), 7, 21),
        rsiEntry: roundInt(finiteOrDefault(params.rsiEntry, 15), 8, 25),
        bbWindow: roundInt(finiteOrDefault(params.bbWindow, 20), 14, 30),
        bbMultiplier: clamp(finiteOrDefault(params.bbMultiplier, 2.5), 1.8, 3.5),
        profitTargetPct: clamp(finiteOrDefault(params.profitTargetPct, 0.02), 0.005, 0.04),
        stopLossPct: clamp(finiteOrDefault(params.stopLossPct, 0.03), 0.01, 0.05)
      })
    });
  }

  if (familyId.includes("simple-crash-dip")) {
    return adaptScoredStrategy({
      strategyId: `${candidateId}-crash`,
      sleeveId: "micro",
      family: "meanreversion",
      decisionTimeframe: "1h",
      executionTimeframe: "1h",
      scoredStrategy: createCrashDipBuyStrategy({
        atrPeriod: roundInt(finiteOrDefault(params.atrPeriod, 14), 10, 20),
        dropAtrMult: clamp(finiteOrDefault(params.dropAtrMult, 2.0), 1.5, 4.0),
        profitTargetPct: clamp(finiteOrDefault(params.profitTargetPct, 0.015), 0.005, 0.03),
        stopLossPct: clamp(finiteOrDefault(params.stopLossPct, 0.025), 0.01, 0.04),
        maxHoldBars: roundInt(finiteOrDefault(params.maxHoldBars, 8), 4, 16)
      })
    });
  }

  if (familyId.includes("simple-volume-breakout-rider")) {
    return adaptScoredStrategy({
      strategyId: `${candidateId}-vol-rider`,
      sleeveId: "trend",
      family: "trend",
      decisionTimeframe: "1h",
      executionTimeframe: "1h",
      scoredStrategy: createVolumeBreakoutRiderStrategy({
        emaFast: roundInt(finiteOrDefault(params.emaFast, 10), 5, 15),
        emaSlow: roundInt(finiteOrDefault(params.emaSlow, 30), 20, 50),
        volumeWindow: roundInt(finiteOrDefault(params.volumeWindow, 20), 10, 30),
        volumeSpikeMult: clamp(finiteOrDefault(params.volumeSpikeMult, 1.8), 1.3, 3.0),
        atrPeriod: roundInt(finiteOrDefault(params.atrPeriod, 14), 10, 20),
        atrTrailMult: clamp(finiteOrDefault(params.atrTrailMult, 2.5), 1.5, 4.0),
        maxHoldBars: roundInt(finiteOrDefault(params.maxHoldBars, 72), 24, 168)
      })
    });
  }

  if (familyId.includes("simple-volume-exhaustion")) {
    return adaptScoredStrategy({
      strategyId: `${candidateId}-vol-exhaust`,
      sleeveId: "micro",
      family: "meanreversion",
      decisionTimeframe: "1h",
      executionTimeframe: "1h",
      scoredStrategy: createVolumeExhaustionBounceStrategy({
        dropLookback: roundInt(finiteOrDefault(params.dropLookback, 5), 3, 8),
        dropThresholdPct: clamp(finiteOrDefault(params.dropThresholdPct, 0.06), 0.03, 0.12),
        volumeWindow: roundInt(finiteOrDefault(params.volumeWindow, 20), 10, 30),
        volumeSpikeMult: clamp(finiteOrDefault(params.volumeSpikeMult, 2.5), 1.5, 4.0),
        rsiPeriod: roundInt(finiteOrDefault(params.rsiPeriod, 14), 7, 21),
        rsiEntry: roundInt(finiteOrDefault(params.rsiEntry, 20), 10, 30),
        profitTargetPct: clamp(finiteOrDefault(params.profitTargetPct, 0.025), 0.01, 0.05)
      })
    });
  }

  if (familyId.includes("simple-bb-squeeze")) {
    return adaptScoredStrategy({
      strategyId: `${candidateId}-squeeze`,
      sleeveId: "micro",
      family: "meanreversion",
      decisionTimeframe: "1h",
      executionTimeframe: "1h",
      scoredStrategy: createBbSqueezeScalpStrategy({
        bbWindow: roundInt(finiteOrDefault(params.bbWindow, 20), 14, 30),
        bbMultiplier: clamp(finiteOrDefault(params.bbMultiplier, 2.0), 1.5, 3.0),
        squeezeMaxWidth: clamp(finiteOrDefault(params.squeezeMaxWidth, 0.04), 0.02, 0.08),
        rsiPeriod: roundInt(finiteOrDefault(params.rsiPeriod, 14), 7, 21),
        rsiOversold: roundInt(finiteOrDefault(params.rsiOversold, 30), 20, 40),
        rsiOverbought: roundInt(finiteOrDefault(params.rsiOverbought, 70), 55, 80)
      })
    });
  }

  // Dynamic fallback: try loading LLM-generated strategy
  try {
    const { loadDynamicStrategy } = await import("./dynamic-loader.js");
    const dynamicModule = await loadDynamicStrategy(familyId);
    if (dynamicModule) {
      return dynamicModule.createStrategy({
        strategyId: candidateId,
        parameters: params
      });
    }
  } catch {
    // dynamic loading failed, fall through to error
  }

  throw new Error(`Cannot create block strategy for family: ${familyId}`);
}

function aggregate5mCandlesTo15m(candlesByMarket: CandleMap): CandleMap {
  return Object.fromEntries(
    Object.entries(candlesByMarket).map(([marketCode, candles]) => {
      const buckets = new Map<number, Candle[]>();
      for (const candle of candles) {
        const bucketMs = 15 * 60_000;
        const bucket = Math.floor(candle.candleTimeUtc.getTime() / bucketMs) * bucketMs;
        const existing = buckets.get(bucket) ?? [];
        existing.push(candle);
        buckets.set(bucket, existing);
      }

      const aggregated = Array.from(buckets.entries())
        .sort((left, right) => left[0] - right[0])
        .map(([, bucketCandles]) => {
          const sorted = bucketCandles.slice().sort((a, b) => a.candleTimeUtc.getTime() - b.candleTimeUtc.getTime());
          const first = sorted[0]!;
          const last = sorted[sorted.length - 1]!;
          return {
            marketCode,
            timeframe: "15m",
            candleTimeUtc: new Date(Math.floor(first.candleTimeUtc.getTime() / (15 * 60_000)) * (15 * 60_000)),
            openPrice: first.openPrice,
            highPrice: Math.max(...sorted.map((c) => c.highPrice)),
            lowPrice: Math.min(...sorted.map((c) => c.lowPrice)),
            closePrice: last.closePrice,
            volume: sorted.reduce((sum, c) => sum + c.volume, 0),
            quoteVolume: sorted.reduce((sum, c) => sum + (c.quoteVolume ?? c.closePrice * c.volume), 0),
            isSynthetic: sorted.every((c) => c.isSynthetic ?? false)
          } satisfies Candle;
        });

      return [marketCode, aggregated];
    })
  );
}

function chooseReferenceCandles(candlesByMarket: CandleMap, timeframe: StrategyTimeframe): Candle[] {
  const normalized = normalizeToFullGrid({ timeframe, candlesByMarket });
  const bestMarket = Object.entries(normalized.candlesByMarket)
    .sort(([, a], [, b]) => b.length - a.length)[0]?.[0];
  return bestMarket ? normalized.candlesByMarket[bestMarket] ?? [] : [];
}

function filterCandlesByRange(candlesByMarket: CandleMap, range: { start: Date; end: Date }): CandleMap {
  return Object.fromEntries(
    Object.entries(candlesByMarket).map(([marketCode, candles]) => [
      marketCode,
      candles.filter((c) => c.candleTimeUtc >= range.start && c.candleTimeUtc <= range.end)
    ])
  );
}

/**
 * Compute average buy-and-hold return across all markets for a given range.
 * For each market: (lastClose - firstOpen) / firstOpen, then average.
 */
function computeBuyAndHoldReturn(candlesByMarket: CandleMap, range: { start: Date; end: Date }): number {
  const returns: number[] = [];
  for (const candles of Object.values(candlesByMarket)) {
    const inRange = candles.filter((c) => c.candleTimeUtc >= range.start && c.candleTimeUtc <= range.end);
    if (inRange.length < 2) continue;
    const sorted = inRange.slice().sort((a, b) => a.candleTimeUtc.getTime() - b.candleTimeUtc.getTime());
    const firstOpen = sorted[0].openPrice;
    const lastClose = sorted[sorted.length - 1].closePrice;
    if (firstOpen > 0) {
      returns.push((lastClose - firstOpen) / firstOpen);
    }
  }
  return returns.length === 0 ? 0 : returns.reduce((s, v) => s + v, 0) / returns.length;
}

export async function evaluateBlockCandidate(params: {
  config: AutoResearchRunConfig;
  candidate: NormalizedCandidateProposal;
  marketCodes: string[];
  loadCandles?: CandleLoader;
}): Promise<CandidateBacktestEvaluation> {
  const { config, candidate, marketCodes } = params;
  const familyDef = getBlockFamilyById(candidate.familyId);
  const requiredTimeframes = (familyDef.requiredData ?? [familyDef.timeframe]) as StrategyTimeframe[];
  const loadCandles = params.loadCandles ?? loadCandlesForMarkets;

  const loadLimit = (tf: StrategyTimeframe) =>
    calculateAutoResearchMinimumLimit({
      timeframe: tf,
      holdoutDays: config.holdoutDays,
      trainingDays: config.trainingDays,
      stepDays: config.stepDays,
      mode: config.mode
    });

  const needs1h = requiredTimeframes.includes("1h");
  const needs5m = requiredTimeframes.includes("5m") || requiredTimeframes.includes("15m");
  const needs1m = requiredTimeframes.includes("1m");

  // Cap 1m candles to 6 months — scalping strategies don't benefit from longer history
  // and 1m bar-by-bar simulation is extremely CPU-heavy
  const MAX_1M_CANDLES = 180 * 24 * 60; // 6 months of 1m data = ~259,200 per market
  const limit1m = needs1m ? Math.min(loadLimit("1m"), MAX_1M_CANDLES) : 0;
  const marketCodes1m = needs1m ? marketCodes.slice(0, Math.max(config.marketLimit, 3)) : [];

  // Ensure execution timeframe candles cover at least the same time span as decision candles.
  // Without this, 1h decisions spanning ~1685 days have no 5m execution data for early windows.
  const limit1h = needs1h ? Math.max(config.limit, loadLimit("1h")) : 0;
  const limit5m = needs5m
    ? Math.max(loadLimit("5m"), needs1h ? limit1h * 12 : 0)
    : 0;

  const [candles1h, candles5m, candles1m] = await Promise.all([
    needs1h ? loadCandles({ marketCodes, timeframe: "1h", limit: limit1h }) : Promise.resolve({}),
    needs5m ? loadCandles({ marketCodes, timeframe: "5m", limit: limit5m }) : Promise.resolve({}),
    needs1m ? loadCandles({ marketCodes: marketCodes1m, timeframe: "1m", limit: limit1m }) : Promise.resolve({})
  ]);

  const candles15m = requiredTimeframes.includes("15m") ? aggregate5mCandlesTo15m(candles5m as CandleMap) : {};

  const referenceTimeframe = familyDef.timeframe as StrategyTimeframe;
  const referenceCandleMap = referenceTimeframe === "1h"
    ? (candles1h as CandleMap)
    : referenceTimeframe === "15m"
      ? candles15m
      : referenceTimeframe === "5m"
        ? (candles5m as CandleMap)
        : (candles1m as CandleMap);

  // Clip reference candles to the available execution data range.
  // Without this, 1h reference candles spanning 1685 days create WF windows
  // in periods where 5m execution data doesn't exist, causing 100% no_execution_window blocks.
  const executionTimeframe = (familyDef.requiredData ?? [familyDef.timeframe]).includes("5m") ? "5m"
    : (familyDef.requiredData ?? [familyDef.timeframe]).includes("1m") ? "1m" : null;
  const executionCandleMap = executionTimeframe === "5m" ? (candles5m as CandleMap)
    : executionTimeframe === "1m" ? (candles1m as CandleMap) : null;
  let clippedReferenceCandleMap = referenceCandleMap;
  if (executionCandleMap && referenceTimeframe !== executionTimeframe) {
    let execStart: Date | undefined;
    let execEnd: Date | undefined;

    for (const candles of Object.values(executionCandleMap)) {
      for (const candle of candles) {
        if (!execStart || candle.candleTimeUtc < execStart) {
          execStart = candle.candleTimeUtc;
        }
        if (!execEnd || candle.candleTimeUtc > execEnd) {
          execEnd = candle.candleTimeUtc;
        }
      }
    }

    if (execStart && execEnd) {
      clippedReferenceCandleMap = Object.fromEntries(
        Object.entries(referenceCandleMap).map(([market, candles]) => [
          market,
          candles.filter((c: { candleTimeUtc: Date }) => c.candleTimeUtc >= execStart && c.candleTimeUtc <= execEnd)
        ])
      );
    }
  }

  const referenceCandles = chooseReferenceCandles(clippedReferenceCandleMap, referenceTimeframe);

  if (referenceCandles.length === 0) {
    throw new Error(`No reference candles for block evaluation (${familyDef.timeframe})`);
  }

  const availableSpan = summarizeReferenceCandleSpan(referenceCandles);
  const baseStrategy = await createBlockStrategy(candidate.familyId, candidate.candidateId, candidate.parameters);
  const gateConfig = buildBlockGateConfig(candidate.familyId, candidate.parameters);
  const strategy = withRegimeGate({ strategy: baseStrategy, gate: gateConfig });
  const bbPortfolioControls = isBbMeanReversionFamily(candidate.familyId)
    ? resolveBbPortfolioControls(candidate.familyId, candidate.parameters)
    : null;

  const sleeveId: "trend" | "breakout" | "micro" = candidate.familyId.includes("reversion") ? "micro"
    : candidate.familyId.includes("micro") ? "micro"
      : candidate.familyId.includes("bounce") ? "micro"
        : candidate.familyId.includes("crash-dip") ? "micro"
          : candidate.familyId.includes("exhaustion") ? "micro"
            : candidate.familyId.includes("squeeze") ? "micro"
              : candidate.familyId.includes("breakout") ? "breakout"
                : "trend";

  const sleeves: StrategySleeveConfig[] = [{
    sleeveId,
    capitalBudgetPct: 0.95,
    maxOpenPositions: 8,
    maxSinglePositionPct: 0.3,
    priority: 10
  }];

  const decisionCandles: Partial<Record<StrategyTimeframe, CandleMap>> = {
    "1h": candles1h as CandleMap,
    "15m": candles15m,
    "5m": candles5m as CandleMap,
    "1m": candles1m as CandleMap
  };
  const executionCandles: Partial<Record<StrategyTimeframe, CandleMap>> = {
    "1h": candles1h as CandleMap,
    "15m": candles15m,
    "5m": candles5m as CandleMap,
    "1m": candles1m as CandleMap
  };

  const runBacktest = (range: { start: Date; end: Date }) =>
    runMultiStrategyBacktest({
      universeName: config.universeName,
      initialCapital: 1_000_000,
      sleeves,
      strategies: [strategy],
      decisionCandles: Object.fromEntries(
        Object.entries(decisionCandles).map(([tf, cm]) => [tf, filterCandlesByRange(cm ?? {}, range)])
      ),
      executionCandles: Object.fromEntries(
        Object.entries(executionCandles).map(([tf, cm]) => [tf, filterCandlesByRange(cm ?? {}, range)])
      ),
      universeConfig: {
        topN: Math.min(config.marketLimit, marketCodes.length),
        lookbackBars: 28,
        refreshEveryBars: 4
      },
      captureTraceArtifacts: false,
      captureUniverseSnapshots: false,
      maxOpenPositions: 8,
      maxCapitalUsagePct: 0.95,
      cooldownBarsAfterLoss: bbPortfolioControls?.cooldownBarsAfterLoss ?? 0,
      minBarsBetweenEntries: bbPortfolioControls?.minBarsBetweenEntries ?? 0
    });

  if (config.mode === "holdout") {
    const split = splitTrainTestByDays(referenceCandles, config.holdoutDays);
    const trainRange = split.trainRange;
    const testRange = (config.testStartDate && config.testEndDate)
      ? { start: config.testStartDate, end: config.testEndDate }
      : split.testRange;
    const testResult = runBacktest(testRange);
    const testUniverse = universeSizeSummary(testResult);
    const signalCount = testResult.metrics.signalCount;
    const ghostSignalCount = Object.values(testResult.ghostSummary).reduce((sum, item) => sum + item.count, 0);
    const decisionCoverage = testResult.decisionCoverageSummary;
    const buyAndHoldReturn = computeBuyAndHoldReturn(referenceCandleMap, testRange);

    return {
      candidate,
      mode: "holdout",
      status: "completed",
      summary: {
        totalReturn: testResult.metrics.netReturn,
        grossReturn: testResult.metrics.grossReturn,
        netReturn: testResult.metrics.netReturn,
        maxDrawdown: testResult.metrics.maxDrawdown,
        turnover: testResult.metrics.turnover,
        winRate: testResult.metrics.winRate,
        avgHoldBars: testResult.metrics.avgHoldBars,
        tradeCount: testResult.completedTrades.length,
        feePaid: testResult.metrics.feePaid,
        slippagePaid: testResult.metrics.slippagePaid,
        rejectedOrdersCount: testResult.metrics.rejectedOrdersCount,
        cooldownSkipsCount: testResult.metrics.cooldownSkipsCount,
        signalCount,
        ghostSignalCount,
        buyAndHoldReturn
      },
      diagnostics: {
        coverage: {
          tradeCount: testResult.completedTrades.length,
          signalCount,
          ghostSignalCount,
          rejectedOrdersCount: testResult.metrics.rejectedOrdersCount,
          cooldownSkipsCount: testResult.metrics.cooldownSkipsCount,
          rawBuySignals: decisionCoverage.rawBuySignals,
          rawSellSignals: decisionCoverage.rawSellSignals,
          rawHoldSignals: decisionCoverage.rawHoldSignals,
          avgUniverseSize: testUniverse.avg,
          minUniverseSize: testUniverse.min,
          maxUniverseSize: testUniverse.max,
          avgConsideredBuys: decisionCoverage.avgConsideredBuys,
          avgEligibleBuys: decisionCoverage.avgEligibleBuys
        },
        reasons: {
          strategy: Object.fromEntries(
            Object.entries(testResult.funnel).flatMap(([sid, stages]) =>
              Object.entries(stages).map(([stage, count]) => [`${sid}:${stage}`, count])
            )
          ),
          strategyTags: {},
          coordinator: { blocked_signals: testResult.metrics.blockedSignalCount },
          execution: { rejected_orders: testResult.metrics.rejectedOrdersCount },
          risk: {}
        },
        costs: {
          feePaid: testResult.metrics.feePaid,
          slippagePaid: testResult.metrics.slippagePaid,
          totalCostsPaid: testResult.metrics.feePaid + testResult.metrics.slippagePaid
        },
        robustness: {},
        crossChecks: [],
        windows: {
          mode: "holdout",
          holdoutDays: config.holdoutDays,
          trainStartAt: trainRange.start.toISOString(),
          trainEndAt: trainRange.end.toISOString(),
          testStartAt: testRange.start.toISOString(),
          testEndAt: testRange.end.toISOString(),
          availableStartAt: availableSpan.startAt?.toISOString(),
          availableEndAt: availableSpan.endAt?.toISOString(),
          availableDays: availableSpan.availableDays
        }
      }
    };
  }

  // walk-forward with early exit for 0-trade candidates
  const trainingDays = config.trainingDays ?? config.holdoutDays * 2;
  const stepDays = config.stepDays ?? config.holdoutDays;
  let windows = buildWalkForwardRanges({ candles: referenceCandles, trainingDays, holdoutDays: config.holdoutDays, stepDays });
  if (config.testStartDate && config.testEndDate) {
    // Keep windows whose test range overlaps with the specified period
    windows = windows.filter((w) =>
      w.testRange.start < config.testEndDate! && w.testRange.end > config.testStartDate!
    );
  }

  if (windows.length === 0) {
    throw new Error("No valid block walk-forward windows.");
  }

  // Progressive early exit: bail on hopeless candidates to save compute
  const EARLY_EXIT_WINDOW_COUNT = Math.min(4, windows.length);
  const results: Array<{ trainRange: { start: Date; end: Date }; testRange: { start: Date; end: Date }; test: ReturnType<typeof runBacktest> }> = [];
  let earlyExitZeroTrade = false;

  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    results.push({
      trainRange: w.trainRange,
      testRange: w.testRange,
      test: runBacktest(w.testRange)
    });

    // Check after first EARLY_EXIT_WINDOW_COUNT windows
    if (i + 1 === EARLY_EXIT_WINDOW_COUNT) {
      const totalTrades = results.reduce((s, r) => s + r.test.completedTrades.length, 0);
      const allNegative = results.every((r) => r.test.metrics.netReturn < 0);
      const avgReturn = results.reduce((s, r) => s + r.test.metrics.netReturn, 0) / results.length;

      // Exit 1: zero or near-zero trades — entry conditions are too restrictive
      if (totalTrades < 3) {
        earlyExitZeroTrade = true;
        break;
      }

      // Exit 2: all windows losing AND average return below -3% — consistently bad
      if (allNegative && avgReturn < -0.03) {
        earlyExitZeroTrade = true;
        break;
      }

      // Exit 3: losing to buy-and-hold in every window with meaningful margin
      const windowBhReturns = results.map((r) => computeBuyAndHoldReturn(referenceCandleMap, r.testRange));
      const allBelowBH = results.every((r, idx) =>
        r.test.metrics.netReturn < windowBhReturns[idx] - 0.01
      );
      if (allBelowBH && avgReturn < 0) {
        earlyExitZeroTrade = true;
        break;
      }
    }
  }

  const testReturns = results.map((r) => r.test.metrics.netReturn);
  const testDrawdowns = results.map((r) => r.test.metrics.maxDrawdown);
  const positiveWindowCount = testReturns.filter((v) => v > 0).length;
  const totalClosedTrades = results.reduce((s, r) => s + r.test.completedTrades.length, 0);
  const windowBuyAndHoldReturns = results.map((r) => computeBuyAndHoldReturn(referenceCandleMap, r.testRange));
  const avgBuyAndHoldReturn = windowBuyAndHoldReturns.length === 0
    ? 0
    : windowBuyAndHoldReturns.reduce((s, v) => s + v, 0) / windowBuyAndHoldReturns.length;

  // Per-window regime-tagged performance records (composite regime: weekly 50% + daily 35% + intraday 15%)
  const sampleCandleMap = candles1h as CandleMap;
  const sampleMarket = Object.keys(sampleCandleMap).sort(
    (a, b) => (sampleCandleMap[b]?.length ?? 0) - (sampleCandleMap[a]?.length ?? 0)
  )[0];
  const windowDetails: WindowPerformanceRecord[] = results.map((r, i) => {
    const startMs = r.testRange.start.getTime();
    const endMs = r.testRange.end.getTime();
    // Sample composite regime every 24h within the window
    const counts: Record<string, number> = {};
    let total = 0;
    if (sampleMarket) {
      const windowCandles = (sampleCandleMap[sampleMarket] ?? []).filter(
        (c) => c.candleTimeUtc.getTime() >= startMs && c.candleTimeUtc.getTime() <= endMs
      );
      const sampleInterval = 24; // every 24 bars (1 day for 1h candles)
      for (let idx = 0; idx < windowCandles.length; idx += sampleInterval) {
        const ctx = buildMarketStateContexts({
          referenceTime: windowCandles[idx].candleTimeUtc,
          universeCandlesByMarket: sampleCandleMap
        });
        const regime = ctx[sampleMarket]?.composite?.regime ?? "unknown";
        counts[regime] = (counts[regime] ?? 0) + 1;
        total++;
      }
    }
    let dominantRegime = "unknown";
    let maxCount = 0;
    const regimeDistribution: Record<string, number> = {};
    for (const [regime, count] of Object.entries(counts)) {
      const ratio = Math.round((count / Math.max(total, 1)) * 100) / 100;
      if (ratio > 0) regimeDistribution[regime] = ratio;
      if (count > maxCount) { maxCount = count; dominantRegime = regime; }
    }
    return {
      testStartAt: r.testRange.start.toISOString(),
      testEndAt: r.testRange.end.toISOString(),
      netReturn: r.test.metrics.netReturn,
      maxDrawdown: r.test.metrics.maxDrawdown,
      tradeCount: r.test.completedTrades.length,
      winRate: r.test.metrics.winRate,
      buyAndHoldReturn: windowBuyAndHoldReturns[i],
      dominantRegime,
      regimeDistribution
    };
  });

  const signalCount = results.reduce((s, r) => s + r.test.metrics.signalCount, 0);
  const ghostSignalCount = results.reduce(
    (s, r) => s + Object.values(r.test.ghostSummary).reduce((gs, item) => gs + item.count, 0),
    0
  );
  const feePaid = results.reduce((s, r) => s + r.test.metrics.feePaid, 0);
  const slippagePaid = results.reduce((s, r) => s + r.test.metrics.slippagePaid, 0);
  const universeStats = results.map((r) => universeSizeSummary(r.test));
  const totalUniverseObservations = universeStats.reduce(
    (sum, window) => sum + ("observationCount" in window ? window.observationCount : 0),
    0
  );
  const avgUniverseSize = totalUniverseObservations === 0
    ? 0
    : universeStats.reduce(
      (sum, window) =>
        sum + (window.avg * ("observationCount" in window ? window.observationCount : 0)),
      0
    ) / totalUniverseObservations;
  let minUniverseSize = Number.POSITIVE_INFINITY;
  let maxUniverseSize = 0;

  for (const window of universeStats) {
    const observationCount = "observationCount" in window ? window.observationCount : 0;
    if (observationCount === 0) {
      continue;
    }

    minUniverseSize = Math.min(minUniverseSize, window.min);
    maxUniverseSize = Math.max(maxUniverseSize, window.max);
  }
  const totalDecisionObservations = results.reduce(
    (sum, window) => sum + window.test.decisionCoverageSummary.observationCount,
    0
  );
  const rawBuySignals = results.reduce(
    (sum, window) => sum + window.test.decisionCoverageSummary.rawBuySignals,
    0
  );
  const rawSellSignals = results.reduce(
    (sum, window) => sum + window.test.decisionCoverageSummary.rawSellSignals,
    0
  );
  const rawHoldSignals = results.reduce(
    (sum, window) => sum + window.test.decisionCoverageSummary.rawHoldSignals,
    0
  );
  const avgConsideredBuys = totalDecisionObservations === 0
    ? 0
    : results.reduce(
      (sum, window) =>
        sum +
        (window.test.decisionCoverageSummary.avgConsideredBuys *
          window.test.decisionCoverageSummary.observationCount),
      0
    ) / totalDecisionObservations;
  const avgEligibleBuys = totalDecisionObservations === 0
    ? 0
    : results.reduce(
      (sum, window) =>
        sum +
        (window.test.decisionCoverageSummary.avgEligibleBuys *
          window.test.decisionCoverageSummary.observationCount),
      0
    ) / totalDecisionObservations;

  return {
    candidate,
    mode: "walk-forward",
    status: "completed",
    summary: {
      totalReturn: testReturns.reduce((s, v) => s + v, 0) / results.length,
      grossReturn: results.reduce((s, r) => s + r.test.metrics.grossReturn, 0) / results.length,
      netReturn: testReturns.reduce((s, v) => s + v, 0) / results.length,
      maxDrawdown: results.reduce((s, r) => s + r.test.metrics.maxDrawdown, 0) / results.length,
      turnover: results.reduce((s, r) => s + r.test.metrics.turnover, 0) / results.length,
      winRate: results.reduce((s, r) => s + r.test.metrics.winRate, 0) / results.length,
      avgHoldBars: results.reduce((s, r) => s + r.test.metrics.avgHoldBars, 0) / results.length,
      tradeCount: totalClosedTrades / results.length,
      feePaid,
      slippagePaid,
      rejectedOrdersCount: results.reduce((s, r) => s + r.test.metrics.rejectedOrdersCount, 0),
      cooldownSkipsCount: results.reduce((s, r) => s + r.test.metrics.cooldownSkipsCount, 0),
      signalCount,
      ghostSignalCount,
      buyAndHoldReturn: avgBuyAndHoldReturn
    },
    diagnostics: {
      coverage: {
        tradeCount: totalClosedTrades,
        signalCount,
        ghostSignalCount,
        rejectedOrdersCount: results.reduce((s, r) => s + r.test.metrics.rejectedOrdersCount, 0),
        cooldownSkipsCount: results.reduce((s, r) => s + r.test.metrics.cooldownSkipsCount, 0),
        rawBuySignals,
        rawSellSignals,
        rawHoldSignals,
        avgUniverseSize,
        minUniverseSize: Number.isFinite(minUniverseSize) ? minUniverseSize : 0,
        maxUniverseSize: Number.isFinite(maxUniverseSize) ? maxUniverseSize : 0,
        avgConsideredBuys,
        avgEligibleBuys
      },
      reasons: {
        strategy: results.reduce((acc, r) => {
          for (const [sid, stages] of Object.entries(r.test.funnel)) {
            for (const [stage, count] of Object.entries(stages)) {
              const key = `${sid}:${stage}`;
              acc[key] = (acc[key] ?? 0) + count;
            }
          }
          return acc;
        }, {} as Record<string, number>),
        strategyTags: {},
        coordinator: { blocked_signals: results.reduce((s, r) => s + r.test.metrics.blockedSignalCount, 0) },
        execution: { rejected_orders: results.reduce((s, r) => s + r.test.metrics.rejectedOrdersCount, 0) },
        risk: {}
      },
      costs: { feePaid, slippagePaid, totalCostsPaid: feePaid + slippagePaid },
      robustness: {},
      crossChecks: [],
      windows: {
        mode: "walk-forward",
        holdoutDays: config.holdoutDays,
        trainingDays,
        stepDays,
        windowCount: results.length,
        availableStartAt: availableSpan.startAt?.toISOString(),
        availableEndAt: availableSpan.endAt?.toISOString(),
        availableDays: availableSpan.availableDays,
        requiredDays: trainingDays + config.holdoutDays,
        positiveWindowCount,
        positiveWindowRatio: positiveWindowCount / results.length,
        negativeWindowCount: testReturns.filter((v) => v < 0).length,
        bestWindowNetReturn: Math.max(...testReturns),
        worstWindowNetReturn: Math.min(...testReturns),
        bestWindowMaxDrawdown: Math.min(...testDrawdowns),
        worstWindowMaxDrawdown: Math.max(...testDrawdowns),
        totalClosedTrades,
        details: windowDetails
      }
    }
  };
}
