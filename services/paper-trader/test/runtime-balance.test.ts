import test from "node:test";
import assert from "node:assert/strict";
import {
  applyPaperSellNetValue,
  resolveAvailablePaperCash
} from "../src/runtime-balance.js";

test("resolveAvailablePaperCash restores current balance when flat", () => {
  const cash = resolveAvailablePaperCash({
    startingBalance: 1_000_000,
    currentBalance: 1_075_000,
    openNotional: 0
  });

  assert.equal(cash, 1_075_000);
});

test("resolveAvailablePaperCash excludes open position notional on resume", () => {
  const cash = resolveAvailablePaperCash({
    startingBalance: 1_000_000,
    currentBalance: 1_050_000,
    openNotional: 800_000
  });

  assert.equal(cash, 250_000);
});

test("applyPaperSellNetValue preserves leftover cash and adds sell proceeds", () => {
  const nextCash = applyPaperSellNetValue(250_000, 780_000);

  assert.equal(nextCash, 1_030_000);
});
