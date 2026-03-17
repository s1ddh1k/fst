import test from "node:test";
import assert from "node:assert/strict";
import { runUniverseScoredBacktest } from "../src/backtest/BacktestEngine.js";
import { createFixedWeightSizer } from "../../strategies/src/position-sizer.js";
import { createNoOpRiskManager } from "../../strategies/src/portfolio-risk.js";
import { createUpbitKrwExchangeAdapter } from "../src/execution/exchangeAdapter.js";
import type { ScoredStrategy } from "../../strategies/src/types.js";
import { createHourlyCandles } from "./test-helpers.js";

test("Universe scored backtest enforces single-position flow flat -> buy -> hold -> sell", () => {
  const scriptedStrategy: ScoredStrategy = {
    name: "scripted-flow",
    parameters: {},
    parameterCount: 0,
    generateSignal(context) {
      const market = context.candles[0]?.marketCode;

      if (!context.hasPosition) {
        if (context.index === 1 && market === "KRW-A") return { signal: "BUY", conviction: 0.9 };
        if (context.index === 1 && market === "KRW-B") return { signal: "BUY", conviction: 0.7 };
        return { signal: "HOLD", conviction: 0 };
      }

      if (market === "KRW-A" && context.index === 3) {
        return { signal: "SELL", conviction: 0.9 };
      }

      return { signal: "HOLD", conviction: 0 };
    }
  };

  const result = runUniverseScoredBacktest({
    universeName: "krw-top",
    timeframe: "1h",
    candidateCandlesByMarket: {
      "KRW-A": createHourlyCandles({
        marketCode: "KRW-A",
        closes: [100, 101, 102, 103, 104, 105]
      }),
      "KRW-B": createHourlyCandles({
        marketCode: "KRW-B",
        closes: [100, 100, 100, 100, 100, 100]
      })
    },
    strategy: scriptedStrategy,
    positionSizer: createFixedWeightSizer(1),
    riskManager: createNoOpRiskManager(),
    exchangeAdapter: createUpbitKrwExchangeAdapter({
      minOrderNotional: 100,
      takerFeeRate: 0
    }),
    universeConfig: {
      topN: 2,
      lookbackBars: 1,
      refreshEveryBars: 1
    },
    executionPolicy: {
      maxSlippageBps: 0
    },
    initialCapital: 10_000
  });

  assert.equal(result.trades.length, 2);
  assert.equal(result.trades[0]?.side, "BUY");
  assert.equal(result.trades[0]?.marketCode, "KRW-A");
  assert.equal(result.trades[1]?.side, "SELL");
  assert.equal(result.trades[1]?.marketCode, "KRW-A");
  assert.equal(result.signalCount, 1);
  assert.equal(result.decisionCounts.rawBuySignals, 2);
  assert.equal(result.ghostSignalCount, 2);
  assert.equal(result.reasonCounts.coordinator.ranked_out_by_single_position, 1);
  assert.equal(result.ghostStudy.entryReference, "next_bar_open");
  assert.ok(result.metrics.tradeCount === 2);
  assert.ok(result.metrics.winRate >= 0);
});

test("Universe scored backtest blocks immediate re-entry after a losing exit", () => {
  const cooldownStrategy: ScoredStrategy = {
    name: "scripted-cooldown",
    parameters: {},
    parameterCount: 0,
    generateSignal(context) {
      const market = context.candles[0]?.marketCode;

      if (market !== "KRW-A") {
        return { signal: "HOLD", conviction: 0 };
      }

      if (!context.hasPosition && context.index >= 1 && context.index <= 4) {
        return { signal: "BUY", conviction: 0.9 };
      }

      if (context.hasPosition && context.index === 2) {
        return { signal: "SELL", conviction: 0.9 };
      }

      return { signal: "HOLD", conviction: 0 };
    }
  };

  const result = runUniverseScoredBacktest({
    universeName: "krw-top",
    timeframe: "1h",
    candidateCandlesByMarket: {
      "KRW-A": createHourlyCandles({
        marketCode: "KRW-A",
        closes: [100, 99, 98, 96, 95, 94, 93]
      })
    },
    strategy: cooldownStrategy,
    positionSizer: createFixedWeightSizer(1),
    riskManager: createNoOpRiskManager(),
    exchangeAdapter: createUpbitKrwExchangeAdapter({
      minOrderNotional: 100,
      takerFeeRate: 0
    }),
    universeConfig: {
      topN: 1,
      lookbackBars: 1,
      refreshEveryBars: 1
    },
    coordinatorConfig: {
      cooldownBarsAfterLoss: 3
    },
    executionPolicy: {
      maxSlippageBps: 0
    },
    initialCapital: 10_000
  });

  assert.equal(result.trades.length, 2);
  assert.ok(result.metrics.cooldownSkipsCount >= 1);
  assert.ok((result.reasonCounts.coordinator.cooldown_active ?? 0) >= 1);
});

