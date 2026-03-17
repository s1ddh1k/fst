import type { Strategy, StrategySleeveConfig } from "../../../../packages/shared/src/index.js";
import { createBreakoutRotationStrategy } from "./BreakoutRotationStrategy.js";
import { createLeaderPullbackStateMachineMultiStrategy } from "./LeaderPullbackStateMachineStrategy.js";
import { createMicroBreakoutStrategy } from "./MicroStrategy.js";
import { createRelativeMomentumPullbackMultiStrategy } from "./RelativeMomentumPullbackStrategy.js";
import { createRelativeBreakoutRotationMultiStrategy } from "./RelativeBreakoutRotationMultiStrategy.js";
import { createRelativeStrengthRotationStrategy } from "./RelativeStrengthRotationStrategy.js";

export type MultiStrategyPreset = {
  label: string;
  sleeves: StrategySleeveConfig[];
  strategies: Strategy[];
};

function createDefaultSleeves(): StrategySleeveConfig[] {
  return [
    { sleeveId: "trend", capitalBudgetPct: 0.4, maxOpenPositions: 2, maxSinglePositionPct: 0.5, priority: 9 },
    { sleeveId: "breakout", capitalBudgetPct: 0.35, maxOpenPositions: 2, maxSinglePositionPct: 0.5, priority: 7 },
    { sleeveId: "micro", capitalBudgetPct: 0.2, maxOpenPositions: 1, maxSinglePositionPct: 1, priority: 5 }
  ];
}

