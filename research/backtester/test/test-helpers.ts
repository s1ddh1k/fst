import type { Candle } from "../src/types.js";

function timeframeToMs(timeframe: string): number {
  switch (timeframe) {
    case "1m":
      return 60_000;
    case "5m":
      return 5 * 60_000;
    case "15m":
      return 15 * 60_000;
    case "1h":
      return 60 * 60_000;
    default:
      throw new Error(`Unsupported timeframe: ${timeframe}`);
  }
}

export function createCandles(params: {
  marketCode: string;
  timeframe: "1m" | "5m" | "15m" | "1h";
  closes: number[];
  volumes?: number[];
  startTime?: string;
}): Candle[] {
  const start = new Date(params.startTime ?? "2024-01-01T00:00:00.000Z");

  return params.closes.map((closePrice, index) => {
    const previousClose = params.closes[Math.max(0, index - 1)] ?? closePrice;
    const volume = params.volumes?.[index] ?? 1;

    return {
      marketCode: params.marketCode,
      timeframe: params.timeframe,
      candleTimeUtc: new Date(start.getTime() + index * timeframeToMs(params.timeframe)),
      openPrice: previousClose,
      highPrice: Math.max(previousClose, closePrice),
      lowPrice: Math.min(previousClose, closePrice),
      closePrice,
      volume,
      quoteVolume: closePrice * volume,
      isSynthetic: false
    };
  });
}

export function createHourlyCandles(params: {
  marketCode: string;
  closes: number[];
  volumes?: number[];
  startTime?: string;
}): Candle[] {
  return createCandles({
    ...params,
    timeframe: "1h"
  });
}
