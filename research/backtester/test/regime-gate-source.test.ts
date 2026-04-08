import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Strategy, StrategyContext } from "../../../packages/shared/src/index.js";
import { withRegimeGate } from "../src/multi-strategy/RegimeGatedStrategy.js";
import { createRelativeStrengthRotationStrategy } from "../src/multi-strategy/RelativeStrengthRotationStrategy.js";

function createBaseContext(overrides?: Partial<StrategyContext>): StrategyContext {
  return {
    strategyId: "test-strategy",
    market: "KRW-ETH",
    decisionTime: new Date("2026-03-30T00:00:00.000Z"),
    decisionTimeframe: "1h",
    executionTimeframe: "1h",
    featureView: {
      candles: [],
      decisionIndex: 4,
      executionIndex: 4,
      trailingCandles: []
    },
    marketState: {
      breadth: {
        riskOnScore: 0.1,
        aboveTrendRatio: 0.2,
        liquidityScore: 0.8,
        dispersionScore: 0
      },
      composite: {
        regime: "range",
        trendScore: -0.1,
        historicalVolatility: 0.03
      },
      benchmark: {
        regime: "trend_down",
        trendScore: -0.4,
        historicalVolatility: 0.02
      },
      relativeStrength: {
        momentumPercentile: 0.95,
        returnPercentile: 0.95,
        compositeMomentumSpread: 0.3
      }
    },
    ...overrides
  };
}

describe("regime gate source selection", () => {
  it("uses benchmark regime when requested", () => {
    const strategy: Strategy = {
      id: "always-buy",
      sleeveId: "trend",
      family: "trend",
      decisionTimeframe: "1h",
      executionTimeframe: "1h",
      parameters: {},
      generateSignal(context) {
        return {
          strategyId: "always-buy",
          sleeveId: "trend",
          family: "trend",
          market: context.market,
          signal: "BUY",
          conviction: 0.9,
          decisionTime: context.decisionTime,
          decisionTimeframe: "1h",
          executionTimeframe: "1h",
          reason: "always_buy",
          stages: {
            universe_eligible: true,
            trigger_pass: true
          }
        };
      }
    };

    const gated = withRegimeGate({
      strategy,
      gate: {
        regimeSource: "benchmark",
        allowedRegimes: ["trend_down"]
      }
    });

    const signal = gated.generateSignal(createBaseContext());
    assert.equal(signal.signal, "BUY");
    assert.equal(signal.metadata?.regimeGateSource, "benchmark");
    assert.equal(signal.metadata?.regimeGateRegime, "trend_down");
  });

  it("rotation can skip internal regime gate when an external benchmark gate already filtered it", () => {
    const strategy = createRelativeStrengthRotationStrategy({
      strategyId: "rotation-test",
      rebalanceBars: 4,
      entryFloor: 0.7,
      exitFloor: 0.4,
      switchGap: 0.05,
      minAboveTrendRatio: 0.55,
      minLiquidityScore: 0.05,
      minCompositeTrend: 0,
      skipInternalRegimeCheck: true
    });

    const signal = strategy.generateSignal(createBaseContext());
    assert.equal(signal.signal, "BUY");
    assert.equal(signal.stages.regime_pass, true);
  });
});
