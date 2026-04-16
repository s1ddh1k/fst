import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEvaluationAnalysis,
  buildBlockReviewPrompt,
  buildProposalPrompt,
  buildPortfolioCompositionReviewPrompt,
  buildReviewPrompt,
  type AutoResearchRunConfig,
  type CandidateBacktestEvaluation,
  type ProposalBatch,
  type ResearchIterationRecord,
  type StrategyFamilyDefinition,
  type ValidatedBlockCatalog
} from "../src/auto-research/index.js";

const BASE_CONFIG: AutoResearchRunConfig = {
  universeName: "krw-top",
  timeframe: "1h",
  marketLimit: 5,
  limit: 500,
  holdoutDays: 30,
  trainingDays: 60,
  stepDays: 30,
  iterations: 2,
  candidatesPerIteration: 3,
  parallelism: 2,
  mode: "walk-forward",
  llmProvider: "codex",
  llmModel: "medium",
  llmTimeoutMs: 120000,
  outputDir: "/tmp/fst-prompt-builder-test",
  allowDataCollection: false,
  allowFeatureCacheBuild: false,
  allowCodeMutation: false
};

const BASE_FAMILY: StrategyFamilyDefinition = {
  familyId: "relative-momentum-pullback",
  strategyName: "relative-momentum-pullback",
  title: "Relative Momentum Pullback",
  thesis: "Test family",
  timeframe: "1h",
  requiredData: ["1h"],
  parameterSpecs: [{
    name: "minStrengthPct",
    description: "strength floor",
    min: 0.5,
    max: 0.95
  }],
  guardrails: []
};

const BASE_PROPOSAL: ProposalBatch = {
  researchSummary: "test",
  preparation: [],
  proposedFamilies: [],
  codeTasks: [],
  candidates: [{
    candidateId: "candidate-01",
    familyId: BASE_FAMILY.familyId,
    thesis: "test",
    parameters: {
      minStrengthPct: 0.8
    },
    invalidationSignals: []
  }]
};

const BASE_BLOCK_CATALOG: ValidatedBlockCatalog = {
  generatedAt: "2026-03-21T00:00:00.000Z",
  universeName: "krw-top",
  mode: "walk-forward",
  blocks: []
};

function makeEvaluation(): CandidateBacktestEvaluation {
  return {
    candidate: {
      candidateId: "candidate-01",
      familyId: BASE_FAMILY.familyId,
      strategyName: BASE_FAMILY.strategyName,
      thesis: "test",
      parameters: {
        minStrengthPct: 0.8
      },
      invalidationSignals: [],
      origin: "llm"
    },
    mode: "walk-forward",
    status: "completed",
    summary: {
      totalReturn: 0.04,
      grossReturn: 0.05,
      netReturn: 0.04,
      maxDrawdown: 0.03,
      turnover: 1.2,
      winRate: 0.55,
      avgHoldBars: 12,
      tradeCount: 12,
      feePaid: 0.003,
      slippagePaid: 0.001,
      rejectedOrdersCount: 0,
      cooldownSkipsCount: 0,
      signalCount: 18,
      ghostSignalCount: 0,
      buyAndHoldReturn: 0.01
    },
    diagnostics: {
      coverage: {
        tradeCount: 12,
        signalCount: 18,
        ghostSignalCount: 0,
        rejectedOrdersCount: 0,
        cooldownSkipsCount: 0,
        rawBuySignals: 18,
        rawSellSignals: 12,
        rawHoldSignals: 30,
        avgUniverseSize: 10,
        minUniverseSize: 8,
        maxUniverseSize: 12,
        avgConsideredBuys: 5,
        avgEligibleBuys: 3
      },
      reasons: {
        strategy: {},
        strategyTags: {},
        coordinator: {},
        execution: {},
        risk: {}
      },
      costs: {
        feePaid: 0.003,
        slippagePaid: 0.001,
        totalCostsPaid: 0.004
      },
      robustness: {},
      crossChecks: [],
      windows: {
        mode: "walk-forward",
        holdoutDays: 30,
        trainingDays: 60,
        stepDays: 30,
        windowCount: 4,
        positiveWindowCount: 3,
        positiveWindowRatio: 0.75,
        negativeWindowCount: 1,
        bestWindowNetReturn: 0.03,
        worstWindowNetReturn: -0.01,
        bestWindowMaxDrawdown: 0.01,
        worstWindowMaxDrawdown: 0.04,
        totalClosedTrades: 12
      }
    }
  };
}

