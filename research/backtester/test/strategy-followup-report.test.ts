import test from "node:test";
import assert from "node:assert/strict";
import { buildScoredStrategyNeighborGrid } from "../src/parameter-grid.js";
import { isReusableSeedRow, type FollowupRow } from "../src/strategy-followup-report.js";

function buildRow(overrides: Partial<FollowupRow> = {}): FollowupRow {
  return {
    strategyName: "relative-momentum-pullback",
    parameters: {
      minStrengthPct: 0.8,
      minRiskOn: 0.1,
      pullbackZ: 1,
      trailAtrMult: 2
    },
    windowCount: 3,
    avgTrainReturn: 0.02,
    avgTestReturn: 0.01,
    medianTestReturn: 0.008,
    executedTradeCount: 8,
    signalCount: 12,
    ghostSignalCount: 24,
    avgTurnover: 0.5,
    grossReturn: 0.012,
    netReturn: 0.01,
    feePaid: 100,
    slippagePaid: 50,
    bootstrapPassRate: 0.33,
    randomPassRate: 0,
    averageFoldTradeCount: 2.67,
    neighborPositiveRate: 0.4,
    passesSufficiency: false,
    passesPerformance: false,
    passesRobustness: false,
    promotionEligible: false,
    folds: [],
    ghostStudy: {
      horizons: [],
      bestNetHorizonBars: null
    },
    ...overrides
  };
}

test("follow-up reusable seed rows require meaningful positive edge", () => {
  assert.equal(
    isReusableSeedRow(
      buildRow({
        avgTestReturn: 0.0018,
        medianTestReturn: 0.0025,
        executedTradeCount: 2,
        neighborPositiveRate: 0.375
      })
    ),
    false
  );

  assert.equal(
    isReusableSeedRow(
      buildRow({
        avgTestReturn: 0.009,
        executedTradeCount: 6,
        bootstrapPassRate: 0.34
      })
    ),
    true
  );
});

test("scored strategy neighbor grid expands around known lattice points", () => {
  const neighbors = buildScoredStrategyNeighborGrid("relative-momentum-pullback", {
    minStrengthPct: 0.8,
    minRiskOn: 0.15,
    pullbackZ: 0.9,
    trailAtrMult: 2.2
  });

  assert.ok(neighbors.length > 0);
  assert.ok(
    neighbors.some(
      (strategy) =>
        strategy.parameters.minStrengthPct === 0.7 &&
        strategy.parameters.minRiskOn === 0.15 &&
        strategy.parameters.pullbackZ === 0.9 &&
        strategy.parameters.trailAtrMult === 2.2
    )
  );
  assert.ok(
    neighbors.every(
      (strategy) =>
        !(
          strategy.parameters.minStrengthPct === 0.8 &&
          strategy.parameters.minRiskOn === 0.15 &&
          strategy.parameters.pullbackZ === 0.9 &&
          strategy.parameters.trailAtrMult === 2.2
        )
    )
  );
});
