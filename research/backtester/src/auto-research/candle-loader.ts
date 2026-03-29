/**
 * Centralized candle loading — single source of truth.
 *
 * Previously candle loading logic was duplicated in:
 *   - block-evaluator.ts (evaluateBlockCandidate)
 *   - orchestrator.ts (loadCandlesForTimeframes)
 *
 * Both had the same bugs (15m not loaded, --test-start/end not working).
 * This module consolidates all candle loading into one place.
 */

import type { StrategyTimeframe } from "../../../../packages/shared/src/index.js";
import { loadCandlesForMarkets } from "../db.js";
import { calculateAutoResearchMinimumLimit } from "./limit-resolution.js";
import type { AutoResearchRunConfig } from "./types.js";

type CandleMap = Record<string, Array<{
  marketCode: string;
  timeframe: string;
  candleTimeUtc: Date;
  openPrice: number;
  highPrice: number;
  lowPrice: number;
  closePrice: number;
  volume: number;
  quoteVolume?: number;
  isSynthetic?: boolean;
}>>;

type PeriodRange = { start: Date; end: Date };

export type CandleLoadResult = Partial<Record<StrategyTimeframe, CandleMap>>;

export function computeLoadRange(config: AutoResearchRunConfig): PeriodRange | undefined {
  if (!config.testStartDate || !config.testEndDate) return undefined;
  const trainingDays = config.trainingDays ?? config.holdoutDays * 2;
  return {
    start: new Date(config.testStartDate.getTime() - trainingDays * 24 * 60 * 60 * 1000),
    end: config.testEndDate
  };
}

export function computeLoadLimit(
  timeframe: StrategyTimeframe,
  config: Pick<AutoResearchRunConfig, "holdoutDays" | "trainingDays" | "stepDays" | "mode" | "limit">
): number {
  const base = calculateAutoResearchMinimumLimit({
    timeframe,
    holdoutDays: config.holdoutDays,
    trainingDays: config.trainingDays,
    stepDays: config.stepDays,
    mode: config.mode
  });

  switch (timeframe) {
    case "1h":
      return Math.max(config.limit, base);
    case "15m":
      return Math.max(base, config.limit * 4);
    case "5m":
      return base;
    case "1m":
      return Math.min(base, 180 * 24 * 60); // Cap 1m to 6 months
    default:
      return base;
  }
}

export async function loadCandlesForTimeframes(params: {
  timeframes: StrategyTimeframe[];
  marketCodes: string[];
  config: AutoResearchRunConfig;
  cache?: Map<string, CandleMap>;
}): Promise<CandleLoadResult> {
  const { timeframes, marketCodes, config } = params;
  const cache = params.cache ?? new Map<string, CandleMap>();
  const loadRange = computeLoadRange(config);

  const loadOrCache = async (tf: StrategyTimeframe, codes: string[]): Promise<CandleMap> => {
    const limit = computeLoadLimit(tf, config);
    const cacheKey = loadRange
      ? `${tf}:range:${loadRange.start.toISOString()}:${loadRange.end.toISOString()}:${codes.slice().sort().join(",")}`
      : `${tf}:limit:${limit}:${codes.slice().sort().join(",")}`;

    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const data = loadRange
      ? await loadCandlesForMarkets({ marketCodes: codes, timeframe: tf, range: loadRange }) as CandleMap
      : await loadCandlesForMarkets({ marketCodes: codes, timeframe: tf, limit }) as CandleMap;

    cache.set(cacheKey, data);
    return data;
  };

  // 1m uses fewer markets to limit memory
  const marketCodes1m = marketCodes.slice(0, Math.max(config.marketLimit, 3));

  const result: CandleLoadResult = {};

  await Promise.all(
    timeframes.map(async (tf) => {
      const codes = tf === "1m" ? marketCodes1m : marketCodes;
      result[tf] = await loadOrCache(tf, codes);
    })
  );

  return result;
}
