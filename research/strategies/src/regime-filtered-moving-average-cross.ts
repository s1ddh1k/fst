import type { Signal, Strategy, StrategyContext } from "./types.js";
import { detectMarketRegime, getSma } from "./factors/index.js";

export function createRegimeFilteredMovingAverageCrossStrategy(params?: {
  shortWindow?: number;
  longWindow?: number;
  regimeTrendWindow?: number;
  regimeMomentumLookback?: number;
  regimeVolatilityWindow?: number;
  regimeVolatilityThreshold?: number;
}): Strategy {
  const shortWindow = params?.shortWindow ?? 10;
  const longWindow = params?.longWindow ?? 30;
  const regimeTrendWindow = params?.regimeTrendWindow ?? 50;
  const regimeMomentumLookback = params?.regimeMomentumLookback ?? 20;
  const regimeVolatilityWindow = params?.regimeVolatilityWindow ?? 20;
  const regimeVolatilityThreshold = params?.regimeVolatilityThreshold ?? 0.03;

  return {
    name: "regime-filtered-moving-average-cross",
    parameters: {
      shortWindow,
      longWindow,
      regimeTrendWindow,
      regimeMomentumLookback,
      regimeVolatilityWindow,
      regimeVolatilityThreshold
    },
    generateSignal(context: StrategyContext): Signal {
      const currentShort = getSma(context.candles, context.index, shortWindow);
      const currentLong = getSma(context.candles, context.index, longWindow);
      const previousShort = getSma(context.candles, context.index - 1, shortWindow);
      const previousLong = getSma(context.candles, context.index - 1, longWindow);

      if (
        currentShort === null ||
        currentLong === null ||
        previousShort === null ||
        previousLong === null
      ) {
        return "HOLD";
      }

      const regime = detectMarketRegime(context.candles, context.index, {
        trendWindow: regimeTrendWindow,
        momentumLookback: regimeMomentumLookback,
        volatilityWindow: regimeVolatilityWindow,
        volatilityThreshold: regimeVolatilityThreshold
      });

      if (!context.hasPosition && regime === "trend_up" && previousShort <= previousLong && currentShort > currentLong) {
        return "BUY";
      }

      if (
        context.hasPosition &&
        (regime === "trend_down" || (previousShort >= previousLong && currentShort < currentLong))
      ) {
        return "SELL";
      }

      return "HOLD";
    }
  };
}
