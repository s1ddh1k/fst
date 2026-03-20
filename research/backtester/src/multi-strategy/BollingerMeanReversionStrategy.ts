import { createBollingerMeanReversionStrategy } from "../../../strategies/src/bollinger-mean-reversion.js";
import { adaptScoredStrategy } from "./StrategyAdapter.js";

export function createBollingerMeanReversionMultiStrategy(params?: {
  strategyId?: string;
  sleeveId?: "micro";
  bbWindow?: number;
  bbMultiplier?: number;
  rsiPeriod?: number;
  exitRsi?: number;
  stopLossPct?: number;
  maxHoldBars?: number;
  entryPercentB?: number;
}) {
  return adaptScoredStrategy({
    strategyId: params?.strategyId ?? "bollinger-mean-reversion",
    sleeveId: params?.sleeveId ?? "micro",
    family: "meanreversion",
    decisionTimeframe: "1h",
    executionTimeframe: "5m",
    scoredStrategy: createBollingerMeanReversionStrategy({
      bbWindow: params?.bbWindow,
      bbMultiplier: params?.bbMultiplier,
      rsiPeriod: params?.rsiPeriod,
      exitRsi: params?.exitRsi,
      stopLossPct: params?.stopLossPct,
      maxHoldBars: params?.maxHoldBars,
      entryPercentB: params?.entryPercentB
    })
  });
}
