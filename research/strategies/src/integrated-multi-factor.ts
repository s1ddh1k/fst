import {
  detectMarketRegime,
  getAdx,
  getAtr,
  getAverageVolume,
  getBollingerBands,
  getEma,
  getHistoricalVolatility,
  getMacd,
  getMomentum,
  getObvSlope,
  getPriceSlope,
  getRsi,
  getVolumeSpikeRatio,
  getZScore
} from "./factors/index.js";
import type { Strategy, StrategyContext } from "./types.js";
import {
  createWeightedScoreStrategy,
  type StrategyGate,
  type WeightedScoreFactor
} from "./weighted-score-strategy.js";

function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(-1, Math.min(1, value));
}

function average(scores: number[]): number {
  return scores.reduce((sum, value) => sum + value, 0) / scores.length;
}

function getScale(threshold: number, fallback: number): number {
  return Math.max(Math.abs(threshold), fallback);
}

function normalizeAroundZero(value: number, scale: number): number {
  return clampScore(value / Math.max(scale, 0.0001));
}

function scoreAbove(value: number, threshold: number, fallback = 0.0001): number {
  return clampScore((value - threshold) / getScale(threshold, fallback));
}

function scoreBelow(value: number, threshold: number, fallback = 0.0001): number {
  return clampScore((threshold - value) / getScale(threshold, fallback));
}

function getRegimeValue(
  context: StrategyContext,
  params: {
    regimeTrendWindow: number;
    regimeMomentumLookback: number;
    regimeVolatilityWindow: number;
    regimeVolatilityThreshold: number;
  }
) {
  return detectMarketRegime(context.candles, context.index, {
    trendWindow: params.regimeTrendWindow,
    momentumLookback: params.regimeMomentumLookback,
    volatilityWindow: params.regimeVolatilityWindow,
    volatilityThreshold: params.regimeVolatilityThreshold
  });
}

function createEntryRegimeFactor(params: {
  regimeTrendWindow: number;
  regimeMomentumLookback: number;
  regimeVolatilityWindow: number;
  regimeVolatilityThreshold: number;
  regimeWeight: number;
}): WeightedScoreFactor {
  return {
    name: "entry_regime_context",
    weight: params.regimeWeight,
    evaluate(context) {
      const regime = getRegimeValue(context, params);

      switch (regime) {
        case "trend_up":
          return 1;
        case "range":
          return 0.25;
        case "volatile":
          return -0.65;
        case "trend_down":
          return -1;
        default:
          return null;
      }
    }
  };
}

function createTrendAlignmentFactor(params: {
  trendWindow: number;
  adxPeriod: number;
  minAdx: number;
  trendWeight: number;
}): WeightedScoreFactor {
  return {
    name: "entry_trend_alignment",
    weight: params.trendWeight,
    evaluate(context) {
      const close = context.candles[context.index]?.closePrice;
      const ema = getEma(context.candles, context.index, params.trendWindow);
      const adx = getAdx(context.candles, context.index, params.adxPeriod);

      if (close === undefined || close === 0 || ema === null || adx === null) {
        return null;
      }

      return average([
        normalizeAroundZero((close - ema) / ema, 0.03),
        normalizeAroundZero(adx.plusDi - adx.minusDi, 18),
        scoreAbove(adx.adx, params.minAdx, 5)
      ]);
    }
  };
}

function createMomentumContinuationFactor(params: {
  trendWindow: number;
  momentumLookback: number;
  macdFastWindow: number;
  macdSlowWindow: number;
  macdSignalWindow: number;
  momentumWeight: number;
}): WeightedScoreFactor {
  return {
    name: "entry_momentum_continuation",
    weight: params.momentumWeight,
    evaluate(context) {
      const close = context.candles[context.index]?.closePrice;
      const momentum = getMomentum(context.candles, context.index, params.momentumLookback);
      const slope = getPriceSlope(context.candles, context.index, params.trendWindow);
      const macd = getMacd(context.candles, context.index, {
        fastWindow: params.macdFastWindow,
        slowWindow: params.macdSlowWindow,
        signalWindow: params.macdSignalWindow
      });

      if (close === undefined || close === 0 || momentum === null || slope === null || macd === null) {
        return null;
      }

      return average([
        normalizeAroundZero(momentum, 0.03),
        normalizeAroundZero((slope * params.trendWindow) / close, 0.03),
        normalizeAroundZero(macd.histogram / close, 0.01)
      ]);
    }
  };
}

