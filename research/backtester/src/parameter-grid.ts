import type { Strategy } from "./types.js";
import {
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

function cartesianProduct<T>(items: T[][]): T[][] {
  return items.reduce<T[][]>(
    (accumulator, current) =>
      accumulator.flatMap((prefix) => current.map((value) => [...prefix, value])),
    [[]]
  );
}

export function buildStrategyGrid(strategyName: string): Strategy[] {
  switch (strategyName) {
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
        [-1.75, -2],
        [0],
        [14],
        [35, 40],
        [55],
        [20],
        [0.03],
        [0.02, 0.025],
        [24, 36],
        [30, 50],
        [10, 20],
        [-0.01, 0]
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
