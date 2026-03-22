import test from "node:test";
import assert from "node:assert/strict";
import { createBollingerMeanReversionStrategy } from "../../strategies/src/bollinger-mean-reversion.js";

function buildMarketState(regime: "trend_up" | "trend_down" | "range" | "volatile" | "unknown") {
  return {
    referenceTime: new Date("2024-01-03T00:00:00.000Z"),
    sampleSize: 12,
    breadth: {
      sampleSize: 12,
      advancingRatio: 0.5,
      aboveTrendRatio: 0.5,
      positiveMomentumRatio: 0.5,
      averageMomentum: 0,
      averageZScore: -0.1,
      averageVolumeSpike: 1,
      averageHistoricalVolatility: 0.03,
      dispersionScore: 0.1,
      liquidityScore: 0.2,
      compositeTrendScore: regime === "trend_down" ? -0.2 : 0.1,
      riskOnScore: regime === "trend_down" ? -0.1 : 0.1
    },
    composite: {
      source: "universe_composite" as const,
      marketCode: "__COMPOSITE__",
      averageChange: regime === "trend_down" ? -0.01 : 0.005,
      momentum: regime === "trend_down" ? -0.02 : 0.01,
      aboveTrend: regime === "trend_down" ? false : true,
      aboveTrendRatio: regime === "trend_down" ? 0.25 : 0.65,
      historicalVolatility: 0.03,
      trendScore: regime === "trend_down" ? -0.25 : 0.15,
      liquidityScore: 0.2,
      dispersionScore: 0.1,
      regime
    },
    benchmark: {
      source: "universe_composite" as const,
      marketCode: "KRW-BTC",
      averageChange: regime === "trend_down" ? -0.008 : 0.006,
      momentum: regime === "trend_down" ? -0.018 : 0.015,
      aboveTrend: regime === "trend_down" ? false : true,
      aboveTrendRatio: regime === "trend_down" ? 0.3 : 0.68,
      historicalVolatility: 0.028,
      trendScore: regime === "trend_down" ? -0.22 : 0.18,
      liquidityScore: 0.24,
      dispersionScore: 0.08,
      regime,
      anchors: {
        intraday: {
          timeframe: "intraday" as const,
          sampleSize: 12,
          averageChange: regime === "trend_down" ? -0.008 : 0.006,
          momentum: regime === "trend_down" ? -0.018 : 0.015,
          aboveTrend: regime === "trend_down" ? false : true,
          aboveTrendRatio: regime === "trend_down" ? 0.3 : 0.68,
          historicalVolatility: 0.028,
          trendScore: regime === "trend_down" ? -0.22 : 0.18,
          liquidityScore: 0.24,
          dispersionScore: 0.08,
          regime
        },
        daily: {
          timeframe: "1d" as const,
          sampleSize: 30,
          averageChange: regime === "trend_down" ? -0.006 : 0.007,
          momentum: regime === "trend_down" ? -0.02 : 0.018,
          aboveTrend: regime === "trend_down" ? false : true,
          aboveTrendRatio: regime === "trend_down" ? 0.28 : 0.72,
          historicalVolatility: 0.025,
          trendScore: regime === "trend_down" ? -0.25 : 0.22,
          liquidityScore: 0.25,
          dispersionScore: 0.07,
          regime
        },
        weekly: {
          timeframe: "1w" as const,
          sampleSize: 16,
          averageChange: regime === "trend_down" ? -0.004 : 0.008,
          momentum: regime === "trend_down" ? -0.018 : 0.02,
          aboveTrend: regime === "trend_down" ? false : true,
          aboveTrendRatio: regime === "trend_down" ? 0.25 : 0.75,
          historicalVolatility: 0.023,
          trendScore: regime === "trend_down" ? -0.24 : 0.24,
          liquidityScore: 0.24,
          dispersionScore: 0.06,
          regime
        }
      }
    },
    relativeStrength: {
      momentumSpread: regime === "trend_down" ? -0.015 : -0.002,
      zScoreSpread: -0.1,
      volumeSpikeSpread: -0.05,
      benchmarkMomentumSpread: regime === "trend_down" ? -0.02 : -0.006,
      momentumPercentile: regime === "trend_down" ? 0.28 : 0.55,
      cohortMomentumSpread: regime === "trend_down" ? -0.016 : -0.003,
      cohortZScoreSpread: -0.08,
      cohortVolumeSpikeSpread: -0.04,
      compositeMomentumSpread: regime === "trend_down" ? -0.014 : -0.002,
      compositeChangeSpread: regime === "trend_down" ? -0.008 : -0.001,
      liquiditySpread: 0.02,
      returnPercentile: regime === "trend_down" ? 0.25 : 0.52
    }
  };
}

