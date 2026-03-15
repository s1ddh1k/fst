import type { Candle } from "../types.js";
import { buildTimeGrid } from "./timeframe.js";

export type NormalizedCandleSet = {
  timeframe: string;
  timeline: Date[];
  candlesByMarket: Record<string, Candle[]>;
};

function withQuoteVolume(candle: Candle): Candle {
  return {
    ...candle,
    quoteVolume: candle.quoteVolume ?? candle.closePrice * candle.volume,
    isSynthetic: candle.isSynthetic ?? false
  };
}

export function normalizeCandlesToFullGrid(params: {
  candlesByMarket: Record<string, Candle[]>;
  timeframe: string;
}): NormalizedCandleSet {
  const markets = Object.entries(params.candlesByMarket)
    .filter(([, candles]) => candles.length > 0)
    .sort(([left], [right]) => left.localeCompare(right));

  if (markets.length === 0) {
    return {
      timeframe: params.timeframe,
      timeline: [],
      candlesByMarket: {}
    };
  }

  const startTime = markets
    .map(([, candles]) => candles[0].candleTimeUtc)
    .reduce((current, next) => (next > current ? next : current));
  const endTime = markets
    .map(([, candles]) => candles[candles.length - 1].candleTimeUtc)
    .reduce((current, next) => (next < current ? next : current));

  if (startTime >= endTime) {
    return {
      timeframe: params.timeframe,
      timeline: [],
      candlesByMarket: Object.fromEntries(markets.map(([marketCode]) => [marketCode, [] as Candle[]]))
    };
  }

  const timeline = buildTimeGrid({
    startTime,
    endTime,
    timeframe: params.timeframe
  });
  const candlesByMarket: Record<string, Candle[]> = {};

  for (const [marketCode, sourceCandles] of markets) {
    const sortedCandles = sourceCandles
      .slice()
      .sort((left, right) => left.candleTimeUtc.getTime() - right.candleTimeUtc.getTime())
      .map(withQuoteVolume);
    const byTime = new Map(
      sortedCandles.map((candle) => [candle.candleTimeUtc.toISOString(), candle])
    );
    const normalized: Candle[] = [];
    let previousClose: number | null = null;

    for (const time of timeline) {
      const actual = byTime.get(time.toISOString());

      if (actual) {
        previousClose = actual.closePrice;
        normalized.push(actual);
        continue;
      }

      if (previousClose === null) {
        continue;
      }

      normalized.push({
        marketCode,
        timeframe: params.timeframe,
        candleTimeUtc: time,
        openPrice: previousClose,
        highPrice: previousClose,
        lowPrice: previousClose,
        closePrice: previousClose,
        volume: 0,
        quoteVolume: 0,
        isSynthetic: true
      });
    }

    candlesByMarket[marketCode] = normalized;
  }

  return {
    timeframe: params.timeframe,
    timeline,
    candlesByMarket
  };
}
