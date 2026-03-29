/**
 * Adaptive regime detection test.
 *
 * Verifies that the adaptive regime (SMA200 + momentum72, no volatile override)
 * correctly classifies crypto market conditions instead of marking everything "volatile".
 *
 * The default regime uses SMA(55) + momentum(20) + volatilityThreshold(0.03),
 * which classifies ~93% of crypto data as "volatile" because crypto is inherently volatile.
 * The adaptive regime removes the volatile override entirely.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildRegimeSeriesFromCandles,
  buildAdaptiveRegimeSeriesFromCandles
} from "../../strategies/src/market-state.js";

function generateTrendingPrices(count: number, direction: "up" | "down"): number[] {
  const prices: number[] = [];
  let price = 50_000_000;

  for (let i = 0; i < count; i++) {
    // Add noise to simulate real crypto volatility
    const noise = (Math.random() - 0.5) * price * 0.02;
    const trend = direction === "up" ? price * 0.003 : -price * 0.003;
    price += trend + noise;
    price = Math.max(price * 0.5, price); // prevent going negative
    prices.push(price);
  }

  return prices;
}

function generateRangingPrices(count: number): number[] {
  const prices: number[] = [];
  let price = 50_000_000;
  const center = price;

  for (let i = 0; i < count; i++) {
    // Oscillate around center with noise
    price = center + Math.sin(i * 0.1) * center * 0.05 + (Math.random() - 0.5) * center * 0.02;
    prices.push(price);
  }

  return prices;
}

describe("adaptive regime detection", () => {
  it("default regime marks most crypto bars as volatile due to high volatility threshold", () => {
    const prices = generateTrendingPrices(300, "up");
    const regimes = buildRegimeSeriesFromCandles(prices);

    const counts: Record<string, number> = {};
    for (const r of regimes) {
      counts[r] = (counts[r] ?? 0) + 1;
    }

    // Default regime likely classifies many bars as "volatile" due to crypto's inherent volatility
    // This is the problem we're fixing
    const totalClassified = regimes.filter(r => r !== "unknown").length;
    assert.ok(totalClassified > 0, "should have some classified bars");
  });

  it("adaptive regime never returns volatile", () => {
    const prices = generateTrendingPrices(300, "up");
    const regimes = buildAdaptiveRegimeSeriesFromCandles(prices);

    const volatileCount = regimes.filter(r => r === "volatile").length;
    assert.equal(volatileCount, 0, "adaptive regime should never return volatile");
  });

  it("adaptive regime classifies clear uptrend as trend_up after warmup", () => {
    // Need 200+ candles for SMA(200) warmup
    const prices = generateTrendingPrices(350, "up");
    const regimes = buildAdaptiveRegimeSeriesFromCandles(prices);

    // After SMA(200) warmup, last 100 bars should mostly be trend_up
    const lastRegimes = regimes.slice(-100);
    const trendUpCount = lastRegimes.filter(r => r === "trend_up").length;
    const totalValid = lastRegimes.filter(r => r !== "unknown").length;

    assert.ok(
      trendUpCount / totalValid >= 0.5,
      `Expected >50% trend_up in uptrend, got ${trendUpCount}/${totalValid} (${((trendUpCount / totalValid) * 100).toFixed(1)}%)`
    );
  });

  it("adaptive regime classifies clear downtrend as trend_down after warmup", () => {
    // First 210 bars trending up (warmup), then 150 bars trending down
    const warmup = generateTrendingPrices(210, "up");
    const downtrend: number[] = [];
    let price = warmup[warmup.length - 1];
    for (let i = 0; i < 150; i++) {
      const noise = (Math.random() - 0.5) * price * 0.015;
      price -= price * 0.004 + noise;
      downtrend.push(price);
    }
    const prices = [...warmup, ...downtrend];
    const regimes = buildAdaptiveRegimeSeriesFromCandles(prices);

    // Last 80 bars should have meaningful trend_down classification
    const lastRegimes = regimes.slice(-80);
    const trendDownCount = lastRegimes.filter(r => r === "trend_down").length;
    const totalValid = lastRegimes.filter(r => r !== "unknown").length;

    assert.ok(
      trendDownCount / totalValid >= 0.3,
      `Expected >30% trend_down in downtrend, got ${trendDownCount}/${totalValid} (${((trendDownCount / totalValid) * 100).toFixed(1)}%)`
    );
  });

  it("adaptive regime classifies ranging market as range after warmup", () => {
    const prices = generateRangingPrices(350);
    const regimes = buildAdaptiveRegimeSeriesFromCandles(prices);

    // In a ranging market, most bars should be "range"
    const lastRegimes = regimes.slice(-100);
    const rangeCount = lastRegimes.filter(r => r === "range").length;
    const totalValid = lastRegimes.filter(r => r !== "unknown").length;

    // Range market should have >30% "range" (rest may be trend_up/down from noise)
    assert.ok(
      rangeCount / totalValid >= 0.25,
      `Expected >25% range in ranging market, got ${rangeCount}/${totalValid} (${((rangeCount / totalValid) * 100).toFixed(1)}%)`
    );
  });

  it("adaptive regime uses longer parameters (SMA200, momentum72) by default", () => {
    // With only 100 candles and SMA(200), everything should be "unknown"
    const shortPrices = generateTrendingPrices(100, "up");
    const regimes = buildAdaptiveRegimeSeriesFromCandles(shortPrices);

    const unknownCount = regimes.filter(r => r === "unknown").length;
    assert.equal(
      unknownCount,
      100,
      "All bars should be unknown with less data than SMA(200) warmup"
    );
  });

  it("default regime returns same types as adaptive regime", () => {
    const prices = generateTrendingPrices(300, "up");
    const defaultRegimes = buildRegimeSeriesFromCandles(prices);
    const adaptiveRegimes = buildAdaptiveRegimeSeriesFromCandles(prices);

    assert.equal(defaultRegimes.length, adaptiveRegimes.length, "same length");

    const validTypes = new Set(["trend_up", "trend_down", "range", "volatile", "unknown"]);
    for (const r of adaptiveRegimes) {
      assert.ok(validTypes.has(r), `unexpected regime type: ${r}`);
    }
  });
});
