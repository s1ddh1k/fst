import type { UniverseSnapshot } from "../../../../packages/shared/src/index.js";
import type { FullGridCandleSet, UniverseSnapshotBuilderConfig } from "./types.js";

export function createDefaultUniverseSnapshotBuilderConfig(): UniverseSnapshotBuilderConfig {
  return {
    topN: 12,
    lookbackBars: 24 * 30,
    refreshEveryBars: 24
  };
}

function sumQuoteVolume(candles: FullGridCandleSet["candlesByMarket"][string], start: number, end: number): number {
  let total = 0;

  for (let index = start; index <= end; index += 1) {
    const candle = candles[index];
    total += candle?.quoteVolume ?? ((candle?.closePrice ?? 0) * (candle?.volume ?? 0));
  }

  return total;
}

export function buildUniverseSnapshots(params: {
  candleSet: FullGridCandleSet;
  config?: Partial<UniverseSnapshotBuilderConfig>;
}): Map<string, UniverseSnapshot> {
  const config = {
    ...createDefaultUniverseSnapshotBuilderConfig(),
    ...params.config
  };
  const snapshots = new Map<string, UniverseSnapshot>();
  const markets = Object.keys(params.candleSet.candlesByMarket).sort((left, right) =>
    left.localeCompare(right)
  );
  let latest: UniverseSnapshot | undefined;

  for (let index = 0; index < params.candleSet.timeline.length; index += 1) {
    const asOf = params.candleSet.timeline[index];

    if (index + 1 < config.lookbackBars) {
      continue;
    }

    const shouldRefresh =
      !latest || (index - (config.lookbackBars - 1)) % config.refreshEveryBars === 0;

    if (shouldRefresh) {
      const start = index - config.lookbackBars + 1;
      const ranked = markets
        .map((market) => ({
          market,
          metric: sumQuoteVolume(params.candleSet.candlesByMarket[market], start, index)
        }))
        .filter((item) => item.metric > 0)
        .sort((left, right) => {
          if (right.metric !== left.metric) {
            return right.metric - left.metric;
          }

          return left.market.localeCompare(right.market);
        })
        .slice(0, config.topN);

      latest = {
        asOf,
        timeframe: params.candleSet.timeframe,
        markets: ranked.map((item) => item.market),
        metricByMarket: Object.fromEntries(ranked.map((item) => [item.market, item.metric]))
      };
    }

    if (latest) {
      snapshots.set(asOf.toISOString(), {
        asOf,
        timeframe: latest.timeframe,
        markets: latest.markets.slice(),
        metricByMarket: { ...latest.metricByMarket }
      });
    }
  }

  return snapshots;
}
