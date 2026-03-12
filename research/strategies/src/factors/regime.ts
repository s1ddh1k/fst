import type { Candle } from "../types.js";
import { getSma } from "./moving-averages.js";
import { getMomentum } from "./momentum.js";
import { getHistoricalVolatility } from "./volatility.js";

export type MarketRegime = "trend_up" | "trend_down" | "range" | "volatile" | "unknown";

export function detectMarketRegime(
  candles: Candle[],
  endIndex: number,
  params?: {
    trendWindow?: number;
    momentumLookback?: number;
    volatilityWindow?: number;
    volatilityThreshold?: number;
  }
): MarketRegime {
  const trendWindow = params?.trendWindow ?? 50;
  const momentumLookback = params?.momentumLookback ?? 20;
  const volatilityWindow = params?.volatilityWindow ?? 20;
  const volatilityThreshold = params?.volatilityThreshold ?? 0.03;

  const sma = getSma(candles, endIndex, trendWindow);
  const momentum = getMomentum(candles, endIndex, momentumLookback);
  const volatility = getHistoricalVolatility(candles, endIndex, volatilityWindow);
  const close = candles[endIndex]?.closePrice;

  if (sma === null || momentum === null || volatility === null || close === undefined) {
    return "unknown";
  }

  if (volatility >= volatilityThreshold) {
    return "volatile";
  }

  if (close > sma && momentum > 0) {
    return "trend_up";
  }

  if (close < sma && momentum < 0) {
    return "trend_down";
  }

  return "range";
}

export function matchesRegime(
  candles: Candle[],
  endIndex: number,
  allowed: MarketRegime[]
): boolean {
  return allowed.includes(detectMarketRegime(candles, endIndex));
}