function createPullbackTimingFactor(params: {
  zScoreWindow: number;
  entryZScore: number;
  rsiPeriod: number;
  entryRsi: number;
  bollingerWindow: number;
  bollingerMultiplier: number;
  entryPercentB: number;
  timingWeight: number;
}): WeightedScoreFactor {
  return {
    name: "entry_pullback_timing",
    weight: params.timingWeight,
    evaluate(context) {
      const zScore = getZScore(context.candles, context.index, params.zScoreWindow);
      const rsi = getRsi(context.candles, context.index, params.rsiPeriod);
      const bands = getBollingerBands(
        context.candles,
        context.index,
        params.bollingerWindow,
        params.bollingerMultiplier
      );

      if (zScore === null || rsi === null || bands === null) {
        return null;
      }

      return average([
        scoreBelow(zScore, params.entryZScore, 0.5),
        scoreBelow(rsi, params.entryRsi, 5),
        scoreBelow(bands.percentB, params.entryPercentB, 0.1)
      ]);
    }
  };
}

function createParticipationFactor(params: {
  volumeWindow: number;
  minVolumeSpike: number;
  obvLookback: number;
  participationWeight: number;
}): WeightedScoreFactor {
  return {
    name: "entry_participation_confirmation",
    weight: params.participationWeight,
    evaluate(context) {
      const volumeSpike = getVolumeSpikeRatio(context.candles, context.index, params.volumeWindow);
      const obvSlope = getObvSlope(context.candles, context.index, params.obvLookback);
      const averageVolume = getAverageVolume(context.candles, context.index, params.volumeWindow);

      if (
        volumeSpike === null ||
        obvSlope === null ||
        averageVolume === null ||
        averageVolume === 0
      ) {
        return null;
      }

      return average([
        scoreAbove(volumeSpike, params.minVolumeSpike, 0.1),
        normalizeAroundZero(obvSlope / averageVolume, 0.75)
      ]);
    }
  };
}

function createMarketBreadthFactor(params: {
  breadthWeight: number;
}): WeightedScoreFactor {
  return {
    name: "entry_market_breadth",
    weight: params.breadthWeight,
    evaluate(context) {
      const breadth = context.marketState?.breadth;

      if (!breadth || breadth.sampleSize < 3) {
        return null;
      }

      return average([
        breadth.riskOnScore,
        breadth.advancingRatio * 2 - 1,
        breadth.aboveTrendRatio * 2 - 1,
        breadth.positiveMomentumRatio * 2 - 1
      ]);
    }
  };
}

function createRelativeStrengthFactor(params: {
  relativeStrengthWeight: number;
  minMomentumPercentile: number;
}): WeightedScoreFactor {
  return {
    name: "entry_relative_strength",
    weight: params.relativeStrengthWeight,
    evaluate(context) {
      const relativeStrength = context.marketState?.relativeStrength;

      if (!relativeStrength) {
        return null;
      }

      return average([
        normalizeAroundZero(relativeStrength.cohortMomentumSpread ?? 0, 0.03),
        normalizeAroundZero(relativeStrength.compositeMomentumSpread ?? 0, 0.03),
        normalizeAroundZero(relativeStrength.liquiditySpread ?? 0, 0.4),
        scoreAbove(relativeStrength.momentumPercentile ?? 0.5, params.minMomentumPercentile, 0.1),
        normalizeAroundZero((relativeStrength.returnPercentile ?? 0.5) - 0.5, 0.25)
      ]);
    }
  };
}

function createVolatilityEfficiencyFactor(params: {
  volatilityWindow: number;
  maxHistoricalVolatility: number;
  atrPeriod: number;
  maxAtrRatio: number;
  riskWeight: number;
}): WeightedScoreFactor {
  return {
    name: "entry_volatility_efficiency",
    weight: params.riskWeight,
    evaluate(context) {
      const close = context.candles[context.index]?.closePrice;
      const historicalVolatility = getHistoricalVolatility(
        context.candles,
        context.index,
        params.volatilityWindow
      );
      const atr = getAtr(context.candles, context.index, params.atrPeriod);

      if (close === undefined || close === 0 || historicalVolatility === null || atr === null) {
        return null;
      }

      return average([
        scoreBelow(historicalVolatility, params.maxHistoricalVolatility, 0.005),
        scoreBelow(atr / close, params.maxAtrRatio, 0.005)
      ]);
    }
  };
}

