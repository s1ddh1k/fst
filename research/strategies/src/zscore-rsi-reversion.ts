import { createComposableStrategy } from "./composable-strategy.js";
import { getHistoricalVolatility, getRsi, getZScore } from "./factors/index.js";
import type { Strategy, StrategyContext } from "./types.js";

function createEntryRule(params: {
  zScoreWindow: number;
  minNegativeZScore: number;
  rsiPeriod: number;
  maxEntryRsi: number;
}) {
  return (context: StrategyContext): boolean => {
    const zScore = getZScore(context.candles, context.index, params.zScoreWindow);
    const rsi = getRsi(context.candles, context.index, params.rsiPeriod);

    if (zScore === null || rsi === null) {
      return false;
    }

    return zScore <= params.minNegativeZScore && rsi <= params.maxEntryRsi;
  };
}

function createVolatilityFilterRule(params: {
  volatilityWindow: number;
  maxVolatility: number;
}) {
  return (context: StrategyContext): boolean => {
    const volatility = getHistoricalVolatility(
      context.candles,
      context.index,
      params.volatilityWindow
    );

    return volatility !== null && volatility <= params.maxVolatility;
  };
}

function createExitRule(params: {
  zScoreWindow: number;
  exitZScore: number;
  rsiPeriod: number;
  exitRsi: number;
}) {
  return (context: StrategyContext): boolean => {
    const zScore = getZScore(context.candles, context.index, params.zScoreWindow);
    const rsi = getRsi(context.candles, context.index, params.rsiPeriod);

    if (zScore === null || rsi === null) {
      return false;
    }

    return zScore >= params.exitZScore || rsi >= params.exitRsi;
  };
}

export function createZscoreRsiReversionStrategy(params?: {
  zScoreWindow?: number;
  minNegativeZScore?: number;
  exitZScore?: number;
  rsiPeriod?: number;
  maxEntryRsi?: number;
  exitRsi?: number;
  volatilityWindow?: number;
  maxVolatility?: number;
}): Strategy {
  const zScoreWindow = params?.zScoreWindow ?? 20;
  const minNegativeZScore = params?.minNegativeZScore ?? -2;
  const exitZScore = params?.exitZScore ?? -0.25;
  const rsiPeriod = params?.rsiPeriod ?? 14;
  const maxEntryRsi = params?.maxEntryRsi ?? 35;
  const exitRsi = params?.exitRsi ?? 55;
  const volatilityWindow = params?.volatilityWindow ?? 20;
  const maxVolatility = params?.maxVolatility ?? 0.03;

  return createComposableStrategy({
    name: "zscore-rsi-reversion",
    parameters: {
      zScoreWindow,
      minNegativeZScore,
      exitZScore,
      rsiPeriod,
      maxEntryRsi,
      exitRsi,
      volatilityWindow,
      maxVolatility
    },
    entryRule: createEntryRule({
      zScoreWindow,
      minNegativeZScore,
      rsiPeriod,
      maxEntryRsi
    }),
    filterRules: [
      createVolatilityFilterRule({
        volatilityWindow,
        maxVolatility
      })
    ],
    exitRule: createExitRule({
      zScoreWindow,
      exitZScore,
      rsiPeriod,
      exitRsi
    })
  });
}
