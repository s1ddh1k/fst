import type { Candle } from "../types.js";

function getTrueRange(current: Candle, previous: Candle | null): number {
  if (!previous) {
    return current.highPrice - current.lowPrice;
  }

  return Math.max(
    current.highPrice - current.lowPrice,
    Math.abs(current.highPrice - previous.closePrice),
    Math.abs(current.lowPrice - previous.closePrice)
  );
}

export function getAtr(candles: Candle[], endIndex: number, period: number): number | null {
  if (period <= 0 || endIndex < period) {
    return null;
  }

  let total = 0;

  for (let index = endIndex - period + 1; index <= endIndex; index += 1) {
    total += getTrueRange(candles[index], candles[index - 1] ?? null);
  }

  return total / period;
}

export function getHistoricalVolatility(
  candles: Candle[],
  endIndex: number,
  window: number
): number | null {
  if (window <= 1 || endIndex < window) {
    return null;
  }

  const returns: number[] = [];

  for (let index = endIndex - window + 1; index <= endIndex; index += 1) {
    const previous = candles[index - 1].closePrice;
    const current = candles[index].closePrice;

    if (previous === 0) {
      return null;
    }

    returns.push(Math.log(current / previous));
  }

  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance =
    returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(returns.length - 1, 1);

  return Math.sqrt(variance);
}

export function getRangeExpansionScore(
  candles: Candle[],
  endIndex: number,
  window: number
): number | null {
  if (window <= 1 || endIndex < window) {
    return null;
  }

  const currentRange = candles[endIndex].highPrice - candles[endIndex].lowPrice;
  let total = 0;

  for (let index = endIndex - window; index < endIndex; index += 1) {
    total += candles[index].highPrice - candles[index].lowPrice;
  }

  const averageRange = total / window;
  return averageRange === 0 ? null : currentRange / averageRange;
}
