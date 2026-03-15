import { buildMarketStateContext } from "../../strategies/src/index.js";
import type { Candle, MarketStateConfig } from "../../strategies/src/index.js";
import {
  getEma,
  getHistoricalVolatility,
  getMomentum,
  getVolumeSpikeRatio,
  getZScore
} from "../../strategies/src/factors/index.js";
import type { UniverseAlphaCandidate } from "./types.js";

export type UniverseAlphaModel = {
  name: string;
  parameters: Record<string, number>;
  contextConfig?: MarketStateConfig;
  rankCandidates(params: {
    referenceTime: Date;
    universeName?: string;
    marketCodes: string[];
    universeCandlesByMarket: Record<string, Candle[]>;
  }): UniverseAlphaCandidate[];
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

export function createCrossSectionalMultiFactorAlphaModel(params?: {
  trendWindow?: number;
  momentumLookback?: number;
  volumeWindow?: number;
  zScoreWindow?: number;
  volatilityWindow?: number;
  minBreadthScore?: number;
  minMomentumPercentile?: number;
}): UniverseAlphaModel {
  const trendWindow = params?.trendWindow ?? 55;
  const momentumLookback = params?.momentumLookback ?? 20;
  const volumeWindow = params?.volumeWindow ?? 20;
  const zScoreWindow = params?.zScoreWindow ?? 20;
  const volatilityWindow = params?.volatilityWindow ?? 20;
  const minBreadthScore = params?.minBreadthScore ?? -0.05;
  const minMomentumPercentile = params?.minMomentumPercentile ?? 0.55;

  return {
    name: "cross-sectional-multi-factor",
    parameters: {
      trendWindow,
      momentumLookback,
      volumeWindow,
      zScoreWindow,
      volatilityWindow,
      minBreadthScore,
      minMomentumPercentile
    },
    contextConfig: {
      trendWindow,
      momentumLookback,
      volumeWindow,
      zScoreWindow,
      volatilityWindow
    },
    rankCandidates(input) {
      const ranked: UniverseAlphaCandidate[] = [];

      for (const marketCode of input.marketCodes) {
        const candles = input.universeCandlesByMarket[marketCode] ?? [];
        const index = findCandleIndexAtOrBefore(candles, input.referenceTime);

        if (index <= Math.max(trendWindow, momentumLookback, volumeWindow, zScoreWindow, volatilityWindow)) {
          continue;
        }

        const close = candles[index]?.closePrice;
        const ema = getEma(candles, index, trendWindow);
        const momentum = getMomentum(candles, index, momentumLookback);
        const volumeSpike = getVolumeSpikeRatio(candles, index, volumeWindow);
        const zScore = getZScore(candles, index, zScoreWindow);
        const historicalVolatility = getHistoricalVolatility(candles, index, volatilityWindow);
        const marketState = buildMarketStateContext({
          marketCode,
          referenceTime: input.referenceTime,
          universeName: input.universeName,
          universeCandlesByMarket: input.universeCandlesByMarket,
          config: {
            trendWindow,
            momentumLookback,
            volumeWindow,
            zScoreWindow,
            volatilityWindow
          }
        });

        if (
          close === undefined ||
          close === 0 ||
          ema === null ||
          momentum === null ||
          volumeSpike === null ||
          zScore === null ||
          historicalVolatility === null ||
          !marketState ||
          !marketState.relativeStrength
        ) {
          continue;
        }

        const trendScore = normalize((close - ema) / ema, 0.05);
        const momentumScore = normalize(momentum, 0.06);
        const volumeScore = normalize(volumeSpike - 1, 0.6);
        const pullbackScore = clampScore((1.5 - Math.abs(zScore)) / 1.5);
        const volatilityScore = normalize(0.04 - historicalVolatility, 0.04);
        const breadthScore = average([
          marketState.breadth.riskOnScore,
          marketState.breadth.compositeTrendScore,
          marketState.breadth.liquidityScore,
          marketState.breadth.dispersionScore
        ]);
        const relativeStrengthScore = average([
          marketState.relativeStrength.cohortMomentumSpread === null
            ? null
            : normalize(marketState.relativeStrength.cohortMomentumSpread, 0.05),
          marketState.relativeStrength.compositeMomentumSpread === null
            ? null
            : normalize(marketState.relativeStrength.compositeMomentumSpread, 0.05),
          marketState.relativeStrength.liquiditySpread === null
            ? null
            : normalize(marketState.relativeStrength.liquiditySpread, 0.5),
          marketState.relativeStrength.momentumPercentile === null
            ? null
            : clampScore(marketState.relativeStrength.momentumPercentile * 2 - 1),
          marketState.relativeStrength.returnPercentile === null
            ? null
            : clampScore(marketState.relativeStrength.returnPercentile * 2 - 1)
        ]);
        const compositeScore =
          marketState.composite?.regime === "trend_up"
            ? average([
                0.5,
                marketState.composite.trendScore,
                marketState.composite.liquidityScore
              ])
            : marketState.composite?.regime === "trend_down"
              ? average([
                  -0.75,
                  marketState.composite.trendScore,
                  marketState.composite.dispersionScore
                ])
              : marketState.composite?.regime === "volatile"
                ? -0.4
                : 0;

        const score = average([
          trendScore,
          momentumScore,
          volumeScore,
          pullbackScore,
          volatilityScore,
          breadthScore,
          relativeStrengthScore,
          compositeScore
        ]);

        if (
          score === null ||
          (breadthScore ?? 0) < minBreadthScore ||
          (marketState.relativeStrength.momentumPercentile ?? 0) < minMomentumPercentile
        ) {
          continue;
        }

        ranked.push({
          marketCode,
          score,
          factors: {
            trendScore,
            momentumScore,
            volumeScore,
            pullbackScore,
            volatilityScore,
            breadthScore,
            relativeStrengthScore,
            compositeScore
          }
        });
      }

      return ranked.sort((left, right) => right.score - left.score);
    }
  };
}
