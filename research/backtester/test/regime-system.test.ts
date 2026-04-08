import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildMacroRegimeSeries, detectMacroRegime } from "../src/auto-research/regime-system.js";

function buildCandles(prices: number[]) {
  return prices.map((closePrice, index) => ({
    marketCode: "KRW-BTC",
    timeframe: "1h",
    candleTimeUtc: new Date(Date.UTC(2024, 0, 1, index)),
    openPrice: index === 0 ? closePrice : prices[index - 1],
    highPrice: closePrice * 1.01,
    lowPrice: closePrice * 0.99,
    closePrice,
    volume: 1_000 + index
  }));
}

describe("regime system macro regime", () => {
  it("returns neutral before warmup completes", () => {
    const candles = buildCandles(Array.from({ length: 100 }, (_, index) => 100 + index));
    assert.equal(detectMacroRegime(candles, 99), "neutral");
  });

  it("builds a stable bull regime on a sustained uptrend", () => {
    const prices = Array.from({ length: 900 }, (_, index) => 100 * Math.pow(1.0015, index));
    const regimes = buildMacroRegimeSeries(buildCandles(prices), 24);
    const tail = regimes.slice(-100);
    const bulls = tail.filter((regime) => regime === "bull").length;
    assert.ok(bulls >= 40, `expected stable bull tail, got ${bulls}/100`);
  });
});
