import type { Candle, Signal, Strategy, StrategyContext } from "./types.js";
import { getSma } from "./factors/index.js";

export function createMovingAverageCrossStrategy(params?: {
  shortWindow?: number;
  longWindow?: number;
}): Strategy {
  const shortWindow = params?.shortWindow ?? 10;
  const longWindow = params?.longWindow ?? 30;

  return {
    name: "moving-average-cross",
    parameters: {
      shortWindow,
      longWindow
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

      if (!context.hasPosition && previousShort <= previousLong && currentShort > currentLong) {
        return "BUY";
      }

      if (context.hasPosition && previousShort >= previousLong && currentShort < currentLong) {
        return "SELL";
      }

      return "HOLD";
    }
  };
}