function makeIteration(evaluations: CandidateBacktestEvaluation[]): ResearchIterationRecord {
  return {
    iteration: 1,
    proposal: BASE_PROPOSAL,
    preparationResults: [],
    codeMutationResults: [],
    validationResults: [],
    evaluations,
    review: {
      summary: "keep searching",
      verdict: "keep_searching",
      nextPreparation: [],
      proposedFamilies: [],
      codeTasks: [],
      nextCandidates: [],
      retireCandidateIds: [],
      observations: []
    }
  };
}

function assertPromptFrontAndBack(prompt: string): void {
  const frontNeedle = 'Choose "keep_searching" when you can provide 1 to 3 concrete nextCandidates.';
  const backNeedle = "Final response reminder: when verdict=keep_searching, fill nextCandidates with unique, executable candidates.";
  const factsNeedle = "Structured run facts:";

  const frontIndex = prompt.indexOf(frontNeedle);
  const factsIndex = prompt.indexOf(factsNeedle);
  const backIndex = prompt.lastIndexOf(backNeedle);

  assert.notEqual(frontIndex, -1);
  assert.notEqual(backIndex, -1);
  assert.notEqual(factsIndex, -1);
  assert.ok(frontIndex < factsIndex);
  assert.ok(backIndex > factsIndex);
}

test("review prompts place nextCandidates contract at the front and the end", () => {
  const common = {
    config: BASE_CONFIG,
    families: [BASE_FAMILY],
    history: [],
    latestProposal: BASE_PROPOSAL,
    preparationResults: [],
    codeMutationResults: [],
    validationResults: [],
    evaluations: []
  };

  assertPromptFrontAndBack(buildReviewPrompt(common));
  assertPromptFrontAndBack(buildBlockReviewPrompt(common));
  assertPromptFrontAndBack(buildPortfolioCompositionReviewPrompt({
    ...common,
    blockCatalog: BASE_BLOCK_CATALOG
  }));
});

test("buildEvaluationAnalysis derives actionable blocked-signal diagnosis", () => {
  const evaluation = makeEvaluation();
  evaluation.summary.tradeCount = 2;
  evaluation.summary.signalCount = 4;
  evaluation.summary.ghostSignalCount = 9;
  evaluation.summary.rejectedOrdersCount = 2;
  evaluation.diagnostics.coverage.tradeCount = 2;
  evaluation.diagnostics.coverage.signalCount = 4;
  evaluation.diagnostics.coverage.ghostSignalCount = 9;
  evaluation.diagnostics.coverage.rejectedOrdersCount = 2;
  evaluation.diagnostics.reasons.strategy = {
    trend_filter_blocked: 10
  };
  evaluation.diagnostics.windows.totalClosedTrades = 2;

  const analysis = buildEvaluationAnalysis(evaluation);

  assert.equal(analysis.diagnosis.primaryFailureMode, "blocked_signals");
  assert.equal(analysis.diagnosis.blockingLayer, "strategy");
  assert.match(analysis.diagnosis.summary, /blocked/i);
  assert.ok(
    analysis.diagnosis.prescriptions.some((item) =>
      item.includes("Relax the dominant strategy filters")
    )
  );
});

test("proposal and review prompts expose evaluation diagnoses for process-aware tuning", () => {
  const evaluation = makeEvaluation();
  evaluation.summary.tradeCount = 3;
  evaluation.diagnostics.windows.totalClosedTrades = 3;

  const history = [makeIteration([evaluation])];
  const proposalPrompt = buildProposalPrompt({
    config: BASE_CONFIG,
    families: [BASE_FAMILY],
    marketCodes: ["KRW-BTC"],
    history
  });
  const reviewPrompt = buildReviewPrompt({
    config: BASE_CONFIG,
    families: [BASE_FAMILY],
    history,
    latestProposal: BASE_PROPOSAL,
    preparationResults: [],
    codeMutationResults: [],
    validationResults: [],
    evaluations: [evaluation]
  });
  const portfolioPrompt = buildPortfolioCompositionReviewPrompt({
    config: BASE_CONFIG,
    families: [BASE_FAMILY],
    history,
    latestProposal: BASE_PROPOSAL,
    preparationResults: [],
    codeMutationResults: [],
    validationResults: [],
    evaluations: [evaluation],
    blockCatalog: BASE_BLOCK_CATALOG
  });

  assert.match(proposalPrompt, /recentEvaluationAnalyses/);
  assert.match(proposalPrompt, /primaryFailureMode/);
  assert.match(reviewPrompt, /latestEvaluationAnalyses/);
  assert.match(reviewPrompt, /prescriptions/);
  assert.match(portfolioPrompt, /latestEvaluationAnalyses/);
  assert.match(portfolioPrompt, /coordination, risk, or execution bottlenecks/);
});
