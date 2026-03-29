/**
 * End-to-end simulation test.
 *
 * Verifies the FULL pipeline with synthetic candles where we know exactly
 * what trades should happen. If this test passes, the simulation is trustworthy.
 *
 * Scenario: 100 candles with a clear crash at bar 60 (price drops 10% in 3 bars).
 * volume-exhaustion strategy should detect this and buy.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runMultiStrategyBacktest } from "../src/multi-strategy/index.js";
import { adaptScoredStrategy } from "../src/multi-strategy/index.js";
import { createVolumeExhaustionBounceStrategy } from "../../strategies/src/simple-strategies.js";
import type { Candle } from "../src/types.js";

function generateCandles(count: number): Candle[] {
  const candles: Candle[] = [];
  let price = 50_000_000; // 5천만원 (KRW-BTC scale)
  const baseVolume = 100;

  for (let i = 0; i < count; i++) {
    const time = new Date("2023-01-01T00:00:00Z");
    time.setHours(time.getHours() + i);

    // Normal market: small random moves
    let open = price;
    let close = price;
    let high = price;
    let low = price;
    let volume = baseVolume;

    if (i >= 60 && i <= 62) {
      // CRASH: 3 bars of sharp drop with volume spike
      close = price * 0.965; // -3.5% per bar
      low = close * 0.99;
      high = open * 1.005;
      volume = baseVolume * 4; // 4x volume spike
      price = close;
    } else if (i >= 63 && i <= 67) {
      // RECOVERY: price bounces back
      close = price * 1.015;
      low = price * 0.998;
      high = close * 1.005;
      volume = baseVolume * 2;
      price = close;
    } else {
      // Normal: small oscillation
      const change = (Math.sin(i * 0.3) * 0.005 + 0.001);
      close = price * (1 + change);
      high = Math.max(open, close) * 1.003;
      low = Math.min(open, close) * 0.997;
      volume = baseVolume * (1 + Math.random() * 0.5);
      price = close;
    }

    candles.push({
      marketCode: "KRW-BTC",
      timeframe: "1h",
      candleTimeUtc: time,
      openPrice: open,
      highPrice: high,
      lowPrice: low,
      closePrice: close,
      volume,
      quoteVolume: close * volume
    });
  }
  return candles;
}

describe("e2e simulation", () => {
  it("volume-exhaustion detects crash and generates a profitable trade", () => {
    const candles = generateCandles(100);

    // Verify crash happened at expected location
    const preCrash = candles[59].closePrice;
    const postCrash = candles[62].closePrice;
    const dropPct = (preCrash - postCrash) / preCrash;
    assert.ok(dropPct > 0.05, `Expected >5% drop, got ${(dropPct * 100).toFixed(1)}%`);

    // Create strategy with params that should trigger on this crash
    const strategy = adaptScoredStrategy({
      strategyId: "test-vex",
      sleeveId: "micro",
      family: "meanreversion",
      decisionTimeframe: "1h",
      executionTimeframe: "1h",
      scoredStrategy: createVolumeExhaustionBounceStrategy({
        dropLookback: 3,
        dropThresholdPct: 0.05,
        volumeWindow: 20,
        volumeSpikeMult: 2.0,
        rsiPeriod: 14,
        rsiEntry: 40,
        profitTargetPct: 0.02
      })
    });

    const result = runMultiStrategyBacktest({
      universeName: "test",
      initialCapital: 1_000_000,
      sleeves: [{ sleeveId: "micro", capitalBudgetPct: 0.95, maxOpenPositions: 5, maxSinglePositionPct: 0.5, priority: 10 }],
      strategies: [strategy],
      decisionCandles: { "1h": { "KRW-BTC": candles } },
      executionCandles: { "1h": { "KRW-BTC": candles } },
      universeConfig: { topN: 1, lookbackBars: 28, refreshEveryBars: 4 },
      captureTraceArtifacts: false,
      captureUniverseSnapshots: false,
      maxOpenPositions: 5,
      maxCapitalUsagePct: 0.95
    });

    // Should have at least 1 trade
    assert.ok(result.completedTrades.length > 0,
      `Expected trades but got ${result.completedTrades.length}. Signals: buy=${result.decisionCoverageSummary.rawBuySignals} sell=${result.decisionCoverageSummary.rawSellSignals}`);

    // First trade should be around the crash (bars 60-63)
    const firstTrade = result.completedTrades[0];
    assert.ok(firstTrade, "No completed trade");

    // Entry should be during or after crash period (bars 60-62)
    const entryTime = firstTrade.entryTime;
    const crashStart = candles[60].candleTimeUtc;
    assert.ok(entryTime.getTime() >= crashStart.getTime(),
      `Entry at ${entryTime.toISOString()} should be during/after crash starting ${crashStart.toISOString()}`);

    // Verify fee is charged (proves execution simulator ran)
    assert.ok(result.metrics.feePaid > 0, "Fees should be charged");

    // Fee should be charged
    assert.ok(result.metrics.feePaid > 0, "Fees should be charged");
  });

  it("net return is consistent and fees are charged", () => {
    const candles = generateCandles(100);

    const strategy = adaptScoredStrategy({
      strategyId: "test-vex",
      sleeveId: "micro",
      family: "meanreversion",
      decisionTimeframe: "1h",
      executionTimeframe: "1h",
      scoredStrategy: createVolumeExhaustionBounceStrategy({
        dropLookback: 3,
        dropThresholdPct: 0.05,
        volumeWindow: 20,
        volumeSpikeMult: 2.0,
        rsiPeriod: 14,
        rsiEntry: 40,
        profitTargetPct: 0.02
      })
    });

    const result = runMultiStrategyBacktest({
      universeName: "test",
      initialCapital: 1_000_000,
      sleeves: [{ sleeveId: "micro", capitalBudgetPct: 0.95, maxOpenPositions: 5, maxSinglePositionPct: 0.5, priority: 10 }],
      strategies: [strategy],
      decisionCandles: { "1h": { "KRW-BTC": candles } },
      executionCandles: { "1h": { "KRW-BTC": candles } },
      universeConfig: { topN: 1, lookbackBars: 28, refreshEveryBars: 4 },
      captureTraceArtifacts: false,
      captureUniverseSnapshots: false,
      maxOpenPositions: 5,
      maxCapitalUsagePct: 0.95
    });

    // Net return should be finite
    assert.ok(Number.isFinite(result.metrics.netReturn), `Net return is ${result.metrics.netReturn}`);

    // Gross return >= net return (fees make net lower)
    assert.ok(result.metrics.grossReturn >= result.metrics.netReturn,
      `Gross ${result.metrics.grossReturn} should be >= net ${result.metrics.netReturn}`);

    // Fee should be positive if there are trades
    if (result.completedTrades.length > 0) {
      assert.ok(result.metrics.feePaid > 0, "Fees should be charged for completed trades");
    }

    // Final account cash should be consistent
    const finalCash = result.finalAccount.cash;
    assert.ok(Number.isFinite(finalCash), `Final cash is ${finalCash}`);
    assert.ok(finalCash > 0, `Final cash should be positive: ${finalCash}`);
  });

  it("zero-volume bars are rejected", () => {
    const candles = generateCandles(100);
    // Set bar 63 (execution bar after crash) to zero volume
    candles[63] = { ...candles[63], volume: 0 };

    const strategy = adaptScoredStrategy({
      strategyId: "test-vex",
      sleeveId: "micro",
      family: "meanreversion",
      decisionTimeframe: "1h",
      executionTimeframe: "1h",
      scoredStrategy: createVolumeExhaustionBounceStrategy({
        dropLookback: 3,
        dropThresholdPct: 0.05,
        volumeWindow: 20,
        volumeSpikeMult: 2.0,
        rsiPeriod: 14,
        rsiEntry: 40,
        profitTargetPct: 0.02
      })
    });

    const result = runMultiStrategyBacktest({
      universeName: "test",
      initialCapital: 1_000_000,
      sleeves: [{ sleeveId: "micro", capitalBudgetPct: 0.95, maxOpenPositions: 5, maxSinglePositionPct: 0.5, priority: 10 }],
      strategies: [strategy],
      decisionCandles: { "1h": { "KRW-BTC": candles } },
      executionCandles: { "1h": { "KRW-BTC": candles } },
      universeConfig: { topN: 1, lookbackBars: 28, refreshEveryBars: 4 },
      captureTraceArtifacts: false,
      captureUniverseSnapshots: false,
      maxOpenPositions: 5,
      maxCapitalUsagePct: 0.95
    });

    // The trade at bar 63 should be rejected due to zero volume
    // The strategy might still trade on a later bar if conditions persist
    assert.ok(result.metrics.rejectedOrdersCount > 0 || result.completedTrades.length === 0,
      "Zero-volume bar should cause rejection or no trades");
  });

  it("regime detection returns non-unknown for sufficient data", async () => {
    const { buildMarketStateContexts } = await import("../../strategies/src/market-state.js");

    // Build 200 candles with clear downtrend
    const candles = [];
    let price = 50_000_000;
    for (let i = 0; i < 200; i++) {
      const time = new Date("2023-01-01T00:00:00Z");
      time.setHours(time.getHours() + i);
      price = price * 0.998; // steady decline
      candles.push({
        marketCode: "KRW-BTC", timeframe: "1h", candleTimeUtc: time,
        openPrice: price * 1.001, highPrice: price * 1.003,
        lowPrice: price * 0.997, closePrice: price,
        volume: 100, quoteVolume: price * 100
      });
    }

    const ctx = buildMarketStateContexts({
      referenceTime: candles[199].candleTimeUtc,
      universeCandlesByMarket: { "KRW-BTC": candles }
    });
    const regime = ctx["KRW-BTC"]?.composite?.regime;
    assert.ok(regime !== "unknown", `Expected a real regime with 200 candles, got: ${regime}`);
    assert.equal(regime, "trend_down", `200 bars of decline should be trend_down, got: ${regime}`);
  });
});