function createMarketDeteriorationExitFactor(params: {
  breadthWeight: number;
  relativeStrengthWeight: number;
}): WeightedScoreFactor {
  return {
    name: "exit_market_deterioration",
    weight: params.breadthWeight + params.relativeStrengthWeight,
    evaluate(context) {
      const breadth = context.marketState?.breadth;

      if (!breadth || breadth.sampleSize < 3) {
        return null;
      }

      return average([
        normalizeAroundZero(-breadth.riskOnScore, 0.5),
        normalizeAroundZero(
          -(context.marketState?.relativeStrength?.compositeMomentumSpread ?? 0),
          0.03
        ),
        normalizeAroundZero(-(context.marketState?.composite?.trendScore ?? 0), 0.5)
      ]);
    }
  };
}

function createRecoveryExitFactor(params: {
  zScoreWindow: number;
  exitZScore: number;
  rsiPeriod: number;
  exitRsi: number;
  bollingerWindow: number;
  bollingerMultiplier: number;
  exitPercentB: number;
  timingWeight: number;
}): WeightedScoreFactor {
  return {
    name: "exit_recovery_completion",
    weight: params.timingWeight,
    evaluate(context) {
      const zScore = getZScore(context.candles, context.index, params.zScoreWindow);
      const rsi = getRsi(context.candles, context.index, params.rsiPeriod);
      const bands = getBollingerBands(
        context.candles,
        context.index,
        params.bollingerWindow,
        params.bollingerMultiplier
      );

      if (zScore === null || rsi === null || bands === null) {
        return null;
      }

      return average([
        scoreAbove(zScore, params.exitZScore, 0.5),
        scoreAbove(rsi, params.exitRsi, 5),
        scoreAbove(bands.percentB, params.exitPercentB, 0.1)
      ]);
    }
  };
}

function createTrendBreakdownExitFactor(params: {
  trendWindow: number;
  momentumLookback: number;
  macdFastWindow: number;
  macdSlowWindow: number;
  macdSignalWindow: number;
  trendWeight: number;
  momentumWeight: number;
}): WeightedScoreFactor {
  return {
    name: "exit_trend_breakdown",
    weight: params.trendWeight + params.momentumWeight,
    evaluate(context) {
      const close = context.candles[context.index]?.closePrice;
      const ema = getEma(context.candles, context.index, params.trendWindow);
      const momentum = getMomentum(context.candles, context.index, params.momentumLookback);
      const macd = getMacd(context.candles, context.index, {
        fastWindow: params.macdFastWindow,
        slowWindow: params.macdSlowWindow,
        signalWindow: params.macdSignalWindow
      });

      if (close === undefined || close === 0 || ema === null || momentum === null || macd === null) {
        return null;
      }

      return average([
        normalizeAroundZero((ema - close) / ema, 0.03),
        normalizeAroundZero(-momentum, 0.03),
        normalizeAroundZero((-macd.histogram) / close, 0.01)
      ]);
    }
  };
}

function createVolatilityStressExitFactor(params: {
  volatilityWindow: number;
  maxHistoricalVolatility: number;
  atrPeriod: number;
  maxAtrRatio: number;
  regimeTrendWindow: number;
  regimeMomentumLookback: number;
  regimeVolatilityWindow: number;
  regimeVolatilityThreshold: number;
  riskWeight: number;
}): WeightedScoreFactor {
  return {
    name: "exit_volatility_stress",
    weight: params.riskWeight,
    evaluate(context) {
      const close = context.candles[context.index]?.closePrice;
      const historicalVolatility = getHistoricalVolatility(
        context.candles,
        context.index,
        params.volatilityWindow
      );
      const atr = getAtr(context.candles, context.index, params.atrPeriod);
      const regime = getRegimeValue(context, params);

      if (close === undefined || close === 0 || historicalVolatility === null || atr === null) {
        return null;
      }

      const regimeScore =
        regime === "volatile"
          ? 1
          : regime === "trend_down"
            ? 0.8
            : regime === "range"
              ? 0
              : -0.5;

      return average([
        scoreAbove(historicalVolatility, params.maxHistoricalVolatility, 0.005),
        scoreAbove(atr / close, params.maxAtrRatio, 0.005),
        regimeScore
      ]);
    }
  };
}

