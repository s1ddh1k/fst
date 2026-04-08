import type { Candle, StrategyTimeframe } from "../../../../packages/shared/src/index.js";
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

  // Use the longest market as the reference timeline so late-listed markets do not
  // collapse the entire backtest window to their listing date.
  const referenceCandles = markets
    .slice()
    .sort(([, left], [, right]) => {
      if (right.length !== left.length) {
        return right.length - left.length;
      }

      return left[0].candleTimeUtc.getTime() - right[0].candleTimeUtc.getTime();
    })[0]?.[1] ?? [];
  const timeline = referenceCandles.map((candle) => new Date(candle.candleTimeUtc.getTime()));

  const normalizedByMarket: MarketTimeframeSeries = {};

  for (const [market, candles] of markets) {
    const byTime = new Map(candles.map((candle) => [candle.candleTimeUtc.getTime(), candle]));
    const normalized: Candle[] = [];
    const firstActual = candles[0];
    let previousClose: number | null = firstActual?.closePrice ?? null;

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