test("Universe scored backtest rejects non-hourly decision timeframes", () => {
  const strategy: ScoredStrategy = {
    name: "scripted-timeframe-guard",
    parameters: {},
    parameterCount: 0,
    generateSignal() {
      return { signal: "HOLD", conviction: 0 };
    }
  };

  assert.throws(
    () =>
      runUniverseScoredBacktest({
        universeName: "krw-top",
        timeframe: "5m",
        candidateCandlesByMarket: {
          "KRW-A": createHourlyCandles({
            marketCode: "KRW-A",
            closes: [100, 101, 102]
          })
        },
        strategy,
        positionSizer: createFixedWeightSizer(1),
        riskManager: createNoOpRiskManager(),
        exchangeAdapter: createUpbitKrwExchangeAdapter({
          minOrderNotional: 100,
          takerFeeRate: 0
        }),
        universeConfig: {
          topN: 1,
          lookbackBars: 1,
          refreshEveryBars: 1
        },
        executionPolicy: {
          maxSlippageBps: 0
        },
        initialCapital: 10_000
      }),
    /Scored strategies must run on 1h decision candles/
  );
});

test("Universe scored backtest preserves warmup history outside evaluation range", () => {
  const strategy: ScoredStrategy = {
    name: "scripted-evaluation-window",
    parameters: {},
    parameterCount: 0,
    generateSignal(context) {
      if (!context.hasPosition && context.index === 3) {
        return { signal: "BUY", conviction: 0.9 };
      }

      if (context.hasPosition && context.index === 4) {
        return { signal: "SELL", conviction: 0.9 };
      }

      return { signal: "HOLD", conviction: 0 };
    }
  };

  const candles = createHourlyCandles({
    marketCode: "KRW-A",
    closes: [100, 101, 102, 103, 104, 105]
  });
  const result = runUniverseScoredBacktest({
    universeName: "krw-top",
    timeframe: "1h",
    candidateCandlesByMarket: {
      "KRW-A": candles
    },
    evaluationRange: {
      start: candles[3].candleTimeUtc,
      end: candles[5].candleTimeUtc
    },
    strategy,
    positionSizer: createFixedWeightSizer(1),
    riskManager: createNoOpRiskManager(),
    exchangeAdapter: createUpbitKrwExchangeAdapter({
      minOrderNotional: 100,
      takerFeeRate: 0
    }),
    universeConfig: {
      topN: 1,
      lookbackBars: 1,
      refreshEveryBars: 1
    },
    executionPolicy: {
      maxSlippageBps: 0
    },
    initialCapital: 10_000
  });

  assert.equal(result.trades.length, 2);
  assert.equal(result.trades[0]?.side, "BUY");
  assert.equal(result.trades[1]?.side, "SELL");
});

test("Universe scored backtest reports raw ghost BUY candidates separately from executed entries", () => {
  const strategy: ScoredStrategy = {
    name: "scripted-ghost-study",
    parameters: {},
    parameterCount: 0,
    generateSignal(context) {
      if (!context.hasPosition && context.index === 1) {
        return { signal: "BUY", conviction: context.candles[0]?.marketCode === "KRW-A" ? 0.9 : 0.7 };
      }

      return { signal: "HOLD", conviction: 0 };
    }
  };

  const result = runUniverseScoredBacktest({
    universeName: "krw-top",
    timeframe: "1h",
    candidateCandlesByMarket: {
      "KRW-A": createHourlyCandles({
        marketCode: "KRW-A",
        closes: Array.from({ length: 30 }, (_, index) => 100 + index)
      }),
      "KRW-B": createHourlyCandles({
        marketCode: "KRW-B",
        closes: Array.from({ length: 30 }, (_, index) => 100 + Math.min(index, 2))
      })
    },
    strategy,
    positionSizer: createFixedWeightSizer(1),
    riskManager: createNoOpRiskManager(),
    exchangeAdapter: createUpbitKrwExchangeAdapter({
      minOrderNotional: 100,
      takerFeeRate: 0
    }),
    universeConfig: {
      topN: 2,
      lookbackBars: 1,
      refreshEveryBars: 1
    },
    executionPolicy: {
      maxSlippageBps: 0
    },
    initialCapital: 10_000
  });

  assert.equal(result.signalCount, 1);
  assert.equal(result.ghostSignalCount, 2);
  assert.ok(result.ghostStudy.horizonSummaries.some((summary) => summary.sampleSize > 0));
});