function buildEntryCandidateCandles() {
  return Array.from({ length: 80 }, (_, index) => {
    let close = 100;
    if (index < 60) {
      close = 100 + Math.sin(index / 3) * 4;
    } else if (index < 79) {
      close = 100 + Math.sin(index / 2) * 6;
    } else {
      close = 94;
    }

    return {
      marketCode: "KRW-BTC",
      timeframe: "1h",
      candleTimeUtc: new Date(Date.UTC(2024, 0, 1, index, 0, 0)),
      openPrice: close,
      highPrice: close * 1.01,
      lowPrice: close * 0.99,
      closePrice: close,
      volume: 1
    };
  });
}

function buildSoftExitCandles() {
  const closes = [
    ...Array.from({ length: 14 }, () => 100),
    98,
    95,
    92,
    90,
    93,
    96,
    95
  ];
  const volumes = [
    ...Array.from({ length: 14 }, () => 1),
    3,
    4,
    5,
    6,
    4,
    3,
    0.8
  ];

  return closes.map((close, index) => {
    const isLast = index === closes.length - 1;
    const openPrice = isLast ? 96.4 : close;
    const highPrice = isLast ? 98 : close * 1.01;
    const lowPrice = isLast ? 94.5 : close * 0.99;

    return {
      marketCode: "KRW-BTC",
      timeframe: "1h" as const,
      candleTimeUtc: new Date(Date.UTC(2024, 0, 1, index, 0, 0)),
      openPrice,
      highPrice,
      lowPrice,
      closePrice: close,
      volume: volumes[index]!
    };
  });
}

test("bollinger mean reversion does not require RSI confirmation by default", () => {
  const candles = buildEntryCandidateCandles();
  const index = candles.length - 1;

  const permissiveStrategy = createBollingerMeanReversionStrategy({
    bbWindow: 20,
    bbMultiplier: 2,
    rsiPeriod: 14,
    entryPercentB: 0.2,
    entryRsiThreshold: 34
  });
  const strictStrategy = createBollingerMeanReversionStrategy({
    bbWindow: 20,
    bbMultiplier: 2,
    rsiPeriod: 14,
    entryPercentB: 0.2,
    entryRsiThreshold: 34,
    requireRsiConfirmation: true
  });

  const permissiveSignal = permissiveStrategy.generateSignal({
    candles,
    index,
    hasPosition: false
  });
  const strictSignal = strictStrategy.generateSignal({
    candles,
    index,
    hasPosition: false
  });

  assert.equal(permissiveSignal.signal, "BUY");
  assert.equal(permissiveSignal.metadata?.reason, "bb_lower_band_touch");
  assert.equal(strictSignal.signal, "HOLD");
  assert.equal(strictSignal.metadata?.reason, "rsi_not_oversold");
});

