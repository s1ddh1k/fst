import type { Signal, Strategy, StrategyContext } from "./types.js";
import { getRsi } from "./factors/index.js";

export function createRsiMeanReversionStrategy(params?: {
  period?: number;
  oversold?: number;
  overbought?: number;
}): Strategy {
  const period = params?.period ?? 14;
  const oversold = params?.oversold ?? 30;
  const overbought = params?.overbought ?? 70;

  return {
    name: "rsi-mean-reversion",
    parameters: {
      period,
      oversold,
      overbought
    },
    generateSignal(context: StrategyContext): Signal {
      const rsi = getRsi(context.candles, context.index, period);

      if (rsi === null) {
        return "HOLD";
      }

      if (!context.hasPosition && rsi <= oversold) {
        return "BUY";
      }

      if (context.hasPosition && rsi >= overbought) {
        return "SELL";
      }

      return "HOLD";
    }
  };
}
