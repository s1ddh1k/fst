import type { Candle } from "../src/types.js";

export function createHourlyCandles(params: {
  marketCode: string;
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
      timeframe: "1h",
      candleTimeUtc: new Date(start.getTime() + index * 60 * 60 * 1000),
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
