import type { Strategy, StrategySleeveConfig, StrategyTimeframe } from "../../../../packages/shared/src/index.js";
import {
  createMicroBreakoutStrategy,
  createLeaderPullbackStateMachineMultiStrategy,
  createRelativeBreakoutRotationMultiStrategy,
  createRelativeMomentumPullbackMultiStrategy,
  createResidualReversionMultiStrategy,
  createRelativeStrengthRotationStrategy,
  withRegimeGate
} from "../multi-strategy/index.js";
import type { NormalizedCandidateProposal, ValidatedBlockCatalog } from "./types.js";
import { assemblePortfolioFromBlocks, ASSEMBLED_PORTFOLIO_PREFIX } from "./portfolio-assembler.js";

export const PORTFOLIO_STRATEGY_PREFIX = "portfolio:";
export const MULTI_TF_REGIME_CORE_PORTFOLIO = `${PORTFOLIO_STRATEGY_PREFIX}multi-tf-regime-core`;
export const MULTI_TF_TREND_BURST_PORTFOLIO = `${PORTFOLIO_STRATEGY_PREFIX}multi-tf-trend-burst`;
export const MULTI_TF_DEFENSIVE_RECLAIM_PORTFOLIO = `${PORTFOLIO_STRATEGY_PREFIX}multi-tf-defensive-reclaim`;
export const MULTI_TF_REGIME_SWITCH_SCREEN_PORTFOLIO = `${PORTFOLIO_STRATEGY_PREFIX}multi-tf-regime-switch-screen`;
export const MULTI_TF_REGIME_SWITCH_PORTFOLIO = `${PORTFOLIO_STRATEGY_PREFIX}multi-tf-regime-switch`;

export type PortfolioCandidateRuntime = {
  label: string;
  strategies: Strategy[];
  sleeves: StrategySleeveConfig[];
  requiredTimeframes: StrategyTimeframe[];
  universeTopN: number;
  maxOpenPositions: number;
  maxCapitalUsagePct: number;
  cooldownBarsAfterLoss: number;
  minBarsBetweenEntries: number;
  universeLookbackBars: number;
  refreshEveryBars: number;
};

