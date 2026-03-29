import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeLoadRange, computeLoadLimit } from "../src/auto-research/candle-loader.js";
import type { AutoResearchRunConfig } from "../src/auto-research/types.js";

describe("candle-loader", () => {
  const baseConfig = {
    holdoutDays: 90,
    trainingDays: 180,
    stepDays: 90,
    mode: "walk-forward" as const,
    limit: 38544
  };

  describe("computeLoadRange", () => {
    it("returns undefined when no test dates", () => {
      const result = computeLoadRange({ ...baseConfig } as AutoResearchRunConfig);
      assert.equal(result, undefined);
    });

    it("includes training period before test start", () => {
      const testStart = new Date("2022-01-01");
      const testEnd = new Date("2022-12-31");
      const result = computeLoadRange({
        ...baseConfig,
        testStartDate: testStart,
        testEndDate: testEnd
      } as AutoResearchRunConfig);
      assert.ok(result);
      assert.equal(result.end.toISOString(), testEnd.toISOString());
      // training = 180 days before test start
      const expectedStart = new Date(testStart.getTime() - 180 * 24 * 60 * 60 * 1000);
      assert.equal(result.start.toISOString(), expectedStart.toISOString());
    });
  });

  describe("computeLoadLimit", () => {
    it("1h uses max of config.limit and calculated minimum", () => {
      const limit = computeLoadLimit("1h", baseConfig);
      assert.ok(limit >= baseConfig.limit);
    });

    it("15m is 4x config.limit to cover same time span", () => {
      const limit = computeLoadLimit("15m", baseConfig);
      assert.ok(limit >= baseConfig.limit * 4);
    });

    it("1m is capped to 6 months", () => {
      const limit = computeLoadLimit("1m", baseConfig);
      assert.ok(limit <= 180 * 24 * 60);
    });

    it("different timeframes produce different limits", () => {
      const l1h = computeLoadLimit("1h", baseConfig);
      const l15m = computeLoadLimit("15m", baseConfig);
      const l5m = computeLoadLimit("5m", baseConfig);
      assert.ok(l15m > l1h, "15m should have higher limit than 1h");
      assert.ok(l5m > l1h, "5m should have higher limit than 1h");
    });
  });
});
