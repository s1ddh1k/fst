import test from "node:test";
import assert from "node:assert/strict";
import { createGhostTradeStudyCollector } from "../src/ghost/ghost-trade-study.js";
import { createUpbitKrwExchangeAdapter } from "../src/execution/exchangeAdapter.js";
import { createDefaultExecutionPolicy } from "../src/execution/ExecutionSimulator.js";
import { createHourlyCandles } from "./test-helpers.js";

test("ghost trade study records forward return and excursion summaries from BUY signals", () => {
  const candles = createHourlyCandles({
    marketCode: "KRW-A",
    closes: [100, 101, 103, 105, 104]
  });
  const collector = createGhostTradeStudyCollector({
    exchangeAdapter: createUpbitKrwExchangeAdapter({
      minOrderNotional: 100,
      makerFeeRate: 0,
      takerFeeRate: 0
    }),
    policy: {
      ...createDefaultExecutionPolicy(),
      maxSlippageBps: 0
    },
    evaluationEndIndex: candles.length - 1,
    studyNotional: 1_000,
    horizons: [1, 2]
  });

  collector.record({
    signal: {
      market: "KRW-A",
      timestamp: candles[0].candleTimeUtc,
      signal: "BUY",
      conviction: 0.8,
      lastPrice: candles[0].closePrice,
      metadata: {
        estimatedSpreadBps: 0,
        avgDailyNotional: 1_000_000,
        isSyntheticBar: false
      }
    },
    candles,
    decisionIndex: 0,
    decisionLagBars: 1
  });

  const summary = collector.summarize();
  const horizon1 = summary.horizonSummaries.find((item) => item.horizonBars === 1);
  const horizon2 = summary.horizonSummaries.find((item) => item.horizonBars === 2);

  assert.equal(collector.getGhostSignalCount(), 1);
  assert.ok(horizon1);
  assert.ok(horizon2);
  assert.equal(horizon1?.sampleSize, 1);
  assert.equal(horizon2?.sampleSize, 1);
  assert.ok((horizon1?.medianGrossReturn ?? 0) > 0);
  assert.ok((horizon2?.medianNetReturn ?? 0) > 0);
  assert.ok((horizon2?.medianMfe ?? 0) >= (horizon1?.medianMfe ?? 0));
});
