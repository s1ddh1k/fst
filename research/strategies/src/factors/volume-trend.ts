import type { Candle } from "../types.js";

export function getObv(candles: Candle[], endIndex: number): number | null {
  if (endIndex <= 0) {
    return null;
  }

  let obv = 0;

  for (let index = 1; index <= endIndex; index += 1) {
    const currentClose = candles[index].closePrice;
    const previousClose = candles[index - 1].closePrice;

    if (currentClose > previousClose) {
      obv += candles[index].volume;
      continue;
    }

    if (currentClose < previousClose) {
      obv -= candles[index].volume;
    }
  }

  return obv;
}

export function getObvSlope(
  candles: Candle[],
  endIndex: number,
  lookback: number
): number | null {
  if (lookback <= 0 || endIndex < lookback) {
    return null;
  }

  const currentObv = getObv(candles, endIndex);
  const previousObv = getObv(candles, endIndex - lookback);

  if (currentObv === null || previousObv === null) {
    return null;
  }

  return (currentObv - previousObv) / lookback;
}
