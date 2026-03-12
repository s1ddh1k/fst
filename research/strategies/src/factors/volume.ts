import type { Candle } from "../types.js";

export function getAverageVolume(candles: Candle[], endIndex: number, window: number): number | null {
  if (window <= 0 || endIndex + 1 < window) {
    return null;
  }

  let total = 0;

  for (let index = endIndex - window + 1; index <= endIndex; index += 1) {
    total += candles[index].volume;
  }

  return total / window;
}

export function getVolumeSpikeRatio(
  candles: Candle[],
  endIndex: number,
  window: number
): number | null {
  const averageVolume = getAverageVolume(candles, endIndex - 1, window);

  if (averageVolume === null || averageVolume === 0) {
    return null;
  }

  return candles[endIndex].volume / averageVolume;
}
