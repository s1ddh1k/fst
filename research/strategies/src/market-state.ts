import { getEma } from "./factors/moving-averages.js";
import { getMomentum } from "./factors/momentum.js";
import { detectMarketRegime } from "./factors/regime.js";
import { getHistoricalVolatility } from "./factors/volatility.js";
import { getVolumeSpikeRatio } from "./factors/volume.js";
import { getZScore } from "./factors/mean-reversion.js";
import type {
  Candle,
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

export type ResolvedMarketStateConfig = Required<Omit<MarketStateConfig, "benchmarkMarketCode">>;

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
  _benchmarkMarketCode?: string
): string {
  const resolved = resolveMarketStateConfig(config);

  return [
    `trend=${resolved.trendWindow}`,
    `momentum=${resolved.momentumLookback}`,
    `volume=${resolved.volumeWindow}`,
    `zscore=${resolved.zScoreWindow}`,
    `volatility=${resolved.volatilityWindow}`,
    "benchmark=composite"
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

function percentile(values: Array<number | null>, currentValue: number | null): number | null {
  const filtered = values
    .filter((value): value is number => value !== null && Number.isFinite(value))
    .sort((left, right) => left - right);

  if (currentValue === null || filtered.length === 0) {
    return null;
  }

  return filtered.filter((value) => value <= currentValue).length / filtered.length;
}

function averageQuoteVolume(candles: Candle[], index: number, window: number): number | null {
  const start = Math.max(0, index - window + 1);
  let total = 0;
  let count = 0;

  for (let candleIndex = start; candleIndex <= index; candleIndex += 1) {
    const candle = candles[candleIndex];

    if (!candle) {
      continue;
    }

    total += candle.quoteVolume ?? candle.closePrice * candle.volume;
    count += 1;
  }

  return count === 0 ? null : total / count;
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
  referenceTime: Date;
  config: ResolvedMarketStateConfig;
}): ResolvedMarketSnapshot | null {
  const index = findCandleIndexAtOrBefore(params.candles, params.referenceTime);

  if (index <= 0) {
    return null;
  }

  const close = params.candles[index]?.closePrice;
  const previousClose = params.candles[index - 1]?.closePrice;
  const ema = getEma(params.candles, index, params.config.trendWindow);
  const momentum = getMomentum(params.candles, index, params.config.momentumLookback);
  const zScore = getZScore(params.candles, index, params.config.zScoreWindow);
  const volumeSpike = getVolumeSpikeRatio(params.candles, index, params.config.volumeWindow);
  const quoteVolume = averageQuoteVolume(params.candles, index, params.config.volumeWindow);
  const historicalVolatility = getHistoricalVolatility(
    params.candles,
    index,
    params.config.volatilityWindow
  );

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
    regime: detectMarketRegime(params.candles, index, {
      trendWindow: params.config.trendWindow,
      momentumLookback: params.config.momentumLookback,
      volatilityWindow: params.config.volatilityWindow,
      volatilityThreshold: 0.03
    })
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

function buildCompositeBenchmarkContext(
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

function buildRelativeStrengthContext(
  current: ResolvedMarketSnapshot | undefined,
  snapshots: ResolvedMarketSnapshot[],
  breadth: MarketBreadthContext,
  composite: CompositeBenchmarkContext
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
  const compositeMomentumSpread =
    current.momentum === null || composite.momentum === null
      ? null
      : current.momentum - composite.momentum;
  const compositeChangeSpread =
    composite.averageChange === null ? null : current.change - composite.averageChange;
  const liquiditySpread =
    current.liquidityScore === null ? null : current.liquidityScore - breadth.liquidityScore;
  const momentumPercentile = percentile(
    snapshots.map((snapshot) => snapshot.momentum),
    current.momentum
  );
  const returnPercentile = percentile(
    snapshots.map((snapshot) => snapshot.change),
    current.change
  );

  return {
    momentumSpread: cohortMomentumSpread,
    zScoreSpread: cohortZScoreSpread,
    volumeSpikeSpread: cohortVolumeSpikeSpread,
    benchmarkMomentumSpread: compositeMomentumSpread,
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
  const referenceTime =
    params.referenceTime ??
    (params.candles && params.index !== undefined
      ? params.candles[params.index]?.candleTimeUtc
      : undefined);

  if (!referenceTime) {
    return undefined;
  }

  const config = resolveMarketStateConfig(params.config);
  const snapshots = new Map<string, ResolvedMarketSnapshot>();

  for (const [marketCode, candles] of Object.entries(params.universeCandlesByMarket)) {
    const snapshot = resolveMarketSnapshot({
      marketCode,
      candles,
      referenceTime,
      config
    });

    if (snapshot) {
      snapshots.set(marketCode, snapshot);
    }
  }

  if (snapshots.size === 0) {
    return undefined;
  }

  const snapshotValues = [...snapshots.values()];
  const breadth = buildBreadthContext(snapshotValues);
  const composite = buildCompositeBenchmarkContext(snapshotValues, breadth);
  const relativeStrength = buildRelativeStrengthContext(
    snapshots.get(params.marketCode),
    snapshotValues,
    breadth,
    composite
  );

  return {
    universeName: params.universeName,
    benchmarkMarketCode: composite.marketCode,
    referenceTime,
    sampleSize: snapshotValues.length,
    breadth,
    relativeStrength,
    composite,
    benchmark: composite
  };
}