test("bollinger mean reversion exposes expanded parameter set in metadata", () => {
  const strategy = createBollingerMeanReversionStrategy({
    entryRsiThreshold: 31,
    reclaimLookbackBars: 6,
    reclaimPercentBThreshold: 0.18,
    reclaimMinCloseBouncePct: 0.007,
    reclaimBandWidthFactor: 0.12,
    deepTouchEntryPercentB: -0.14,
    deepTouchRsiThreshold: 21,
    minBandWidth: 0.03,
    trendUpExitRsiOffset: 12,
    trendDownExitRsiOffset: -9,
    rangeExitRsiOffset: -4,
    trendUpExitBandFraction: 0.42,
    trendDownExitBandFraction: 0.22,
    volatileExitBandFraction: 0.5,
    profitTakePnlThreshold: 0.07,
    profitTakeBandWidthFactor: 0.8,
    trendDownProfitTargetScale: 0.58,
    volatileProfitTargetScale: 0.76,
    profitTakeRsiFraction: 0.9,
    entryBenchmarkLeadWeight: 0.22,
    entryBenchmarkLeadMinScore: 0.48,
    softExitScoreThreshold: 0.57,
    softExitMinPnl: 0.018,
    softExitMinBandFraction: 0.34,
    exitVolumeFadeWeight: 0.19,
    exitReversalWeight: 0.31,
    exitMomentumDecayWeight: 0.21,
    exitBenchmarkWeaknessWeight: 0.11,
    exitRelativeFragilityWeight: 0.17,
    exitTimeDecayWeight: 0.18
  });

  assert.equal(strategy.parameters.entryRsiThreshold, 31);
  assert.equal(strategy.parameters.reclaimLookbackBars, 6);
  assert.equal(strategy.parameters.reclaimPercentBThreshold, 0.18);
  assert.equal(strategy.parameters.reclaimMinCloseBouncePct, 0.007);
  assert.equal(strategy.parameters.reclaimBandWidthFactor, 0.12);
  assert.equal(strategy.parameters.deepTouchEntryPercentB, -0.14);
  assert.equal(strategy.parameters.deepTouchRsiThreshold, 21);
  assert.equal(strategy.parameters.minBandWidth, 0.03);
  assert.equal(strategy.parameters.trendUpExitRsiOffset, 12);
  assert.equal(strategy.parameters.trendDownExitRsiOffset, -9);
  assert.equal(strategy.parameters.rangeExitRsiOffset, -4);
  assert.equal(strategy.parameters.trendUpExitBandFraction, 0.42);
  assert.equal(strategy.parameters.trendDownExitBandFraction, 0.22);
  assert.equal(strategy.parameters.volatileExitBandFraction, 0.5);
  assert.equal(strategy.parameters.profitTakePnlThreshold, 0.07);
  assert.equal(strategy.parameters.profitTakeBandWidthFactor, 0.8);
  assert.equal(strategy.parameters.trendDownProfitTargetScale, 0.58);
  assert.equal(strategy.parameters.volatileProfitTargetScale, 0.76);
  assert.equal(strategy.parameters.profitTakeRsiFraction, 0.9);
  assert.equal(strategy.parameters.entryBenchmarkLeadWeight, 0.22);
  assert.equal(strategy.parameters.entryBenchmarkLeadMinScore, 0.48);
  assert.equal(strategy.parameters.softExitScoreThreshold, 0.57);
  assert.equal(strategy.parameters.softExitMinPnl, 0.018);
  assert.equal(strategy.parameters.softExitMinBandFraction, 0.34);
  assert.equal(strategy.parameters.exitVolumeFadeWeight, 0.19);
  assert.equal(strategy.parameters.exitReversalWeight, 0.31);
  assert.equal(strategy.parameters.exitMomentumDecayWeight, 0.21);
  assert.equal(strategy.parameters.exitBenchmarkWeaknessWeight, 0.11);
  assert.equal(strategy.parameters.exitRelativeFragilityWeight, 0.17);
  assert.equal(strategy.parameters.exitTimeDecayWeight, 0.18);
  assert.equal(strategy.parameterCount, Object.keys(strategy.parameters).length);
});

test("bollinger mean reversion can require reclaim confirmation before buying", () => {
  const closes = [
    ...Array.from({ length: 20 }, () => 100),
    92, 97
  ];
  const candles = closes.map((close, index) => ({
    marketCode: "KRW-BTC",
    timeframe: "1h" as const,
    candleTimeUtc: new Date(Date.UTC(2024, 0, 1, index, 0, 0)),
    openPrice: close,
    highPrice: close * 1.01,
    lowPrice: close * 0.99,
    closePrice: close,
    volume: 1
  }));
  const index = candles.length - 1;

  const reclaimStrategy = createBollingerMeanReversionStrategy({
    bbWindow: 20,
    bbMultiplier: 2,
    rsiPeriod: 14,
    entryPercentB: 0.1,
    requireReclaimConfirmation: true,
    reclaimLookbackBars: 3,
    reclaimPercentBThreshold: 0.15,
    reclaimMinCloseBouncePct: 0.01
  });
  const noReclaimStrategy = createBollingerMeanReversionStrategy({
    bbWindow: 20,
    bbMultiplier: 2,
    rsiPeriod: 14,
    entryPercentB: 0.1,
    requireReclaimConfirmation: false
  });

  const reclaimSignal = reclaimStrategy.generateSignal({
    candles,
    index,
    hasPosition: false
  });
  const noReclaimSignal = noReclaimStrategy.generateSignal({
    candles,
    index,
    hasPosition: false
  });

  assert.equal(reclaimSignal.signal, "BUY");
  assert.equal(reclaimSignal.metadata?.reason, "bb_lower_band_touch");
  assert.equal(noReclaimSignal.signal, "HOLD");
  assert.equal(noReclaimSignal.metadata?.reason, "price_above_bb_lower");
});

