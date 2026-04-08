import type { Strategy } from "./types.js";
import type { ScoredStrategy } from "../../strategies/src/types.js";
import {
  createIntegratedMultiFactorStrategy,
  createMovingAverageCrossStrategy,
  createRegimeFilteredMovingAverageCrossStrategy,
  createRsiMeanReversionStrategy,
  createTemplateBreakoutTrendVolumeStrategy,
  createTemplateMeanReversionBandsStrategy,
  createVolatilityBreakoutStrategy,
  createVolumeFilteredBreakoutStrategy,
  createZscoreRsiReversionGuardedStrategy,
  createZscoreRsiReversionStrategy,
  createZscoreRsiUptrendReversionStrategy,
  createZscoreRsiTrendPullbackStrategy
} from "./strategies-bridge.js";
import { createResidualReversionStrategy } from "../../strategies/src/residual-reversion-strategy.js";
import { createLeaderPullbackStateMachineStrategy } from "../../strategies/src/leader-pullback-state-machine.js";
import { createRelativeBreakoutRotationStrategy } from "../../strategies/src/relative-breakout-rotation.js";
import { createRelativeMomentumPullbackStrategy } from "../../strategies/src/relative-momentum-pullback.js";

function cartesianProduct<T>(items: T[][]): T[][] {
  return items.reduce<T[][]>(
    (accumulator, current) =>
      accumulator.flatMap((prefix) => current.map((value) => [...prefix, value])),
    [[]]
  );
}

type ScoredAxisDefinition = {
  parameterNames: string[];
  axisValues: number[][];
  build: (parameters: Record<string, number>) => ScoredStrategy;
};

const SCORED_STRATEGY_AXES: Partial<Record<string, ScoredAxisDefinition>> = {
  "relative-momentum-pullback": {
    parameterNames: ["minStrengthPct", "minRiskOn", "pullbackZ", "trailAtrMult"],
    axisValues: [
      [0.7, 0.8, 0.9],
      [0.05, 0.15],
      [0.6, 0.9, 1.2],
      [1.8, 2.2, 2.6]
    ],
    build: (parameters) => createRelativeMomentumPullbackStrategy(parameters)
  },
  "leader-pullback-state-machine": {
    parameterNames: ["strengthFloor", "pullbackAtr", "setupExpiryBars", "trailAtrMult"],
    axisValues: [
      [0.6, 0.7, 0.8],
      [0.5, 0.9, 1.3],
      [2, 4, 6],
      [1.8, 2.2, 2.6]
    ],
    build: (parameters) => createLeaderPullbackStateMachineStrategy(parameters)
  },
  "relative-breakout-rotation": {
    parameterNames: ["breakoutLookback", "strengthFloor", "maxExtensionAtr", "trailAtrMult"],
    axisValues: [
      [10, 20, 30],
      [0.6, 0.7, 0.8],
      [0.8, 1.2, 1.6],
      [1.8, 2.2, 2.6]
    ],
    build: (parameters) => createRelativeBreakoutRotationStrategy(parameters)
  }
};

function buildScoredStrategyAxisProducts(strategyName: string): number[][] | undefined {
  const definition = SCORED_STRATEGY_AXES[strategyName];
  if (!definition) {
    return undefined;
  }

  return cartesianProduct<number>(definition.axisValues);
}

function buildScoredStrategyFromAxisProduct(strategyName: string, product: number[]): ScoredStrategy {
  const definition = SCORED_STRATEGY_AXES[strategyName];
  if (!definition) {
    throw new Error(`Unknown scored strategy grid: ${strategyName}`);
  }

  const parameters = definition.parameterNames.reduce<Record<string, number>>((result, name, index) => {
    result[name] = product[index] ?? 0;
    return result;
  }, {});

  return definition.build(parameters);
}

export function buildScoredStrategyNeighborGrid(
  strategyName: string,
  parameters: Record<string, number>
): ScoredStrategy[] {
  const definition = SCORED_STRATEGY_AXES[strategyName];
  if (!definition) {
    throw new Error(`Unknown scored strategy grid: ${strategyName}`);
  }

  const currentIndices = definition.parameterNames.map((name, axisIndex) => {
    const axis = definition.axisValues[axisIndex] ?? [];
    return axis.findIndex((value) => value === parameters[name]);
  });

  if (currentIndices.some((index) => index < 0)) {
    return [];
  }

  const perAxisNeighborIndices = currentIndices.map((currentIndex, axisIndex) => {
    const axis = definition.axisValues[axisIndex] ?? [];
    return [currentIndex - 1, currentIndex, currentIndex + 1].filter(
      (index, position, values) =>
        index >= 0 && index < axis.length && values.indexOf(index) === position
    );
  });

  return cartesianProduct<number>(perAxisNeighborIndices)
    .filter((combo) => combo.some((axisIndex, index) => axisIndex !== currentIndices[index]))
    .map((combo) =>
      buildScoredStrategyFromAxisProduct(
        strategyName,
        combo.map((axisValueIndex, axisIndex) => definition.axisValues[axisIndex]?.[axisValueIndex] ?? 0)
      )
    );
}

