import {
  buildMarketStateContext,
  getMarketStateConfigKey,
  resolveMarketStateConfig
} from "../../strategies/src/index.js";
import type { Candle, MarketStateConfig } from "../../strategies/src/index.js";
import {
  getSelectedUniverseMarketsWithMinimumCandles,
  loadCandlesForMarkets,
  upsertMarketBreadthFeatures,
  upsertMarketRelativeStrengthFeatures
} from "./db.js";

function collectFeatureTimes(universeCandlesByMarket: Record<string, Candle[]>): Date[] {
  const unique = new Map<string, Date>();

  for (const candles of Object.values(universeCandlesByMarket)) {
    for (const candle of candles) {
      unique.set(candle.candleTimeUtc.toISOString(), candle.candleTimeUtc);
    }
  }

  return [...unique.values()].sort((left, right) => left.getTime() - right.getTime());
}

export async function buildMarketFeaturePipeline(params: {
  universeName: string;
  timeframe: string;
  limit: number;
  minCandles: number;
  marketLimit?: number;
  marketCodes?: string[];
  config?: MarketStateConfig;
}): Promise<{
  universeName: string;
  timeframe: string;
  configKey: string;
  marketCount: number;
  breadthFeatureCount: number;
  relativeStrengthFeatureCount: number;
  firstFeatureTimeUtc?: Date;
  lastFeatureTimeUtc?: Date;
  marketCodes: string[];
}> {
  const selectedMarkets =
    params.marketCodes ??
    (
      await getSelectedUniverseMarketsWithMinimumCandles({
        universeName: params.universeName,
        timeframe: params.timeframe,
        minCandles: params.minCandles,
        limit: params.marketLimit
      })
    ).map((item) => item.marketCode);
  const marketCodes = [...new Set(selectedMarkets)];

  if (marketCodes.length === 0) {
    throw new Error("No markets available to build market features");
  }

  const resolvedConfig = resolveMarketStateConfig(params.config);
  const universeCandlesByMarket = await loadCandlesForMarkets({
    marketCodes,
    timeframe: params.timeframe,
    limit: params.limit
  });
  const featureTimes = collectFeatureTimes(universeCandlesByMarket);

  if (featureTimes.length === 0) {
    throw new Error("No candles available to build market features");
  }

  const sampleMarketCode = marketCodes[0];
  const breadthRows = [];
  const relativeStrengthRows = [];

  for (const featureTimeUtc of featureTimes) {
    const sampleMarketState = buildMarketStateContext({
      marketCode: sampleMarketCode,
      referenceTime: featureTimeUtc,
      universeName: params.universeName,
      universeCandlesByMarket,
      config: resolvedConfig
    });

    if (!sampleMarketState) {
      continue;
    }

    breadthRows.push({
      featureTimeUtc,
      sampleSize: sampleMarketState.sampleSize,
      breadth: sampleMarketState.breadth,
      benchmarkMarketCode: sampleMarketState.benchmarkMarketCode,
      benchmark: sampleMarketState.benchmark
    });

    if (sampleMarketState.relativeStrength) {
      relativeStrengthRows.push({
        marketCode: sampleMarketCode,
        featureTimeUtc,
        relativeStrength: sampleMarketState.relativeStrength
      });
    }

    for (const marketCode of marketCodes) {
      if (marketCode === sampleMarketCode) {
        continue;
      }

      const marketState = buildMarketStateContext({
        marketCode,
        referenceTime: featureTimeUtc,
        universeName: params.universeName,
        universeCandlesByMarket,
        config: resolvedConfig
      });

      if (!marketState?.relativeStrength) {
        continue;
      }

      relativeStrengthRows.push({
        marketCode,
        featureTimeUtc,
        relativeStrength: marketState.relativeStrength
      });
    }
  }

  const breadthFeatureCount = await upsertMarketBreadthFeatures({
    universeName: params.universeName,
    timeframe: params.timeframe,
    config: resolvedConfig,
    rows: breadthRows
  });
  const relativeStrengthFeatureCount = await upsertMarketRelativeStrengthFeatures({
    universeName: params.universeName,
    timeframe: params.timeframe,
    config: resolvedConfig,
    rows: relativeStrengthRows
  });

  return {
    universeName: params.universeName,
    timeframe: params.timeframe,
    configKey: getMarketStateConfigKey(resolvedConfig),
    marketCount: marketCodes.length,
    breadthFeatureCount,
    relativeStrengthFeatureCount,
    firstFeatureTimeUtc: breadthRows[0]?.featureTimeUtc,
    lastFeatureTimeUtc: breadthRows[breadthRows.length - 1]?.featureTimeUtc,
    marketCodes
  };
}
