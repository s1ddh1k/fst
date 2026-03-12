import { createComposableStrategy } from "./composable-strategy.js";
import { getHistoricalVolatility, getMomentum, getRsi, getSma, getZScore } from "./factors/index.js";
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

function createTrendBiasFilterRule(params: {
  trendWindow: number;
  momentumLookback: number;
  minMomentum: number;
}) {
  return (context: StrategyContext): boolean => {
    const close = context.candles[context.index]?.closePrice;
    const sma = getSma(context.candles, context.index, params.trendWindow);
    const momentum = getMomentum(context.candles, context.index, params.momentumLookback);

    if (close === undefined || sma === null || momentum === null) {
      return false;
    }

    return close >= sma && momentum >= params.minMomentum;
  };
}

function createExitRule(params: {
  zScoreWindow: number;
  exitZScore: number;
  rsiPeriod: number;
  exitRsi: number;
  stopLossPct: number;
  maxHoldBars: number;
}) {
  return (context: StrategyContext): boolean => {
    const zScore = getZScore(context.candles, context.index, params.zScoreWindow);
    const rsi = getRsi(context.candles, context.index, params.rsiPeriod);
    const currentPrice = context.candles[context.index]?.closePrice ?? 0;
    const stopPrice = context.currentPosition
      ? context.currentPosition.entryPrice * (1 - params.stopLossPct)
      : 0;

    if (context.currentPosition) {
      if (currentPrice <= stopPrice) {
        return true;
      }

      if (context.currentPosition.barsHeld >= params.maxHoldBars) {
        return true;
      }
    }

    if (zScore === null || rsi === null) {
      return false;
    }

    return zScore >= params.exitZScore || rsi >= params.exitRsi;
  };
}

export function createZscoreRsiTrendPullbackStrategy(params?: {
  zScoreWindow?: number;
  minNegativeZScore?: number;
  exitZScore?: number;
  rsiPeriod?: number;
  maxEntryRsi?: number;
  exitRsi?: number;
  volatilityWindow?: number;
  maxVolatility?: number;
  stopLossPct?: number;
  maxHoldBars?: number;
  trendWindow?: number;
  momentumLookback?: number;
  minMomentum?: number;
}): Strategy {
  const zScoreWindow = params?.zScoreWindow ?? 20;
  const minNegativeZScore = params?.minNegativeZScore ?? -1.75;
  const exitZScore = params?.exitZScore ?? 0;
  const rsiPeriod = params?.rsiPeriod ?? 14;
  const maxEntryRsi = params?.maxEntryRsi ?? 40;
  const exitRsi = params?.exitRsi ?? 55;
  const volatilityWindow = params?.volatilityWindow ?? 20;
  const maxVolatility = params?.maxVolatility ?? 0.03;
  const stopLossPct = params?.stopLossPct ?? 0.025;
  const maxHoldBars = params?.maxHoldBars ?? 36;
  const trendWindow = params?.trendWindow ?? 30;
  const momentumLookback = params?.momentumLookback ?? 10;
  const minMomentum = params?.minMomentum ?? -0.01;

  return createComposableStrategy({
    name: "zscore-rsi-trend-pullback",
    parameters: {
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
      }),
      createTrendBiasFilterRule({
        trendWindow,
        momentumLookback,
        minMomentum
      })
    ],
    exitRule: createExitRule({
      zScoreWindow,
      exitZScore,
      rsiPeriod,
      exitRsi,
      stopLossPct,
      maxHoldBars
    })
  });
}
