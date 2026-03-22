import type {
  Candle,
  CompositeBenchmarkAnchorContext,
  CompositeBenchmarkContext,
  MarketBreadthContext,
  MarketStateConfig,
  MarketStateContext,
  RelativeStrengthContext
} from "./types.js";

const COMPOSITE_MARKET_CODE = "__COMPOSITE__";

const DEFAULT_MARKET_STATE_CONFIG: Required<Omit<MarketStateConfig, "benchmarkMarketCode">> = {
  trendWindow: 55,
  momentumLookback: 20,
  volumeWindow: 20,
  zScoreWindow: 20,
  volatilityWindow: 20
};

const DAILY_ANCHOR_CONFIG: ResolvedMarketStateConfig = {
  trendWindow: 30,
  momentumLookback: 10,
  volumeWindow: 20,
  zScoreWindow: 20,
  volatilityWindow: 20
};

const WEEKLY_ANCHOR_CONFIG: ResolvedMarketStateConfig = {
  trendWindow: 12,
  momentumLookback: 4,
  volumeWindow: 8,
  zScoreWindow: 8,
  volatilityWindow: 8
};

const COMPOSITE_ANCHOR_WEIGHTS = {
  intraday: 0.15,
  daily: 0.35,
  weekly: 0.5
} as const;

export type ResolvedMarketStateConfig = Required<Omit<MarketStateConfig, "benchmarkMarketCode">>;

type AnchorTimeframe = "1d" | "1w";

type CompositeAnchorInput = {
  sampleSize: number;
  breadth: MarketBreadthContext;
  composite: CompositeBenchmarkContext;
};

export function resolveMarketStateConfig(
  config?: MarketStateConfig,
  _benchmarkMarketCode?: string
): ResolvedMarketStateConfig {
  return {
    ...DEFAULT_MARKET_STATE_CONFIG,
    ...config
  };
}

export function getMarketStateConfigKey(
  config?: MarketStateConfig,
  benchmarkMarketCode?: string
): string {
  const resolved = resolveMarketStateConfig(config);
  const benchmarkKey = benchmarkMarketCode ?? config?.benchmarkMarketCode ?? "auto";

  return [
    `trend=${resolved.trendWindow}`,
    `momentum=${resolved.momentumLookback}`,
    `volume=${resolved.volumeWindow}`,
    `zscore=${resolved.zScoreWindow}`,
    `volatility=${resolved.volatilityWindow}`,
    `benchmark=${benchmarkKey}`
  ].join("|");
}

type ResolvedMarketSnapshot = {
  marketCode: string;
  closePrice: number;
  change: number;
  aboveTrend: boolean | null;
  momentum: number | null;
  zScore: number | null;
  volumeSpike: number | null;
  historicalVolatility: number | null;
  liquidityScore: number | null;
  regime: CompositeBenchmarkContext["regime"];
};

type NumericSeries = Array<number | null>;

type MarketFeatureSet = {
  emaByIndex: NumericSeries;
  smaByIndex: NumericSeries;
  momentumByIndex: NumericSeries;
  zScoreByIndex: NumericSeries;
  volumeSpikeByIndex: NumericSeries;
  averageQuoteVolumeByIndex: NumericSeries;
  historicalVolatilityByIndex: NumericSeries;
  regimeByIndex: CompositeBenchmarkContext["regime"][];
};

const marketFeatureCache = new WeakMap<Candle[], Map<string, MarketFeatureSet>>();
const aggregatedCandleCache = new WeakMap<Candle[], Map<AnchorTimeframe, Candle[]>>();

function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(-1, Math.min(1, value));
}

function normalize(value: number, scale: number): number {
  return clampScore(value / Math.max(scale, 0.0001));
}

