import test from "node:test";
import assert from "node:assert/strict";
import { OrderStateMachine } from "../../../packages/shared/src/execution.ts";
import { reconcileOrderStates } from "../src/live-reconciliation.js";

test("paper/live reconciliation uses shared order state machine snapshots", () => {
  const machine = new OrderStateMachine();
  machine.apply({
    type: "ORDER_CREATED",
    at: new Date("2024-01-01T00:00:00.000Z"),
    orderId: "ord-1",
    market: "KRW-BTC",
    side: "BUY"
  });
  machine.apply({
    type: "ORDER_SUBMITTED",
    at: new Date("2024-01-01T00:00:01.000Z"),
    orderId: "ord-1"
  });

  const result = reconcileOrderStates({
    localOrders: machine.snapshot(),
    exchangeOpenOrderIds: ["ord-2"]
  });

  assert.deepEqual(result.missingLocalOrders, ["ord-2"]);
  assert.deepEqual(result.staleOpenOrders, ["ord-1"]);
});
