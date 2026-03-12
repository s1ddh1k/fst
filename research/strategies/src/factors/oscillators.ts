import type { Candle } from "../types.js";
import { getSma } from "./moving-averages.js";

export function getBollingerBands(
  candles: Candle[],
  endIndex: number,
  window: number,
  multiplier = 2
): { middle: number; upper: number; lower: number; width: number; percentB: number } | null {
  if (window <= 1 || endIndex + 1 < window) {
    return null;
  }

  const middle = getSma(candles, endIndex, window);

  if (middle === null) {
    return null;
  }

  const closes: number[] = [];

  for (let index = endIndex - window + 1; index <= endIndex; index += 1) {
    closes.push(candles[index].closePrice);
  }

  const variance =
    closes.reduce((sum, value) => sum + (value - middle) ** 2, 0) / Math.max(closes.length - 1, 1);
  const standardDeviation = Math.sqrt(variance);
  const upper = middle + standardDeviation * multiplier;
  const lower = middle - standardDeviation * multiplier;
  const bandRange = upper - lower;
  const close = candles[endIndex].closePrice;

  return {
    middle,
    upper,
    lower,
    width: middle === 0 ? 0 : bandRange / middle,
    percentB: bandRange === 0 ? 0.5 : (close - lower) / bandRange
  };
}

export function getStochasticOscillator(
  candles: Candle[],
  endIndex: number,
  lookback: number,
  smoothWindow = 3
): { k: number; d: number } | null {
  if (lookback <= 0 || smoothWindow <= 0 || endIndex + 1 < lookback + smoothWindow - 1) {
    return null;
  }

  const kValues: number[] = [];

  for (let offset = endIndex - smoothWindow + 1; offset <= endIndex; offset += 1) {
    let highestHigh = Number.NEGATIVE_INFINITY;
    let lowestLow = Number.POSITIVE_INFINITY;

    for (let index = offset - lookback + 1; index <= offset; index += 1) {
      highestHigh = Math.max(highestHigh, candles[index].highPrice);
      lowestLow = Math.min(lowestLow, candles[index].lowPrice);
    }

    const range = highestHigh - lowestLow;
    const close = candles[offset].closePrice;
    const k = range === 0 ? 50 : ((close - lowestLow) / range) * 100;
    kValues.push(k);
  }

  const k = kValues[kValues.length - 1];
  const d = kValues.reduce((sum, value) => sum + value, 0) / kValues.length;

  return { k, d };
}

export function getCci(
  candles: Candle[],
  endIndex: number,
  window: number
): number | null {
  if (window <= 1 || endIndex + 1 < window) {
    return null;
  }

  const typicalPrices: number[] = [];

  for (let index = endIndex - window + 1; index <= endIndex; index += 1) {
    typicalPrices.push(
      (candles[index].highPrice + candles[index].lowPrice + candles[index].closePrice) / 3
    );
  }

  const mean = typicalPrices.reduce((sum, value) => sum + value, 0) / typicalPrices.length;
  const meanDeviation =
    typicalPrices.reduce((sum, value) => sum + Math.abs(value - mean), 0) / typicalPrices.length;

  if (meanDeviation === 0) {
    return 0;
  }

  const currentTypicalPrice = typicalPrices[typicalPrices.length - 1];
  return (currentTypicalPrice - mean) / (0.015 * meanDeviation);
}