function average(values: Array<number | null>): number | null {
  const filtered = values.filter((value): value is number => value !== null && Number.isFinite(value));

  if (filtered.length === 0) {
    return null;
  }

  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

function standardDeviation(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;

  return Math.sqrt(variance);
}

function ratioFromBooleans(values: Array<boolean | null>): number {
  const filtered = values.filter((value): value is boolean => value !== null);

  if (filtered.length === 0) {
    return 0;
  }

  return filtered.filter(Boolean).length / filtered.length;
}

function percentileInSortedValues(sortedValues: number[], currentValue: number | null): number | null {
  if (currentValue === null || sortedValues.length === 0) {
    return null;
  }

  let left = 0;
  let right = sortedValues.length - 1;
  let upperBound = -1;

  while (left <= right) {
    const middle = Math.floor((left + right) / 2);
    const value = sortedValues[middle] ?? Number.NEGATIVE_INFINITY;

    if (value <= currentValue) {
      upperBound = middle;
      left = middle + 1;
      continue;
    }

    right = middle - 1;
  }

  return upperBound === -1 ? 0 : (upperBound + 1) / sortedValues.length;
}

function timeframeToMilliseconds(timeframe: string): number | null {
  switch (timeframe) {
    case "1m":
      return 60_000;
    case "5m":
      return 5 * 60_000;
    case "15m":
      return 15 * 60_000;
    case "1h":
    case "60m":
      return 60 * 60_000;
    case "1d":
      return 24 * 60 * 60_000;
    case "1w":
      return 7 * 24 * 60 * 60_000;
    default:
      return null;
  }
}

function getBucketStartUtc(time: Date, targetTimeframe: AnchorTimeframe): number {
  const year = time.getUTCFullYear();
  const month = time.getUTCMonth();
  const day = time.getUTCDate();

  if (targetTimeframe === "1d") {
    return Date.UTC(year, month, day);
  }

  const startOfDay = Date.UTC(year, month, day);
  const weekdayOffset = (time.getUTCDay() + 6) % 7;
  return startOfDay - weekdayOffset * 24 * 60 * 60_000;
}

function getAggregatedCandles(
  candles: Candle[],
  targetTimeframe: AnchorTimeframe
): Candle[] {
  if (candles.length === 0) {
    return [];
  }

  const sourceTimeframe = candles[0]?.timeframe;
  if (sourceTimeframe === targetTimeframe) {
    return candles;
  }

  const sourceStepMs = sourceTimeframe ? timeframeToMilliseconds(sourceTimeframe) : null;
  const bucketDurationMs = timeframeToMilliseconds(targetTimeframe);
  if (!sourceStepMs || !bucketDurationMs) {
    return candles;
  }

  const cachedByTarget = aggregatedCandleCache.get(candles);
  const cached = cachedByTarget?.get(targetTimeframe);
  if (cached) {
    return cached;
  }

  const aggregated: Candle[] = [];
  let currentBucketStart = Number.NaN;
  let currentBucket: Candle | null = null;

  for (const candle of candles) {
    const bucketStart = getBucketStartUtc(candle.candleTimeUtc, targetTimeframe);
    const bucketEnd = new Date(bucketStart + bucketDurationMs - sourceStepMs);

    if (bucketStart !== currentBucketStart || currentBucket === null) {
      if (currentBucket) {
        aggregated.push(currentBucket);
      }

      currentBucketStart = bucketStart;
      currentBucket = {
        marketCode: candle.marketCode,
        timeframe: targetTimeframe,
        candleTimeUtc: bucketEnd,
        openPrice: candle.openPrice,
        highPrice: candle.highPrice,
        lowPrice: candle.lowPrice,
        closePrice: candle.closePrice,
        volume: candle.volume,
        quoteVolume: candle.quoteVolume ?? candle.closePrice * candle.volume,
        isSynthetic: candle.isSynthetic ?? false
      };
      continue;
    }

    currentBucket.highPrice = Math.max(currentBucket.highPrice, candle.highPrice);
    currentBucket.lowPrice = Math.min(currentBucket.lowPrice, candle.lowPrice);
    currentBucket.closePrice = candle.closePrice;
    currentBucket.volume += candle.volume;
    currentBucket.quoteVolume =
      (currentBucket.quoteVolume ?? 0) + (candle.quoteVolume ?? candle.closePrice * candle.volume);
    currentBucket.isSynthetic = Boolean(currentBucket.isSynthetic && candle.isSynthetic);
  }

  if (currentBucket) {
    aggregated.push(currentBucket);
  }

  const cache = cachedByTarget ?? new Map<AnchorTimeframe, Candle[]>();
  cache.set(targetTimeframe, aggregated);
  if (!cachedByTarget) {
    aggregatedCandleCache.set(candles, cache);
  }

  return aggregated;
}

function buildRollingAverage(values: number[], window: number): NumericSeries {
  const result = new Array<number | null>(values.length).fill(null);

  if (window <= 0 || values.length < window) {
    return result;
  }

  let sum = 0;

  for (let index = 0; index < values.length; index += 1) {
    sum += values[index] ?? 0;

    if (index >= window) {
      sum -= values[index - window] ?? 0;
    }

    if (index + 1 >= window) {
      result[index] = sum / window;
    }
  }

  return result;
}

function buildTrailingAverage(values: number[], window: number): NumericSeries {
  const result = new Array<number | null>(values.length).fill(null);

  if (window <= 0) {
    return result;
  }

  let sum = 0;

  for (let index = 0; index < values.length; index += 1) {
    sum += values[index] ?? 0;

    if (index >= window) {
      sum -= values[index - window] ?? 0;
    }

    const sampleSize = Math.min(index + 1, window);
    result[index] = sampleSize === 0 ? null : sum / sampleSize;
  }

  return result;
}

function buildEmaSeries(closePrices: number[], window: number, smaByIndex: NumericSeries): NumericSeries {
  const result = new Array<number | null>(closePrices.length).fill(null);

  if (window <= 0 || closePrices.length < window) {
    return result;
  }

  const seed = smaByIndex[window - 1];
  if (seed === null) {
    return result;
  }

  const multiplier = 2 / (window + 1);
  let ema = seed;
  result[window - 1] = ema;

  for (let index = window; index < closePrices.length; index += 1) {
    ema = (closePrices[index] - ema) * multiplier + ema;
    result[index] = ema;
  }

  return result;
}

function buildMomentumSeries(closePrices: number[], lookback: number): NumericSeries {
  const result = new Array<number | null>(closePrices.length).fill(null);

  if (lookback <= 0) {
    return result;
  }

  for (let index = lookback; index < closePrices.length; index += 1) {
    const previous = closePrices[index - lookback];
    result[index] = previous === 0 ? null : (closePrices[index] - previous) / previous;
  }

  return result;
}

function buildZScoreSeries(closePrices: number[], window: number): NumericSeries {
  const result = new Array<number | null>(closePrices.length).fill(null);

  if (window <= 1 || closePrices.length < window) {
    return result;
  }

  let sum = 0;
  let sumSquares = 0;

  for (let index = 0; index < closePrices.length; index += 1) {
    const close = closePrices[index] ?? 0;
    sum += close;
    sumSquares += close ** 2;

    if (index >= window) {
      const expired = closePrices[index - window] ?? 0;
      sum -= expired;
      sumSquares -= expired ** 2;
    }

    if (index + 1 < window) {
      continue;
    }

    const mean = sum / window;
    const variance = Math.max(0, sumSquares / window - mean ** 2);
    const stdDev = Math.sqrt(variance);
    result[index] = stdDev === 0 ? 0 : (close - mean) / stdDev;
  }

  return result;
}

function buildVolumeSpikeSeries(volumes: number[], window: number): NumericSeries {
  const result = new Array<number | null>(volumes.length).fill(null);
  const averageVolumeByIndex = buildRollingAverage(volumes, window);

  for (let index = window; index < volumes.length; index += 1) {
    const averageVolume = averageVolumeByIndex[index - 1];
    result[index] =
      averageVolume === null || averageVolume === 0
        ? null
        : volumes[index] / averageVolume;
  }

  return result;
}

function buildHistoricalVolatilitySeries(closePrices: number[], window: number): NumericSeries {
  const result = new Array<number | null>(closePrices.length).fill(null);

  if (window <= 1 || closePrices.length <= window) {
    return result;
  }

  const logReturns = new Array<number>(closePrices.length).fill(0);
  const invalidReturns = new Array<number>(closePrices.length).fill(0);

  for (let index = 1; index < closePrices.length; index += 1) {
    const previous = closePrices[index - 1];
    const current = closePrices[index];

    if (previous === 0 || current <= 0) {
      invalidReturns[index] = 1;
      continue;
    }

    logReturns[index] = Math.log(current / previous);
  }

  let sum = 0;
  let sumSquares = 0;
  let invalidCount = 0;

  for (let index = 1; index < closePrices.length; index += 1) {
    const value = logReturns[index] ?? 0;
    sum += value;
    sumSquares += value ** 2;
    invalidCount += invalidReturns[index] ?? 0;

    if (index > window) {
      const expiredValue = logReturns[index - window] ?? 0;
      sum -= expiredValue;
      sumSquares -= expiredValue ** 2;
      invalidCount -= invalidReturns[index - window] ?? 0;
    }

    if (index < window || invalidCount > 0) {
      continue;
    }

    const mean = sum / window;
    const variance = Math.max(0, (sumSquares - window * mean ** 2) / Math.max(window - 1, 1));
    result[index] = Math.sqrt(variance);
  }

  return result;
}

function buildRegimeSeries(params: {
  closePrices: number[];
  smaByIndex: NumericSeries;
  momentumByIndex: NumericSeries;
  historicalVolatilityByIndex: NumericSeries;
  volatilityThreshold: number;
}): CompositeBenchmarkContext["regime"][] {
  return params.closePrices.map((close, index) => {
    const sma = params.smaByIndex[index];
    const momentum = params.momentumByIndex[index];
    const volatility = params.historicalVolatilityByIndex[index];

    if (sma === null || momentum === null || volatility === null || close === undefined) {
      return "unknown";
    }

    if (volatility >= params.volatilityThreshold) {
      return "volatile";
    }

    if (close > sma && momentum > 0) {
      return "trend_up";
    }

    if (close < sma && momentum < 0) {
      return "trend_down";
    }

    return "range";
  });
}

function getMarketFeatureSet(
  candles: Candle[],
  config: ResolvedMarketStateConfig
): MarketFeatureSet {
  const configKey = getMarketStateConfigKey(config);
  const cachedByConfig = marketFeatureCache.get(candles);
  const cached = cachedByConfig?.get(configKey);

  if (cached) {
    return cached;
  }

  const closePrices = candles.map((candle) => candle.closePrice);
  const volumes = candles.map((candle) => candle.volume);
  const quoteVolumes = candles.map(
    (candle) => candle.quoteVolume ?? candle.closePrice * candle.volume
  );
  const smaByIndex = buildRollingAverage(closePrices, config.trendWindow);
  const featureSet: MarketFeatureSet = {
    smaByIndex,
    emaByIndex: buildEmaSeries(closePrices, config.trendWindow, smaByIndex),
    momentumByIndex: buildMomentumSeries(closePrices, config.momentumLookback),
    zScoreByIndex: buildZScoreSeries(closePrices, config.zScoreWindow),
    volumeSpikeByIndex: buildVolumeSpikeSeries(volumes, config.volumeWindow),
    averageQuoteVolumeByIndex: buildTrailingAverage(quoteVolumes, config.volumeWindow),
    historicalVolatilityByIndex: buildHistoricalVolatilitySeries(
      closePrices,
      config.volatilityWindow
    ),
    regimeByIndex: []
  };
  featureSet.regimeByIndex = buildRegimeSeries({
    closePrices,
    smaByIndex,
    momentumByIndex: featureSet.momentumByIndex,
    historicalVolatilityByIndex: featureSet.historicalVolatilityByIndex,
    volatilityThreshold: 0.03
  });

  const perConfigCache = cachedByConfig ?? new Map<string, MarketFeatureSet>();
  perConfigCache.set(configKey, featureSet);

  if (!cachedByConfig) {
    marketFeatureCache.set(candles, perConfigCache);
  }

  return featureSet;
}

function findCandleIndexAtOrBefore(candles: Candle[], referenceTime: Date): number {
  let left = 0;
  let right = candles.length - 1;
  let result = -1;
  const target = referenceTime.getTime();

  while (left <= right) {
    const middle = Math.floor((left + right) / 2);
    const current = candles[middle]?.candleTimeUtc.getTime() ?? Number.NEGATIVE_INFINITY;

    if (current <= target) {
      result = middle;
      left = middle + 1;
      continue;
    }

    right = middle - 1;
  }

  return result;
}

function resolveMarketSnapshot(params: {
  marketCode: string;
  candles: Candle[];
  referenceTime?: Date;
  index?: number;
  alignedIndex?: number;
  config: ResolvedMarketStateConfig;
}): ResolvedMarketSnapshot | null {
  const index =
    params.alignedIndex ??
    params.index ??
    (params.referenceTime ? findCandleIndexAtOrBefore(params.candles, params.referenceTime) : -1);

  if (index <= 0) {
    return null;
  }

  const features = getMarketFeatureSet(params.candles, params.config);
  const close = params.candles[index]?.closePrice;
  const previousClose = params.candles[index - 1]?.closePrice;
  const ema = features.emaByIndex[index];
  const momentum = features.momentumByIndex[index];
  const zScore = features.zScoreByIndex[index];
  const volumeSpike = features.volumeSpikeByIndex[index];
  const quoteVolume = features.averageQuoteVolumeByIndex[index];
  const historicalVolatility = features.historicalVolatilityByIndex[index];

  if (close === undefined || previousClose === undefined || previousClose === 0) {
    return null;
  }

  return {
    marketCode: params.marketCode,
    closePrice: close,
    change: (close - previousClose) / previousClose,
    aboveTrend: ema === null ? null : close >= ema,
    momentum,
    zScore,
    volumeSpike,
    historicalVolatility,
    liquidityScore:
      quoteVolume === null ? null : clampScore((Math.log10(Math.max(quoteVolume, 1)) - 6) / 4),
    regime: features.regimeByIndex[index] ?? "unknown"
  };
}

function buildBreadthContext(snapshots: ResolvedMarketSnapshot[]): MarketBreadthContext {
  const advancingRatio = ratioFromBooleans(snapshots.map((snapshot) => snapshot.change > 0));
  const aboveTrendRatio = ratioFromBooleans(snapshots.map((snapshot) => snapshot.aboveTrend));
  const positiveMomentumRatio = ratioFromBooleans(
    snapshots.map((snapshot) => snapshot.momentum !== null && snapshot.momentum > 0)
  );
  const averageMomentum = average(snapshots.map((snapshot) => snapshot.momentum));
  const averageZScore = average(snapshots.map((snapshot) => snapshot.zScore));
  const averageVolumeSpike = average(snapshots.map((snapshot) => snapshot.volumeSpike));
  const averageHistoricalVolatility = average(
    snapshots.map((snapshot) => snapshot.historicalVolatility)
  );
  const averageLiquidityScore = average(snapshots.map((snapshot) => snapshot.liquidityScore));
  const changeDispersion = standardDeviation(snapshots.map((snapshot) => snapshot.change));

  const volatilityComfortScore =
    averageHistoricalVolatility === null
      ? 0
      : clampScore((0.03 - averageHistoricalVolatility) / 0.03);
  const liquidityScore = averageLiquidityScore ?? 0;
  const dispersionScore =
    changeDispersion === null ? 0 : clampScore((0.02 - changeDispersion) / 0.02);
  const compositeTrendScore = clampScore(
    [
      advancingRatio * 2 - 1,
      aboveTrendRatio * 2 - 1,
      positiveMomentumRatio * 2 - 1,
      averageMomentum === null ? 0 : normalize(averageMomentum, 0.03)
    ].reduce((sum, value) => sum + value, 0) / 4
  );

  return {
    sampleSize: snapshots.length,
    advancingRatio,
    aboveTrendRatio,
    positiveMomentumRatio,
    averageMomentum,
    averageZScore,
    averageVolumeSpike,
    averageHistoricalVolatility,
    dispersionScore,
    liquidityScore,
    compositeTrendScore,
    riskOnScore: clampScore(
      [
        compositeTrendScore,
        liquidityScore,
        dispersionScore,
        volatilityComfortScore
      ].reduce((sum, value) => sum + value, 0) / 4
    )
  };
}

function buildSingleHorizonCompositeBenchmarkContext(
  snapshots: ResolvedMarketSnapshot[],
  breadth: MarketBreadthContext
): CompositeBenchmarkContext {
  const averageChange = average(snapshots.map((snapshot) => snapshot.change));
  const momentum = average(snapshots.map((snapshot) => snapshot.momentum));
  const historicalVolatility = average(
    snapshots.map((snapshot) => snapshot.historicalVolatility)
  );
  const aboveTrendRatio = breadth.aboveTrendRatio;
  const trendScore = breadth.compositeTrendScore;
  const regime =
    historicalVolatility === null || momentum === null
      ? "unknown"
      : historicalVolatility >= 0.04 && breadth.dispersionScore < -0.1
        ? "volatile"
        : trendScore >= 0.2 && momentum >= 0
          ? "trend_up"
          : trendScore <= -0.2 && momentum <= 0
            ? "trend_down"
            : "range";

  return {
    source: "universe_composite",
    marketCode: COMPOSITE_MARKET_CODE,
    averageChange,
    momentum,
    aboveTrend: aboveTrendRatio >= 0.5,
    aboveTrendRatio,
    historicalVolatility,
    trendScore,
    liquidityScore: breadth.liquidityScore,
    dispersionScore: breadth.dispersionScore,
    regime
  };
}

function buildSingleMarketBenchmarkContext(
  timeframe: CompositeBenchmarkAnchorContext["timeframe"],
  snapshot: ResolvedMarketSnapshot
): CompositeBenchmarkAnchorContext {
  const trendScore = clampScore(
    [
      snapshot.aboveTrend === null ? 0 : snapshot.aboveTrend ? 1 : -1,
      snapshot.momentum === null ? 0 : normalize(snapshot.momentum, 0.03),
      normalize(snapshot.change, 0.02)
    ].reduce((sum, value) => sum + value, 0) / 3
  );
  const regime =
    snapshot.historicalVolatility === null || snapshot.momentum === null
      ? "unknown"
      : snapshot.historicalVolatility >= 0.04
        ? "volatile"
        : trendScore >= 0.2 && snapshot.momentum >= 0
          ? "trend_up"
          : trendScore <= -0.2 && snapshot.momentum <= 0
            ? "trend_down"
            : "range";

  return {
    timeframe,
    sampleSize: 1,
    averageChange: snapshot.change,
    momentum: snapshot.momentum,
    aboveTrend: snapshot.aboveTrend,
    aboveTrendRatio: snapshot.aboveTrend === null ? 0.5 : snapshot.aboveTrend ? 1 : 0,
    historicalVolatility: snapshot.historicalVolatility,
    trendScore,
    liquidityScore: snapshot.liquidityScore ?? 0,
    dispersionScore: 0,
    regime
  };
}

function toCompositeAnchorContext(
  timeframe: CompositeBenchmarkAnchorContext["timeframe"],
  sampleSize: number,
  composite: CompositeBenchmarkContext
): CompositeBenchmarkAnchorContext {
  return {
    timeframe,
    sampleSize,
    averageChange: composite.averageChange,
    momentum: composite.momentum,
    aboveTrend: composite.aboveTrend,
    aboveTrendRatio: composite.aboveTrendRatio,
    historicalVolatility: composite.historicalVolatility,
    trendScore: composite.trendScore,
    liquidityScore: composite.liquidityScore,
    dispersionScore: composite.dispersionScore,
    regime: composite.regime
  };
}

function weightedAverageFromAnchors(
  items: Array<{ weight: number; value: number | null | undefined }>
): number | null {
  let totalWeight = 0;
  let totalValue = 0;

  for (const item of items) {
    if (item.value === null || item.value === undefined || !Number.isFinite(item.value)) {
      continue;
    }

    totalWeight += item.weight;
    totalValue += item.value * item.weight;
  }

  if (totalWeight === 0) {
    return null;
  }

  return totalValue / totalWeight;
}

function getDirectionalBias(regime: CompositeBenchmarkContext["regime"] | undefined): number {
  if (regime === "trend_up") {
    return 1;
  }

  if (regime === "trend_down") {
    return -1;
  }

  return 0;
}

function determineAnchoredRegime(params: {
  intraday: CompositeBenchmarkAnchorContext;
  daily?: CompositeBenchmarkAnchorContext;
  weekly?: CompositeBenchmarkAnchorContext;
  benchmark?: CompositeBenchmarkContext;
  trendScore: number;
  momentum: number | null;
  historicalVolatility: number | null;
}): CompositeBenchmarkContext["regime"] {
  const weeklyBias = getDirectionalBias(params.weekly?.regime);
  const dailyBias = getDirectionalBias(params.daily?.regime);
  const intradayBias = getDirectionalBias(params.intraday.regime);
  const benchmarkBias = getDirectionalBias(params.benchmark?.regime);
  const macroConflict =
    weeklyBias !== 0 &&
    dailyBias !== 0 &&
    weeklyBias !== dailyBias &&
    Math.abs(params.weekly?.trendScore ?? 0) >= 0.12 &&
    Math.abs(params.daily?.trendScore ?? 0) >= 0.12;
  const weightedBias = weightedAverageFromAnchors([
    { weight: COMPOSITE_ANCHOR_WEIGHTS.weekly, value: weeklyBias === 0 ? null : weeklyBias },
    { weight: COMPOSITE_ANCHOR_WEIGHTS.daily, value: dailyBias === 0 ? null : dailyBias },
    { weight: COMPOSITE_ANCHOR_WEIGHTS.intraday, value: intradayBias === 0 ? null : intradayBias },
    { weight: 0.2, value: benchmarkBias === 0 ? null : benchmarkBias }
  ]) ?? 0;
  const volatileVotes = [
    params.intraday.regime,
    params.daily?.regime,
    params.weekly?.regime,
    params.benchmark?.regime
  ].filter((regime) => regime === "volatile").length;
  const benchmarkTrendScore = params.benchmark?.trendScore ?? 0;

  if (
    volatileVotes >= 2 ||
    (
      volatileVotes >= 1 &&
      (macroConflict || Math.abs(params.trendScore) < 0.12 || Math.abs(benchmarkTrendScore) < 0.12)
    )
  ) {
    return "volatile";
  }

  if (
    weeklyBias !== 0 &&
    (dailyBias === 0 || dailyBias === weeklyBias) &&
    (benchmarkBias === 0 || benchmarkBias === weeklyBias) &&
    (intradayBias === 0 || intradayBias === weeklyBias || Math.abs(params.trendScore) >= 0.18)
  ) {
    return weeklyBias > 0 ? "trend_up" : "trend_down";
  }

  if (
    dailyBias !== 0 &&
    (benchmarkBias === 0 || benchmarkBias === dailyBias) &&
    (intradayBias === 0 || intradayBias === dailyBias || Math.abs(params.trendScore) >= 0.16)
  ) {
    return dailyBias > 0 ? "trend_up" : "trend_down";
  }

  if (
    benchmarkBias !== 0 &&
    Math.abs(benchmarkTrendScore) >= 0.18 &&
    Math.sign(params.trendScore || benchmarkTrendScore) === benchmarkBias &&
    Math.sign(params.momentum ?? benchmarkTrendScore) === benchmarkBias
  ) {
    return benchmarkBias > 0 ? "trend_up" : "trend_down";
  }

  if (weightedBias >= 0.45 && params.trendScore >= 0.12 && (params.momentum ?? 0) >= 0) {
    return "trend_up";
  }

  if (weightedBias <= -0.45 && params.trendScore <= -0.12 && (params.momentum ?? 0) <= 0) {
    return "trend_down";
  }

  if ((params.historicalVolatility ?? 0) >= 0.04 && Math.abs(params.trendScore) < 0.15) {
    return "volatile";
  }

  if (params.trendScore >= 0.2 && (params.momentum ?? 0) >= 0) {
    return "trend_up";
  }

  if (params.trendScore <= -0.2 && (params.momentum ?? 0) <= 0) {
    return "trend_down";
  }

  return "range";
}

function combineCompositeBenchmarkContext(params: {
  marketCode: string;
  anchors: {
    intraday: CompositeBenchmarkAnchorContext;
    daily?: CompositeBenchmarkAnchorContext;
    weekly?: CompositeBenchmarkAnchorContext;
  };
  benchmark?: CompositeBenchmarkContext;
}): CompositeBenchmarkContext {
  const trendScoreBase = weightedAverageFromAnchors([
    { weight: COMPOSITE_ANCHOR_WEIGHTS.intraday, value: params.anchors.intraday.trendScore },
    { weight: COMPOSITE_ANCHOR_WEIGHTS.daily, value: params.anchors.daily?.trendScore },
    { weight: COMPOSITE_ANCHOR_WEIGHTS.weekly, value: params.anchors.weekly?.trendScore }
  ]) ?? params.anchors.intraday.trendScore;
  const benchmarkBlendWeight =
    params.benchmark && Number.isFinite(params.benchmark.trendScore) ? 0.25 : 0;
  const trendScore =
    benchmarkBlendWeight > 0
      ? clampScore(
          trendScoreBase * (1 - benchmarkBlendWeight) +
          params.benchmark!.trendScore * benchmarkBlendWeight
        )
      : trendScoreBase;
  const averageChange = weightedAverageFromAnchors([
    { weight: COMPOSITE_ANCHOR_WEIGHTS.intraday, value: params.anchors.intraday.averageChange },
    { weight: COMPOSITE_ANCHOR_WEIGHTS.daily, value: params.anchors.daily?.averageChange },
    { weight: COMPOSITE_ANCHOR_WEIGHTS.weekly, value: params.anchors.weekly?.averageChange },
    { weight: benchmarkBlendWeight, value: params.benchmark?.averageChange }
  ]);
  const momentum = weightedAverageFromAnchors([
    { weight: COMPOSITE_ANCHOR_WEIGHTS.intraday, value: params.anchors.intraday.momentum },
    { weight: COMPOSITE_ANCHOR_WEIGHTS.daily, value: params.anchors.daily?.momentum },
    { weight: COMPOSITE_ANCHOR_WEIGHTS.weekly, value: params.anchors.weekly?.momentum },
    { weight: benchmarkBlendWeight, value: params.benchmark?.momentum }
  ]);
  const aboveTrendRatio = weightedAverageFromAnchors([
    { weight: COMPOSITE_ANCHOR_WEIGHTS.intraday, value: params.anchors.intraday.aboveTrendRatio },
    { weight: COMPOSITE_ANCHOR_WEIGHTS.daily, value: params.anchors.daily?.aboveTrendRatio },
    { weight: COMPOSITE_ANCHOR_WEIGHTS.weekly, value: params.anchors.weekly?.aboveTrendRatio },
    { weight: benchmarkBlendWeight, value: params.benchmark?.aboveTrendRatio }
  ]) ?? params.anchors.intraday.aboveTrendRatio;
  const historicalVolatility = weightedAverageFromAnchors([
    { weight: COMPOSITE_ANCHOR_WEIGHTS.intraday, value: params.anchors.intraday.historicalVolatility },
    { weight: COMPOSITE_ANCHOR_WEIGHTS.daily, value: params.anchors.daily?.historicalVolatility },
    { weight: COMPOSITE_ANCHOR_WEIGHTS.weekly, value: params.anchors.weekly?.historicalVolatility },
    { weight: benchmarkBlendWeight, value: params.benchmark?.historicalVolatility }
  ]);
  const liquidityScore = weightedAverageFromAnchors([
    { weight: COMPOSITE_ANCHOR_WEIGHTS.intraday, value: params.anchors.intraday.liquidityScore },
    { weight: COMPOSITE_ANCHOR_WEIGHTS.daily, value: params.anchors.daily?.liquidityScore },
    { weight: COMPOSITE_ANCHOR_WEIGHTS.weekly, value: params.anchors.weekly?.liquidityScore },
    { weight: benchmarkBlendWeight, value: params.benchmark?.liquidityScore }
  ]) ?? params.anchors.intraday.liquidityScore;
  const dispersionScore = weightedAverageFromAnchors([
    { weight: COMPOSITE_ANCHOR_WEIGHTS.intraday, value: params.anchors.intraday.dispersionScore },
    { weight: COMPOSITE_ANCHOR_WEIGHTS.daily, value: params.anchors.daily?.dispersionScore },
    { weight: COMPOSITE_ANCHOR_WEIGHTS.weekly, value: params.anchors.weekly?.dispersionScore },
    { weight: benchmarkBlendWeight, value: params.benchmark?.dispersionScore }
  ]) ?? params.anchors.intraday.dispersionScore;
  const regime = determineAnchoredRegime({
    intraday: params.anchors.intraday,
    daily: params.anchors.daily,
    weekly: params.anchors.weekly,
    benchmark: params.benchmark,
    trendScore,
    momentum,
    historicalVolatility
  });

  return {
    source: "universe_composite",
    marketCode: params.marketCode,
    averageChange,
    momentum,
    aboveTrend: aboveTrendRatio >= 0.5,
    aboveTrendRatio,
    historicalVolatility,
    trendScore,
    liquidityScore,
    dispersionScore,
    regime,
    anchors: params.anchors
  };
}

function resolveBenchmarkMarketCode(params: {
  benchmarkMarketCode?: string;
  universeCandlesByMarket: Record<string, Candle[]>;
}): string | undefined {
  if (params.benchmarkMarketCode && params.universeCandlesByMarket[params.benchmarkMarketCode]) {
    return params.benchmarkMarketCode;
  }

  if (params.universeCandlesByMarket["KRW-BTC"]) {
    return "KRW-BTC";
  }

  return undefined;
}

function buildRelativeStrengthContext(
  current: ResolvedMarketSnapshot | undefined,
  breadth: MarketBreadthContext,
  benchmark: CompositeBenchmarkContext,
  composite: CompositeBenchmarkContext,
  sortedMomentumValues: number[],
  sortedReturnValues: number[]
): RelativeStrengthContext | undefined {
  if (!current) {
    return undefined;
  }

  const cohortMomentumSpread =
    current.momentum === null || breadth.averageMomentum === null
      ? null
      : current.momentum - breadth.averageMomentum;
  const cohortZScoreSpread =
    current.zScore === null || breadth.averageZScore === null
      ? null
      : current.zScore - breadth.averageZScore;
  const cohortVolumeSpikeSpread =
    current.volumeSpike === null || breadth.averageVolumeSpike === null
      ? null
      : current.volumeSpike - breadth.averageVolumeSpike;
  const benchmarkMomentumSpread =
    current.momentum === null || benchmark.momentum === null
      ? null
      : current.momentum - benchmark.momentum;
  const compositeMomentumSpread =
    current.momentum === null || composite.momentum === null
      ? benchmarkMomentumSpread
      : current.momentum - composite.momentum;
  const compositeChangeSpread =
    composite.averageChange === null ? null : current.change - composite.averageChange;
  const liquiditySpread =
    current.liquidityScore === null ? null : current.liquidityScore - breadth.liquidityScore;
  const momentumPercentile = percentileInSortedValues(sortedMomentumValues, current.momentum);
  const returnPercentile = percentileInSortedValues(sortedReturnValues, current.change);

  return {
    momentumSpread: cohortMomentumSpread,
    zScoreSpread: cohortZScoreSpread,
    volumeSpikeSpread: cohortVolumeSpikeSpread,
    benchmarkMomentumSpread,
    momentumPercentile,
    cohortMomentumSpread,
    cohortZScoreSpread,
    cohortVolumeSpikeSpread,
    compositeMomentumSpread,
    compositeChangeSpread,
    liquiditySpread,
    returnPercentile
  };
}

function resolveUniverseSnapshots(params: {
  referenceTime: Date;
  alignedIndex?: number;
  universeCandlesByMarket: Record<string, Candle[]>;
  config: ResolvedMarketStateConfig;
  aggregateTo?: AnchorTimeframe;
}): Map<string, ResolvedMarketSnapshot> {
  const snapshots = new Map<string, ResolvedMarketSnapshot>();

  for (const [marketCode, rawCandles] of Object.entries(params.universeCandlesByMarket)) {
    const candles = params.aggregateTo ? getAggregatedCandles(rawCandles, params.aggregateTo) : rawCandles;
    const snapshot = resolveMarketSnapshot({
      marketCode,
      candles,
      referenceTime: params.referenceTime,
      alignedIndex: params.aggregateTo ? undefined : params.alignedIndex,
      config: params.config
    });

    if (snapshot) {
      snapshots.set(marketCode, snapshot);
    }
  }

  return snapshots;
}

function buildCompositeAnchorInput(params: {
  referenceTime: Date;
  alignedIndex?: number;
  universeCandlesByMarket: Record<string, Candle[]>;
  config: ResolvedMarketStateConfig;
  aggregateTo?: AnchorTimeframe;
}): CompositeAnchorInput | undefined {
  const snapshots = resolveUniverseSnapshots(params);
  if (snapshots.size === 0) {
    return undefined;
  }

  const snapshotValues = [...snapshots.values()];
  const breadth = buildBreadthContext(snapshotValues);
  const composite = buildSingleHorizonCompositeBenchmarkContext(snapshotValues, breadth);

  return {
    sampleSize: snapshotValues.length,
    breadth,
    composite
  };
}

function buildBenchmarkAnchorContext(params: {
  timeframe: CompositeBenchmarkAnchorContext["timeframe"];
  benchmarkMarketCode: string;
  referenceTime: Date;
  universeCandlesByMarket: Record<string, Candle[]>;
  config: ResolvedMarketStateConfig;
  aggregateTo?: AnchorTimeframe;
}): CompositeBenchmarkAnchorContext | undefined {
  const rawCandles = params.universeCandlesByMarket[params.benchmarkMarketCode];
  if (!rawCandles || rawCandles.length === 0) {
    return undefined;
  }

  const candles = params.aggregateTo ? getAggregatedCandles(rawCandles, params.aggregateTo) : rawCandles;
  const snapshot = resolveMarketSnapshot({
    marketCode: params.benchmarkMarketCode,
    candles,
    referenceTime: params.referenceTime,
    config: params.config
  });

  if (!snapshot) {
    return undefined;
  }

  return buildSingleMarketBenchmarkContext(params.timeframe, snapshot);
}

function buildAnchoredBenchmarkContext(params: {
  benchmarkMarketCode: string;
  referenceTime: Date;
  universeCandlesByMarket: Record<string, Candle[]>;
  intradayConfig: ResolvedMarketStateConfig;
}): CompositeBenchmarkContext | undefined {
  const intraday = buildBenchmarkAnchorContext({
    timeframe: "intraday",
    benchmarkMarketCode: params.benchmarkMarketCode,
    referenceTime: params.referenceTime,
    universeCandlesByMarket: params.universeCandlesByMarket,
    config: params.intradayConfig
  });

  if (!intraday) {
    return undefined;
  }

  const daily = buildBenchmarkAnchorContext({
    timeframe: "1d",
    benchmarkMarketCode: params.benchmarkMarketCode,
    referenceTime: params.referenceTime,
    universeCandlesByMarket: params.universeCandlesByMarket,
    config: DAILY_ANCHOR_CONFIG,
    aggregateTo: "1d"
  });
  const weekly = buildBenchmarkAnchorContext({
    timeframe: "1w",
    benchmarkMarketCode: params.benchmarkMarketCode,
    referenceTime: params.referenceTime,
    universeCandlesByMarket: params.universeCandlesByMarket,
    config: WEEKLY_ANCHOR_CONFIG,
    aggregateTo: "1w"
  });

  return combineCompositeBenchmarkContext({
    marketCode: params.benchmarkMarketCode,
    anchors: {
      intraday,
      daily,
      weekly
    }
  });
}

export function buildMarketStateContexts(params: {
  marketCode?: string;
  marketCodes?: string[];
  candles?: Candle[];
  index?: number;
  alignedIndex?: number;
  referenceTime?: Date;
  universeName?: string;
  benchmarkMarketCode?: string;
  universeCandlesByMarket: Record<string, Candle[]>;
  config?: MarketStateConfig;
}): Record<string, MarketStateContext> {
  const referenceTime =
    params.referenceTime ??
    (params.candles && params.index !== undefined
      ? params.candles[params.index]?.candleTimeUtc
      : undefined);

  if (!referenceTime) {
    return {};
  }

  const config = resolveMarketStateConfig(params.config);
  const intradayAnchor = buildCompositeAnchorInput({
    referenceTime,
    alignedIndex: params.alignedIndex,
    universeCandlesByMarket: params.universeCandlesByMarket,
    config
  });
  if (!intradayAnchor) {
    return {};
  }

  const snapshots = resolveUniverseSnapshots({
    referenceTime,
    alignedIndex: params.alignedIndex,
    universeCandlesByMarket: params.universeCandlesByMarket,
    config
  });
  const snapshotValues = [...snapshots.values()];
  const breadth = intradayAnchor.breadth;
  const dailyAnchor = buildCompositeAnchorInput({
    referenceTime,
    universeCandlesByMarket: params.universeCandlesByMarket,
    config: DAILY_ANCHOR_CONFIG,
    aggregateTo: "1d"
  });
  const weeklyAnchor = buildCompositeAnchorInput({
    referenceTime,
    universeCandlesByMarket: params.universeCandlesByMarket,
    config: WEEKLY_ANCHOR_CONFIG,
    aggregateTo: "1w"
  });
  const resolvedBenchmarkMarketCode = resolveBenchmarkMarketCode({
    benchmarkMarketCode: params.benchmarkMarketCode ?? params.config?.benchmarkMarketCode,
    universeCandlesByMarket: params.universeCandlesByMarket
  });
  const benchmark = resolvedBenchmarkMarketCode
    ? buildAnchoredBenchmarkContext({
        benchmarkMarketCode: resolvedBenchmarkMarketCode,
        referenceTime,
        universeCandlesByMarket: params.universeCandlesByMarket,
        intradayConfig: config
      })
    : undefined;
  const benchmarkForRelativeStrength =
    benchmark?.anchors?.intraday
      ? {
          ...benchmark,
          averageChange: benchmark.anchors.intraday.averageChange,
          momentum: benchmark.anchors.intraday.momentum,
          aboveTrend: benchmark.anchors.intraday.aboveTrend,
          aboveTrendRatio: benchmark.anchors.intraday.aboveTrendRatio,
          historicalVolatility: benchmark.anchors.intraday.historicalVolatility,
          trendScore: benchmark.anchors.intraday.trendScore,
          liquidityScore: benchmark.anchors.intraday.liquidityScore,
          dispersionScore: benchmark.anchors.intraday.dispersionScore,
          regime: benchmark.anchors.intraday.regime
        }
      : intradayAnchor.composite;
  const composite = combineCompositeBenchmarkContext({
    marketCode: COMPOSITE_MARKET_CODE,
    anchors: {
      intraday: toCompositeAnchorContext("intraday", intradayAnchor.sampleSize, intradayAnchor.composite),
      daily: dailyAnchor
        ? toCompositeAnchorContext("1d", dailyAnchor.sampleSize, dailyAnchor.composite)
        : undefined,
      weekly: weeklyAnchor
        ? toCompositeAnchorContext("1w", weeklyAnchor.sampleSize, weeklyAnchor.composite)
        : undefined
    },
    benchmark
  });
  const requestedMarkets = params.marketCodes ? new Set(params.marketCodes) : undefined;
  const sortedMomentumValues = snapshotValues
    .map((snapshot) => snapshot.momentum)
    .filter((value): value is number => value !== null && Number.isFinite(value))
    .sort((left, right) => left - right);
  const sortedReturnValues = snapshotValues
    .map((snapshot) => snapshot.change)
    .filter((value): value is number => Number.isFinite(value))
    .sort((left, right) => left - right);
  const baseContext = {
    universeName: params.universeName,
    benchmarkMarketCode: benchmark?.marketCode ?? composite.marketCode,
    referenceTime,
    sampleSize: snapshotValues.length,
    breadth,
    composite,
    benchmark: benchmark ?? composite
  };

  return Object.fromEntries(
    snapshotValues
      .filter((snapshot) => !requestedMarkets || requestedMarkets.has(snapshot.marketCode))
      .map((snapshot) => [
      snapshot.marketCode,
      {
        ...baseContext,
        relativeStrength: buildRelativeStrengthContext(
          snapshot,
          breadth,
          benchmarkForRelativeStrength,
          composite,
          sortedMomentumValues,
          sortedReturnValues
        )
      } satisfies MarketStateContext
    ])
  );
}

export function buildMarketStateContext(params: {
  marketCode: string;
  candles?: Candle[];
  index?: number;
  referenceTime?: Date;
  universeName?: string;
  benchmarkMarketCode?: string;
  universeCandlesByMarket: Record<string, Candle[]>;
  config?: MarketStateConfig;
}): MarketStateContext | undefined {
  return buildMarketStateContexts(params)[params.marketCode];
}
