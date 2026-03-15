import type { Candle } from "../types.js";

export type PointInTimeUniverseConfig = {
  topN: number;
  lookbackBars: number;
  refreshEveryBars: number;
};

export type PointInTimeUniverseSnapshot = {
  time: Date;
  marketCodes: string[];
  turnoverByMarket: Record<string, number>;
};

export function createDefaultPointInTimeUniverseConfig(): PointInTimeUniverseConfig {
  return {
    topN: 12,
    lookbackBars: 30 * 24,
    refreshEveryBars: 24
  };
}

function sumQuoteVolume(candles: Candle[], startIndex: number, endIndex: number): number {
  let total = 0;

  for (let index = startIndex; index <= endIndex; index += 1) {
    const candle = candles[index];
    total += candle?.quoteVolume ?? ((candle?.closePrice ?? 0) * (candle?.volume ?? 0));
  }

  return total;
}

export function buildPointInTimeUniverse(params: {
  candlesByMarket: Record<string, Candle[]>;
  timeline: Date[];
  config?: Partial<PointInTimeUniverseConfig>;
}): Map<string, PointInTimeUniverseSnapshot> {
  const config = {
    ...createDefaultPointInTimeUniverseConfig(),
    ...params.config
  };
  const snapshots = new Map<string, PointInTimeUniverseSnapshot>();
  const markets = Object.keys(params.candlesByMarket).sort((left, right) => left.localeCompare(right));
  let latestSelection: PointInTimeUniverseSnapshot | null = null;

  for (let index = 0; index < params.timeline.length; index += 1) {
    const time = params.timeline[index];

    if (index + 1 < config.lookbackBars) {
      continue;
    }

    const shouldRefresh =
      latestSelection === null || (index - (config.lookbackBars - 1)) % config.refreshEveryBars === 0;

    if (shouldRefresh) {
      const startIndex = index - config.lookbackBars + 1;
      const ranking = markets
        .map((marketCode) => ({
          marketCode,
          turnover: sumQuoteVolume(params.candlesByMarket[marketCode] ?? [], startIndex, index)
        }))
        .filter((item) => item.turnover > 0)
        .sort((left, right) => {
          if (right.turnover !== left.turnover) {
            return right.turnover - left.turnover;
          }

          return left.marketCode.localeCompare(right.marketCode);
        })
        .slice(0, config.topN);

      latestSelection = {
        time,
        marketCodes: ranking.map((item) => item.marketCode),
        turnoverByMarket: Object.fromEntries(
          ranking.map((item) => [item.marketCode, item.turnover])
        )
      };
    }

    if (latestSelection) {
      snapshots.set(time.toISOString(), {
        time,
        marketCodes: latestSelection.marketCodes.slice(),
        turnoverByMarket: { ...latestSelection.turnoverByMarket }
      });
    }
  }

  return snapshots;
}