export function buildMultiStrategyPresets(): MultiStrategyPreset[] {
  return [
    {
      label: "balanced",
      sleeves: createDefaultSleeves(),
      strategies: [
        createRelativeStrengthRotationStrategy(),
        createBreakoutRotationStrategy(),
        createMicroBreakoutStrategy()
      ]
    },
    {
      label: "trend-heavy",
      sleeves: [
        { sleeveId: "trend", capitalBudgetPct: 0.5, maxOpenPositions: 3, maxSinglePositionPct: 0.45, priority: 9 },
        { sleeveId: "breakout", capitalBudgetPct: 0.3, maxOpenPositions: 2, maxSinglePositionPct: 0.45, priority: 7 },
        { sleeveId: "micro", capitalBudgetPct: 0.15, maxOpenPositions: 1, maxSinglePositionPct: 1, priority: 5 }
      ],
      strategies: [
        createRelativeStrengthRotationStrategy({
          rebalanceBars: 2,
          entryFloor: 0.66,
          exitFloor: 0.5,
          switchGap: 0.12
        }),
        createBreakoutRotationStrategy({
          breakoutLookback: 24,
          strengthFloor: 0.75,
          maxExtensionAtr: 1.1,
          trailAtrMult: 2.4
        }),
        createMicroBreakoutStrategy({
          lookbackBars: 10,
          extensionThreshold: 0.0025,
          holdingBarsMax: 8,
          stopAtrMult: 1.1,
          minVolumeSpike: 1
        })
      ]
    },
    {
      label: "intraday-heavy",
      sleeves: [
        { sleeveId: "trend", capitalBudgetPct: 0.3, maxOpenPositions: 2, maxSinglePositionPct: 0.45, priority: 8 },
        { sleeveId: "breakout", capitalBudgetPct: 0.4, maxOpenPositions: 3, maxSinglePositionPct: 0.4, priority: 8 },
        { sleeveId: "micro", capitalBudgetPct: 0.25, maxOpenPositions: 2, maxSinglePositionPct: 0.5, priority: 6 }
      ],
      strategies: [
        createRelativeStrengthRotationStrategy({
          rebalanceBars: 1,
          entryFloor: 0.68,
          exitFloor: 0.52,
          switchGap: 0.1
        }),
        createBreakoutRotationStrategy({
          breakoutLookback: 16,
          strengthFloor: 0.68,
          maxExtensionAtr: 1.5,
          trailAtrMult: 1.9
        }),
        createMicroBreakoutStrategy({
          lookbackBars: 6,
          extensionThreshold: 0.002,
          holdingBarsMax: 6,
          stopAtrMult: 1,
          minVolumeSpike: 1.05
        })
      ]
    },
    {
      label: "conservative",
      sleeves: [
        { sleeveId: "trend", capitalBudgetPct: 0.35, maxOpenPositions: 1, maxSinglePositionPct: 0.5, priority: 9 },
        { sleeveId: "breakout", capitalBudgetPct: 0.2, maxOpenPositions: 1, maxSinglePositionPct: 0.5, priority: 8 },
        { sleeveId: "micro", capitalBudgetPct: 0.05, maxOpenPositions: 1, maxSinglePositionPct: 0.25, priority: 4 }
      ],
      strategies: [
        createRelativeStrengthRotationStrategy({
          rebalanceBars: 4,
          entryFloor: 0.78,
          exitFloor: 0.58,
          switchGap: 0.18,
          minAboveTrendRatio: 0.65,
          minLiquidityScore: 0.1,
          minCompositeTrend: 0.05
        }),
        createBreakoutRotationStrategy({
          breakoutLookback: 30,
          strengthFloor: 0.8,
          maxExtensionAtr: 1.0,
          trailAtrMult: 2.6
        }),
        createMicroBreakoutStrategy({
          lookbackBars: 12,
          extensionThreshold: 0.0015,
          holdingBarsMax: 4,
          stopAtrMult: 0.9,
          minVolumeSpike: 1.15,
          minRiskOnScore: 0.05
        })
      ]
    },
    {
      label: "breakout-only",
      sleeves: [
        { sleeveId: "trend", capitalBudgetPct: 0.05, maxOpenPositions: 0, maxSinglePositionPct: 0, priority: 1 },
        { sleeveId: "breakout", capitalBudgetPct: 0.55, maxOpenPositions: 2, maxSinglePositionPct: 0.5, priority: 9 },
        { sleeveId: "micro", capitalBudgetPct: 0.05, maxOpenPositions: 0, maxSinglePositionPct: 0, priority: 1 }
      ],
      strategies: [
        createBreakoutRotationStrategy({
          breakoutLookback: 24,
          strengthFloor: 0.82,
          maxExtensionAtr: 0.9,
          trailAtrMult: 2.8
        })
      ]
    },
    {
      label: "micro-selective",
      sleeves: [
        { sleeveId: "trend", capitalBudgetPct: 0.02, maxOpenPositions: 0, maxSinglePositionPct: 0, priority: 1 },
        { sleeveId: "breakout", capitalBudgetPct: 0.02, maxOpenPositions: 0, maxSinglePositionPct: 0, priority: 1 },
        { sleeveId: "micro", capitalBudgetPct: 0.12, maxOpenPositions: 1, maxSinglePositionPct: 0.2, priority: 9 }
      ],
      strategies: [
        createMicroBreakoutStrategy({
          lookbackBars: 18,
          extensionThreshold: 0.0012,
          holdingBarsMax: 3,
          stopAtrMult: 0.8,
          minVolumeSpike: 1.35,
          minRiskOnScore: 0.08
        })
      ]
    },
    {
      label: "micro-ultra",
      sleeves: [
        { sleeveId: "trend", capitalBudgetPct: 0.02, maxOpenPositions: 0, maxSinglePositionPct: 0, priority: 1 },
        { sleeveId: "breakout", capitalBudgetPct: 0.02, maxOpenPositions: 0, maxSinglePositionPct: 0, priority: 1 },
        { sleeveId: "micro", capitalBudgetPct: 0.08, maxOpenPositions: 1, maxSinglePositionPct: 0.12, priority: 10 }
      ],
      strategies: [
        createMicroBreakoutStrategy({
          lookbackBars: 24,
          extensionThreshold: 0.0008,
          holdingBarsMax: 2,
          stopAtrMult: 0.7,
          minVolumeSpike: 1.6,
          minRiskOnScore: 0.12,
          minLiquidityScore: 0.08,
          minBreakoutDistance: 0.0004,
          maxBreakoutDistance: 0.0012,
          requireCloseNearHigh: 0.78,
          profitTarget: 0.001
        })
      ]
    },
    {
      label: "micro-ultra-hold",
      sleeves: [
        { sleeveId: "trend", capitalBudgetPct: 0.02, maxOpenPositions: 0, maxSinglePositionPct: 0, priority: 1 },
        { sleeveId: "breakout", capitalBudgetPct: 0.02, maxOpenPositions: 0, maxSinglePositionPct: 0, priority: 1 },
        { sleeveId: "micro", capitalBudgetPct: 0.08, maxOpenPositions: 1, maxSinglePositionPct: 0.12, priority: 10 }
      ],
      strategies: [
        createMicroBreakoutStrategy({
          lookbackBars: 24,
          extensionThreshold: 0.0008,
          holdingBarsMax: 4,
          stopAtrMult: 0.75,
          minVolumeSpike: 1.65,
          minRiskOnScore: 0.12,
          minLiquidityScore: 0.08,
          minBreakoutDistance: 0.00045,
          maxBreakoutDistance: 0.0011,
          requireCloseNearHigh: 0.8,
          profitTarget: 0.0011
        })
      ]
    },
    {
      label: "micro-elite",
      sleeves: [
        { sleeveId: "trend", capitalBudgetPct: 0.02, maxOpenPositions: 0, maxSinglePositionPct: 0, priority: 1 },
        { sleeveId: "breakout", capitalBudgetPct: 0.02, maxOpenPositions: 0, maxSinglePositionPct: 0, priority: 1 },
        { sleeveId: "micro", capitalBudgetPct: 0.07, maxOpenPositions: 1, maxSinglePositionPct: 0.1, priority: 10 }
      ],
      strategies: [
        createMicroBreakoutStrategy({
          lookbackBars: 30,
          extensionThreshold: 0.00075,
          holdingBarsMax: 3,
          stopAtrMult: 0.65,
          minVolumeSpike: 1.85,
          minRiskOnScore: 0.16,
          minLiquidityScore: 0.1,
          minBreakoutDistance: 0.00045,
          maxBreakoutDistance: 0.001,
          requireCloseNearHigh: 0.82,
          profitTarget: 0.0012
        })
      ]
    },
    {
      label: "hourly-pullback",
      sleeves: [
        { sleeveId: "trend", capitalBudgetPct: 0.45, maxOpenPositions: 2, maxSinglePositionPct: 0.45, priority: 10 },
        { sleeveId: "breakout", capitalBudgetPct: 0.02, maxOpenPositions: 0, maxSinglePositionPct: 0, priority: 1 },
        { sleeveId: "micro", capitalBudgetPct: 0.02, maxOpenPositions: 0, maxSinglePositionPct: 0, priority: 1 }
      ],
      strategies: [
        createRelativeMomentumPullbackMultiStrategy({
          minStrengthPct: 0.8,
          minRiskOn: 0.1,
          pullbackZ: 0.9,
          trailAtrMult: 2.2
        })
      ]
    },
    {
      label: "hourly-pullback-focused",
      sleeves: [
        { sleeveId: "trend", capitalBudgetPct: 0.8, maxOpenPositions: 1, maxSinglePositionPct: 0.8, priority: 10 },
        { sleeveId: "breakout", capitalBudgetPct: 0.02, maxOpenPositions: 0, maxSinglePositionPct: 0, priority: 1 },
        { sleeveId: "micro", capitalBudgetPct: 0.02, maxOpenPositions: 0, maxSinglePositionPct: 0, priority: 1 }
      ],
      strategies: [
        createRelativeMomentumPullbackMultiStrategy({
          minStrengthPct: 0.8,
          minRiskOn: 0.1,
          pullbackZ: 0.9,
          trailAtrMult: 2.2
        })
      ]
    },
    {
      label: "hourly-leader",
      sleeves: [
        { sleeveId: "trend", capitalBudgetPct: 0.45, maxOpenPositions: 1, maxSinglePositionPct: 0.45, priority: 10 },
        { sleeveId: "breakout", capitalBudgetPct: 0.02, maxOpenPositions: 0, maxSinglePositionPct: 0, priority: 1 },
        { sleeveId: "micro", capitalBudgetPct: 0.02, maxOpenPositions: 0, maxSinglePositionPct: 0, priority: 1 }
      ],
      strategies: [
        createLeaderPullbackStateMachineMultiStrategy({
          strengthFloor: 0.7,
          pullbackAtr: 0.9,
          setupExpiryBars: 4,
          trailAtrMult: 2.2
        })
      ]
    },
    {
      label: "hourly-breakout",
      sleeves: [
        { sleeveId: "trend", capitalBudgetPct: 0.02, maxOpenPositions: 0, maxSinglePositionPct: 0, priority: 1 },
        { sleeveId: "breakout", capitalBudgetPct: 0.45, maxOpenPositions: 1, maxSinglePositionPct: 0.45, priority: 10 },
        { sleeveId: "micro", capitalBudgetPct: 0.02, maxOpenPositions: 0, maxSinglePositionPct: 0, priority: 1 }
      ],
      strategies: [
        createRelativeBreakoutRotationMultiStrategy({
          breakoutLookback: 20,
          strengthFloor: 0.7,
          maxExtensionAtr: 1.2,
          trailAtrMult: 2.2
        })
      ]
    },
    {
      label: "hourly-dual",
      sleeves: [
        { sleeveId: "trend", capitalBudgetPct: 0.32, maxOpenPositions: 1, maxSinglePositionPct: 0.32, priority: 10 },
        { sleeveId: "breakout", capitalBudgetPct: 0.24, maxOpenPositions: 1, maxSinglePositionPct: 0.24, priority: 8 },
        { sleeveId: "micro", capitalBudgetPct: 0.02, maxOpenPositions: 0, maxSinglePositionPct: 0, priority: 1 }
      ],
      strategies: [
        createRelativeMomentumPullbackMultiStrategy({
          minStrengthPct: 0.8,
          minRiskOn: 0.1,
          pullbackZ: 0.9,
          trailAtrMult: 2.2
        }),
        createLeaderPullbackStateMachineMultiStrategy({
          strengthFloor: 0.7,
          pullbackAtr: 0.9,
          setupExpiryBars: 4,
          trailAtrMult: 2.2
        }),
        createRelativeBreakoutRotationMultiStrategy({
          breakoutLookback: 20,
          strengthFloor: 0.7,
          maxExtensionAtr: 1.2,
          trailAtrMult: 2.2
        })
      ]
    },
    {
      label: "hourly-dual-conservative",
      sleeves: [
        { sleeveId: "trend", capitalBudgetPct: 0.28, maxOpenPositions: 1, maxSinglePositionPct: 0.28, priority: 10 },
        { sleeveId: "breakout", capitalBudgetPct: 0.18, maxOpenPositions: 1, maxSinglePositionPct: 0.18, priority: 8 },
        { sleeveId: "micro", capitalBudgetPct: 0.02, maxOpenPositions: 0, maxSinglePositionPct: 0, priority: 1 }
      ],
      strategies: [
        createRelativeMomentumPullbackMultiStrategy({
          minStrengthPct: 0.8,
          minRiskOn: 0.1,
          pullbackZ: 0.9,
          trailAtrMult: 2.2
        }),
        createLeaderPullbackStateMachineMultiStrategy({
          strengthFloor: 0.78,
          pullbackAtr: 1,
          setupExpiryBars: 3,
          trailAtrMult: 2.4
        }),
        createRelativeBreakoutRotationMultiStrategy({
          breakoutLookback: 24,
          strengthFloor: 0.78,
          maxExtensionAtr: 1,
          trailAtrMult: 2.6
        })
      ]
    },
    {
      label: "hourly-pullback-loose",
      sleeves: [
        { sleeveId: "trend", capitalBudgetPct: 0.45, maxOpenPositions: 2, maxSinglePositionPct: 0.45, priority: 10 },
        { sleeveId: "breakout", capitalBudgetPct: 0.02, maxOpenPositions: 0, maxSinglePositionPct: 0, priority: 1 },
        { sleeveId: "micro", capitalBudgetPct: 0.02, maxOpenPositions: 0, maxSinglePositionPct: 0, priority: 1 }
      ],
      strategies: [
        createRelativeMomentumPullbackMultiStrategy({
          minStrengthPct: 0.7,
          minRiskOn: 0.05,
          pullbackZ: 0.6,
          trailAtrMult: 2
        })
      ]
    },
    {
      label: "hourly-pullback-trend",
      sleeves: [
        { sleeveId: "trend", capitalBudgetPct: 0.45, maxOpenPositions: 2, maxSinglePositionPct: 0.45, priority: 10 },
        { sleeveId: "breakout", capitalBudgetPct: 0.02, maxOpenPositions: 0, maxSinglePositionPct: 0, priority: 1 },
        { sleeveId: "micro", capitalBudgetPct: 0.02, maxOpenPositions: 0, maxSinglePositionPct: 0, priority: 1 }
      ],
      strategies: [
        createRelativeMomentumPullbackMultiStrategy({
          minStrengthPct: 0.8,
          minRiskOn: 0.05,
          pullbackZ: 0.9,
          trailAtrMult: 2.6
        })
      ]
    },
    {
      label: "hourly-pullback-tight",
      sleeves: [
        { sleeveId: "trend", capitalBudgetPct: 0.45, maxOpenPositions: 2, maxSinglePositionPct: 0.45, priority: 10 },
        { sleeveId: "breakout", capitalBudgetPct: 0.02, maxOpenPositions: 0, maxSinglePositionPct: 0, priority: 1 },
        { sleeveId: "micro", capitalBudgetPct: 0.02, maxOpenPositions: 0, maxSinglePositionPct: 0, priority: 1 }
      ],
      strategies: [
        createRelativeMomentumPullbackMultiStrategy({
          minStrengthPct: 0.9,
          minRiskOn: 0.15,
          pullbackZ: 1.2,
          trailAtrMult: 2.6
        })
      ]
    },
    {
      label: "hourly-pullback-lite",
      sleeves: [
        { sleeveId: "trend", capitalBudgetPct: 0.35, maxOpenPositions: 2, maxSinglePositionPct: 0.35, priority: 10 },
        { sleeveId: "breakout", capitalBudgetPct: 0.02, maxOpenPositions: 0, maxSinglePositionPct: 0, priority: 1 },
        { sleeveId: "micro", capitalBudgetPct: 0.03, maxOpenPositions: 1, maxSinglePositionPct: 0.08, priority: 4 }
      ],
      strategies: [
        createRelativeMomentumPullbackMultiStrategy({
          minStrengthPct: 0.7,
          minRiskOn: 0.05,
          pullbackZ: 0.6,
          trailAtrMult: 2.6
        }),
        createMicroBreakoutStrategy({
          lookbackBars: 28,
          extensionThreshold: 0.0008,
          holdingBarsMax: 2,
          stopAtrMult: 0.6,
          minVolumeSpike: 1.9,
          minRiskOnScore: 0.18,
          minLiquidityScore: 0.12,
          minBreakoutDistance: 0.0005,
          maxBreakoutDistance: 0.00095,
          requireCloseNearHigh: 0.84,
          profitTarget: 0.0012
        })
      ]
    },
    {
      label: "conservative-micro-lite",
      sleeves: [
        { sleeveId: "trend", capitalBudgetPct: 0.25, maxOpenPositions: 1, maxSinglePositionPct: 0.45, priority: 8 },
        { sleeveId: "breakout", capitalBudgetPct: 0.1, maxOpenPositions: 1, maxSinglePositionPct: 0.4, priority: 7 },
        { sleeveId: "micro", capitalBudgetPct: 0.03, maxOpenPositions: 1, maxSinglePositionPct: 0.15, priority: 5 }
      ],
      strategies: [
        createRelativeStrengthRotationStrategy({
          rebalanceBars: 6,
          entryFloor: 0.8,
          exitFloor: 0.62,
          switchGap: 0.22,
          minAboveTrendRatio: 0.68,
          minLiquidityScore: 0.12,
          minCompositeTrend: 0.08
        }),
        createBreakoutRotationStrategy({
          breakoutLookback: 36,
          strengthFloor: 0.85,
          maxExtensionAtr: 0.8,
          trailAtrMult: 3
        }),
        createMicroBreakoutStrategy({
          lookbackBars: 20,
          extensionThreshold: 0.001,
          holdingBarsMax: 3,
          stopAtrMult: 0.8,
          minVolumeSpike: 1.4,
          minRiskOnScore: 0.1,
          minLiquidityScore: 0.08,
          minBreakoutDistance: 0.0005,
          maxBreakoutDistance: 0.0014,
          requireCloseNearHigh: 0.74,
          profitTarget: 0.0011
        })
      ]
    }
  ];
}
