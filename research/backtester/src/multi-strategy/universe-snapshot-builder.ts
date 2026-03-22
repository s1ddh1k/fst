import type { UniverseSnapshot } from "../../../../packages/shared/src/index.js";
import type { FullGridCandleSet, UniverseSnapshotBuilderConfig } from "./types.js";

export function createDefaultUniverseSnapshotBuilderConfig(): UniverseSnapshotBuilderConfig {
  return {
    topN: 12,
    lookbackBars: 24 * 30,
    refreshEveryBars: 24
  };
}

function getQuoteVolume(candle: FullGridCandleSet["candlesByMarket"][string][number] | undefined): number {
  if (!candle) {
    return 0;
  }

  return candle.quoteVolume ?? (candle.closePrice * candle.volume);
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
  const rollingMetricByMarket = Object.fromEntries(markets.map((market) => [market, 0]));
  let latest: UniverseSnapshot | undefined;

  for (let index = 0; index < params.candleSet.timeline.length; index += 1) {
    const asOf = params.candleSet.timeline[index];
    const expiredIndex = index - config.lookbackBars;

    for (const market of markets) {
      const candles = params.candleSet.candlesByMarket[market] ?? [];
      rollingMetricByMarket[market] += getQuoteVolume(candles[index]);
      if (expiredIndex >= 0) {
        rollingMetricByMarket[market] -= getQuoteVolume(candles[expiredIndex]);
      }
    }

    if (index + 1 < config.lookbackBars) {
      continue;
    }

    const shouldRefresh =
      !latest || (index - (config.lookbackBars - 1)) % config.refreshEveryBars === 0;

    if (shouldRefresh) {
      const ranked = markets
        .map((market) => ({
          market,
          metric: rollingMetricByMarket[market] ?? 0
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