test("bollinger mean reversion can buy immediately on an extreme deep touch even when reclaim is required", () => {
  const closes = [
    ...Array.from({ length: 20 }, () => 100),
    83
  ];
  const candles = closes.map((close, index) => ({
    marketCode: "KRW-BTC",
    timeframe: "1h" as const,
    candleTimeUtc: new Date(Date.UTC(2024, 0, 1, index, 0, 0)),
    openPrice: close,
    highPrice: close * 1.01,
    lowPrice: close * 0.99,
    closePrice: close,
    volume: 1
  }));
  const index = candles.length - 1;

  const strategy = createBollingerMeanReversionStrategy({
    bbWindow: 20,
    bbMultiplier: 2,
    rsiPeriod: 14,
    entryPercentB: 0.02,
    requireReclaimConfirmation: true,
    reclaimLookbackBars: 4,
    reclaimPercentBThreshold: 0.2,
    reclaimMinCloseBouncePct: 0.01,
    deepTouchEntryPercentB: -0.08,
    deepTouchRsiThreshold: 28,
    minBandWidth: 0.01
  });

  const signal = strategy.generateSignal({
    candles,
    index,
    hasPosition: false
  });

  assert.equal(signal.signal, "BUY");
  assert.equal(signal.metadata?.reason, "bb_deep_touch_entry");
});

test("bollinger mean reversion can scale reclaim confirmation by band width", () => {
  const closes = [
    ...Array.from({ length: 20 }, () => 100),
    88,
    90.4
  ];
  const candles = closes.map((close, index) => ({
    marketCode: "KRW-BTC",
    timeframe: "1h" as const,
    candleTimeUtc: new Date(Date.UTC(2024, 0, 1, index, 0, 0)),
    openPrice: close,
    highPrice: close * 1.01,
    lowPrice: close * 0.99,
    closePrice: close,
    volume: 1
  }));
  const index = candles.length - 1;

  const looserStrategy = createBollingerMeanReversionStrategy({
    bbWindow: 20,
    bbMultiplier: 2,
    rsiPeriod: 14,
    entryPercentB: 0.1,
    requireReclaimConfirmation: true,
    reclaimLookbackBars: 3,
    reclaimPercentBThreshold: -0.2,
    reclaimMinCloseBouncePct: 0.001,
    reclaimBandWidthFactor: 0.08,
    deepTouchEntryPercentB: -0.3,
    deepTouchRsiThreshold: 5
  });
  const tighterStrategy = createBollingerMeanReversionStrategy({
    bbWindow: 20,
    bbMultiplier: 2,
    rsiPeriod: 14,
    entryPercentB: 0.1,
    requireReclaimConfirmation: true,
    reclaimLookbackBars: 3,
    reclaimPercentBThreshold: -0.2,
    reclaimMinCloseBouncePct: 0.001,
    reclaimBandWidthFactor: 0.35,
    deepTouchEntryPercentB: -0.3,
    deepTouchRsiThreshold: 5
  });

  const looserSignal = looserStrategy.generateSignal({
    candles,
    index,
    hasPosition: false
  });
  const tighterSignal = tighterStrategy.generateSignal({
    candles,
    index,
    hasPosition: false
  });

  assert.equal(looserSignal.signal, "BUY");
  assert.equal(looserSignal.metadata?.reason, "bb_lower_band_touch");
  assert.equal(tighterSignal.signal, "HOLD");
  assert.equal(tighterSignal.metadata?.reason, "bb_reclaim_not_confirmed");
});

