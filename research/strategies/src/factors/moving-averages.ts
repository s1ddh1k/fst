import type { Candle } from "../types.js";

export function getSma(candles: Candle[], endIndex: number, window: number): number | null {
  if (window <= 0 || endIndex + 1 < window) {
    return null;
  }

  let total = 0;

  for (let index = endIndex - window + 1; index <= endIndex; index += 1) {
    total += candles[index].closePrice;
  }

  return total / window;
}

export function getEma(candles: Candle[], endIndex: number, window: number): number | null {
  if (window <= 0 || endIndex + 1 < window) {
    return null;
  }

  const multiplier = 2 / (window + 1);
  let ema = getSma(candles, window - 1, window);

  if (ema === null) {
    return null;
  }

  for (let index = window; index <= endIndex; index += 1) {
    ema = (candles[index].closePrice - ema) * multiplier + ema;
  }

  return ema;
}
