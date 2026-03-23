import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assemblePortfolioFromBlocks,
  isAssembledPortfolioStrategyName,
  ASSEMBLED_PORTFOLIO_PREFIX
} from "../src/auto-research/portfolio-assembler.js";
import type { ValidatedBlock, ValidatedBlockCatalog } from "../src/auto-research/types.js";

function makeBlock(overrides?: Partial<ValidatedBlock>): ValidatedBlock {
  return {
    blockId: "block:rotation-15m-trend-up-abc123",
    strategyType: "block:rotation-15m-trend-up",
    strategyName: "block:rotation-15m-trend-up",
    decisionTimeframe: "15m",
    executionTimeframe: "5m",
    family: "trend",
    sleeveId: "trend",
    regimeGate: {
      allowedRegimes: ["trend_up"],
      gateMinRiskOnScore: 0.04,
      gateMinTrendScore: 0.02,
      gateMinAboveTrendRatio: 0.58,
      gateMinLiquidityScore: 0.04
    },
    parameters: {
      rebalanceBars: 5,
      entryFloor: 0.78,
      exitFloor: 0.56,
      switchGap: 0.12,
      minAboveTrendRatio: 0.68,
      minLiquidityScore: 0.07,
      minCompositeTrend: 0.02
    },
    performance: {
      netReturn: 0.08,
      maxDrawdown: 0.05,
      tradeCount: 20,
      positiveWindowRatio: 0.67,
      riskAdjustedScore: 0.5
    },
    validatedAt: new Date().toISOString(),
    sourceFamilyId: "block:rotation-15m-trend-up",
    ...overrides
  };
}

function makeCatalog(blocks: ValidatedBlock[]): ValidatedBlockCatalog {
  return {
    version: 1,
    blocks,
    updatedAt: new Date().toISOString()
  };
}

describe("portfolio-assembler", () => {
  it("identifies assembled portfolio strategy names", () => {
    assert.ok(isAssembledPortfolioStrategyName(`${ASSEMBLED_PORTFOLIO_PREFIX}composition`));
    assert.ok(!isAssembledPortfolioStrategyName("portfolio:multi-tf-regime-core"));
    assert.ok(!isAssembledPortfolioStrategyName("relative-momentum-pullback"));
  });

  it("assembles a portfolio from blocks", () => {
    const trendBlock = makeBlock();
    const breakoutBlock = makeBlock({
      blockId: "block:breakout-5m-upvol-def456",
      strategyType: "block:breakout-5m-upvol",
      strategyName: "block:breakout-5m-upvol",
      decisionTimeframe: "5m",
      executionTimeframe: "1m",
      family: "breakout",
      sleeveId: "breakout",
      sourceFamilyId: "block:breakout-5m-upvol",
      regimeGate: {
        allowedRegimes: ["trend_up", "volatile"],
        gateMinRiskOnScore: 0.02,
        gateMinLiquidityScore: 0.04,
        gateMinVolatility: 0.008
      },
      parameters: {
        breakoutLookback: 20,
        strengthFloor: 0.8,
        maxExtensionAtr: 1.3,
        trailAtrMult: 2.2
      }
    });

    const catalog = makeCatalog([trendBlock, breakoutBlock]);
    const runtime = assemblePortfolioFromBlocks({
      candidateId: "test-assembled-01",
      blockCatalog: catalog,
      blockIds: [trendBlock.blockId, breakoutBlock.blockId],
      sleeveAllocations: { trend: 0.45, breakout: 0.25 },
      portfolioParams: {
        universeTopN: 9,
        maxOpenPositions: 4,
        maxCapitalUsagePct: 0.72,
        cooldownBarsAfterLoss: 8,
        minBarsBetweenEntries: 2,
        universeLookbackBars: 28,
        refreshEveryBars: 4
      }
    });

    assert.equal(runtime.strategies.length, 2);
    assert.equal(runtime.sleeves.length, 2);
    assert.ok(runtime.requiredTimeframes.includes("15m"));
    assert.ok(runtime.requiredTimeframes.includes("5m"));
    assert.equal(runtime.universeTopN, 9);
    assert.equal(runtime.maxOpenPositions, 4);
    assert.ok(runtime.maxCapitalUsagePct <= 0.72);
    assert.ok(runtime.label.includes("test-assembled-01"));
  });

  it("throws when block not found in catalog", () => {
    const catalog = makeCatalog([]);
    assert.throws(
      () =>
        assemblePortfolioFromBlocks({
          candidateId: "test",
          blockCatalog: catalog,
          blockIds: ["nonexistent"],
          sleeveAllocations: {},
          portfolioParams: {
            universeTopN: 9,
            maxOpenPositions: 4,
            maxCapitalUsagePct: 0.72,
            cooldownBarsAfterLoss: 8,
            minBarsBetweenEntries: 2,
            universeLookbackBars: 28,
            refreshEveryBars: 4
          }
        }),
      /Block not found/
    );
  });

  it("scales budgets down when exceeding maxCapitalUsagePct", () => {
    const block = makeBlock();
    const catalog = makeCatalog([block]);
    const runtime = assemblePortfolioFromBlocks({
      candidateId: "test",
      blockCatalog: catalog,
      blockIds: [block.blockId],
      sleeveAllocations: { trend: 0.9 },
      portfolioParams: {
        universeTopN: 9,
        maxOpenPositions: 3,
        maxCapitalUsagePct: 0.5,
        cooldownBarsAfterLoss: 8,
        minBarsBetweenEntries: 2,
        universeLookbackBars: 28,
        refreshEveryBars: 4
      }
    });

    const totalBudget = runtime.sleeves.reduce((s, sl) => s + sl.capitalBudgetPct, 0);
    assert.ok(totalBudget <= 0.5 + 0.001, `Total budget ${totalBudget} should be <= 0.5`);
  });
});