test("bollinger mean reversion can require a bullish BTC lead score before entering", () => {
  const candles = buildEntryCandidateCandles();
  const index = candles.length - 1;
  const strategy = createBollingerMeanReversionStrategy({
    bbWindow: 20,
    bbMultiplier: 2,
    rsiPeriod: 14,
    entryPercentB: 0.2,
    entryBenchmarkLeadWeight: 0.25,
    entryBenchmarkLeadMinScore: 0.55
  });

  const bullishSignal = strategy.generateSignal({
    candles,
    index,
    hasPosition: false,
    marketState: buildMarketState("trend_up")
  });
  const weakSignal = strategy.generateSignal({
    candles,
    index,
    hasPosition: false,
    marketState: buildMarketState("trend_down")
  });

  assert.equal(bullishSignal.signal, "BUY");
  assert.equal(bullishSignal.metadata?.reason, "bb_lower_band_touch");
  assert.ok((bullishSignal.metadata?.metrics?.benchmarkLeadScore ?? 0) > 0.55);
  assert.equal(weakSignal.signal, "HOLD");
  assert.equal(weakSignal.metadata?.reason, "benchmark_lead_not_supportive");
});

test("bollinger mean reversion scales profit taking target by band width", () => {
  const closes = [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 98, 96, 95, 97];
  const candles = closes.map((close, index) => ({
    marketCode: "KRW-BTC",
    timeframe: "1h" as const,
    candleTimeUtc: new Date(Date.UTC(2024, 0, 1, index, 0, 0)),
    openPrice: close,
    highPrice: close * 1.01,
    lowPrice: close * 0.99,
    closePrice: close,
    volume: 1
  }));
  const index = candles.length - 1;
  const position = {
    entryPrice: 95,
    barsHeld: 5,
    quantity: 1,
    marketCode: "KRW-BTC",
    entryTime: candles[0]!.candleTimeUtc
  };

  const lowerTargetStrategy = createBollingerMeanReversionStrategy({
    bbWindow: 20,
    bbMultiplier: 2,
    rsiPeriod: 14,
    exitRsi: 50,
    stopLossPct: 0.3,
    maxHoldBars: 200,
    profitTakePnlThreshold: 0.005,
    profitTakeBandWidthFactor: 0.3,
    profitTakeRsiFraction: 0.5
  });
  const higherTargetStrategy = createBollingerMeanReversionStrategy({
    bbWindow: 20,
    bbMultiplier: 2,
    rsiPeriod: 14,
    exitRsi: 50,
    stopLossPct: 0.3,
    maxHoldBars: 200,
    profitTakePnlThreshold: 0.005,
    profitTakeBandWidthFactor: 0.6,
    profitTakeRsiFraction: 0.5
  });

  const lowerTargetSignal = lowerTargetStrategy.generateSignal({
    candles,
    index,
    hasPosition: true,
    currentPosition: position
  });
  const higherTargetSignal = higherTargetStrategy.generateSignal({
    candles,
    index,
    hasPosition: true,
    currentPosition: position
  });

  assert.equal(lowerTargetSignal.signal, "SELL");
  assert.equal(lowerTargetSignal.metadata?.reason, "profit_taking_partial_reversion");
  assert.equal(higherTargetSignal.signal, "HOLD");
  assert.equal(higherTargetSignal.metadata?.reason, "waiting_for_reversion");
  assert.ok(
    (lowerTargetSignal.metadata?.metrics?.widthScaledProfitTarget ?? 0) > 0.018 &&
      (lowerTargetSignal.metadata?.metrics?.widthScaledProfitTarget ?? 0) < 0.019,
    "width-scaled target should reflect normalized Bollinger width"
  );
});

