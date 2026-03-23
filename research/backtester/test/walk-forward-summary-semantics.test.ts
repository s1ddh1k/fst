import test from "node:test";
import assert from "node:assert/strict";

import {
  compareCandidateEvaluations,
  passesPromotionGate,
  summarizeEvaluationRanking
} from "../src/auto-research/ranking.js";
import { promoteToValidatedBlock } from "../src/auto-research/block-catalog.js";
import type {
  CandidateBacktestEvaluation,
  NormalizedCandidateProposal,
  StrategyFamilyDefinition
} from "../src/auto-research/types.js";

function buildCandidate(candidateId: string): NormalizedCandidateProposal {
  return {
    candidateId,
    familyId: "block:bb-reversion-1h-daily",
    strategyName: "bollinger-mean-reversion",
    thesis: candidateId,
    parameters: {
      bbWindow: 72,
      bbMultiplier: 2.4
    },
    invalidationSignals: []
  };
}

function buildWalkForwardEvaluation(params?: {
  candidateId?: string;
  netReturn?: number;
  averageTradeCount?: number;
  totalClosedTrades?: number;
  averageMaxDrawdown?: number;
  worstWindowMaxDrawdown?: number;
  positiveWindowRatio?: number;
  worstWindowNetReturn?: number;
}): CandidateBacktestEvaluation {
  const candidate = buildCandidate(params?.candidateId ?? "wf");

  return {
    candidate,
    mode: "walk-forward",
    status: "completed",
    summary: {
      totalReturn: params?.netReturn ?? 0.08,
      grossReturn: (params?.netReturn ?? 0.08) + 0.01,
      netReturn: params?.netReturn ?? 0.08,
      maxDrawdown: params?.averageMaxDrawdown ?? 0.05,
      turnover: 0.22,
      winRate: 0.48,
      avgHoldBars: 14,
      tradeCount: params?.averageTradeCount ?? 2,
      feePaid: 1200,
      slippagePaid: 800,
      rejectedOrdersCount: 1,
      cooldownSkipsCount: 2,
      signalCount: 44,
      ghostSignalCount: 60,
      bootstrapSignificant: true,
      randomPercentile: 0.84
    },
    diagnostics: {
      coverage: {
        tradeCount: params?.totalClosedTrades ?? 12,
        signalCount: 44,
        ghostSignalCount: 60,
        rejectedOrdersCount: 1,
        cooldownSkipsCount: 2,
        rawBuySignals: 18,
        rawSellSignals: 12,
        rawHoldSignals: 14,
        avgUniverseSize: 6.5,
        minUniverseSize: 4,
        maxUniverseSize: 9,
        avgConsideredBuys: 1.1,
        avgEligibleBuys: 0.7
      },
      reasons: {
        strategy: {},
        strategyTags: {},
        coordinator: {},
        execution: {},
        risk: {}
      },
      costs: {
        feePaid: 1200,
        slippagePaid: 800,
        totalCostsPaid: 2000
      },
      robustness: {
        bootstrapSignificant: true,
        randomPercentile: 0.84
      },
      crossChecks: [],
      windows: {
        mode: "walk-forward",
        holdoutDays: 90,
        trainingDays: 180,
        stepDays: 90,
        windowCount: 4,
        positiveWindowCount: Math.round((params?.positiveWindowRatio ?? 0.75) * 4),
        positiveWindowRatio: params?.positiveWindowRatio ?? 0.75,
        negativeWindowCount: 1,
        bestWindowNetReturn: 0.12,
        worstWindowNetReturn: params?.worstWindowNetReturn ?? -0.02,
        bestWindowMaxDrawdown: 0.02,
        worstWindowMaxDrawdown: params?.worstWindowMaxDrawdown ?? 0.18,
        totalClosedTrades: params?.totalClosedTrades ?? 12
      }
    }
  };
}

test("promotion gate uses total OOS trades and worst window drawdown for walk-forward evaluations", () => {
  const evaluation = buildWalkForwardEvaluation({
    averageTradeCount: 2,
    totalClosedTrades: 12,
    averageMaxDrawdown: 0.04,
    worstWindowMaxDrawdown: 0.27
  });

  assert.equal(
    passesPromotionGate(evaluation, {
      minTrades: 10,
      minNetReturn: 0.03,
      maxDrawdown: 0.2,
      minPositiveWindowRatio: 0.5,
      minRandomPercentile: 0.6,
      requireBootstrapSignificance: true
    }),
    false
  );

  evaluation.diagnostics.windows.worstWindowMaxDrawdown = 0.19;

  assert.equal(
    passesPromotionGate(evaluation, {
      minTrades: 10,
      minNetReturn: 0.03,
      maxDrawdown: 0.2,
      minPositiveWindowRatio: 0.5,
      minRandomPercentile: 0.6,
      requireBootstrapSignificance: true
    }),
    true
  );
});

test("ranking summaries and ordering use aggregate walk-forward semantics instead of per-window averages", () => {
  const robust = buildWalkForwardEvaluation({
    candidateId: "robust",
    netReturn: 0.075,
    averageTradeCount: 2.5,
    totalClosedTrades: 10,
    averageMaxDrawdown: 0.04,
    worstWindowMaxDrawdown: 0.11,
    positiveWindowRatio: 0.75,
    worstWindowNetReturn: -0.012
  });
  const fragile = buildWalkForwardEvaluation({
    candidateId: "fragile",
    netReturn: 0.075,
    averageTradeCount: 2.5,
    totalClosedTrades: 10,
    averageMaxDrawdown: 0.03,
    worstWindowMaxDrawdown: 0.29,
    positiveWindowRatio: 0.75,
    worstWindowNetReturn: -0.012
  });

  const fragileSummary = summarizeEvaluationRanking(fragile);
  assert.equal(fragileSummary.tradeCount, 10);
  assert.equal(fragileSummary.totalClosedTrades, 10);
  assert.equal(fragileSummary.maxDrawdown, 0.29);
  assert.ok(compareCandidateEvaluations(robust, fragile) < 0);
});

test("validated block catalog stores walk-forward OOS trade count and worst drawdown", async () => {
  const evaluation = buildWalkForwardEvaluation({
    totalClosedTrades: 14,
    averageTradeCount: 3.5,
    averageMaxDrawdown: 0.05,
    worstWindowMaxDrawdown: 0.23
  });
  const familyDef: StrategyFamilyDefinition = {
    familyId: "block:bb-reversion-1h-daily",
    strategyName: "bollinger-mean-reversion",
    title: "BB Daily",
    thesis: "bb",
    timeframe: "1h",
    requiredData: ["1h", "5m"],
    parameterSpecs: [],
    guardrails: []
  };

  const promoted = await promoteToValidatedBlock({
    evaluation,
    familyDef,
    blockFamilyId: familyDef.familyId
  });

  assert.equal(promoted.performance.tradeCount, 14);
  assert.equal(promoted.performance.maxDrawdown, 0.23);
  assert.equal(promoted.performance.netReturn, evaluation.summary.netReturn);
});
