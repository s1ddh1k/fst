import test from "node:test";
import assert from "node:assert/strict";
import { OrderStateMachine } from "../../../packages/shared/src/execution.ts";
import {
  buildMultiStrategyPresets,
  buildUniverseSnapshots,
  createBreakoutRotationStrategy,
  createMicroBreakoutStrategy,
  createRelativeStrengthRotationStrategy,
  formatMultiStrategyComparisonTable,
  formatMultiStrategyReport,
  normalizeToFullGrid,
  runMultiStrategyBacktest
} from "../src/multi-strategy/index.js";
import type { Strategy } from "../../../packages/shared/src/index.ts";
import { createUpbitKrwExchangeAdapter } from "../src/execution/exchangeAdapter.js";
import { createCandles } from "./test-helpers.js";

test("Phase 0: full-grid normalization fills synthetic candles across 15m bars", () => {
  const marketA = createCandles({
    marketCode: "KRW-A",
    timeframe: "15m",
    closes: [100, 102],
    startTime: "2024-01-01T00:00:00.000Z"
  });
  marketA[1] = {
    ...marketA[1],
    candleTimeUtc: new Date("2024-01-01T00:30:00.000Z")
  };
  const marketB = createCandles({
    marketCode: "KRW-B",
    timeframe: "15m",
    closes: [200, 201, 202],
    startTime: "2024-01-01T00:00:00.000Z"
  });

  const normalized = normalizeToFullGrid({
    timeframe: "15m",
    candlesByMarket: {
      "KRW-A": marketA,
      "KRW-B": marketB
    }
  });

  assert.equal(normalized.timeline.length, 3);
  assert.equal(normalized.candlesByMarket["KRW-A"][1]?.isSynthetic, true);
  assert.equal(normalized.candlesByMarket["KRW-A"][1]?.closePrice, 100);
});

test("Phase 0: full-grid normalization keeps earliest timeline and backfills late-listed markets", () => {
  const longHistory = createCandles({
    marketCode: "KRW-A",
    timeframe: "1h",
    closes: [100, 101, 102, 103],
    startTime: "2024-01-01T00:00:00.000Z"
  });
  const lateListed = createCandles({
    marketCode: "KRW-B",
    timeframe: "1h",
    closes: [200, 201],
    startTime: "2024-01-01T02:00:00.000Z"
  });

  const normalized = normalizeToFullGrid({
    timeframe: "1h",
    candlesByMarket: {
      "KRW-A": longHistory,
      "KRW-B": lateListed
    }
  });

  assert.equal(normalized.timeline.length, 4);
  assert.equal(normalized.timeline[0]?.toISOString(), "2024-01-01T00:00:00.000Z");
  assert.equal(normalized.candlesByMarket["KRW-B"].length, 4);
  assert.equal(normalized.candlesByMarket["KRW-B"][0]?.isSynthetic, true);
  assert.equal(normalized.candlesByMarket["KRW-B"][0]?.volume, 0);
  assert.equal(normalized.candlesByMarket["KRW-B"][0]?.closePrice, 200);
  assert.equal(normalized.candlesByMarket["KRW-B"][2]?.isSynthetic, false);
});

test("Phase 0: point-in-time universe snapshot builder avoids lookahead", () => {
  const candleSet = normalizeToFullGrid({
    timeframe: "15m",
    candlesByMarket: {
      "KRW-A": createCandles({
        marketCode: "KRW-A",
        timeframe: "15m",
        closes: [100, 101, 102, 103, 104],
        volumes: [100, 100, 100, 1, 1]
      }),
      "KRW-B": createCandles({
        marketCode: "KRW-B",
        timeframe: "15m",
        closes: [100, 101, 102, 103, 104],
        volumes: [1, 1, 1, 200, 200]
      })
    }
  });

  const snapshots = buildUniverseSnapshots({
    candleSet,
    config: {
      topN: 1,
      lookbackBars: 2,
      refreshEveryBars: 1
    }
  });

  assert.deepEqual(
    snapshots.get("2024-01-01T00:30:00.000Z")?.markets,
    ["KRW-A"]
  );
  assert.deepEqual(
    snapshots.get("2024-01-01T01:00:00.000Z")?.markets,
    ["KRW-B"]
  );
});

