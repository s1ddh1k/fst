import test from "node:test";
import assert from "node:assert/strict";
import { createMarketPolicyCache } from "../src/market-policy-cache.js";

test("market policy cache returns upbit KRW constraints and refreshes tick size by price", () => {
  const cache = createMarketPolicyCache({
    minOrderNotional: 5_000,
    takerFeeRate: 0.001
  });

  const low = cache.get("KRW-XRP", 999);
  const high = cache.get("KRW-BTC", 100_000);

  assert.equal(low.minOrderNotional, 5_000);
  assert.equal(low.tickSize, 0.1);
  assert.equal(high.tickSize, 50);
  assert.equal(cache.roundPrice(100.01, "BUY"), 100.1);
});