function createParticipationFailureExitFactor(params: {
  volumeWindow: number;
  obvLookback: number;
  participationWeight: number;
}): WeightedScoreFactor {
  return {
    name: "exit_participation_failure",
    weight: params.participationWeight,
    evaluate(context) {
      const volumeSpike = getVolumeSpikeRatio(context.candles, context.index, params.volumeWindow);
      const obvSlope = getObvSlope(context.candles, context.index, params.obvLookback);
      const averageVolume = getAverageVolume(context.candles, context.index, params.volumeWindow);

      if (
        volumeSpike === null ||
        obvSlope === null ||
        averageVolume === null ||
        averageVolume === 0
      ) {
        return null;
      }

      return average([
        normalizeAroundZero(1 - volumeSpike, 0.4),
        normalizeAroundZero(-(obvSlope / averageVolume), 0.75)
      ]);
    }
  };
}

function createBreadthSupportGate(params: {
  minBreadthScore: number;
  minBreadthSampleSize: number;
}): StrategyGate {
  return {
    name: "breadth_support_gate",
    test(context) {
      if (!context.marketState) {
        return true;
      }

      return (
        context.marketState.sampleSize >= params.minBreadthSampleSize &&
        context.marketState.breadth.riskOnScore >= params.minBreadthScore
      );
    }
  };
}

function createAllowedRegimeGate(params: {
  regimeTrendWindow: number;
  regimeMomentumLookback: number;
  regimeVolatilityWindow: number;
  regimeVolatilityThreshold: number;
}): StrategyGate {
  return {
    name: "allowed_entry_regime",
    test(context) {
      const regime = getRegimeValue(context, params);
      return regime === "trend_up" || regime === "range";
    }
  };
}

function createTrendBiasGate(params: { trendWindow: number }): StrategyGate {
  return {
    name: "trend_bias_gate",
    test(context) {
      const close = context.candles[context.index]?.closePrice;
      const ema = getEma(context.candles, context.index, params.trendWindow);

      return close !== undefined && ema !== null && close >= ema;
    }
  };
}

function createHardRiskOffGate(params: {
  regimeTrendWindow: number;
  regimeMomentumLookback: number;
  regimeVolatilityWindow: number;
  regimeVolatilityThreshold: number;
  momentumLookback: number;
}): StrategyGate {
  return {
    name: "hard_risk_off",
    test(context) {
      const regime = getRegimeValue(context, params);
      const momentum = getMomentum(context.candles, context.index, params.momentumLookback);

      return regime === "trend_down" && momentum !== null && momentum < 0;
    }
  };
}

function createVolatilityKillGate(params: {
  volatilityWindow: number;
  maxHistoricalVolatility: number;
}): StrategyGate {
  return {
    name: "volatility_kill_switch",
    test(context) {
      const historicalVolatility = getHistoricalVolatility(
        context.candles,
        context.index,
        params.volatilityWindow
      );

      return (
        historicalVolatility !== null &&
        historicalVolatility >= params.maxHistoricalVolatility * 1.6
      );
    }
  };
}

