import type { Candle } from "../types.js";
import { getSma } from "./moving-averages.js";

export function getRsi(candles: Candle[], endIndex: number, period: number): number | null {
  if (period <= 0 || endIndex < period) {
    return null;
  }

  let gains = 0;
  let losses = 0;

  for (let index = endIndex - period + 1; index <= endIndex; index += 1) {
    const change = candles[index].closePrice - candles[index - 1].closePrice;

    if (change >= 0) {
      gains += change;
    } else {
      losses += Math.abs(change);
    }
  }

  if (losses === 0) {
    return 100;
  }

  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

export function getZScore(candles: Candle[], endIndex: number, window: number): number | null {
  if (window <= 1 || endIndex + 1 < window) {
    return null;
  }

  const mean = getSma(candles, endIndex, window);

  if (mean === null) {
    return null;
  }

  let variance = 0;

  for (let index = endIndex - window + 1; index <= endIndex; index += 1) {
    variance += (candles[index].closePrice - mean) ** 2;
  }

  const stdDev = Math.sqrt(variance / window);
  return stdDev === 0 ? 0 : (candles[endIndex].closePrice - mean) / stdDev;
}