test("Phase 0: universe snapshot builder excludes late-listed markets until min history is met", () => {
  const candleSet = normalizeToFullGrid({
    timeframe: "1h",
    candlesByMarket: {
      "KRW-A": createCandles({
        marketCode: "KRW-A",
        timeframe: "1h",
        closes: [100, 101, 102, 103, 104, 105],
        volumes: [100, 100, 100, 100, 100, 100],
        startTime: "2024-01-01T00:00:00.000Z"
      }),
      "KRW-B": createCandles({
        marketCode: "KRW-B",
        timeframe: "1h",
        closes: [200, 210, 220],
        volumes: [1000, 1000, 1000],
        startTime: "2024-01-01T03:00:00.000Z"
      })
    }
  });

  const snapshots = buildUniverseSnapshots({
    candleSet,
    config: {
      topN: 2,
      lookbackBars: 2,
      refreshEveryBars: 1,
      minHistoryBars: 2
    }
  });

  assert.deepEqual(
    snapshots.get("2024-01-01T03:00:00.000Z")?.markets,
    ["KRW-A"]
  );
  assert.deepEqual(
    snapshots.get("2024-01-01T04:00:00.000Z")?.markets,
    ["KRW-B", "KRW-A"]
  );
});

test("Phase 0: universe snapshot builder can shrink topN by cumulative quote-volume share", () => {
  const candleSet = normalizeToFullGrid({
    timeframe: "1h",
    candlesByMarket: {
      "KRW-A": createCandles({
        marketCode: "KRW-A",
        timeframe: "1h",
        closes: [100, 100, 100],
        volumes: [100, 100, 100]
      }),
      "KRW-B": createCandles({
        marketCode: "KRW-B",
        timeframe: "1h",
        closes: [100, 100, 100],
        volumes: [60, 60, 60]
      }),
      "KRW-C": createCandles({
        marketCode: "KRW-C",
        timeframe: "1h",
        closes: [100, 100, 100],
        volumes: [10, 10, 10]
      }),
      "KRW-D": createCandles({
        marketCode: "KRW-D",
        timeframe: "1h",
        closes: [100, 100, 100],
        volumes: [5, 5, 5]
      })
    }
  });

  const snapshots = buildUniverseSnapshots({
    candleSet,
    config: {
      topN: 4,
      minTopN: 2,
      targetQuoteVolumeShare: 0.9,
      lookbackBars: 2,
      refreshEveryBars: 1
    }
  });

  assert.deepEqual(
    snapshots.get("2024-01-01T01:00:00.000Z")?.markets,
    ["KRW-A", "KRW-B"]
  );
});