export function createIntegratedMultiFactorStrategy(params?: {
  regimeWeight?: number;
  trendWeight?: number;
  momentumWeight?: number;
  timingWeight?: number;
  participationWeight?: number;
  riskWeight?: number;
  breadthWeight?: number;
  relativeStrengthWeight?: number;
  trendWindow?: number;
  momentumLookback?: number;
  macdFastWindow?: number;
  macdSlowWindow?: number;
  macdSignalWindow?: number;
  adxPeriod?: number;
  minAdx?: number;
  rsiPeriod?: number;
  entryRsi?: number;
  exitRsi?: number;
  zScoreWindow?: number;
  entryZScore?: number;
  exitZScore?: number;
  bollingerWindow?: number;
  bollingerMultiplier?: number;
  entryPercentB?: number;
  exitPercentB?: number;
  volumeWindow?: number;
  minVolumeSpike?: number;
  obvLookback?: number;
  volatilityWindow?: number;
  maxHistoricalVolatility?: number;
  atrPeriod?: number;
  maxAtrRatio?: number;
  regimeTrendWindow?: number;
  regimeMomentumLookback?: number;
  regimeVolatilityWindow?: number;
  regimeVolatilityThreshold?: number;
  minBreadthScore?: number;
  minMomentumPercentile?: number;
  minBreadthSampleSize?: number;
  entryThreshold?: number;
  exitThreshold?: number;
  entryMinFactors?: number;
  exitMinFactors?: number;
  stopLossPct?: number;
  maxHoldBars?: number;
}): Strategy {
  const regimeWeight = params?.regimeWeight ?? 1.1;
  const trendWeight = params?.trendWeight ?? 1.25;
  const momentumWeight = params?.momentumWeight ?? 1;
  const timingWeight = params?.timingWeight ?? 1.35;
  const participationWeight = params?.participationWeight ?? 0.9;
  const riskWeight = params?.riskWeight ?? 0.85;
  const breadthWeight = params?.breadthWeight ?? 1;
  const relativeStrengthWeight = params?.relativeStrengthWeight ?? 1.1;
  const trendWindow = params?.trendWindow ?? 55;
  const momentumLookback = params?.momentumLookback ?? 20;
  const macdFastWindow = params?.macdFastWindow ?? 12;
  const macdSlowWindow = params?.macdSlowWindow ?? 26;
  const macdSignalWindow = params?.macdSignalWindow ?? 9;
  const adxPeriod = params?.adxPeriod ?? 14;
  const minAdx = params?.minAdx ?? 20;
  const rsiPeriod = params?.rsiPeriod ?? 14;
  const entryRsi = params?.entryRsi ?? 40;
  const exitRsi = params?.exitRsi ?? 58;
  const zScoreWindow = params?.zScoreWindow ?? 20;
  const entryZScore = params?.entryZScore ?? -1.4;
  const exitZScore = params?.exitZScore ?? 0.4;
  const bollingerWindow = params?.bollingerWindow ?? 20;
  const bollingerMultiplier = params?.bollingerMultiplier ?? 2;
  const entryPercentB = params?.entryPercentB ?? 0.35;
  const exitPercentB = params?.exitPercentB ?? 0.7;
  const volumeWindow = params?.volumeWindow ?? 20;
  const minVolumeSpike = params?.minVolumeSpike ?? 1.05;
  const obvLookback = params?.obvLookback ?? 10;
  const volatilityWindow = params?.volatilityWindow ?? 20;
  const maxHistoricalVolatility = params?.maxHistoricalVolatility ?? 0.03;
  const atrPeriod = params?.atrPeriod ?? 14;
  const maxAtrRatio = params?.maxAtrRatio ?? 0.025;
  const regimeTrendWindow = params?.regimeTrendWindow ?? 55;
  const regimeMomentumLookback = params?.regimeMomentumLookback ?? 20;
  const regimeVolatilityWindow = params?.regimeVolatilityWindow ?? 20;
  const regimeVolatilityThreshold = params?.regimeVolatilityThreshold ?? 0.035;
  const minBreadthScore = params?.minBreadthScore ?? -0.05;
  const minMomentumPercentile = params?.minMomentumPercentile ?? 0.55;
  const minBreadthSampleSize = params?.minBreadthSampleSize ?? 4;
  const entryThreshold = params?.entryThreshold ?? 0.35;
  const exitThreshold = params?.exitThreshold ?? 0.3;
  const entryMinFactors = params?.entryMinFactors ?? 4;
  const exitMinFactors = params?.exitMinFactors ?? 2;
  const stopLossPct = params?.stopLossPct ?? 0.025;
  const maxHoldBars = params?.maxHoldBars ?? 36;

  return createWeightedScoreStrategy({
    name: "integrated-multi-factor",
    parameters: {
      regimeWeight,
      trendWeight,
      momentumWeight,
      timingWeight,
      participationWeight,
      riskWeight,
      breadthWeight,
      relativeStrengthWeight,
      trendWindow,
      momentumLookback,
      macdFastWindow,
      macdSlowWindow,
      macdSignalWindow,
      adxPeriod,
      minAdx,
      rsiPeriod,
      entryRsi,
      exitRsi,
      zScoreWindow,
      entryZScore,
      exitZScore,
      bollingerWindow,
      bollingerMultiplier,
      entryPercentB,
      exitPercentB,
      volumeWindow,
      minVolumeSpike,
      obvLookback,
      volatilityWindow,
      maxHistoricalVolatility,
      atrPeriod,
      maxAtrRatio,
      regimeTrendWindow,
      regimeMomentumLookback,
      regimeVolatilityWindow,
      regimeVolatilityThreshold,
      minBreadthScore,
      minMomentumPercentile,
      minBreadthSampleSize,
      entryThreshold,
      exitThreshold,
      entryMinFactors,
      exitMinFactors,
      stopLossPct,
      maxHoldBars
    },
    contextConfig: {
      trendWindow,
      momentumLookback,
      volumeWindow,
      zScoreWindow,
      volatilityWindow
    },
    entryFactors: [
      createEntryRegimeFactor({
        regimeTrendWindow,
        regimeMomentumLookback,
        regimeVolatilityWindow,
        regimeVolatilityThreshold,
        regimeWeight
      }),
      createTrendAlignmentFactor({
        trendWindow,
        adxPeriod,
        minAdx,
        trendWeight
      }),
      createMomentumContinuationFactor({
        trendWindow,
        momentumLookback,
        macdFastWindow,
        macdSlowWindow,
        macdSignalWindow,
        momentumWeight
      }),
      createPullbackTimingFactor({
        zScoreWindow,
        entryZScore,
        rsiPeriod,
        entryRsi,
        bollingerWindow,
        bollingerMultiplier,
        entryPercentB,
        timingWeight
      }),
      createParticipationFactor({
        volumeWindow,
        minVolumeSpike,
        obvLookback,
        participationWeight
      }),
      createMarketBreadthFactor({
        breadthWeight
      }),
      createRelativeStrengthFactor({
        relativeStrengthWeight,
        minMomentumPercentile
      }),
      createVolatilityEfficiencyFactor({
        volatilityWindow,
        maxHistoricalVolatility,
        atrPeriod,
        maxAtrRatio,
        riskWeight
      })
    ],
    exitFactors: [
      createRecoveryExitFactor({
        zScoreWindow,
        exitZScore,
        rsiPeriod,
        exitRsi,
        bollingerWindow,
        bollingerMultiplier,
        exitPercentB,
        timingWeight
      }),
      createTrendBreakdownExitFactor({
        trendWindow,
        momentumLookback,
        macdFastWindow,
        macdSlowWindow,
        macdSignalWindow,
        trendWeight,
        momentumWeight
      }),
      createVolatilityStressExitFactor({
        volatilityWindow,
        maxHistoricalVolatility,
        atrPeriod,
        maxAtrRatio,
        regimeTrendWindow,
        regimeMomentumLookback,
        regimeVolatilityWindow,
        regimeVolatilityThreshold,
        riskWeight
      }),
      createParticipationFailureExitFactor({
        volumeWindow,
        obvLookback,
        participationWeight
      }),
      createMarketDeteriorationExitFactor({
        breadthWeight,
        relativeStrengthWeight
      })
    ],
    filterRules: [
      createAllowedRegimeGate({
        regimeTrendWindow,
        regimeMomentumLookback,
        regimeVolatilityWindow,
        regimeVolatilityThreshold
      }),
      createTrendBiasGate({
        trendWindow
      }),
      createBreadthSupportGate({
        minBreadthScore,
        minBreadthSampleSize
      })
    ],
    riskExitRules: [
      createHardRiskOffGate({
        regimeTrendWindow,
        regimeMomentumLookback,
        regimeVolatilityWindow,
        regimeVolatilityThreshold,
        momentumLookback
      }),
      createVolatilityKillGate({
        volatilityWindow,
        maxHistoricalVolatility
      })
    ],
    entryThreshold,
    exitThreshold,
    entryMinFactors,
    exitMinFactors,
    stopLossPct,
    maxHoldBars
  });
}
