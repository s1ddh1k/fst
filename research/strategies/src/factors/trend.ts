import type { Candle } from "../types.js";
import { getEma } from "./moving-averages.js";

export function getMacd(
  candles: Candle[],
  endIndex: number,
  params?: {
    fastWindow?: number;
    slowWindow?: number;
    signalWindow?: number;
  }
): { macd: number; signal: number; histogram: number } | null {
  const fastWindow = params?.fastWindow ?? 12;
  const slowWindow = params?.slowWindow ?? 26;
  const signalWindow = params?.signalWindow ?? 9;

  if (fastWindow <= 0 || slowWindow <= fastWindow || signalWindow <= 0 || endIndex < slowWindow) {
    return null;
  }

  const macdSeries: number[] = [];

  for (let index = slowWindow - 1; index <= endIndex; index += 1) {
    const fastEma = getEma(candles, index, fastWindow);
    const slowEma = getEma(candles, index, slowWindow);

    if (fastEma === null || slowEma === null) {
      return null;
    }

    macdSeries.push(fastEma - slowEma);
  }

  if (macdSeries.length < signalWindow) {
    return null;
  }

  const signalValues = macdSeries.slice(macdSeries.length - signalWindow);
  const signal = signalValues.reduce((sum, value) => sum + value, 0) / signalValues.length;
  const macd = macdSeries[macdSeries.length - 1];

  return {
    macd,
    signal,
    histogram: macd - signal
  };
}

export function getAdx(
  candles: Candle[],
  endIndex: number,
  period: number
): { adx: number; plusDi: number; minusDi: number } | null {
  if (period <= 0 || endIndex < period * 2) {
    return null;
  }

  const trueRanges: number[] = [];
  const plusDmValues: number[] = [];
  const minusDmValues: number[] = [];

  for (let index = endIndex - period * 2 + 1; index <= endIndex; index += 1) {
    const current = candles[index];
    const previous = candles[index - 1];

    if (!previous) {
      return null;
    }

    const upMove = current.highPrice - previous.highPrice;
    const downMove = previous.lowPrice - current.lowPrice;
    const plusDm = upMove > downMove && upMove > 0 ? upMove : 0;
    const minusDm = downMove > upMove && downMove > 0 ? downMove : 0;
    const trueRange = Math.max(
      current.highPrice - current.lowPrice,
      Math.abs(current.highPrice - previous.closePrice),
      Math.abs(current.lowPrice - previous.closePrice)
    );

    trueRanges.push(trueRange);
    plusDmValues.push(plusDm);
    minusDmValues.push(minusDm);
  }

  const dxValues: number[] = [];

  for (let offset = period - 1; offset < trueRanges.length; offset += 1) {
    const trWindow = trueRanges.slice(offset - period + 1, offset + 1);
    const plusWindow = plusDmValues.slice(offset - period + 1, offset + 1);
    const minusWindow = minusDmValues.slice(offset - period + 1, offset + 1);

    const trSum = trWindow.reduce((sum, value) => sum + value, 0);

    if (trSum === 0) {
      dxValues.push(0);
      continue;
    }

    const plusDi = (plusWindow.reduce((sum, value) => sum + value, 0) / trSum) * 100;
    const minusDi = (minusWindow.reduce((sum, value) => sum + value, 0) / trSum) * 100;
    const diSum = plusDi + minusDi;
    const dx = diSum === 0 ? 0 : (Math.abs(plusDi - minusDi) / diSum) * 100;
    dxValues.push(dx);
  }

  if (dxValues.length < period) {
    return null;
  }

  const adxWindow = dxValues.slice(dxValues.length - period);
  const adx = adxWindow.reduce((sum, value) => sum + value, 0) / adxWindow.length;

  const finalTrWindow = trueRanges.slice(trueRanges.length - period);
  const finalPlusWindow = plusDmValues.slice(plusDmValues.length - period);
  const finalMinusWindow = minusDmValues.slice(minusDmValues.length - period);
  const finalTrSum = finalTrWindow.reduce((sum, value) => sum + value, 0);

  if (finalTrSum === 0) {
    return null;
  }

  return {
    adx,
    plusDi: (finalPlusWindow.reduce((sum, value) => sum + value, 0) / finalTrSum) * 100,
    minusDi: (finalMinusWindow.reduce((sum, value) => sum + value, 0) / finalTrSum) * 100
  };
}

export function getDonchianChannel(
  candles: Candle[],
  endIndex: number,
  window: number
): { upper: number; lower: number; middle: number } | null {
  if (window <= 0 || endIndex + 1 < window) {
    return null;
  }

  let upper = Number.NEGATIVE_INFINITY;
  let lower = Number.POSITIVE_INFINITY;

  for (let index = endIndex - window + 1; index <= endIndex; index += 1) {
    upper = Math.max(upper, candles[index].highPrice);
    lower = Math.min(lower, candles[index].lowPrice);
  }

  return {
    upper,
    lower,
    middle: (upper + lower) / 2
  };
}
