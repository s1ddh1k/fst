import type { Candle, StrategyTimeframe } from "../../../../packages/shared/src/index.js";
import { timeframeToMs } from "./timeframe.js";
import type { FullGridCandleSet, MarketTimeframeSeries } from "./types.js";

function sortCandles(candles: Candle[]): Candle[] {
  return candles
    .slice()
    .sort((left, right) => left.candleTimeUtc.getTime() - right.candleTimeUtc.getTime())
    .map((candle) => ({
      ...candle,
      quoteVolume: candle.quoteVolume ?? candle.closePrice * candle.volume,
      isSynthetic: candle.isSynthetic ?? false
    }));
}

export function normalizeToFullGrid(params: {
  candlesByMarket: MarketTimeframeSeries;
  timeframe: StrategyTimeframe;
}): FullGridCandleSet {
  const markets = Object.entries(params.candlesByMarket)
    .filter(([, candles]) => candles.length > 0)
    .map(([market, candles]) => [market, sortCandles(candles)] as const)
    .sort(([left], [right]) => left.localeCompare(right));

  if (markets.length === 0) {
    return {
      timeframe: params.timeframe,
      timeline: [],
      candlesByMarket: {}
    };
  }

  const startMs = Math.max(...markets.map(([, candles]) => candles[0].candleTimeUtc.getTime()));
  const endMs = Math.min(
    ...markets.map(([, candles]) => candles[candles.length - 1].candleTimeUtc.getTime())
  );
  const stepMs = timeframeToMs(params.timeframe);
  const timeline: Date[] = [];

  for (let ts = startMs; ts <= endMs; ts += stepMs) {
    timeline.push(new Date(ts));
  }

  const normalizedByMarket: MarketTimeframeSeries = {};

  for (const [market, candles] of markets) {
    const byTime = new Map(candles.map((candle) => [candle.candleTimeUtc.getTime(), candle]));
    const normalized: Candle[] = [];
    let previousClose: number | null = null;

    for (const time of timeline) {
      const actual = byTime.get(time.getTime());

      if (actual) {
        previousClose = actual.closePrice;
        normalized.push(actual);
        continue;
      }

      if (previousClose === null) {
        continue;
      }

      normalized.push({
        marketCode: market,
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

    normalizedByMarket[market] = normalized;
  }

  return {
    timeframe: params.timeframe,
    timeline,
    candlesByMarket: normalizedByMarket
  };
}