type PortfolioCandidateLike = Pick<NormalizedCandidateProposal, "candidateId" | "strategyName" | "parameters">;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function finiteOrDefault(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function roundInt(value: number, min: number, max: number): number {
  return Math.round(clamp(value, min, max));
}

function scaleSleeveBudgets(
  maxCapitalUsagePct: number,
  sleeves: Array<{ sleeveId: StrategySleeveConfig["sleeveId"]; capitalBudgetPct: number; priority: number }>
): StrategySleeveConfig[] {
  const totalBudget = sleeves.reduce((sum, sleeve) => sum + sleeve.capitalBudgetPct, 0);
  const scale = totalBudget > maxCapitalUsagePct ? maxCapitalUsagePct / totalBudget : 1;

  return sleeves.map((sleeve, index) => ({
    sleeveId: sleeve.sleeveId,
    capitalBudgetPct: Number((sleeve.capitalBudgetPct * scale).toFixed(4)),
    maxOpenPositions: 1,
    maxSinglePositionPct: index === 0 ? 0.65 : 0.5,
    priority: sleeve.priority
  }));
}

function distributeMaxOpenPositions(
  sleeves: StrategySleeveConfig[],
  maxOpenPositions: number
): StrategySleeveConfig[] {
  const byBudget = sleeves
    .map((sleeve, index) => ({ sleeve, index }))
    .sort((left, right) => right.sleeve.capitalBudgetPct - left.sleeve.capitalBudgetPct);
  const allocations = new Array(sleeves.length).fill(1);
  let remaining = Math.max(0, maxOpenPositions - sleeves.length);

  for (const entry of byBudget) {
    if (remaining <= 0) {
      break;
    }
    allocations[entry.index] += 1;
    remaining -= 1;
  }

  while (remaining > 0 && byBudget.length > 0) {
    for (const entry of byBudget) {
      if (remaining <= 0) {
        break;
      }
      allocations[entry.index] += 1;
      remaining -= 1;
    }
  }

  return sleeves.map((sleeve, index) => ({
    ...sleeve,
    maxOpenPositions: Math.max(1, allocations[index] ?? 1)
  }));
}

function buildSleeves(params: {
  maxCapitalUsagePct: number;
  maxOpenPositions: number;
  budgets: Array<{ sleeveId: StrategySleeveConfig["sleeveId"]; capitalBudgetPct: number; priority: number }>;
}): StrategySleeveConfig[] {
  return distributeMaxOpenPositions(
    scaleSleeveBudgets(params.maxCapitalUsagePct, params.budgets),
    params.maxOpenPositions
  );
}

function buildRegimeSwitchRuntime(params: {
  candidate: PortfolioCandidateLike;
  includeMicro: boolean;
  label: string;
}): PortfolioCandidateRuntime {
  const { candidate, includeMicro, label } = params;
  const universeTopN = roundInt(finiteOrDefault(candidate.parameters.universeTopN, 9), 4, 16);
  const maxOpenPositions = roundInt(finiteOrDefault(candidate.parameters.maxOpenPositions, 4), 3, 6);
  const maxCapitalUsagePct = clamp(
    finiteOrDefault(candidate.parameters.maxCapitalUsagePct, 0.72),
    0.35,
    0.92
  );
  const trendBudgetPct = clamp(finiteOrDefault(candidate.parameters.trendBudgetPct, 0.28), 0.12, 0.5);
  const breakoutBudgetPct = clamp(
    finiteOrDefault(candidate.parameters.breakoutBudgetPct, 0.18),
    0.08,
    0.4
  );
  const microBudgetPct = clamp(finiteOrDefault(candidate.parameters.microBudgetPct, 0.2), 0.05, 0.28);
  const trendRebalanceBars = roundInt(
    finiteOrDefault(candidate.parameters.trendRebalanceBars, 5),
    2,
    8
  );
  const sleeves = buildSleeves({
    maxCapitalUsagePct,
    maxOpenPositions,
    budgets: [
      { sleeveId: "trend", capitalBudgetPct: trendBudgetPct, priority: 10 },
      { sleeveId: "breakout", capitalBudgetPct: breakoutBudgetPct, priority: 8 },
      { sleeveId: "micro", capitalBudgetPct: microBudgetPct, priority: 7 }
    ]
  });

  const strategies: Strategy[] = [
    withRegimeGate({
      strategy: createRelativeStrengthRotationStrategy({
        strategyId: `${candidate.candidateId}-rotation`,
        rebalanceBars: trendRebalanceBars,
        entryFloor: clamp(finiteOrDefault(candidate.parameters.trendEntryFloor, 0.78), 0.68, 0.88),
        exitFloor: clamp(finiteOrDefault(candidate.parameters.trendExitFloor, 0.56), 0.42, 0.72),
        switchGap: clamp(finiteOrDefault(candidate.parameters.trendSwitchGap, 0.12), 0.06, 0.18),
        minAboveTrendRatio: clamp(
          finiteOrDefault(candidate.parameters.trendMinAboveTrendRatio, 0.68),
          0.55,
          0.86
        ),
        minLiquidityScore: clamp(
          finiteOrDefault(candidate.parameters.trendMinLiquidityScore, 0.07),
          0.02,
          0.25
        ),
        minCompositeTrend: clamp(
          finiteOrDefault(candidate.parameters.trendMinCompositeTrend, 0.02),
          -0.05,
          0.18
        )
      }),
      gate: {
        allowedRegimes: ["trend_up"],
        minRiskOnScore: clamp(
          finiteOrDefault(candidate.parameters.trendMinRiskOnGate, 0.04),
          -0.08,
          0.25
        ),
        minCompositeTrendScore: clamp(
          finiteOrDefault(candidate.parameters.trendMinTrendScoreGate, 0.02),
          -0.05,
          0.2
        ),
        minAboveTrendRatio: clamp(
          finiteOrDefault(candidate.parameters.trendGateMinAboveTrendRatio, 0.58),
          0.45,
          0.8
        ),
        minLiquidityScore: clamp(
          finiteOrDefault(candidate.parameters.trendGateMinLiquidityScore, 0.04),
          0.01,
          0.25
        )
      }
    }),
    withRegimeGate({
      strategy: createLeaderPullbackStateMachineMultiStrategy({
        strategyId: `${candidate.candidateId}-leader`,
        strengthFloor: clamp(
          finiteOrDefault(candidate.parameters.leaderStrengthFloor, 0.74),
          0.55,
          0.92
        ),
        pullbackAtr: clamp(
          finiteOrDefault(candidate.parameters.leaderPullbackAtr, 1),
          0.4,
          1.6
        ),
        setupExpiryBars: roundInt(
          finiteOrDefault(candidate.parameters.leaderSetupExpiryBars, 5),
          2,
          10
        ),
        trailAtrMult: clamp(
          finiteOrDefault(candidate.parameters.leaderTrailAtrMult, 2.2),
          1.2,
          3.4
        )
      }),
      gate: {
        allowedRegimes: ["trend_up"],
        minRiskOnScore: clamp(
          finiteOrDefault(candidate.parameters.leaderMinRiskOnGate, 0.02),
          -0.08,
          0.25
        ),
        minCompositeTrendScore: clamp(
          finiteOrDefault(candidate.parameters.leaderMinTrendScoreGate, 0.01),
          -0.05,
          0.2
        ),
        minLiquidityScore: clamp(
          finiteOrDefault(candidate.parameters.leaderMinLiquidityGate, 0.03),
          0.01,
          0.25
        )
      }
    }),
    withRegimeGate({
      strategy: createRelativeBreakoutRotationMultiStrategy({
        strategyId: `${candidate.candidateId}-breakout`,
        breakoutLookback: roundInt(
          finiteOrDefault(candidate.parameters.breakoutLookback, 20),
          12,
          36
        ),
        strengthFloor: clamp(
          finiteOrDefault(candidate.parameters.breakoutStrengthFloor, 0.8),
          0.65,
          0.95
        ),
        maxExtensionAtr: clamp(
          finiteOrDefault(candidate.parameters.breakoutMaxExtensionAtr, 1.3),
          0.8,
          2.2
        ),
        trailAtrMult: clamp(
          finiteOrDefault(candidate.parameters.breakoutTrailAtrMult, 2.2),
          1.2,
          3.4
        )
      }),
      gate: {
        allowedRegimes: ["trend_up", "volatile"],
        minRiskOnScore: clamp(
          finiteOrDefault(candidate.parameters.breakoutMinRiskOnGate, 0.02),
          -0.05,
          0.2
        ),
        minLiquidityScore: clamp(
          finiteOrDefault(candidate.parameters.breakoutMinLiquidityGate, 0.04),
          0.01,
          0.25
        ),
        minHistoricalVolatility: clamp(
          finiteOrDefault(candidate.parameters.breakoutMinVolatilityGate, 0.008),
          0.003,
          0.04
        )
      }
    }),
    withRegimeGate({
      strategy: createResidualReversionMultiStrategy({
        strategyId: `${candidate.candidateId}-reversion`,
        entryThreshold: clamp(
          finiteOrDefault(candidate.parameters.reversionEntryThreshold, 0.24),
          0.15,
          0.45
        ),
        exitThreshold: clamp(
          finiteOrDefault(candidate.parameters.reversionExitThreshold, 0.13),
          0.05,
          0.3
        ),
        stopLossPct: clamp(
          finiteOrDefault(candidate.parameters.reversionStopLossPct, 0.022),
          0.01,
          0.04
        ),
        maxHoldBars: roundInt(
          finiteOrDefault(candidate.parameters.reversionMaxHoldBars, 20),
          8,
          48
        )
      }),
      gate: {
        allowedRegimes: ["range", "trend_down", "volatile"],
        maxRiskOnScore: clamp(
          finiteOrDefault(candidate.parameters.reversionMaxRiskOnGate, 0.1),
          -0.2,
          0.3
        ),
        maxCompositeTrendScore: clamp(
          finiteOrDefault(candidate.parameters.reversionMaxTrendScoreGate, 0.06),
          -0.2,
          0.25
        ),
        maxHistoricalVolatility: clamp(
          finiteOrDefault(candidate.parameters.reversionMaxVolatilityGate, 0.06),
          0.015,
          0.08
        )
      }
    })
  ];

  if (includeMicro) {
    strategies.push(
      withRegimeGate({
        strategy: createMicroBreakoutStrategy({
          strategyId: `${candidate.candidateId}-micro`,
          lookbackBars: roundInt(
            finiteOrDefault(candidate.parameters.microLookbackBars, 10),
            5,
            18
          ),
          extensionThreshold: clamp(
            finiteOrDefault(candidate.parameters.microExtensionThreshold, 0.003),
            0.0015,
            0.009
          ),
          holdingBarsMax: roundInt(
            finiteOrDefault(candidate.parameters.microHoldingBarsMax, 8),
            4,
            20
          ),
          stopAtrMult: clamp(
            finiteOrDefault(candidate.parameters.microStopAtrMult, 1.05),
            0.8,
            1.8
          ),
          minVolumeSpike: clamp(
            finiteOrDefault(candidate.parameters.microMinVolumeSpike, 0.95),
            0.8,
            1.5
          ),
          minRiskOnScore: clamp(
            finiteOrDefault(candidate.parameters.microMinRiskOnScore, 0.01),
            -0.02,
            0.2
          ),
          minLiquidityScore: clamp(
            finiteOrDefault(candidate.parameters.microMinLiquidityScore, 0.03),
            0.02,
            0.12
          ),
          profitTarget: clamp(
            finiteOrDefault(candidate.parameters.microProfitTarget, 0.004),
            0.0015,
            0.012
          )
        }),
        gate: {
          allowedRegimes: ["trend_up", "volatile"],
          minRiskOnScore: clamp(
            finiteOrDefault(candidate.parameters.microMinRiskOnGate, 0.01),
            -0.05,
            0.18
          ),
          minLiquidityScore: clamp(
            finiteOrDefault(candidate.parameters.microMinLiquidityGate, 0.03),
            0.02,
            0.15
          ),
          minHistoricalVolatility: clamp(
            finiteOrDefault(candidate.parameters.microMinVolatilityGate, 0.008),
            0.003,
            0.03
          )
        }
      })
    );
  }

  return {
    label,
    strategies,
    sleeves,
    requiredTimeframes: includeMicro ? ["1h", "15m", "5m", "1m"] : ["1h", "15m", "5m"],
    universeTopN,
    maxOpenPositions,
    maxCapitalUsagePct,
    cooldownBarsAfterLoss: roundInt(
      finiteOrDefault(candidate.parameters.cooldownBarsAfterLoss, 12),
      2,
      24
    ),
    minBarsBetweenEntries: roundInt(
      finiteOrDefault(candidate.parameters.minBarsBetweenEntries, 6),
      2,
      10
    ),
    universeLookbackBars: roundInt(
      finiteOrDefault(candidate.parameters.universeLookbackBars, 28),
      10,
      60
    ),
    refreshEveryBars: trendRebalanceBars
  };
}

export function isPortfolioStrategyName(strategyName: string): boolean {
  return strategyName.startsWith(PORTFOLIO_STRATEGY_PREFIX);
}

export function buildPortfolioCandidateRuntime(
  candidate: PortfolioCandidateLike,
  blockCatalog?: ValidatedBlockCatalog
): PortfolioCandidateRuntime {
  if (candidate.strategyName.startsWith(ASSEMBLED_PORTFOLIO_PREFIX) && blockCatalog) {
    const blockIds = blockCatalog.blocks.map((b) => b.blockId);
    const sleeveAllocations: Record<string, number> = {};
    for (const [key, value] of Object.entries(candidate.parameters)) {
      if (key.startsWith("sleeveAlloc_")) {
        sleeveAllocations[key.replace("sleeveAlloc_", "")] = value;
      }
    }
    return assemblePortfolioFromBlocks({
      candidateId: candidate.candidateId,
      blockCatalog,
      blockIds,
      sleeveAllocations,
      portfolioParams: {
        universeTopN: candidate.parameters.universeTopN ?? 9,
        maxOpenPositions: candidate.parameters.maxOpenPositions ?? 4,
        maxCapitalUsagePct: candidate.parameters.maxCapitalUsagePct ?? 0.72,
        cooldownBarsAfterLoss: candidate.parameters.cooldownBarsAfterLoss ?? 8,
        minBarsBetweenEntries: candidate.parameters.minBarsBetweenEntries ?? 2,
        universeLookbackBars: candidate.parameters.universeLookbackBars ?? 28,
        refreshEveryBars: candidate.parameters.refreshEveryBars ?? 4
      }
    });
  }

  switch (candidate.strategyName) {
    case MULTI_TF_REGIME_CORE_PORTFOLIO: {
      const universeTopN = roundInt(finiteOrDefault(candidate.parameters.universeTopN, 10), 6, 18);
      const maxOpenPositions = roundInt(finiteOrDefault(candidate.parameters.maxOpenPositions, 4), 2, 6);
      const maxCapitalUsagePct = clamp(
        finiteOrDefault(candidate.parameters.maxCapitalUsagePct, 0.9),
        0.45,
        0.95
      );
      const trendRebalanceBars = roundInt(
        finiteOrDefault(candidate.parameters.trendRebalanceBars, 3),
        1,
        6
      );
      const trendBudgetPct = clamp(finiteOrDefault(candidate.parameters.trendBudgetPct, 0.52), 0.25, 0.75);
      const breakoutBudgetPct = clamp(
        finiteOrDefault(candidate.parameters.breakoutBudgetPct, 0.28),
        0.1,
        0.45
      );
      const sleeves = buildSleeves({
        maxCapitalUsagePct,
        maxOpenPositions,
        budgets: [
          {
            sleeveId: "trend",
            capitalBudgetPct: trendBudgetPct,
            priority: 9
          },
          {
            sleeveId: "breakout",
            capitalBudgetPct: breakoutBudgetPct,
            priority: 7
          }
        ]
      });

      return {
        label: "multi-tf-regime-core",
        strategies: [
          createRelativeStrengthRotationStrategy({
            strategyId: `${candidate.candidateId}-rotation`,
            rebalanceBars: trendRebalanceBars,
            entryFloor: clamp(finiteOrDefault(candidate.parameters.trendEntryFloor, 0.68), 0.58, 0.85),
            exitFloor: clamp(finiteOrDefault(candidate.parameters.trendExitFloor, 0.5), 0.35, 0.68),
            switchGap: clamp(finiteOrDefault(candidate.parameters.trendSwitchGap, 0.1), 0.03, 0.18),
            minAboveTrendRatio: clamp(
              finiteOrDefault(candidate.parameters.trendMinAboveTrendRatio, 0.58),
              0.45,
              0.8
            ),
            minLiquidityScore: clamp(
              finiteOrDefault(candidate.parameters.trendMinLiquidityScore, 0.05),
              0.01,
              0.25
            ),
            minCompositeTrend: clamp(
              finiteOrDefault(candidate.parameters.trendMinCompositeTrend, 0),
              -0.05,
              0.2
            )
          }),
          createRelativeMomentumPullbackMultiStrategy({
            strategyId: `${candidate.candidateId}-pullback`,
            minStrengthPct: clamp(
              finiteOrDefault(candidate.parameters.pullbackMinStrengthPct, 0.8),
              0.65,
              0.92
            ),
            minRiskOn: clamp(
              finiteOrDefault(candidate.parameters.pullbackMinRiskOn, 0.1),
              -0.02,
              0.25
            ),
            pullbackZ: clamp(finiteOrDefault(candidate.parameters.pullbackZ, 0.9), 0.5, 1.5),
            trailAtrMult: clamp(
              finiteOrDefault(candidate.parameters.pullbackTrailAtrMult, 2.2),
              1.2,
              3.2
            )
          }),
          createRelativeBreakoutRotationMultiStrategy({
            strategyId: `${candidate.candidateId}-breakout`,
            breakoutLookback: roundInt(
              finiteOrDefault(candidate.parameters.breakoutLookback, 20),
              12,
              36
            ),
            strengthFloor: clamp(
              finiteOrDefault(candidate.parameters.breakoutStrengthFloor, 0.75),
              0.6,
              0.92
            ),
            maxExtensionAtr: clamp(
              finiteOrDefault(candidate.parameters.breakoutMaxExtensionAtr, 1.4),
              0.8,
              2.2
            ),
            trailAtrMult: clamp(
              finiteOrDefault(candidate.parameters.breakoutTrailAtrMult, 2.2),
              1.2,
              3.2
            )
          })
        ],
        sleeves,
        requiredTimeframes: ["1h", "15m", "5m"],
        universeTopN,
        maxOpenPositions,
        maxCapitalUsagePct,
        cooldownBarsAfterLoss: roundInt(
          finiteOrDefault(candidate.parameters.cooldownBarsAfterLoss, 8),
          2,
          24
        ),
        minBarsBetweenEntries: roundInt(
          finiteOrDefault(candidate.parameters.minBarsBetweenEntries, 1),
          1,
          6
        ),
        universeLookbackBars: roundInt(
          finiteOrDefault(candidate.parameters.universeLookbackBars, 30),
          10,
          60
        ),
        refreshEveryBars: trendRebalanceBars
      };
    }
    case MULTI_TF_TREND_BURST_PORTFOLIO: {
      const universeTopN = roundInt(finiteOrDefault(candidate.parameters.universeTopN, 9), 6, 16);
      const maxOpenPositions = roundInt(finiteOrDefault(candidate.parameters.maxOpenPositions, 4), 2, 6);
      const maxCapitalUsagePct = clamp(
        finiteOrDefault(candidate.parameters.maxCapitalUsagePct, 0.82),
        0.5,
        0.95
      );
      const trendRebalanceBars = roundInt(
        finiteOrDefault(candidate.parameters.trendRebalanceBars, 2),
        1,
        4
      );
      const trendBudgetPct = clamp(finiteOrDefault(candidate.parameters.trendBudgetPct, 0.4), 0.2, 0.7);
      const breakoutBudgetPct = clamp(
        finiteOrDefault(candidate.parameters.breakoutBudgetPct, 0.32),
        0.15,
        0.5
      );
      const sleeves = buildSleeves({
        maxCapitalUsagePct,
        maxOpenPositions,
        budgets: [
          { sleeveId: "trend", capitalBudgetPct: trendBudgetPct, priority: 10 },
          { sleeveId: "breakout", capitalBudgetPct: breakoutBudgetPct, priority: 8 }
        ]
      });

      return {
        label: "multi-tf-trend-burst",
        strategies: [
          createRelativeStrengthRotationStrategy({
            strategyId: `${candidate.candidateId}-rotation`,
            rebalanceBars: trendRebalanceBars,
            entryFloor: clamp(finiteOrDefault(candidate.parameters.trendEntryFloor, 0.74), 0.62, 0.88),
            exitFloor: clamp(finiteOrDefault(candidate.parameters.trendExitFloor, 0.56), 0.4, 0.7),
            switchGap: clamp(finiteOrDefault(candidate.parameters.trendSwitchGap, 0.12), 0.04, 0.2),
            minAboveTrendRatio: clamp(
              finiteOrDefault(candidate.parameters.trendMinAboveTrendRatio, 0.62),
              0.5,
              0.85
            ),
            minLiquidityScore: clamp(
              finiteOrDefault(candidate.parameters.trendMinLiquidityScore, 0.08),
              0.02,
              0.25
            ),
            minCompositeTrend: clamp(
              finiteOrDefault(candidate.parameters.trendMinCompositeTrend, 0.04),
              -0.02,
              0.2
            )
          }),
          createLeaderPullbackStateMachineMultiStrategy({
            strategyId: `${candidate.candidateId}-leader`,
            strengthFloor: clamp(
              finiteOrDefault(candidate.parameters.leaderStrengthFloor, 0.74),
              0.55,
              0.92
            ),
            pullbackAtr: clamp(
              finiteOrDefault(candidate.parameters.leaderPullbackAtr, 0.95),
              0.3,
              1.4
            ),
            setupExpiryBars: roundInt(
              finiteOrDefault(candidate.parameters.leaderSetupExpiryBars, 4),
              2,
              8
            ),
            trailAtrMult: clamp(
              finiteOrDefault(candidate.parameters.leaderTrailAtrMult, 2.1),
              1.2,
              3.2
            )
          }),
          createRelativeBreakoutRotationMultiStrategy({
            strategyId: `${candidate.candidateId}-breakout`,
            breakoutLookback: roundInt(
              finiteOrDefault(candidate.parameters.breakoutLookback, 22),
              14,
              40
            ),
            strengthFloor: clamp(
              finiteOrDefault(candidate.parameters.breakoutStrengthFloor, 0.82),
              0.65,
              0.95
            ),
            maxExtensionAtr: clamp(
              finiteOrDefault(candidate.parameters.breakoutMaxExtensionAtr, 1.25),
              0.8,
              2
            ),
            trailAtrMult: clamp(
              finiteOrDefault(candidate.parameters.breakoutTrailAtrMult, 2.1),
              1.2,
              3.4
            )
          })
        ],
        sleeves,
        requiredTimeframes: ["1h", "15m", "5m"],
        universeTopN,
        maxOpenPositions,
        maxCapitalUsagePct,
        cooldownBarsAfterLoss: roundInt(
          finiteOrDefault(candidate.parameters.cooldownBarsAfterLoss, 7),
          2,
          20
        ),
        minBarsBetweenEntries: roundInt(
          finiteOrDefault(candidate.parameters.minBarsBetweenEntries, 2),
          1,
          5
        ),
        universeLookbackBars: roundInt(
          finiteOrDefault(candidate.parameters.universeLookbackBars, 24),
          10,
          50
        ),
        refreshEveryBars: trendRebalanceBars
      };
    }
    case MULTI_TF_DEFENSIVE_RECLAIM_PORTFOLIO: {
      const universeTopN = roundInt(finiteOrDefault(candidate.parameters.universeTopN, 8), 4, 14);
      const maxOpenPositions = roundInt(finiteOrDefault(candidate.parameters.maxOpenPositions, 3), 2, 5);
      const maxCapitalUsagePct = clamp(
        finiteOrDefault(candidate.parameters.maxCapitalUsagePct, 0.58),
        0.35,
        0.75
      );
      const trendRebalanceBars = roundInt(
        finiteOrDefault(candidate.parameters.trendRebalanceBars, 4),
        2,
        8
      );
      const trendBudgetPct = clamp(finiteOrDefault(candidate.parameters.trendBudgetPct, 0.28), 0.15, 0.5);
      const reversionBudgetPct = clamp(
        finiteOrDefault(candidate.parameters.reversionBudgetPct, 0.2),
        0.1,
        0.35
      );
      const sleeves = buildSleeves({
        maxCapitalUsagePct,
        maxOpenPositions,
        budgets: [
          { sleeveId: "trend", capitalBudgetPct: trendBudgetPct, priority: 9 },
          { sleeveId: "micro", capitalBudgetPct: reversionBudgetPct, priority: 7 }
        ]
      });

      return {
        label: "multi-tf-defensive-reclaim",
        strategies: [
          createRelativeStrengthRotationStrategy({
            strategyId: `${candidate.candidateId}-rotation`,
            rebalanceBars: trendRebalanceBars,
            entryFloor: clamp(finiteOrDefault(candidate.parameters.trendEntryFloor, 0.7), 0.62, 0.82),
            exitFloor: clamp(finiteOrDefault(candidate.parameters.trendExitFloor, 0.5), 0.4, 0.65),
            switchGap: clamp(finiteOrDefault(candidate.parameters.trendSwitchGap, 0.08), 0.03, 0.15),
            minAboveTrendRatio: clamp(
              finiteOrDefault(candidate.parameters.trendMinAboveTrendRatio, 0.64),
              0.5,
              0.85
            ),
            minLiquidityScore: clamp(
              finiteOrDefault(candidate.parameters.trendMinLiquidityScore, 0.08),
              0.02,
              0.25
            ),
            minCompositeTrend: clamp(
              finiteOrDefault(candidate.parameters.trendMinCompositeTrend, 0.03),
              -0.02,
              0.18
            )
          }),
          createLeaderPullbackStateMachineMultiStrategy({
            strategyId: `${candidate.candidateId}-leader`,
            strengthFloor: clamp(
              finiteOrDefault(candidate.parameters.leaderStrengthFloor, 0.7),
              0.55,
              0.95
            ),
            pullbackAtr: clamp(
              finiteOrDefault(candidate.parameters.leaderPullbackAtr, 1.1),
              0.4,
              1.8
            ),
            setupExpiryBars: roundInt(
              finiteOrDefault(candidate.parameters.leaderSetupExpiryBars, 5),
              2,
              10
            ),
            trailAtrMult: clamp(
              finiteOrDefault(candidate.parameters.leaderTrailAtrMult, 2.4),
              1.4,
              3.4
            )
          }),
          createResidualReversionMultiStrategy({
            strategyId: `${candidate.candidateId}-reversion`,
            entryThreshold: clamp(
              finiteOrDefault(candidate.parameters.reversionEntryThreshold, 0.24),
              0.15,
              0.45
            ),
            exitThreshold: clamp(
              finiteOrDefault(candidate.parameters.reversionExitThreshold, 0.14),
              0.05,
              0.3
            ),
            stopLossPct: clamp(
              finiteOrDefault(candidate.parameters.reversionStopLossPct, 0.022),
              0.01,
              0.04
            ),
            maxHoldBars: roundInt(
              finiteOrDefault(candidate.parameters.reversionMaxHoldBars, 24),
              8,
              48
            )
          })
        ],
        sleeves,
        requiredTimeframes: ["1h", "15m", "5m"],
        universeTopN,
        maxOpenPositions,
        maxCapitalUsagePct,
        cooldownBarsAfterLoss: roundInt(
          finiteOrDefault(candidate.parameters.cooldownBarsAfterLoss, 16),
          4,
          30
        ),
        minBarsBetweenEntries: roundInt(
          finiteOrDefault(candidate.parameters.minBarsBetweenEntries, 3),
          1,
          8
        ),
        universeLookbackBars: roundInt(
          finiteOrDefault(candidate.parameters.universeLookbackBars, 28),
          10,
          60
        ),
        refreshEveryBars: trendRebalanceBars
      };
    }
    case MULTI_TF_REGIME_SWITCH_SCREEN_PORTFOLIO:
      return buildRegimeSwitchRuntime({
        candidate,
        includeMicro: false,
        label: "multi-tf-regime-switch-screen"
      });
    case MULTI_TF_REGIME_SWITCH_PORTFOLIO: {
      return buildRegimeSwitchRuntime({
        candidate,
        includeMicro: true,
        label: "multi-tf-regime-switch"
      });
    }
    default:
      throw new Error(`Unsupported portfolio strategy for auto research: ${candidate.strategyName}`);
  }
}