test("bollinger mean reversion can use soft exit scoring to exit a fading rebound earlier", () => {
  const candles = buildSoftExitCandles();
  const index = candles.length - 1;
  const position = {
    entryPrice: 92,
    barsHeld: 90,
    quantity: 1,
    marketCode: "KRW-BTC",
    entryTime: candles[0]!.candleTimeUtc
  };

  const softExitStrategy = createBollingerMeanReversionStrategy({
    bbWindow: 20,
    bbMultiplier: 2,
    rsiPeriod: 14,
    exitRsi: 85,
    stopLossPct: 0.3,
    maxHoldBars: 200,
    trendUpExitBandFraction: 0.8,
    profitTakePnlThreshold: 0.2,
    profitTakeBandWidthFactor: 2,
    profitTakeRsiFraction: 1,
    softExitScoreThreshold: 0.5,
    softExitMinPnl: 0.02,
    softExitMinBandFraction: 0.2,
    exitVolumeFadeWeight: 0.35,
    exitReversalWeight: 0.4,
    exitMomentumDecayWeight: 0,
    exitBenchmarkWeaknessWeight: 0,
    exitTimeDecayWeight: 0.25
  });
  const strictStrategy = createBollingerMeanReversionStrategy({
    bbWindow: 20,
    bbMultiplier: 2,
    rsiPeriod: 14,
    exitRsi: 85,
    stopLossPct: 0.3,
    maxHoldBars: 200,
    trendUpExitBandFraction: 0.8,
    profitTakePnlThreshold: 0.2,
    profitTakeBandWidthFactor: 2,
    profitTakeRsiFraction: 1,
    softExitScoreThreshold: 0.95,
    softExitMinPnl: 0.02,
    softExitMinBandFraction: 0.2,
    exitVolumeFadeWeight: 0.35,
    exitReversalWeight: 0.4,
    exitMomentumDecayWeight: 0,
    exitBenchmarkWeaknessWeight: 0,
    exitTimeDecayWeight: 0.25
  });

  const softExitSignal = softExitStrategy.generateSignal({
    candles,
    index,
    hasPosition: true,
    currentPosition: position,
    marketState: buildMarketState("trend_up")
  });
  const strictSignal = strictStrategy.generateSignal({
    candles,
    index,
    hasPosition: true,
    currentPosition: position,
    marketState: buildMarketState("trend_up")
  });

  assert.equal(softExitSignal.signal, "SELL");
  assert.equal(softExitSignal.metadata?.reason, "soft_exit_score_reached");
  assert.ok((softExitSignal.metadata?.metrics?.softExitScore ?? 0) >= 0.5);
  assert.equal(strictSignal.signal, "HOLD");
  assert.equal(strictSignal.metadata?.reason, "waiting_for_reversion");
});

test("bollinger mean reversion takes smaller dead-cat exits in trend_down regimes", () => {
  const closes = [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 98, 96, 95, 97];
  const candles = closes.map((close, index) => ({
    marketCode: "KRW-BTC",
    timeframe: "1h" as const,
    candleTimeUtc: new Date(Date.UTC(2024, 0, 1, index, 0, 0)),
    openPrice: close,
    highPrice: close * 1.01,
    lowPrice: close * 0.99,
    closePrice: close,
    volume: 1
  }));
  const index = candles.length - 1;
  const position = {
    entryPrice: 95,
    barsHeld: 5,
    quantity: 1,
    marketCode: "KRW-BTC",
    entryTime: candles[0]!.candleTimeUtc
  };
  const strategy = createBollingerMeanReversionStrategy({
    bbWindow: 20,
    bbMultiplier: 2,
    rsiPeriod: 14,
    exitRsi: 70,
    stopLossPct: 0.3,
    maxHoldBars: 200,
    trendDownExitBandFraction: 0.2,
    profitTakePnlThreshold: 0.2,
    profitTakeBandWidthFactor: 1,
    trendDownProfitTargetScale: 1,
    profitTakeRsiFraction: 1
  });

  const neutralSignal = strategy.generateSignal({
    candles,
    index,
    hasPosition: true,
    currentPosition: position,
    marketState: buildMarketState("range")
  });
  const downtrendSignal = strategy.generateSignal({
    candles,
    index,
    hasPosition: true,
    currentPosition: position,
    marketState: buildMarketState("trend_down")
  });

  assert.equal(neutralSignal.signal, "HOLD");
  assert.equal(neutralSignal.metadata?.reason, "waiting_for_reversion");
  assert.equal(downtrendSignal.signal, "SELL");
  assert.equal(downtrendSignal.metadata?.reason, "bb_dead_cat_bounce_target_reached");
});
