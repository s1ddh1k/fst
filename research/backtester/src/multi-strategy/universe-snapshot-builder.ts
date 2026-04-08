import type { UniverseSnapshot } from "../../../../packages/shared/src/index.js";
import type { FullGridCandleSet, UniverseSnapshotBuilderConfig } from "./types.js";

export function createDefaultUniverseSnapshotBuilderConfig(): UniverseSnapshotBuilderConfig {
  return {
    topN: 12,
    minTopN: 12,
    lookbackBars: 24 * 30,
    refreshEveryBars: 24,
    minHistoryBars: 0,
    targetQuoteVolumeShare: 1
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
  const historyBarsByMarket = Object.fromEntries(markets.map((market) => [market, 0]));
  let latest: UniverseSnapshot | undefined;

  const resolveDynamicTopN = (
    ranked: Array<{ market: string; metric: number; historyBars: number }>
  ): Array<{ market: string; metric: number; historyBars: number }> => {
    const maxTopN = Math.max(1, Math.min(config.topN, ranked.length));
    const minTopN = Math.max(1, Math.min(config.minTopN, maxTopN));

    if (config.targetQuoteVolumeShare >= 1) {
      return ranked.slice(0, maxTopN);
    }

    const totalMetric = ranked.reduce((sum, item) => sum + item.metric, 0);
    if (totalMetric <= 0) {
      return ranked.slice(0, maxTopN);
    }

    let cumulativeMetric = 0;
    let dynamicTopN = maxTopN;
    for (let index = 0; index < maxTopN; index += 1) {
      cumulativeMetric += ranked[index]?.metric ?? 0;
      const rank = index + 1;
      if (rank < minTopN) {
        continue;
      }

      if (cumulativeMetric / totalMetric >= config.targetQuoteVolumeShare) {
        dynamicTopN = rank;
        break;
      }
    }

    return ranked.slice(0, dynamicTopN);
  };

  for (let index = 0; index < params.candleSet.timeline.length; index += 1) {
    const asOf = params.candleSet.timeline[index];
    const expiredIndex = index - config.lookbackBars;

    for (const market of markets) {
      const candles = params.candleSet.candlesByMarket[market] ?? [];
      const current = candles[index];
      rollingMetricByMarket[market] += getQuoteVolume(current);
      if (current && !current.isSynthetic) {
        historyBarsByMarket[market] += 1;
      }
      if (expiredIndex >= 0) {
        const expired = candles[expiredIndex];
        rollingMetricByMarket[market] -= getQuoteVolume(expired);
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
          metric: rollingMetricByMarket[market] ?? 0,
          historyBars: historyBarsByMarket[market] ?? 0
        }))
        .filter((item) => item.metric > 0 && item.historyBars >= config.minHistoryBars)
        .sort((left, right) => {
          if (right.metric !== left.metric) {
            return right.metric - left.metric;
          }

          return left.market.localeCompare(right.market);
        });
      const selected = resolveDynamicTopN(ranked);

      latest = {
        asOf,
        timeframe: params.candleSet.timeframe,
        markets: selected.map((item) => item.market),
        metricByMarket: Object.fromEntries(selected.map((item) => [item.market, item.metric]))
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
