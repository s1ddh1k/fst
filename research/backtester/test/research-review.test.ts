import test from "node:test";
import assert from "node:assert/strict";
import { getStrategyFamilies, normalizeCandidateProposal } from "../src/auto-research/catalog.js";
import { generateIterationReview } from "../src/auto-research/research-review.js";
import type {
  AutoResearchRunConfig,
  CandidateBacktestEvaluation,
  NormalizedCandidateProposal
} from "../src/auto-research/types.js";

function buildConfig(overrides: Partial<AutoResearchRunConfig> = {}): AutoResearchRunConfig {
  return {
    strategyFamilyIds: overrides.strategyFamilyIds,
    universeName: "krw-top",
    timeframe: "1h",
    marketLimit: 3,
    limit: 2_000,
    holdoutDays: 30,
    trainingDays: 90,
    stepDays: 30,
    iterations: 2,
    candidatesPerIteration: 2,
    parallelism: 1,
    mode: "holdout",
    outputDir: "/tmp/fst-research-review-test",
    allowDataCollection: false,
    allowFeatureCacheBuild: false,
    allowCodeMutation: false,
    ...overrides
  };
}

function buildEvaluation(candidate: NormalizedCandidateProposal, netReturn: number): CandidateBacktestEvaluation {
  return {
    candidate,
    mode: "holdout",
    status: "completed",
    summary: {
      totalReturn: netReturn,
      grossReturn: netReturn + 0.01,
      netReturn,
      maxDrawdown: 0.03,
      turnover: 0.2,
      winRate: 0.5,
      avgHoldBars: 8,
      tradeCount: 5,
      feePaid: 10,
      slippagePaid: 10,
      rejectedOrdersCount: 0,
      cooldownSkipsCount: 0,
      signalCount: 4,
      ghostSignalCount: 4,
      bootstrapPValue: 0.04,
      bootstrapSignificant: true,
      randomPercentile: 0.9
    },
    diagnostics: {
      coverage: {
        tradeCount: 5,
        signalCount: 4,
        ghostSignalCount: 4,
        rejectedOrdersCount: 0,
        cooldownSkipsCount: 0,
        rawBuySignals: 6,
        rawSellSignals: 3,
        rawHoldSignals: 2,
        avgUniverseSize: 4,
        minUniverseSize: 3,
        maxUniverseSize: 5,
        avgConsideredBuys: 1,
        avgEligibleBuys: 1
      },
      reasons: {
        strategy: {},
        strategyTags: {},
        coordinator: {},
        execution: {},
        risk: {}
      },
      costs: {
        feePaid: 10,
        slippagePaid: 10,
        totalCostsPaid: 20
      },
      robustness: {
        bootstrapPValue: 0.04,
        bootstrapSignificant: true,
        randomPercentile: 0.9
      },
      crossChecks: [],
      windows: {
        mode: "holdout",
        holdoutDays: 30,
        positiveWindowRatio: 0.5
      }
    }
  };
}

test("research review rejects empty keep_searching batches", async () => {
  const family = getStrategyFamilies(["relative-momentum-pullback"])[0]!;
  const candidate = normalizeCandidateProposal(
    {
      familyId: family.familyId,
      thesis: "base",
      parameters: {
        minStrengthPct: 0.8,
        minRiskOn: 0.1,
        pullbackZ: 1,
        trailAtrMult: 2.2
      },
      invalidationSignals: []
    },
    [family],
    0
  );

  await assert.rejects(
    () => generateIterationReview({
      llmClient: {
        async proposeCandidates() {
          throw new Error("not used");
        },
        async reviewIteration() {
          return {
            summary: "keep searching",
            verdict: "keep_searching",
            nextPreparation: [],
            proposedFamilies: [],
            codeTasks: [],
            nextCandidates: [],
            retireCandidateIds: [],
            observations: []
          };
        }
      },
      config: buildConfig({
        strategyFamilyIds: [family.familyId]
      }),
      families: [family],
      history: [],
      proposal: {
        researchSummary: "proposal",
        preparation: [],
        proposedFamilies: [],
        codeTasks: [],
        candidates: [
          {
            candidateId: candidate.candidateId,
            familyId: candidate.familyId,
            thesis: candidate.thesis,
            parameters: candidate.parameters,
            invalidationSignals: candidate.invalidationSignals,
            parentCandidateIds: candidate.parentCandidateIds,
            origin: candidate.origin
          }
        ]
      },
      evaluations: [buildEvaluation(candidate, 0.02)],
      preparationResults: [],
      codeMutationResults: [],
      validationResults: [],
      iteration: 1
    }),
    /keep_searching without any unique next candidates/
  );
});

test("research review keeps a valid LLM promotion decision", async () => {
  const family = getStrategyFamilies(["relative-momentum-pullback"])[0]!;
  const candidate = normalizeCandidateProposal(
    {
      candidateId: "llm-pick-1",
      familyId: family.familyId,
      thesis: "base",
      parameters: {
        minStrengthPct: 0.8,
        minRiskOn: 0.1,
        pullbackZ: 1,
        trailAtrMult: 2.2
      },
      invalidationSignals: []
    },
    [family],
    0
  );

  const result = await generateIterationReview({
    llmClient: {
      async proposeCandidates() {
        throw new Error("not used");
      },
      async reviewIteration() {
        return {
          summary: "promote the strongest hypothesis",
          verdict: "promote_candidate",
          promotedCandidateId: candidate.candidateId,
          nextPreparation: [],
          proposedFamilies: [],
          codeTasks: [],
          nextCandidates: [],
          retireCandidateIds: [],
          observations: []
        };
      }
    },
    config: buildConfig({
      strategyFamilyIds: [family.familyId],
      minTradesForPromotion: 20,
      minNetReturnForPromotion: 0.1
    }),
    families: [family],
    history: [],
    proposal: {
      researchSummary: "proposal",
      preparation: [],
      proposedFamilies: [],
      codeTasks: [],
      candidates: [
        {
          candidateId: candidate.candidateId,
          familyId: candidate.familyId,
          thesis: candidate.thesis,
          parameters: candidate.parameters,
          invalidationSignals: candidate.invalidationSignals,
          parentCandidateIds: candidate.parentCandidateIds,
          origin: candidate.origin
        }
      ]
    },
    evaluations: [buildEvaluation(candidate, 0.02)],
    preparationResults: [],
    codeMutationResults: [],
    validationResults: [],
    iteration: 1
  });

  assert.equal(result.review.verdict, "promote_candidate");
  assert.equal(result.review.promotedCandidateId, candidate.candidateId);
});
