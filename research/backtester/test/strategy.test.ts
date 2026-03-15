import test from "node:test";
import assert from "node:assert/strict";
import { createLeaderPullbackStateMachineStrategy } from "../../strategies/src/leader-pullback-state-machine.js";
import { createRelativeBreakoutRotationStrategy } from "../../strategies/src/relative-breakout-rotation.js";
import { createRelativeMomentumPullbackStrategy } from "../../strategies/src/relative-momentum-pullback.js";
import { createHourlyCandles } from "./test-helpers.js";

function buildTrendPullbackCandles() {
  const closes = [
    ...Array.from({ length: 50 }, (_, index) => 100 + index),
    146, 142, 138, 134, 130, 145, 147, 149
  ];

  return createHourlyCandles({
    marketCode: "KRW-A",
    closes
  });
}

function buildWindowReclaimCandles() {
  const closes = [
    ...Array.from({ length: 50 }, (_, index) => 100 + index),
    146, 142, 138, 141, 145, 147, 149
  ];

  return createHourlyCandles({
    marketCode: "KRW-A",
    closes
  });
}

function buildFailedReclaimCandles() {
  const closes = [
    ...Array.from({ length: 50 }, (_, index) => 100 + index),
    146, 142, 138, 141, 145, 143, 141, 140
  ];

  return createHourlyCandles({
    marketCode: "KRW-A",
    closes
  });
}

function buildLeaderSetupCandles() {
  const closes = [
    ...Array.from({ length: 50 }, (_, index) => 100 + index),
    143, 139, 135, 137, 139, 140
  ];

  return createHourlyCandles({
    marketCode: "KRW-A",
    closes
  });
}

function buildBreakoutCandles() {
  const closes = [
    ...Array.from({ length: 30 }, (_, index) => 100 + index * 0.7),
    ...Array.from(
      { length: 20 },
      (_, index) => 123.8 + (index % 4 === 0 ? 0.7 : index % 4 === 1 ? -0.5 : index % 4 === 2 ? 0.5 : -0.3)
    ),
    123.9, 123.1, 124.0, 123.2, 124.1, 123.3, 124.2, 123.4, 124.3, 124.45
  ];

  return createHourlyCandles({
    marketCode: "KRW-A",
    closes
  });
}

function strongMarketState() {
  return {
    referenceTime: new Date("2024-01-03T00:00:00.000Z"),
    sampleSize: 12,
    breadth: {
      sampleSize: 12,
      advancingRatio: 0.75,
      aboveTrendRatio: 0.75,
      positiveMomentumRatio: 0.75,
      averageMomentum: 0.03,
      averageZScore: -0.2,
      averageVolumeSpike: 1.1,
      averageHistoricalVolatility: 0.02,
      dispersionScore: 0.15,
      liquidityScore: 0.2,
      compositeTrendScore: 0.35,
      riskOnScore: 0.3
    },
    relativeStrength: {
      momentumSpread: 0.03,
      zScoreSpread: -0.1,
      volumeSpikeSpread: 0.1,
      benchmarkMomentumSpread: 0.02,
      momentumPercentile: 0.9,
      cohortMomentumSpread: 0.03,
      cohortZScoreSpread: -0.1,
      cohortVolumeSpikeSpread: 0.1,
      compositeMomentumSpread: 0.02,
      compositeChangeSpread: 0.01,
      liquiditySpread: 0.1,
      returnPercentile: 0.8
    },
    composite: {
      source: "universe_composite" as const,
      marketCode: "__COMPOSITE__",
      averageChange: 0.01,
      momentum: 0.02,
      aboveTrend: true,
      aboveTrendRatio: 0.75,
      historicalVolatility: 0.02,
      trendScore: 0.35,
      liquidityScore: 0.2,
      dispersionScore: 0.15,
      regime: "trend_up" as const
    }
  };
}

test("relative momentum pullback emits BUY with conviction on trend pullback recovery", () => {
  const candles = buildTrendPullbackCandles();
  const strategy = createRelativeMomentumPullbackStrategy();
  const result = strategy.generateSignal({
    candles,
    index: 55,
    hasPosition: false,
    marketState: strongMarketState()
  });

  assert.equal(result.signal, "BUY");
  assert.ok(result.conviction >= 0.55);
});

