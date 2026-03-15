import test from "node:test";
import assert from "node:assert/strict";
import { createPortfolioCoordinator, createInitialPortfolioState } from "../src/portfolio/PortfolioCoordinator.js";
import { createExecutionSimulator } from "../src/execution/ExecutionSimulator.js";
import { createUpbitKrwExchangeAdapter } from "../src/execution/exchangeAdapter.js";
import { createHourlyCandles } from "./test-helpers.js";

test("PortfolioCoordinator selects exactly one highest-conviction BUY and enforces cooldown", () => {
  const coordinator = createPortfolioCoordinator({
    cooldownBarsAfterLoss: 3
  });
  const state = createInitialPortfolioState(10_000);
  const timestamp = new Date("2024-01-01T00:00:00.000Z");
  const first = coordinator.coordinate({
    state,
    barIndex: 10,
    timestamp,
    signals: [
      { market: "KRW-A", timestamp, signal: "BUY", conviction: 0.62, lastPrice: 100 },
      { market: "KRW-B", timestamp, signal: "BUY", conviction: 0.81, lastPrice: 100 },
      { market: "KRW-C", timestamp, signal: "BUY", conviction: 0.77, lastPrice: 100 }
    ]
  });

  assert.equal(first.intent?.side, "BUY");
  assert.equal(first.intent?.market, "KRW-B");

  coordinator.onBuyFilled({
    state,
    market: "KRW-B",
    entryPrice: 100,
    quantity: 1,
    barIndex: 11,
    timestamp: new Date("2024-01-01T01:00:00.000Z")
  });
  coordinator.onSellFilled({
    state,
    market: "KRW-B",
    barIndex: 12,
    timestamp: new Date("2024-01-01T02:00:00.000Z"),
    reason: "signal_exit",
    pnlRatio: -0.03
  });

  const second = coordinator.coordinate({
    state,
    barIndex: 13,
    timestamp: new Date("2024-01-01T03:00:00.000Z"),
    signals: [
      { market: "KRW-B", timestamp, signal: "BUY", conviction: 0.9, lastPrice: 100 }
    ]
  });

  assert.equal(second.intent, null);
  assert.equal(second.diagnostics.cooldownSkips, 1);
});

test("ExecutionSimulator rejects same-bar fills, rounds to ticks, and enforces min notional", () => {
  const simulator = createExecutionSimulator({
    exchangeAdapter: createUpbitKrwExchangeAdapter({
      minOrderNotional: 5_000,
      takerFeeRate: 0.001
    }),
    policy: {
      maxSlippageBps: 0
    }
  });
  const nextBar = createHourlyCandles({
    marketCode: "KRW-A",
    closes: [100.09]
  })[0];
  nextBar.openPrice = 100.01;
  nextBar.highPrice = 100.09;
  nextBar.lowPrice = 99.95;

  const sameBar = simulator.simulate({
    orderIntent: {
      side: "BUY",
      market: "KRW-A",
      timestamp: new Date("2024-01-01T00:00:00.000Z"),
      orderStyle: "best_ioc",
      reason: "entry",
      conviction: 0.8,
      targetNotional: 10_000
    },
    decisionBarIndex: 1,
    executionBarIndex: 1,
    nextBar,
    cashAvailable: 10_000,
    positionQuantity: 0
  });

  assert.equal(sameBar.status, "REJECTED");

  const buyFill = simulator.simulate({
    orderIntent: {
      side: "BUY",
      market: "KRW-A",
      timestamp: new Date("2024-01-01T00:00:00.000Z"),
      orderStyle: "best_ioc",
      reason: "entry",
      conviction: 0.8,
      targetNotional: 10_000
    },
    decisionBarIndex: 0,
    executionBarIndex: 1,
    nextBar,
    cashAvailable: 10_000,
    positionQuantity: 0
  });

  assert.equal(buyFill.status, "FILLED");
  assert.equal(buyFill.fillPrice, 100.1);
  assert.ok((buyFill.feePaid ?? 0) > 0);

  const sellFill = simulator.simulate({
    orderIntent: {
      side: "SELL",
      market: "KRW-A",
      timestamp: new Date("2024-01-01T00:00:00.000Z"),
      orderStyle: "best_ioc",
      reason: "signal_exit",
      conviction: 0.8,
      targetQuantity: 100
    },
    decisionBarIndex: 0,
    executionBarIndex: 1,
    nextBar,
    cashAvailable: 0,
    positionQuantity: 100
  });

  assert.equal(sellFill.status, "FILLED");
  assert.equal(sellFill.fillPrice, 100);

  const rejected = simulator.simulate({
    orderIntent: {
      side: "BUY",
      market: "KRW-A",
      timestamp: new Date("2024-01-01T00:00:00.000Z"),
      orderStyle: "best_ioc",
      reason: "entry",
      conviction: 0.6,
      targetNotional: 1_000
    },
    decisionBarIndex: 0,
    executionBarIndex: 1,
    nextBar,
    cashAvailable: 1_000,
    positionQuantity: 0
  });

  assert.equal(rejected.status, "REJECTED");
  assert.equal(rejected.reason, "below_min_order_notional");
});