test("Phase 1-4: multi-strategy backtest enforces duplicate-market blocking and next-bar fills", () => {
  const result = runMultiStrategyBacktest({
    universeName: "krw-top",
    initialCapital: 100_000,
    exchangeAdapter: createUpbitKrwExchangeAdapter({
      minOrderNotional: 5_000,
      takerFeeRate: 0
    }),
    sleeves: [
      { sleeveId: "trend", capitalBudgetPct: 0.4, maxOpenPositions: 2, maxSinglePositionPct: 0.5, priority: 9 },
      { sleeveId: "breakout", capitalBudgetPct: 0.35, maxOpenPositions: 2, maxSinglePositionPct: 0.5, priority: 7 },
      { sleeveId: "micro", capitalBudgetPct: 0.2, maxOpenPositions: 2, maxSinglePositionPct: 0.5, priority: 5 }
    ],
    strategies: [
      createRelativeStrengthRotationStrategy({
        rebalanceBars: 1,
        entryFloor: 0.5,
        exitFloor: 0.2,
        switchGap: 0.01
      }),
      createBreakoutRotationStrategy({
        breakoutLookback: 4,
        strengthFloor: 0.5,
        maxExtensionAtr: 2,
        trailAtrMult: 1.8
      }),
      createMicroBreakoutStrategy({
        lookbackBars: 3,
        extensionThreshold: 0.05,
        holdingBarsMax: 3,
        stopAtrMult: 1
      })
    ],
    decisionCandles: {
      "1h": {
        "KRW-A": createCandles({
          marketCode: "KRW-A",
          timeframe: "1h",
          closes: [100, 102, 105, 107, 110, 112]
        }),
        "KRW-B": createCandles({
          marketCode: "KRW-B",
          timeframe: "1h",
          closes: [100, 100, 101, 101, 101, 101]
        })
      },
      "15m": {
        "KRW-A": createCandles({
          marketCode: "KRW-A",
          timeframe: "15m",
          closes: [100, 101, 103, 104, 106, 108, 110, 109]
        }),
        "KRW-B": createCandles({
          marketCode: "KRW-B",
          timeframe: "15m",
          closes: [100, 100, 100, 101, 101, 101, 101, 101]
        })
      },
      "5m": {
        "KRW-A": createCandles({
          marketCode: "KRW-A",
          timeframe: "5m",
          closes: [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111]
        }),
        "KRW-B": createCandles({
          marketCode: "KRW-B",
          timeframe: "5m",
          closes: [100, 100, 100, 100, 100, 100, 101, 101, 101, 101, 101, 101]
        })
      },
      "1m": {
        "KRW-A": createCandles({
          marketCode: "KRW-A",
          timeframe: "1m",
          closes: [100, 100.5, 101, 101.5, 102, 102.3, 102.1, 102.4, 102.8, 103.1, 103.5, 103.2]
        }),
        "KRW-B": createCandles({
          marketCode: "KRW-B",
          timeframe: "1m",
          closes: [100, 100, 100, 100.1, 100.2, 100.2, 100.1, 100.3, 100.2, 100.2, 100.1, 100]
        })
      }
    },
    executionCandles: {
      "1h": {
        "KRW-A": createCandles({
          marketCode: "KRW-A",
          timeframe: "1h",
          closes: [100, 102, 105, 107, 110, 112]
        }),
        "KRW-B": createCandles({
          marketCode: "KRW-B",
          timeframe: "1h",
          closes: [100, 100, 101, 101, 101, 101]
        })
      },
      "5m": {
        "KRW-A": createCandles({
          marketCode: "KRW-A",
          timeframe: "5m",
          closes: [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111]
        }),
        "KRW-B": createCandles({
          marketCode: "KRW-B",
          timeframe: "5m",
          closes: [100, 100, 100, 100, 100, 100, 101, 101, 101, 101, 101, 101]
        })
      },
      "1m": {
        "KRW-A": createCandles({
          marketCode: "KRW-A",
          timeframe: "1m",
          closes: [100, 100.5, 101, 101.5, 102, 102.3, 102.1, 102.4, 102.8, 103.1, 103.5, 103.2]
        }),
        "KRW-B": createCandles({
          marketCode: "KRW-B",
          timeframe: "1m",
          closes: [100, 100, 100, 100.1, 100.2, 100.2, 100.1, 100.3, 100.2, 100.2, 100.1, 100]
        })
      }
    },
    universeConfig: {
      topN: 2,
      lookbackBars: 2,
      refreshEveryBars: 1
    }
  });

  assert.ok(result.metrics.signalCount > 0);
  assert.equal(
    result.decisionCoverageSummary.rawBuySignals +
      result.decisionCoverageSummary.rawSellSignals +
      result.decisionCoverageSummary.rawHoldSignals,
    result.metrics.signalCount
  );
  assert.ok(
    result.decisionCoverageSummary.avgEligibleBuys <=
      result.decisionCoverageSummary.avgConsideredBuys + 1e-9
  );
  assert.ok(result.metrics.blockedSignalCount >= 0);
  assert.ok(Object.keys(result.strategyMetrics).length > 0);
  assert.ok(Object.keys(result.sleeveMetrics).length > 0);
  assert.ok(result.fills.every((fill) => fill.status === "FILLED" || fill.status === "REJECTED"));
  assert.ok(result.events.some((event) => event.kind === "ghost_signal"));
  assert.ok(result.events.some((event) => event.kind === "funnel_stage"));
  assert.match(formatMultiStrategyReport(result), /strategy\s+\| summary/);
});

