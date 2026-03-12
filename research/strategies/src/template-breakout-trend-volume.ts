import { createComposableStrategy } from "./composable-strategy.js";
import {
  detectMarketRegime,
  getAdx,
  getVolumeSpikeRatio
} from "./factors/index.js";
import type { Strategy, StrategyContext } from "./types.js";

function createBreakoutEntryRule(params: {
  breakoutMultiplier: number;
  lookback: number;
}) {
  return (context: StrategyContext): boolean => {
    if (context.index < params.lookback) {
      return false;
    }

    const current = context.candles[context.index];
    const previous = context.candles[context.index - params.lookback];
    const range = previous.highPrice - previous.lowPrice;
    const breakoutThreshold = current.openPrice + range * params.breakoutMultiplier;

    return current.closePrice > breakoutThreshold;
  };
}

function createTrendFilterRule(params: {
  regimeTrendWindow: number;
  regimeMomentumLookback: number;
  regimeVolatilityWindow: number;
  regimeVolatilityThreshold: number;
}) {
  return (context: StrategyContext): boolean =>
    detectMarketRegime(context.candles, context.index, {
      trendWindow: params.regimeTrendWindow,
      momentumLookback: params.regimeMomentumLookback,
      volatilityWindow: params.regimeVolatilityWindow,
      volatilityThreshold: params.regimeVolatilityThreshold
    }) === "trend_up";
}

function createVolumeFilterRule(params: {
  volumeWindow: number;
  minVolumeSpikeRatio: number;
}) {
  return (context: StrategyContext): boolean => {
    const ratio = getVolumeSpikeRatio(context.candles, context.index, params.volumeWindow);
    return ratio !== null && ratio >= params.minVolumeSpikeRatio;
  };
}

function createAdxFilterRule(params: {
  adxPeriod: number;
  minAdx: number;
}) {
  return (context: StrategyContext): boolean => {
    const adx = getAdx(context.candles, context.index, params.adxPeriod);
    return adx !== null && adx.adx >= params.minAdx && adx.plusDi > adx.minusDi;
  };
}

function createExitRule(params: {
  lookback: number;
}) {
  return (context: StrategyContext): boolean => {
    if (context.index < params.lookback) {
      return false;
    }

    const current = context.candles[context.index];
    const previous = context.candles[context.index - 1];
    return current.closePrice < current.openPrice || current.closePrice < previous.lowPrice;
  };
}

export function createTemplateBreakoutTrendVolumeStrategy(params?: {
  breakoutMultiplier?: number;
  lookback?: number;
  volumeWindow?: number;
  minVolumeSpikeRatio?: number;
  adxPeriod?: number;
  minAdx?: number;
  regimeTrendWindow?: number;
  regimeMomentumLookback?: number;
  regimeVolatilityWindow?: number;
  regimeVolatilityThreshold?: number;
}): Strategy {
  const breakoutMultiplier = params?.breakoutMultiplier ?? 0.5;
  const lookback = params?.lookback ?? 1;
  const volumeWindow = params?.volumeWindow ?? 20;
  const minVolumeSpikeRatio = params?.minVolumeSpikeRatio ?? 1.2;
  const adxPeriod = params?.adxPeriod ?? 14;
  const minAdx = params?.minAdx ?? 20;
  const regimeTrendWindow = params?.regimeTrendWindow ?? 50;
  const regimeMomentumLookback = params?.regimeMomentumLookback ?? 20;
  const regimeVolatilityWindow = params?.regimeVolatilityWindow ?? 20;
  const regimeVolatilityThreshold = params?.regimeVolatilityThreshold ?? 0.03;

  return createComposableStrategy({
    name: "template-breakout-trend-volume",
    parameters: {
      breakoutMultiplier,
      lookback,
      volumeWindow,
      minVolumeSpikeRatio,
      adxPeriod,
      minAdx,
      regimeTrendWindow,
      regimeMomentumLookback,
      regimeVolatilityWindow,
      regimeVolatilityThreshold
    },
    entryRule: createBreakoutEntryRule({ breakoutMultiplier, lookback }),
    filterRules: [
      createTrendFilterRule({
        regimeTrendWindow,
        regimeMomentumLookback,
        regimeVolatilityWindow,
        regimeVolatilityThreshold
      }),
      createVolumeFilterRule({ volumeWindow, minVolumeSpikeRatio }),
      createAdxFilterRule({ adxPeriod, minAdx })
    ],
    exitRule: createExitRule({ lookback })
  });
}