export function buildStrategyGrid(strategyName: string): Strategy[] {
  switch (strategyName) {
    case "integrated-multi-factor": {
      const products = cartesianProduct<number>([
        [34, 55],
        [10, 20],
        [-1.1, -1.5],
        [38, 42],
        [1.05, 1.15],
        [0.025, 0.035],
        [0.35, 0.45],
        [-0.05, 0.05]
      ]);

      return products.map(
        ([
          trendWindow,
          momentumLookback,
          entryZScore,
          entryRsi,
          minVolumeSpike,
          maxHistoricalVolatility,
          entryThreshold,
          minBreadthScore
        ]) =>
          createIntegratedMultiFactorStrategy({
            trendWindow,
            momentumLookback,
            entryZScore,
            entryRsi,
            minVolumeSpike,
            maxHistoricalVolatility,
            entryThreshold,
            minBreadthScore,
            exitThreshold: 0.3,
            entryMinFactors: 4,
            exitMinFactors: 2
          })
      );
    }

    case "moving-average-cross": {
      const pairs = [
        [5, 20],
        [10, 30],
        [20, 50]
      ];
      return pairs.map(([shortWindow, longWindow]) =>
        createMovingAverageCrossStrategy({ shortWindow, longWindow })
      );
    }

    case "volatility-breakout": {
      const products = cartesianProduct<number>([
        [0.3, 0.5, 0.7],
        [1, 2]
      ]);
      return products.map(([breakoutMultiplier, lookback]) =>
        createVolatilityBreakoutStrategy({ breakoutMultiplier, lookback })
      );
    }

    case "rsi-mean-reversion": {
      const products = cartesianProduct<number>([
        [10, 14],
        [25, 30],
        [65, 70]
      ]);
      return products.map(([period, oversold, overbought]) =>
        createRsiMeanReversionStrategy({ period, oversold, overbought })
      );
    }

    case "volume-filtered-breakout": {
      const products = cartesianProduct<number>([
        [0.3, 0.5],
        [1, 2],
        [10, 20],
        [1.1, 1.3]
      ]);
      return products.map(([breakoutMultiplier, lookback, volumeWindow, minVolumeSpikeRatio]) =>
        createVolumeFilteredBreakoutStrategy({
          breakoutMultiplier,
          lookback,
          volumeWindow,
          minVolumeSpikeRatio
        })
      );
    }

    case "regime-filtered-moving-average-cross": {
      const products = cartesianProduct<number>([
        [5, 10],
        [20, 30],
        [30, 50],
        [10, 20],
        [15, 20],
        [0.03, 0.05]
      ]).filter(
        ([shortWindow, longWindow, regimeTrendWindow]) =>
          shortWindow < longWindow && longWindow <= regimeTrendWindow
      );

      return products.map(
        ([
          shortWindow,
          longWindow,
          regimeTrendWindow,
          regimeMomentumLookback,
          regimeVolatilityWindow,
          regimeVolatilityThreshold
        ]) =>
          createRegimeFilteredMovingAverageCrossStrategy({
            shortWindow,
            longWindow,
            regimeTrendWindow,
            regimeMomentumLookback,
            regimeVolatilityWindow,
            regimeVolatilityThreshold
          })
      );
    }

    case "template-breakout-trend-volume": {
      const products = cartesianProduct<number>([
        [0.3, 0.5],
        [1, 2],
        [10, 20],
        [1.1, 1.3],
        [14],
        [20, 25]
      ]);

      return products.map(
        ([breakoutMultiplier, lookback, volumeWindow, minVolumeSpikeRatio, adxPeriod, minAdx]) =>
          createTemplateBreakoutTrendVolumeStrategy({
            breakoutMultiplier,
            lookback,
            volumeWindow,
            minVolumeSpikeRatio,
            adxPeriod,
            minAdx
          })
      );
    }

    case "template-mean-reversion-bands": {
      const products = cartesianProduct<number>([
        [10, 14],
        [25, 30],
        [50, 55],
        [20],
        [2],
        [20],
        [0.03, 0.04],
        [20],
        [-100, -120]
      ]);

      return products.map(
        ([
          rsiPeriod,
          oversold,
          exitRsi,
          bollingerWindow,
          bollingerMultiplier,
          volatilityWindow,
          maxVolatility,
          cciWindow,
          minCci
        ]) =>
          createTemplateMeanReversionBandsStrategy({
            rsiPeriod,
            oversold,
            exitRsi,
            bollingerWindow,
            bollingerMultiplier,
            volatilityWindow,
            maxVolatility,
            cciWindow,
            minCci
          })
      );
    }

    case "zscore-rsi-reversion": {
      const products = cartesianProduct<number>([
        [20, 30],
        [-1.75, -2],
        [-0.25, 0],
        [14],
        [30, 35],
        [50, 55],
        [20],
        [0.03, 0.04]
      ]);

      return products.map(
        ([
          zScoreWindow,
          minNegativeZScore,
          exitZScore,
          rsiPeriod,
          maxEntryRsi,
          exitRsi,
          volatilityWindow,
          maxVolatility
        ]) =>
          createZscoreRsiReversionStrategy({
            zScoreWindow,
            minNegativeZScore,
            exitZScore,
            rsiPeriod,
            maxEntryRsi,
            exitRsi,
            volatilityWindow,
            maxVolatility
          })
      );
    }

    case "zscore-rsi-reversion-guarded": {
      const products = cartesianProduct<number>([
        [20],
        [-2],
        [0],
        [14],
        [35],
        [55],
        [20],
        [0.03],
        [0.02, 0.025, 0.03],
        [24, 36, 48]
      ]);

      return products.map(
        ([
          zScoreWindow,
          minNegativeZScore,
          exitZScore,
          rsiPeriod,
          maxEntryRsi,
          exitRsi,
          volatilityWindow,
          maxVolatility,
          stopLossPct,
          maxHoldBars
        ]) =>
          createZscoreRsiReversionGuardedStrategy({
            zScoreWindow,
            minNegativeZScore,
            exitZScore,
            rsiPeriod,
            maxEntryRsi,
            exitRsi,
            volatilityWindow,
            maxVolatility,
            stopLossPct,
            maxHoldBars
          })
      );
    }

    case "zscore-rsi-uptrend-reversion": {
      const products = cartesianProduct<number>([
        [20],
        [-2],
        [0],
        [14],
        [35],
        [55],
        [20],
        [0.03],
        [0.02, 0.025],
        [24, 36],
        [50],
        [20],
        [20],
        [0.04, 0.05]
      ]);

      return products.map(
        ([
          zScoreWindow,
          minNegativeZScore,
          exitZScore,
          rsiPeriod,
          maxEntryRsi,
          exitRsi,
          volatilityWindow,
          maxVolatility,
          stopLossPct,
          maxHoldBars,
          regimeTrendWindow,
          regimeMomentumLookback,
          regimeVolatilityWindow,
          regimeVolatilityThreshold
        ]) =>
          createZscoreRsiUptrendReversionStrategy({
            zScoreWindow,
            minNegativeZScore,
            exitZScore,
            rsiPeriod,
            maxEntryRsi,
            exitRsi,
            volatilityWindow,
            maxVolatility,
            stopLossPct,
            maxHoldBars,
            regimeTrendWindow,
            regimeMomentumLookback,
            regimeVolatilityWindow,
            regimeVolatilityThreshold
          })
      );
    }

    case "zscore-rsi-trend-pullback": {
      const products = cartesianProduct<number>([
        [20, 30],
        [-1.5, -1.75, -2],
        [0],
        [14],
        [35, 40, 45],
        [55],
        [20],
        [0.03],
        [0.02, 0.025],
        [24, 36],
        [30, 40, 50],
        [10, 20],
        [-0.02, -0.01, -0.005, 0]
      ]);

      return products.map(
        ([
          zScoreWindow,
          minNegativeZScore,
          exitZScore,
          rsiPeriod,
          maxEntryRsi,
          exitRsi,
          volatilityWindow,
          maxVolatility,
          stopLossPct,
          maxHoldBars,
          trendWindow,
          momentumLookback,
          minMomentum
        ]) =>
          createZscoreRsiTrendPullbackStrategy({
            zScoreWindow,
            minNegativeZScore,
            exitZScore,
            rsiPeriod,
            maxEntryRsi,
            exitRsi,
            volatilityWindow,
            maxVolatility,
            stopLossPct,
            maxHoldBars,
            trendWindow,
            momentumLookback,
            minMomentum
          })
      );
    }

    default:
      throw new Error(`Unknown strategy grid: ${strategyName}`);
  }
}

export function buildScoredStrategyGrid(strategyName: string): ScoredStrategy[] {
  const sharedProducts = buildScoredStrategyAxisProducts(strategyName);
  if (sharedProducts) {
    return sharedProducts.map((product) => buildScoredStrategyFromAxisProduct(strategyName, product));
  }

  switch (strategyName) {
    case "residual-reversion": {
      const products = cartesianProduct<number>([
        [0.15, 0.20, 0.25, 0.30],
        [0.10, 0.15, 0.20],
        [0.020, 0.025, 0.030],
        [24, 36, 48]
      ]);

      return products.map(
        ([entryThreshold, exitThreshold, stopLossPct, maxHoldBars]) =>
          createResidualReversionStrategy({
            entryThreshold,
            exitThreshold,
            stopLossPct,
            maxHoldBars
          })
      );
    }

    default:
      throw new Error(`Unknown scored strategy grid: ${strategyName}`);
  }
}