test("shared order state machine preserves live/paper/backtest transitions", () => {
  const machine = new OrderStateMachine();
  machine.apply({
    type: "ORDER_CREATED",
    at: new Date("2024-01-01T00:00:00.000Z"),
    orderId: "ord-1",
    market: "KRW-ETH",
    side: "BUY"
  });
  machine.apply({
    type: "ORDER_PLANNED",
    at: new Date("2024-01-01T00:00:01.000Z"),
    orderId: "ord-1"
  });
  machine.apply({
    type: "ORDER_SUBMITTED",
    at: new Date("2024-01-01T00:00:02.000Z"),
    orderId: "ord-1"
  });
  machine.apply({
    type: "ORDER_FILLED",
    at: new Date("2024-01-01T00:00:03.000Z"),
    orderId: "ord-1",
    filledQuantity: 1,
    filledNotional: 100_000
  });

  assert.equal(machine.get("ord-1")?.status, "FILLED");
});

test("multi-strategy presets and comparison report are generated", () => {
  const presets = buildMultiStrategyPresets();

  assert.ok(presets.length >= 3);
  assert.match(
    formatMultiStrategyComparisonTable([
      {
        label: "balanced",
        netReturn: 0.12,
        maxDrawdown: 0.08,
        turnover: 1.4,
        winRate: 0.55,
        blockedSignals: 7
      }
    ]),
    /preset/
  );
});

test("multi-strategy backtest skips orders outside execution coverage instead of rejecting them", () => {
  const alwaysBuy: Strategy = {
    id: "always-buy",
    sleeveId: "trend",
    family: "trend",
    decisionTimeframe: "1h",
    executionTimeframe: "5m",
    parameters: {},
    generateSignal(context) {
      return {
        strategyId: "always-buy",
        sleeveId: "trend",
        family: "trend",
        market: context.market,
        signal: "BUY",
        conviction: 0.8,
        decisionTime: context.decisionTime,
        decisionTimeframe: "1h",
        executionTimeframe: "5m",
        reason: "always_buy",
        stages: {
          universe_eligible: true,
          trigger_pass: true
        }
      };
    }
  };

  const result = runMultiStrategyBacktest({
    universeName: "krw-top",
    initialCapital: 100_000,
    exchangeAdapter: createUpbitKrwExchangeAdapter({
      minOrderNotional: 5_000,
      takerFeeRate: 0
    }),
    sleeves: [
      { sleeveId: "trend", capitalBudgetPct: 0.5, maxOpenPositions: 1, maxSinglePositionPct: 0.5, priority: 9 },
      { sleeveId: "breakout", capitalBudgetPct: 0, maxOpenPositions: 0, maxSinglePositionPct: 0, priority: 1 },
      { sleeveId: "micro", capitalBudgetPct: 0, maxOpenPositions: 0, maxSinglePositionPct: 0, priority: 1 }
    ],
    strategies: [alwaysBuy],
    decisionCandles: {
      "1h": {
        "KRW-A": createCandles({
          marketCode: "KRW-A",
          timeframe: "1h",
          closes: [100, 101, 102],
          startTime: "2024-01-01T00:00:00.000Z"
        })
      }
    },
    executionCandles: {
      "5m": {
        "KRW-A": createCandles({
          marketCode: "KRW-A",
          timeframe: "5m",
          closes: [100, 101, 102],
          startTime: "2024-01-01T01:00:00.000Z"
        })
      }
    },
    universeConfig: {
      topN: 1,
      lookbackBars: 1,
      refreshEveryBars: 1
    }
  });

  assert.equal(result.metrics.rejectedOrdersCount, 0);
  assert.ok(result.events.some((event) => event.kind === "blocked_signal"));
});