test("relative momentum pullback accepts reclaim when price recovers above EMA20 within a short window", () => {
  const candles = buildWindowReclaimCandles();
  const strategy = createRelativeMomentumPullbackStrategy({
    minStrengthPct: 0.7,
    minRiskOn: 0.05,
    pullbackZ: 0.6
  });
  const result = strategy.generateSignal({
    candles,
    index: 54,
    hasPosition: false,
    marketState: strongMarketState()
  });

  assert.equal(result.signal, "BUY");
  assert.ok(result.conviction >= 0.55);
});

test("relative momentum pullback emits SELL when held position loses regime support", () => {
  const candles = buildTrendPullbackCandles();
  const strategy = createRelativeMomentumPullbackStrategy();
  const weakState = strongMarketState();
  weakState.breadth.riskOnScore = -0.25;
  weakState.composite.trendScore = -0.2;

  const result = strategy.generateSignal({
    candles,
    index: 56,
    hasPosition: true,
    currentPosition: {
      entryPrice: 148,
      quantity: 1,
      barsHeld: 4
    },
    marketState: weakState
  });

  assert.equal(result.signal, "SELL");
  assert.ok(result.conviction >= 0.8);
});

test("relative momentum pullback exits failed reclaim trades before they turn into larger reversals", () => {
  const candles = buildFailedReclaimCandles();
  const strategy = createRelativeMomentumPullbackStrategy({
    minStrengthPct: 0.7,
    minRiskOn: 0.05,
    pullbackZ: 0.6,
    trailAtrMult: 1.8
  });

  const result = strategy.generateSignal({
    candles,
    index: 57,
    hasPosition: true,
    currentPosition: {
      entryPrice: 145,
      quantity: 1,
      barsHeld: 1
    },
    marketState: strongMarketState()
  });

  assert.equal(result.signal, "SELL");
  assert.ok(result.conviction >= 0.85);
});

test("leader pullback state machine emits BUY after a recent ATR pullback re-accelerates", () => {
  const candles = buildLeaderSetupCandles();
  const strategy = createLeaderPullbackStateMachineStrategy({
    strengthFloor: 0.6,
    pullbackAtr: 0.5,
    setupExpiryBars: 4,
    trailAtrMult: 2.2
  });

  const result = strategy.generateSignal({
    candles,
    index: 55,
    hasPosition: false,
    marketState: strongMarketState()
  });

  assert.equal(result.signal, "BUY");
  assert.ok(result.conviction >= 0.55);
});

test("leader pullback state machine exits failed reclaims quickly", () => {
  const candles = buildFailedReclaimCandles();
  const strategy = createLeaderPullbackStateMachineStrategy({
    strengthFloor: 0.6,
    pullbackAtr: 0.5,
    setupExpiryBars: 4,
    trailAtrMult: 1.8
  });

  const result = strategy.generateSignal({
    candles,
    index: 57,
    hasPosition: true,
    currentPosition: {
      entryPrice: 145,
      quantity: 1,
      barsHeld: 1
    },
    marketState: strongMarketState()
  });

  assert.equal(result.signal, "SELL");
  assert.ok(result.conviction >= 0.85);
});

test("relative breakout rotation emits BUY on leader breakout that is not overextended", () => {
  const candles = buildBreakoutCandles();
  const strategy = createRelativeBreakoutRotationStrategy({
    breakoutLookback: 10,
    strengthFloor: 0.6,
    maxExtensionAtr: 1.6,
    trailAtrMult: 2.2
  });

  const result = strategy.generateSignal({
    candles,
    index: candles.length - 1,
    hasPosition: false,
    marketState: strongMarketState()
  });

  assert.equal(result.signal, "BUY");
  assert.ok(result.conviction >= 0.55);
});

test("relative breakout rotation exits when trend leadership breaks", () => {
  const candles = buildFailedReclaimCandles();
  const strategy = createRelativeBreakoutRotationStrategy({
    breakoutLookback: 10,
    strengthFloor: 0.6,
    maxExtensionAtr: 1.6,
    trailAtrMult: 1.8
  });
  const weakState = strongMarketState();
  weakState.relativeStrength.momentumPercentile = 0.4;

  const result = strategy.generateSignal({
    candles,
    index: 57,
    hasPosition: true,
    currentPosition: {
      entryPrice: 145,
      quantity: 1,
      barsHeld: 4
    },
    marketState: weakState
  });

  assert.equal(result.signal, "SELL");
  assert.ok(result.conviction >= 0.8);
});
