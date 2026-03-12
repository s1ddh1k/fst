import type { Signal, Strategy, StrategyContext } from "./types.js";
import { getVolumeSpikeRatio } from "./factors/index.js";

export function createVolumeFilteredBreakoutStrategy(params?: {
  breakoutMultiplier?: number;
  lookback?: number;
  volumeWindow?: number;
  minVolumeSpikeRatio?: number;
}): Strategy {
  const breakoutMultiplier = params?.breakoutMultiplier ?? 0.5;
  const lookback = params?.lookback ?? 1;
  const volumeWindow = params?.volumeWindow ?? 20;
  const minVolumeSpikeRatio = params?.minVolumeSpikeRatio ?? 1.2;

  return {
    name: "volume-filtered-breakout",
    parameters: {
      breakoutMultiplier,
      lookback,
      volumeWindow,
      minVolumeSpikeRatio
    },
    generateSignal(context: StrategyContext): Signal {
      if (context.index < lookback) {
        return "HOLD";
      }

      const current = context.candles[context.index];
      const previous = context.candles[context.index - lookback];
      const range = previous.highPrice - previous.lowPrice;
      const breakoutThreshold = current.openPrice + range * breakoutMultiplier;
      const volumeSpikeRatio = getVolumeSpikeRatio(
        context.candles,
        context.index,
        volumeWindow
      );

      if (
        !context.hasPosition &&
        volumeSpikeRatio !== null &&
        volumeSpikeRatio >= minVolumeSpikeRatio &&
        current.closePrice > breakoutThreshold
      ) {
        return "BUY";
      }

      if (context.hasPosition && current.closePrice < current.openPrice) {
        return "SELL";
      }

      return "HOLD";
    }
  };
}
