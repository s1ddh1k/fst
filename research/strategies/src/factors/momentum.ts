import type { Candle } from "../types.js";

export function getMomentum(candles: Candle[], endIndex: number, lookback: number): number | null {
  if (lookback <= 0 || endIndex < lookback) {
    return null;
  }

  const current = candles[endIndex].closePrice;
  const previous = candles[endIndex - lookback].closePrice;

  return previous === 0 ? null : (current - previous) / previous;
}

export function getRateOfChange(
  candles: Candle[],
  endIndex: number,
  lookback: number
): number | null {
  return getMomentum(candles, endIndex, lookback);
}

export function getPriceSlope(candles: Candle[], endIndex: number, window: number): number | null {
  if (window <= 1 || endIndex + 1 < window) {
    return null;
  }

  const start = candles[endIndex - window + 1].closePrice;
  const end = candles[endIndex].closePrice;

  return (end - start) / window;
}