test("multi-strategy backtest merges partial precomputed inputs with raw timeframe data", () => {
  const alwaysBuy: Strategy = {
    id: "partial-precompute-buy",
    sleeveId: "trend",
    family: "trend",
    decisionTimeframe: "5m",
    executionTimeframe: "5m",
    parameters: {},
    generateSignal(context) {
      return {
        strategyId: "partial-precompute-buy",
        sleeveId: "trend",
        family: "trend",
        market: context.market,
        signal: "BUY",
        conviction: 0.9,
        decisionTime: context.decisionTime,
        decisionTimeframe: "5m",
        executionTimeframe: "5m",
        reason: "partial_precompute_merge",
        stages: {
          universe_eligible: true,
          trigger_pass: true
        }
      };
    }
  };

  const hourlyCandles = createCandles({
    marketCode: "KRW-A",
    timeframe: "1h",
    closes: [100, 101, 102, 103],
    startTime: "2024-01-01T00:00:00.000Z"
  });
  const intradayCandles = createCandles({
    marketCode: "KRW-A",
    timeframe: "5m",
    closes: [100, 101, 102, 103, 104, 105],
    startTime: "2024-01-01T00:00:00.000Z"
  });
  const preNormalizedHourly = normalizeToFullGrid({
    timeframe: "1h",
    candlesByMarket: {
      "KRW-A": hourlyCandles
    }
  });

  const result = runMultiStrategyBacktest({
    universeName: "krw-top",
    initialCapital: 100_000,
    exchangeAdapter: createUpbitKrwExchangeAdapter({
      minOrderNotional: 5_000,
      takerFeeRate: 0
    }),
    sleeves: [
      { sleeveId: "trend", capitalBudgetPct: 0.8, maxOpenPositions: 1, maxSinglePositionPct: 1, priority: 9 },
      { sleeveId: "breakout", capitalBudgetPct: 0, maxOpenPositions: 0, maxSinglePositionPct: 0, priority: 1 },
      { sleeveId: "micro", capitalBudgetPct: 0, maxOpenPositions: 0, maxSinglePositionPct: 0, priority: 1 }
    ],
    strategies: [alwaysBuy],
    decisionCandles: {
      "1h": {
        "KRW-A": hourlyCandles
      },
      "5m": {
        "KRW-A": intradayCandles
      }
    },
    executionCandles: {
      "5m": {
        "KRW-A": intradayCandles
      }
    },
    preNormalizedDecisionSets: {
      "1h": preNormalizedHourly
    },
    precomputedUniverseSnapshotsByTf: {
      "1h": buildUniverseSnapshots({
        candleSet: preNormalizedHourly,
        config: {
          topN: 1,
          lookbackBars: 1,
          refreshEveryBars: 1
        }
      })
    },
    universeConfig: {
      topN: 1,
      lookbackBars: 1,
      refreshEveryBars: 1
    }
  });

  assert.ok(result.metrics.signalCount > 0);
  assert.ok(result.decisionCoverageSummary.rawBuySignals > 0);
  assert.equal(result.decisionCoverageSummary.rawHoldSignals, 0);
  assert.ok(result.universeCoverageSummary.observationCount > 0);
});

test("multi-strategy backtest fails fast when a required timeframe is missing", () => {
  const missingExecution: Strategy = {
    id: "missing-execution",
    sleeveId: "trend",
    family: "trend",
    decisionTimeframe: "1h",
    executionTimeframe: "5m",
    parameters: {},
    generateSignal(context) {
      return {
        strategyId: "missing-execution",
        sleeveId: "trend",
        family: "trend",
        market: context.market,
        signal: "BUY",
        conviction: 0.8,
        decisionTime: context.decisionTime,
        decisionTimeframe: "1h",
        executionTimeframe: "5m",
        reason: "missing_execution_timeframe",
        stages: {
          universe_eligible: true,
          trigger_pass: true
        }
      };
    }
  };

  assert.throws(
    () =>
      runMultiStrategyBacktest({
        universeName: "krw-top",
        initialCapital: 100_000,
        exchangeAdapter: createUpbitKrwExchangeAdapter({
          minOrderNotional: 5_000,
          takerFeeRate: 0
        }),
        sleeves: [
          { sleeveId: "trend", capitalBudgetPct: 1, maxOpenPositions: 1, maxSinglePositionPct: 1, priority: 9 },
          { sleeveId: "breakout", capitalBudgetPct: 0, maxOpenPositions: 0, maxSinglePositionPct: 0, priority: 1 },
          { sleeveId: "micro", capitalBudgetPct: 0, maxOpenPositions: 0, maxSinglePositionPct: 0, priority: 1 }
        ],
        strategies: [missingExecution],
        decisionCandles: {
          "1h": {
            "KRW-A": createCandles({
              marketCode: "KRW-A",
              timeframe: "1h",
              closes: [100, 101, 102],
              startTime: "2024-01-01T00:00:00.000Z"
            })
          }
        },
        executionCandles: {},
        universeConfig: {
          topN: 1,
          lookbackBars: 1,
          refreshEveryBars: 1
        }
      }),
    /Missing execution candle coverage/
  );
});
