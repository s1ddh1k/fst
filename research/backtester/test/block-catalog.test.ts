import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createEmptyBlockCatalog,
  appendValidatedBlock,
  promoteToValidatedBlock,
  loadValidatedBlockCatalog
} from "../src/auto-research/block-catalog.js";
import type {
  CandidateBacktestEvaluation,
  StrategyFamilyDefinition,
  ValidatedBlock,
  ValidatedBlockCatalog
} from "../src/auto-research/types.js";

function makeEvaluation(overrides?: Partial<CandidateBacktestEvaluation>): CandidateBacktestEvaluation {
  return {
    candidate: {
      candidateId: "test-candidate-01",
      familyId: "block:rotation-1h-trend-up",
      strategyName: "block:rotation-1h-trend-up",
      thesis: "test",
      parameters: {
        rebalanceBars: 5,
        entryFloor: 0.78,
        exitFloor: 0.56,
        switchGap: 0.12,
        minAboveTrendRatio: 0.68,
        minLiquidityScore: 0.07,
        minCompositeTrend: 0.02,
        gateMinRiskOnScore: 0.04,
        gateMinTrendScore: 0.02,
        gateMinAboveTrendRatio: 0.58,
        gateMinLiquidityScore: 0.04
      },
      invalidationSignals: []
    },
    mode: "walk-forward",
    status: "completed",
    summary: {
      totalReturn: 0.08,
      grossReturn: 0.1,
      netReturn: 0.08,
      maxDrawdown: 0.05,
      turnover: 0.3,
      winRate: 0.55,
      avgHoldBars: 12,
      tradeCount: 20,
      feePaid: 0.01,
      slippagePaid: 0.01,
      rejectedOrdersCount: 0,
      cooldownSkipsCount: 0,
      signalCount: 100,
      ghostSignalCount: 5
    },
    diagnostics: {
      coverage: {
        tradeCount: 20,
        signalCount: 100,
        ghostSignalCount: 5,
        rejectedOrdersCount: 0,
        cooldownSkipsCount: 0,
        rawBuySignals: 50,
        rawSellSignals: 50,
        rawHoldSignals: 0,
        avgUniverseSize: 8,
        minUniverseSize: 5,
        maxUniverseSize: 10,
        avgConsideredBuys: 0,
        avgEligibleBuys: 0
      },
      reasons: {
        strategy: {},
        strategyTags: {},
        coordinator: {},
        execution: {},
        risk: {}
      },
      costs: { feePaid: 0.01, slippagePaid: 0.01, totalCostsPaid: 0.02 },
      robustness: {},
      crossChecks: [],
      windows: {
        mode: "walk-forward",
        holdoutDays: 14,
        windowCount: 3,
        positiveWindowRatio: 0.67,
        positiveWindowCount: 2,
        negativeWindowCount: 1,
        totalClosedTrades: 20
      }
    },
    ...overrides
  };
}

function makeFamilyDef(): StrategyFamilyDefinition {
  return {
    familyId: "block:rotation-1h-trend-up",
    strategyName: "block:rotation-1h-trend-up",
    title: "15m Rotation Block",
    thesis: "test",
    timeframe: "15m",
    requiredData: ["15m", "5m"],
    parameterSpecs: [],
    guardrails: []
  };
}

describe("block-catalog", () => {
  it("creates an empty catalog", () => {
    const catalog = createEmptyBlockCatalog();
    assert.equal(catalog.version, 1);
    assert.equal(catalog.blocks.length, 0);
    assert.ok(catalog.updatedAt);
  });

  it("promotes evaluation to ValidatedBlock", async () => {
    const evaluation = makeEvaluation();
    const block = await promoteToValidatedBlock({
      evaluation,
      familyDef: makeFamilyDef(),
      blockFamilyId: "block:rotation-1h-trend-up"
    });
    assert.ok(block.blockId.startsWith("block:rotation-1h-trend-up:"));
    assert.equal(block.decisionTimeframe, "15m");
    assert.equal(block.executionTimeframe, "5m");
    assert.equal(block.family, "trend");
    assert.equal(block.performance.netReturn, 0.08);
    assert.equal(block.performance.tradeCount, 20);
    assert.deepEqual(block.regimeGate.allowedRegimes, ["trend_up"]);
    assert.equal(block.sourceFamilyId, "block:rotation-1h-trend-up");
  });

  it("appends block to catalog", async () => {
    const catalog = createEmptyBlockCatalog();
    const block = await promoteToValidatedBlock({
      evaluation: makeEvaluation(),
      familyDef: makeFamilyDef(),
      blockFamilyId: "block:rotation-1h-trend-up"
    });
    const updated = appendValidatedBlock(catalog, block);
    assert.equal(updated.blocks.length, 1);
    assert.equal(updated.blocks[0]!.sourceFamilyId, "block:rotation-1h-trend-up");
  });

  it("replaces block when better score found for same family", async () => {
    let catalog = createEmptyBlockCatalog();
    const block1 = await promoteToValidatedBlock({
      evaluation: makeEvaluation(),
      familyDef: makeFamilyDef(),
      blockFamilyId: "block:rotation-1h-trend-up"
    });
    catalog = appendValidatedBlock(catalog, block1);

    const betterEval = makeEvaluation({
      summary: {
        ...makeEvaluation().summary,
        netReturn: 0.15,
        tradeCount: 30
      }
    });
    const block2 = await promoteToValidatedBlock({
      evaluation: betterEval,
      familyDef: makeFamilyDef(),
      blockFamilyId: "block:rotation-1h-trend-up"
    });
    catalog = appendValidatedBlock(catalog, block2);

    assert.equal(catalog.blocks.length, 1);
    assert.equal(catalog.blocks[0]!.performance.netReturn, 0.15);
  });

  it("serializes and deserializes catalog", async () => {
    let catalog = createEmptyBlockCatalog();
    const block = await promoteToValidatedBlock({
      evaluation: makeEvaluation(),
      familyDef: makeFamilyDef(),
      blockFamilyId: "block:rotation-1h-trend-up"
    });
    catalog = appendValidatedBlock(catalog, block);

    const json = JSON.stringify(catalog);
    const restored = loadValidatedBlockCatalog(json);
    assert.equal(restored.blocks.length, 1);
    assert.equal(restored.blocks[0]!.blockId, block.blockId);
  });
});
