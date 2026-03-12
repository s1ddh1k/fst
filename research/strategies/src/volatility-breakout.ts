import type { Signal, Strategy, StrategyContext } from "./types.js";

export function createVolatilityBreakoutStrategy(params?: {
  breakoutMultiplier?: number;
  lookback?: number;
}): Strategy {
  const breakoutMultiplier = params?.breakoutMultiplier ?? 0.5;
  const lookback = params?.lookback ?? 1;

  return {
    name: "volatility-breakout",
    parameters: {
      breakoutMultiplier,
      lookback
    },
    generateSignal(context: StrategyContext): Signal {
      if (context.index < lookback) {
        return "HOLD";
      }

      const current = context.candles[context.index];
      const previous = context.candles[context.index - lookback];
      const range = previous.highPrice - previous.lowPrice;
      const breakoutThreshold = current.openPrice + range * breakoutMultiplier;

      if (!context.hasPosition && current.closePrice > breakoutThreshold) {
        return "BUY";
      }

      if (context.hasPosition && current.closePrice < current.openPrice) {
        return "SELL";
      }

      return "HOLD";
    }
  };
}
