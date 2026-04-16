import type { SleeveId, Strategy, StrategySleeveConfig, StrategyTimeframe } from "../../../../packages/shared/src/index.js";
import {
  createMicroBreakoutStrategy,
  createLeaderPullbackStateMachineMultiStrategy,
  createRelativeBreakoutRotationMultiStrategy,
  createRelativeMomentumPullbackMultiStrategy,
  createResidualReversionMultiStrategy,
  createRelativeStrengthRotationStrategy,
  createBollingerMeanReversionMultiStrategy,
  withRegimeGate
} from "../multi-strategy/index.js";
import type { RegimeGateConfig } from "../multi-strategy/RegimeGatedStrategy.js";
import type { PortfolioCandidateRuntime } from "./portfolio-runtime.js";
import type { ValidatedBlock, ValidatedBlockCatalog } from "./types.js";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function roundInt(value: number, min: number, max: number): number {
  return Math.round(clamp(value, min, max));
}

function finiteOrDefault(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function isBbMeanReversionFamily(familyId: string): boolean {
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

function buildGateFromBlock(block: ValidatedBlock): RegimeGateConfig {
  const gate: RegimeGateConfig = {
    allowedRegimes: block.regimeGate.allowedRegimes as RegimeGateConfig["allowedRegimes"]
  };
  const g = block.regimeGate;
  if (typeof g.gateMinRiskOnScore === "number") gate.minRiskOnScore = g.gateMinRiskOnScore;
  if (typeof g.gateMaxRiskOnScore === "number") gate.maxRiskOnScore = g.gateMaxRiskOnScore;
  if (typeof g.gateMinTrendScore === "number") gate.minCompositeTrendScore = g.gateMinTrendScore;
  if (typeof g.gateMaxTrendScore === "number") gate.maxCompositeTrendScore = g.gateMaxTrendScore;
  if (typeof g.gateMinAboveTrendRatio === "number") gate.minAboveTrendRatio = g.gateMinAboveTrendRatio;
  if (typeof g.gateMinLiquidityScore === "number") gate.minLiquidityScore = g.gateMinLiquidityScore;
  if (typeof g.gateMinVolatility === "number") gate.minHistoricalVolatility = g.gateMinVolatility;
  if (typeof g.gateMaxVolatility === "number") gate.maxHistoricalVolatility = g.gateMaxVolatility;
  return gate;
}

function createBbStrategyFromBlock(block: ValidatedBlock, candidateId: string): Strategy {
  const p = block.parameters;
  const id = `${candidateId}-${block.blockId}`;

  if (isBbHourlyLikeFamily(block.sourceFamilyId)) {
    return createBollingerMeanReversionMultiStrategy({
      strategyId: id,
      bbWindow: roundInt(finiteOrDefault(p.bbWindow, 24), 12, 36),
      bbMultiplier: clamp(finiteOrDefault(p.bbMultiplier, 2.1), 1.6, 2.6),
      rsiPeriod: roundInt(finiteOrDefault(p.rsiPeriod, 14), 8, 24),
      entryRsiThreshold: clamp(finiteOrDefault(p.entryRsiThreshold, 30), 20, 40),
      requireRsiConfirmation: isBbRsiConfirmedFamily(block.sourceFamilyId),
      requireReclaimConfirmation: true,
      reclaimLookbackBars: roundInt(finiteOrDefault(p.reclaimLookbackBars, 4), 1, 8),
      reclaimPercentBThreshold: clamp(finiteOrDefault(p.reclaimPercentBThreshold, 0.18), 0.06, 0.5),
      reclaimMinCloseBouncePct: clamp(finiteOrDefault(p.reclaimMinCloseBouncePct, 0.004), 0.0005, 0.015),
      reclaimBandWidthFactor: clamp(finiteOrDefault(p.reclaimBandWidthFactor, 0.12), 0.02, 0.6),
      deepTouchEntryPercentB: clamp(finiteOrDefault(p.deepTouchEntryPercentB, -0.05), -0.12, -0.005),
      deepTouchRsiThreshold: clamp(finiteOrDefault(p.deepTouchRsiThreshold, 18), 8, 28),
      exitRsi: clamp(finiteOrDefault(p.exitRsi, 40), 34, 46),
      stopLossPct: clamp(finiteOrDefault(p.stopLossPct, 0.09), 0.04, 0.16),
      maxHoldBars: roundInt(finiteOrDefault(p.maxHoldBars, 24), 12, 72),
      entryPercentB: clamp(finiteOrDefault(p.entryPercentB, -0.02), -0.08, 0.02),
      minBandWidth: clamp(finiteOrDefault(p.minBandWidth, 0.015), 0.003, 0.08),
      trendUpExitRsiOffset: clamp(finiteOrDefault(p.trendUpExitRsiOffset, 6), 2, 12),
      trendDownExitRsiOffset: clamp(finiteOrDefault(p.trendDownExitRsiOffset, -6), -12, -2),
      rangeExitRsiOffset: clamp(finiteOrDefault(p.rangeExitRsiOffset, -3), -8, 2),
      trendUpExitBandFraction: clamp(finiteOrDefault(p.trendUpExitBandFraction, 0.2), 0.05, 0.45),
      trendDownExitBandFraction: clamp(finiteOrDefault(p.trendDownExitBandFraction, 0.2), 0.05, 0.55),
      volatileExitBandFraction: clamp(finiteOrDefault(p.volatileExitBandFraction, 0.35), 0.08, 0.6),
      profitTakePnlThreshold: clamp(finiteOrDefault(p.profitTakePnlThreshold, 0.006), 0.002, 0.02),
      profitTakeBandWidthFactor: clamp(finiteOrDefault(p.profitTakeBandWidthFactor, 0.28), 0.08, 0.7),
      trendDownProfitTargetScale: clamp(finiteOrDefault(p.trendDownProfitTargetScale, 0.5), 0.2, 0.8),
      volatileProfitTargetScale: clamp(finiteOrDefault(p.volatileProfitTargetScale, 0.7), 0.25, 0.9),
      profitTakeRsiFraction: clamp(finiteOrDefault(p.profitTakeRsiFraction, 0.78), 0.6, 0.95),
      entryBenchmarkLeadWeight: clamp(finiteOrDefault(p.entryBenchmarkLeadWeight, 0), 0, 0.55),
      entryBenchmarkLeadMinScore: clamp(finiteOrDefault(p.entryBenchmarkLeadMinScore, 0), 0, 0.9),
      softExitScoreThreshold: clamp(finiteOrDefault(p.softExitScoreThreshold, 0.5), 0.3, 0.75),
      softExitMinPnl: clamp(finiteOrDefault(p.softExitMinPnl, 0.004), 0.0005, 0.02),
      softExitMinBandFraction: clamp(finiteOrDefault(p.softExitMinBandFraction, 0.18), 0.05, 0.75),
      exitVolumeFadeWeight: clamp(finiteOrDefault(p.exitVolumeFadeWeight, 0.24), 0, 0.55),
      exitReversalWeight: clamp(finiteOrDefault(p.exitReversalWeight, 0.28), 0, 0.65),
      exitMomentumDecayWeight: clamp(finiteOrDefault(p.exitMomentumDecayWeight, 0.22), 0, 0.55),
      exitBenchmarkWeaknessWeight: clamp(finiteOrDefault(p.exitBenchmarkWeaknessWeight, 0.12), 0, 0.45),
      exitRelativeFragilityWeight: clamp(finiteOrDefault(p.exitRelativeFragilityWeight, 0), 0, 0.6),
      exitTimeDecayWeight: clamp(finiteOrDefault(p.exitTimeDecayWeight, 0.14), 0, 0.45)
    });
  }

  if (isBbDailyLikeFamily(block.sourceFamilyId)) {
    return createBollingerMeanReversionMultiStrategy({
      strategyId: id,
      bbWindow: roundInt(finiteOrDefault(p.bbWindow, 72), 48, 120),
      bbMultiplier: clamp(finiteOrDefault(p.bbMultiplier, 2.5), 2.0, 3.0),
      rsiPeriod: roundInt(finiteOrDefault(p.rsiPeriod, 48), 24, 72),
      entryRsiThreshold: clamp(finiteOrDefault(p.entryRsiThreshold, 34), 20, 42),
      requireRsiConfirmation: isBbRsiConfirmedFamily(block.sourceFamilyId),
      requireReclaimConfirmation: true,
      reclaimLookbackBars: roundInt(finiteOrDefault(p.reclaimLookbackBars, 6), 2, 16),
      reclaimPercentBThreshold: clamp(finiteOrDefault(p.reclaimPercentBThreshold, 0.16), 0.04, 0.4),
      reclaimMinCloseBouncePct: clamp(finiteOrDefault(p.reclaimMinCloseBouncePct, 0.003), 0.001, 0.02),
      reclaimBandWidthFactor: clamp(finiteOrDefault(p.reclaimBandWidthFactor, 0.12), 0.02, 0.45),
      deepTouchEntryPercentB: clamp(finiteOrDefault(p.deepTouchEntryPercentB, -0.11), -0.18, -0.02),
      deepTouchRsiThreshold: clamp(finiteOrDefault(p.deepTouchRsiThreshold, 24), 10, 32),
      exitRsi: clamp(finiteOrDefault(p.exitRsi, 45), 38, 50),
      stopLossPct: clamp(finiteOrDefault(p.stopLossPct, 0.15), 0.10, 0.25),
      maxHoldBars: roundInt(finiteOrDefault(p.maxHoldBars, 120), 48, 240),
      entryPercentB: clamp(finiteOrDefault(p.entryPercentB, -0.05), -0.15, 0.0),
      minBandWidth: clamp(finiteOrDefault(p.minBandWidth, 0.02), 0.005, 0.12),
      trendUpExitRsiOffset: clamp(finiteOrDefault(p.trendUpExitRsiOffset, 10), 2, 16),
      trendDownExitRsiOffset: clamp(finiteOrDefault(p.trendDownExitRsiOffset, -8), -16, -2),
      rangeExitRsiOffset: clamp(finiteOrDefault(p.rangeExitRsiOffset, -4), -10, 4),
      trendUpExitBandFraction: clamp(finiteOrDefault(p.trendUpExitBandFraction, 0.3), 0.1, 0.6),
      trendDownExitBandFraction: clamp(finiteOrDefault(p.trendDownExitBandFraction, 0.25), 0.05, 0.65),
      volatileExitBandFraction: clamp(finiteOrDefault(p.volatileExitBandFraction, 0.45), 0.1, 0.8),
      profitTakePnlThreshold: clamp(finiteOrDefault(p.profitTakePnlThreshold, 0.015), 0.004, 0.06),
      profitTakeBandWidthFactor: clamp(finiteOrDefault(p.profitTakeBandWidthFactor, 0.55), 0.15, 1.2),
      trendDownProfitTargetScale: clamp(finiteOrDefault(p.trendDownProfitTargetScale, 0.6), 0.25, 0.9),
      volatileProfitTargetScale: clamp(finiteOrDefault(p.volatileProfitTargetScale, 0.8), 0.3, 1.0),
      profitTakeRsiFraction: clamp(finiteOrDefault(p.profitTakeRsiFraction, 0.85), 0.65, 1.0),
      entryBenchmarkLeadWeight: clamp(finiteOrDefault(p.entryBenchmarkLeadWeight, 0), 0, 0.45),
      entryBenchmarkLeadMinScore: clamp(finiteOrDefault(p.entryBenchmarkLeadMinScore, 0), 0, 0.85),
      softExitScoreThreshold: clamp(finiteOrDefault(p.softExitScoreThreshold, 0.54), 0.35, 0.8),
      softExitMinPnl: clamp(finiteOrDefault(p.softExitMinPnl, 0.01), 0.001, 0.06),
      softExitMinBandFraction: clamp(finiteOrDefault(p.softExitMinBandFraction, 0.24), 0.08, 0.9),
      exitVolumeFadeWeight: clamp(finiteOrDefault(p.exitVolumeFadeWeight, 0.22), 0, 0.5),
      exitReversalWeight: clamp(finiteOrDefault(p.exitReversalWeight, 0.3), 0, 0.6),
      exitMomentumDecayWeight: clamp(finiteOrDefault(p.exitMomentumDecayWeight, 0.22), 0, 0.5),
      exitBenchmarkWeaknessWeight: clamp(finiteOrDefault(p.exitBenchmarkWeaknessWeight, 0.12), 0, 0.4),
      exitRelativeFragilityWeight: clamp(finiteOrDefault(p.exitRelativeFragilityWeight, 0), 0, 0.5),
      exitTimeDecayWeight: clamp(finiteOrDefault(p.exitTimeDecayWeight, 0.16), 0, 0.4)
    });
  }

  // Weekly-like BB (default)
  return createBollingerMeanReversionMultiStrategy({
    strategyId: id,
    bbWindow: roundInt(finiteOrDefault(p.bbWindow, 336), 336, 504),
    bbMultiplier: clamp(finiteOrDefault(p.bbMultiplier, 3.0), 2.5, 3.5),
    rsiPeriod: roundInt(finiteOrDefault(p.rsiPeriod, 120), 72, 168),
    entryRsiThreshold: clamp(finiteOrDefault(p.entryRsiThreshold, 32), 18, 40),
    requireRsiConfirmation: isBbRsiConfirmedFamily(block.sourceFamilyId),
    requireReclaimConfirmation: true,
    reclaimLookbackBars: roundInt(finiteOrDefault(p.reclaimLookbackBars, 12), 4, 48),
    reclaimPercentBThreshold: clamp(finiteOrDefault(p.reclaimPercentBThreshold, 0.12), 0.02, 0.35),
    reclaimMinCloseBouncePct: clamp(finiteOrDefault(p.reclaimMinCloseBouncePct, 0.006), 0.001, 0.03),
    reclaimBandWidthFactor: clamp(finiteOrDefault(p.reclaimBandWidthFactor, 0.1), 0.02, 0.35),
    deepTouchEntryPercentB: clamp(finiteOrDefault(p.deepTouchEntryPercentB, -0.16), -0.25, -0.02),
    deepTouchRsiThreshold: clamp(finiteOrDefault(p.deepTouchRsiThreshold, 22), 10, 32),
    exitRsi: clamp(finiteOrDefault(p.exitRsi, 50), 45, 60),
    stopLossPct: clamp(finiteOrDefault(p.stopLossPct, 0.30), 0.20, 0.35),
    maxHoldBars: roundInt(finiteOrDefault(p.maxHoldBars, 504), 336, 1008),
    entryPercentB: clamp(finiteOrDefault(p.entryPercentB, -0.1), -0.2, 0.0),
    minBandWidth: clamp(finiteOrDefault(p.minBandWidth, 0.025), 0.01, 0.18),
    trendUpExitRsiOffset: clamp(finiteOrDefault(p.trendUpExitRsiOffset, 10), 2, 18),
    trendDownExitRsiOffset: clamp(finiteOrDefault(p.trendDownExitRsiOffset, -10), -20, -2),
    rangeExitRsiOffset: clamp(finiteOrDefault(p.rangeExitRsiOffset, -5), -12, 4),
    trendUpExitBandFraction: clamp(finiteOrDefault(p.trendUpExitBandFraction, 0.3), 0.1, 0.7),
    trendDownExitBandFraction: clamp(finiteOrDefault(p.trendDownExitBandFraction, 0.2), 0.05, 0.7),
    volatileExitBandFraction: clamp(finiteOrDefault(p.volatileExitBandFraction, 0.45), 0.1, 0.9),
    profitTakePnlThreshold: clamp(finiteOrDefault(p.profitTakePnlThreshold, 0.025), 0.008, 0.12),
    profitTakeBandWidthFactor: clamp(finiteOrDefault(p.profitTakeBandWidthFactor, 0.8), 0.25, 1.8),
    trendDownProfitTargetScale: clamp(finiteOrDefault(p.trendDownProfitTargetScale, 0.55), 0.25, 1.0),
    volatileProfitTargetScale: clamp(finiteOrDefault(p.volatileProfitTargetScale, 0.75), 0.3, 1.1),
    profitTakeRsiFraction: clamp(finiteOrDefault(p.profitTakeRsiFraction, 0.85), 0.65, 1.0),
    entryBenchmarkLeadWeight: clamp(finiteOrDefault(p.entryBenchmarkLeadWeight, 0), 0, 0.35),
    entryBenchmarkLeadMinScore: clamp(finiteOrDefault(p.entryBenchmarkLeadMinScore, 0), 0, 0.85),
    softExitScoreThreshold: clamp(finiteOrDefault(p.softExitScoreThreshold, 0.6), 0.45, 0.85),
    softExitMinPnl: clamp(finiteOrDefault(p.softExitMinPnl, 0.02), 0.004, 0.12),
    softExitMinBandFraction: clamp(finiteOrDefault(p.softExitMinBandFraction, 0.34), 0.1, 1.0),
    exitVolumeFadeWeight: clamp(finiteOrDefault(p.exitVolumeFadeWeight, 0.18), 0, 0.45),
    exitReversalWeight: clamp(finiteOrDefault(p.exitReversalWeight, 0.28), 0, 0.55),
    exitMomentumDecayWeight: clamp(finiteOrDefault(p.exitMomentumDecayWeight, 0.18), 0, 0.45),
    exitBenchmarkWeaknessWeight: clamp(finiteOrDefault(p.exitBenchmarkWeaknessWeight, 0.12), 0, 0.35),
    exitRelativeFragilityWeight: clamp(finiteOrDefault(p.exitRelativeFragilityWeight, 0), 0, 0.45),
    exitTimeDecayWeight: clamp(finiteOrDefault(p.exitTimeDecayWeight, 0.14), 0, 0.35)
  });
}

function createStrategyFromBlock(block: ValidatedBlock, candidateId: string): Strategy {
  const p = block.parameters;
  const id = `${candidateId}-${block.blockId}`;

  if (isBbMeanReversionFamily(block.sourceFamilyId)) {
    return createBbStrategyFromBlock(block, candidateId);
  }

  if (block.sourceFamilyId.includes("rotation")) {
    return createRelativeStrengthRotationStrategy({
      strategyId: id,
      rebalanceBars: roundInt(finiteOrDefault(p.rebalanceBars, 5), 2, 8),
      entryFloor: clamp(finiteOrDefault(p.entryFloor, 0.78), 0.68, 0.88),
      exitFloor: clamp(finiteOrDefault(p.exitFloor, 0.56), 0.42, 0.72),
      switchGap: clamp(finiteOrDefault(p.switchGap, 0.12), 0.06, 0.18),
      minAboveTrendRatio: clamp(finiteOrDefault(p.minAboveTrendRatio, 0.68), 0.55, 0.86),
      minLiquidityScore: clamp(finiteOrDefault(p.minLiquidityScore, 0.07), 0.02, 0.25),
      minCompositeTrend: clamp(finiteOrDefault(p.minCompositeTrend, 0.02), -0.05, 0.18)
    });
  }

  if (block.sourceFamilyId.includes("leader")) {
    return createLeaderPullbackStateMachineMultiStrategy({
      strategyId: id,
      strengthFloor: clamp(finiteOrDefault(p.strengthFloor, 0.74), 0.55, 0.92),
      pullbackAtr: clamp(finiteOrDefault(p.pullbackAtr, 1), 0.4, 1.6),
      setupExpiryBars: roundInt(finiteOrDefault(p.setupExpiryBars, 5), 2, 10),
      trailAtrMult: clamp(finiteOrDefault(p.trailAtrMult, 2.2), 1.2, 3.4)
    });
  }

  if (block.sourceFamilyId.includes("micro")) {
    return createMicroBreakoutStrategy({
      strategyId: id,
      lookbackBars: roundInt(finiteOrDefault(p.lookbackBars, 10), 5, 18),
      extensionThreshold: clamp(finiteOrDefault(p.extensionThreshold, 0.003), 0.0015, 0.009),
      holdingBarsMax: roundInt(finiteOrDefault(p.holdingBarsMax, 8), 4, 20),
      stopAtrMult: clamp(finiteOrDefault(p.stopAtrMult, 1.05), 0.8, 1.8),
      minVolumeSpike: clamp(finiteOrDefault(p.minVolumeSpike, 0.95), 0.8, 1.5),
      minRiskOnScore: clamp(finiteOrDefault(p.minRiskOnScore, 0.01), -0.02, 0.2),
      minLiquidityScore: clamp(finiteOrDefault(p.minLiquidityScore, 0.03), 0.02, 0.12),
      profitTarget: clamp(finiteOrDefault(p.profitTarget, 0.004), 0.0015, 0.012)
    });
  }

  if (block.sourceFamilyId.includes("breakout")) {
    return createRelativeBreakoutRotationMultiStrategy({
      strategyId: id,
      breakoutLookback: roundInt(finiteOrDefault(p.breakoutLookback, 20), 12, 36),
      strengthFloor: clamp(finiteOrDefault(p.strengthFloor, 0.8), 0.65, 0.95),
      maxExtensionAtr: clamp(finiteOrDefault(p.maxExtensionAtr, 1.3), 0.8, 2.2),
      trailAtrMult: clamp(finiteOrDefault(p.trailAtrMult, 2.2), 1.2, 3.4)
    });
  }

  if (block.sourceFamilyId.includes("reversion")) {
    return createResidualReversionMultiStrategy({
      strategyId: id,
      entryThreshold: clamp(finiteOrDefault(p.entryThreshold, 0.24), 0.15, 0.45),
      exitThreshold: clamp(finiteOrDefault(p.exitThreshold, 0.13), 0.05, 0.3),
      stopLossPct: clamp(finiteOrDefault(p.stopLossPct, 0.022), 0.01, 0.04),
      maxHoldBars: roundInt(finiteOrDefault(p.maxHoldBars, 20), 8, 48)
    });
  }

  if (block.sourceFamilyId.includes("pullback")) {
    return createRelativeMomentumPullbackMultiStrategy({
      strategyId: id,
      minStrengthPct: clamp(finiteOrDefault(p.minStrengthPct, 0.8), 0.6, 0.95),
      minRiskOn: clamp(finiteOrDefault(p.minRiskOn, 0.1), -0.05, 0.35),
      pullbackZ: clamp(finiteOrDefault(p.pullbackZ, 0.9), 0.4, 1.8),
      trailAtrMult: clamp(finiteOrDefault(p.trailAtrMult, 2.2), 1.2, 3.2)
    });
  }

  throw new Error(`Cannot create strategy from block: ${block.sourceFamilyId}`);
}

export const ASSEMBLED_PORTFOLIO_PREFIX = "portfolio:assembled:";

export function isAssembledPortfolioStrategyName(name: string): boolean {
  return name.startsWith(ASSEMBLED_PORTFOLIO_PREFIX);
}

export function assemblePortfolioFromBlocks(params: {
  candidateId: string;
  blockCatalog: ValidatedBlockCatalog;
  blockIds: string[];
  sleeveAllocations: Record<string, number>;
  portfolioParams: {
    universeTopN: number;
    maxOpenPositions: number;
    maxCapitalUsagePct: number;
    cooldownBarsAfterLoss: number;
    minBarsBetweenEntries: number;
    universeLookbackBars: number;
    refreshEveryBars: number;
  };
}): PortfolioCandidateRuntime {
  const { candidateId, blockCatalog, blockIds, sleeveAllocations, portfolioParams } = params;

  const blocks = blockIds.map((id) => {
    const block = blockCatalog.blocks.find((b) => b.blockId === id);
    if (!block) {
      throw new Error(`Block not found in catalog: ${id}`);
    }
    return block;
  });

  const strategies: Strategy[] = [];
  const sleeveBudgets: Array<{ sleeveId: SleeveId; capitalBudgetPct: number; priority: number }> = [];
  const requiredTimeframeSet = new Set<StrategyTimeframe>();

  for (const block of blocks) {
    const baseStrategy = createStrategyFromBlock(block, candidateId);
    const gate = buildGateFromBlock(block);
    strategies.push(withRegimeGate({ strategy: baseStrategy, gate }));

    const alloc = sleeveAllocations[block.sleeveId] ?? sleeveAllocations[block.blockId] ?? 0.2;
    const resolvedSleeveId: SleeveId =
      block.sleeveId === "trend" || block.sleeveId === "breakout" || block.sleeveId === "micro"
        ? block.sleeveId
        : "micro";
    sleeveBudgets.push({
      sleeveId: resolvedSleeveId,
      capitalBudgetPct: clamp(alloc, 0.05, 0.8),
      priority: block.family === "trend" ? 10 : block.family === "breakout" ? 8 : 7
    });

    requiredTimeframeSet.add(block.decisionTimeframe);
    requiredTimeframeSet.add(block.executionTimeframe);
  }

  const maxCapitalUsagePct = clamp(portfolioParams.maxCapitalUsagePct, 0.3, 0.95);
  const totalBudget = sleeveBudgets.reduce((s, sl) => s + sl.capitalBudgetPct, 0);
  const scale = totalBudget > maxCapitalUsagePct ? maxCapitalUsagePct / totalBudget : 1;

  const sleeves: StrategySleeveConfig[] = sleeveBudgets.map((sl) => ({
    sleeveId: sl.sleeveId,
    capitalBudgetPct: Number((sl.capitalBudgetPct * scale).toFixed(4)),
    maxOpenPositions: 1,
    maxSinglePositionPct: 0.5,
    priority: sl.priority
  }));

  const maxOpen = portfolioParams.maxOpenPositions;
  const byBudget = sleeves
    .map((sl, i) => ({ sl, i }))
    .sort((a, b) => b.sl.capitalBudgetPct - a.sl.capitalBudgetPct);
  const allocations = new Array(sleeves.length).fill(1) as number[];
  let remaining = Math.max(0, maxOpen - sleeves.length);
  for (const entry of byBudget) {
    if (remaining <= 0) break;
    allocations[entry.i]! += 1;
    remaining -= 1;
  }
  for (const [i, sl] of sleeves.entries()) {
    sl.maxOpenPositions = Math.max(1, allocations[i] ?? 1);
  }

  return {
    label: `assembled-${candidateId}`,
    strategies,
    sleeves,
    requiredTimeframes: Array.from(requiredTimeframeSet) as StrategyTimeframe[],
    universeTopN: roundInt(portfolioParams.universeTopN, 4, 18),
    maxOpenPositions: roundInt(portfolioParams.maxOpenPositions, 2, 8),
    maxCapitalUsagePct,
    cooldownBarsAfterLoss: roundInt(portfolioParams.cooldownBarsAfterLoss, 2, 30),
    minBarsBetweenEntries: roundInt(portfolioParams.minBarsBetweenEntries, 1, 10),
    universeLookbackBars: roundInt(portfolioParams.universeLookbackBars, 10, 60),
    refreshEveryBars: roundInt(portfolioParams.refreshEveryBars, 1, 10)
  };
}
