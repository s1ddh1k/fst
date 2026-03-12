import { createComposableStrategy } from "./composable-strategy.js";
import {
  getBollingerBands,
  getCci,
  getHistoricalVolatility,
  getRsi
} from "./factors/index.js";
import type { Strategy, StrategyContext } from "./types.js";

function createEntryRule(params: {
  rsiPeriod: number;
  oversold: number;
  bollingerWindow: number;
  bollingerMultiplier: number;
}) {
  return (context: StrategyContext): boolean => {
    const rsi = getRsi(context.candles, context.index, params.rsiPeriod);
    const bands = getBollingerBands(
      context.candles,
      context.index,
      params.bollingerWindow,
      params.bollingerMultiplier
    );

    if (rsi === null || bands === null) {
      return false;
    }

    return rsi <= params.oversold && bands.percentB <= 0.1;
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

function createCciFilterRule(params: {
  cciWindow: number;
  minCci: number;
}) {
  return (context: StrategyContext): boolean => {
    const cci = getCci(context.candles, context.index, params.cciWindow);
    return cci !== null && cci <= params.minCci;
  };
}

function createExitRule(params: {
  rsiPeriod: number;
  exitRsi: number;
  bollingerWindow: number;
  bollingerMultiplier: number;
}) {
  return (context: StrategyContext): boolean => {
    const rsi = getRsi(context.candles, context.index, params.rsiPeriod);
    const bands = getBollingerBands(
      context.candles,
      context.index,
      params.bollingerWindow,
      params.bollingerMultiplier
    );

    if (rsi === null || bands === null) {
      return false;
    }

    return rsi >= params.exitRsi || context.candles[context.index].closePrice >= bands.middle;
  };
}

export function createTemplateMeanReversionBandsStrategy(params?: {
  rsiPeriod?: number;
  oversold?: number;
  exitRsi?: number;
  bollingerWindow?: number;
  bollingerMultiplier?: number;
  volatilityWindow?: number;
  maxVolatility?: number;
  cciWindow?: number;
  minCci?: number;
}): Strategy {
  const rsiPeriod = params?.rsiPeriod ?? 14;
  const oversold = params?.oversold ?? 30;
  const exitRsi = params?.exitRsi ?? 55;
  const bollingerWindow = params?.bollingerWindow ?? 20;
  const bollingerMultiplier = params?.bollingerMultiplier ?? 2;
  const volatilityWindow = params?.volatilityWindow ?? 20;
  const maxVolatility = params?.maxVolatility ?? 0.04;
  const cciWindow = params?.cciWindow ?? 20;
  const minCci = params?.minCci ?? -100;

  return createComposableStrategy({
    name: "template-mean-reversion-bands",
    parameters: {
      rsiPeriod,
      oversold,
      exitRsi,
      bollingerWindow,
      bollingerMultiplier,
      volatilityWindow,
      maxVolatility,
      cciWindow,
      minCci
    },
    entryRule: createEntryRule({
      rsiPeriod,
      oversold,
      bollingerWindow,
      bollingerMultiplier
    }),
    filterRules: [
      createVolatilityFilterRule({
        volatilityWindow,
        maxVolatility
      }),
      createCciFilterRule({
        cciWindow,
        minCci
      })
    ],
    exitRule: createExitRule({
      rsiPeriod,
      exitRsi,
      bollingerWindow,
      bollingerMultiplier
    })
  });
}
