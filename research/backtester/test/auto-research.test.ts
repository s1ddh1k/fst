import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  calculateAutoResearchMinimumLimit,
  calculateCandidateRiskAdjustedScore,
  compareCandidateEvaluations,
  createAutoResearchOrchestrator,
  createComposedScoredStrategy,
  getStrategyFamilies,
  loadLineageSnapshot,
  passesPromotionGate,
  writeAutoResearchArtifactAudit,
  type AutoResearchRunConfig,
  type ResearchLlmClient,
  type CandidateBacktestEvaluation,
  type NormalizedCandidateProposal
} from "../src/auto-research/index.js";
import { resolveCandidateMarketRequirements } from "../src/auto-research/orchestrator.js";

function buildEvaluation(candidate: NormalizedCandidateProposal, netReturn: number): CandidateBacktestEvaluation {
  return {
    candidate,
    mode: "holdout",
    status: "completed",
    summary: {
      totalReturn: netReturn,
      grossReturn: netReturn + 0.01,
      netReturn,
      maxDrawdown: 0.05,
      turnover: 0.3,
      winRate: 0.5,
      avgHoldBars: 10,
      tradeCount: 4,
      feePaid: 10,
      slippagePaid: 15,
      rejectedOrdersCount: 0,
      cooldownSkipsCount: 0,
      signalCount: 6,
      ghostSignalCount: 12,
      bootstrapPValue: 0.04,
      bootstrapSignificant: true,
      randomPercentile: 0.93
    },
    diagnostics: {
      coverage: {
        tradeCount: 4,
        signalCount: 6,
        ghostSignalCount: 12,
        rejectedOrdersCount: 0,
        cooldownSkipsCount: 0,
        rawBuySignals: 10,
        rawSellSignals: 4,
        rawHoldSignals: 86,
        avgUniverseSize: 7.5,
        minUniverseSize: 5,
        maxUniverseSize: 10,
        avgConsideredBuys: 1.2,
        avgEligibleBuys: 0.8
      },
      reasons: {
        strategy: { trend_regime_not_aligned: 14 },
        strategyTags: { leader_strength_below_floor: 10 },
        coordinator: { ranked_out_by_single_position: 3 },
        execution: { below_min_order_notional: 1 },
        risk: { target_weight_zero: 0 }
      },
      costs: {
        feePaid: 10,
        slippagePaid: 15,
        totalCostsPaid: 25
      },
      robustness: {
        bootstrapPValue: 0.04,
        bootstrapSignificant: true,
        randomPercentile: 0.93
      },
      crossChecks: [
        {
          mode: "walk-forward",
          status: "completed",
          netReturn: netReturn - 0.01,
          maxDrawdown: 0.06,
          tradeCount: 3,
          bootstrapSignificant: true,
          randomPercentile: 0.88,
          windowCount: 4
        }
      ],
      windows: {
        mode: "holdout",
        holdoutDays: 365,
        trainStartAt: "2024-01-01T00:00:00.000Z",
        trainEndAt: "2024-12-31T00:00:00.000Z",
        testStartAt: "2025-01-01T00:00:00.000Z",
        testEndAt: "2025-12-31T00:00:00.000Z"
      }
    },
    rawSummary: {
      backtestRunId: 1,
      strategyName: candidate.strategyName,
      marketCode: "UNIVERSE:krw-top",
      timeframe: "1h",
      holdoutDays: 365,
      trainRange: { start: new Date("2024-01-01T00:00:00.000Z"), end: new Date("2024-12-31T00:00:00.000Z") },
      testRange: { start: new Date("2025-01-01T00:00:00.000Z"), end: new Date("2025-12-31T00:00:00.000Z") },
      train: {
        initialCapital: 1_000_000,
        finalCapital: 1_010_000,
        totalReturn: 0.01,
        grossReturn: 0.01,
        netReturn: 0.01,
        maxDrawdown: 0.03,
        tradeCount: 4,
        winRate: 0.5,
        turnover: 0.2,
        avgHoldBars: 8,
        feePaid: 10,
        slippagePaid: 10,
        rejectedOrdersCount: 0,
        cooldownSkipsCount: 0
      },
      test: {
        initialCapital: 1_000_000,
        finalCapital: 1_015_000,
        totalReturn: netReturn,
        grossReturn: netReturn,
        netReturn,
        maxDrawdown: 0.05,
        tradeCount: 4,
        winRate: 0.5,
        turnover: 0.3,
        avgHoldBars: 10,
        feePaid: 10,
        slippagePaid: 15,
        rejectedOrdersCount: 0,
        cooldownSkipsCount: 0
      },
      parameters: candidate.parameters,
      scoredTrain: {} as never,
      scoredTest: {
        signalCount: 6,
        ghostSignalCount: 12,
        bootstrap: { pValue: 0.04, isSignificant: true },
        randomBenchmark: { percentileVsRandom: 0.93 }
      } as never
    }
  };
}

function buildReferenceCandles(days: number) {
  return Array.from({ length: days + 1 }, (_, index) => ({
    marketCode: "KRW-BTC",
    timeframe: "1h",
    candleTimeUtc: new Date(Date.UTC(2024, 0, 1 + index, 0, 0, 0)),
    openPrice: 1000 + index,
    highPrice: 1005 + index,
    lowPrice: 995 + index,
    closePrice: 1002 + index,
    volume: 1
  }));
}

test("auto research orchestrator iterates, writes artifacts, and promotes best candidate", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-auto-research-"));
  let proposeCalls = 0;

  const llmClient: ResearchLlmClient = {
    async proposeCandidates() {
      proposeCalls += 1;
      return {
        researchSummary: "test iteration proposal",
        preparation: [],
        proposedFamilies: [
          {
            familyId: "momentum-reacceleration-v1",
            title: "Momentum Reacceleration",
            thesis: "new family proposal",
            timeframe: "1h",
            baseFamilyId: "relative-momentum-pullback",
            basedOnFamilies: ["relative-momentum-pullback"],
            parameterSpecs: [
              {
                name: "minStrengthPct",
                description: "relative strength floor",
                min: 0.6,
                max: 0.95
              },
              {
                name: "minRiskOn",
                description: "risk on threshold",
                min: -0.05,
                max: 0.35
              },
              {
                name: "pullbackZ",
                description: "pullback z threshold",
                min: 0.4,
                max: 1.8
              },
              {
                name: "trailAtrMult",
                description: "trail multiple",
                min: 1.2,
                max: 3.2
              }
            ],
            requiredData: ["1h"],
            implementationNotes: ["implement later"]
          }
        ],
        codeTasks: [
          {
            title: "investigate signal collapse bug",
            intent: "fix_bug",
            rationale: "test code task",
            acceptanceCriteria: ["artifact exists"],
            targetFiles: ["research/backtester/src/backtest/BacktestEngine.ts"],
            prompt: "inspect and fix signal collapse bug"
          }
        ],
        candidates: [
          {
            familyId: "momentum-reacceleration-v1",
            thesis: "buy strong pullbacks",
            parameters: {
              minStrengthPct: 0.8,
              minRiskOn: 0.1,
              pullbackZ: 0.9,
              trailAtrMult: 2.2
            },
            invalidationSignals: ["few trades"]
          }
        ]
      };
    },
    async reviewIteration({ evaluations }) {
      return {
        summary: "promote winner",
        verdict: "promote_candidate",
        promotedCandidateId: evaluations[0]?.candidate.candidateId,
        nextPreparation: [],
        proposedFamilies: [],
        codeTasks: [],
        nextCandidates: [],
        retireCandidateIds: [],
        observations: ["looks good"]
      };
    }
  };

  const orchestrator = createAutoResearchOrchestrator({
    llmClient,
    async evaluateCandidate({ candidate }) {
      return buildEvaluation(candidate, 0.12);
    },
    async prepareActions() {
      return [];
    },
    codeAgent: {
      async execute() {
        return [];
      }
    }
  });

  const report = await orchestrator.run({
    universeName: "krw-top",
    timeframe: "1h",
    marketLimit: 5,
    limit: 2000,
    holdoutDays: 180,
    iterations: 2,
    candidatesPerIteration: 2,
    mode: "holdout",
    outputDir,
    allowDataCollection: false,
    allowFeatureCacheBuild: false,
    allowCodeMutation: false,
    minNetReturnForPromotion: 0.1
  });

  assert.equal(proposeCalls, 1);
  assert.equal(report.iterations.length, 1);
  assert.equal(report.bestCandidate?.summary.netReturn, 0.12);
  assert.equal(report.bestTradeCandidate?.summary.tradeCount, 4);
  assert.ok(report.catalog.some((entry) => entry.familyId === "momentum-reacceleration-v1"));

  const savedReport = JSON.parse(await readFile(path.join(outputDir, "report.json"), "utf8"));
  const savedCatalog = JSON.parse(await readFile(path.join(outputDir, "catalog.json"), "utf8"));
  const savedCatalogSummary = JSON.parse(await readFile(path.join(outputDir, "catalog-summary.json"), "utf8"));
  const savedIteration = JSON.parse(
    await readFile(path.join(outputDir, "iteration-01.json"), "utf8")
  );
  const savedStatus = JSON.parse(await readFile(path.join(outputDir, "status.json"), "utf8"));
  const savedLeaderboard = JSON.parse(await readFile(path.join(outputDir, "leaderboard.json"), "utf8"));
  const savedRunLog = await readFile(path.join(outputDir, "run.log"), "utf8");
  const savedHtml = await readFile(path.join(outputDir, "report.html"), "utf8");

  assert.ok(savedCatalog.some((entry: { familyId: string }) => entry.familyId === "momentum-reacceleration-v1"));
  assert.ok(savedCatalogSummary.totals.families >= 1);
  assert.equal(savedReport.bestCandidate.candidate.familyId, "momentum-reacceleration-v1");
  assert.match(savedIteration.review.summary, /promote winner/);
  assert.equal(savedStatus.phase, "completed");
  assert.equal(savedLeaderboard[0].candidateId, "momentum-reacceleration-v1-01");
  assert.match(savedRunLog, /auto-research/);
  assert.match(savedHtml, /Leaderboard/);
  assert.match(savedHtml, /Cross-Checks/);
});

test("auto research review failure marks the run failed instead of synthesizing candidates", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-auto-research-review-failed-"));

  const llmClient: ResearchLlmClient = {
    async proposeCandidates() {
      return {
        researchSummary: "proposal before review failure",
        preparation: [],
        proposedFamilies: [],
        codeTasks: [],
        candidates: [
          {
            candidateId: "rmp-base",
            familyId: "relative-momentum-pullback",
            thesis: "first",
            parameters: {
              minStrengthPct: 0.8,
              minRiskOn: 0.1,
              pullbackZ: 0.9,
              trailAtrMult: 2.2
            },
            invalidationSignals: []
          }
        ]
      };
    },
    async reviewIteration() {
      throw new Error("synthetic review outage");
    }
  };

  const orchestrator = createAutoResearchOrchestrator({
    llmClient,
    async evaluateCandidate({ candidate }) {
      return buildEvaluation(candidate, 0.03);
    },
    async prepareActions() {
      return [];
    },
    codeAgent: {
      async execute() {
        return [];
      }
    }
  });

  await assert.rejects(
    () => orchestrator.run({
      universeName: "krw-top",
      timeframe: "1h",
      marketLimit: 5,
      limit: 2000,
      holdoutDays: 180,
      iterations: 1,
      candidatesPerIteration: 1,
      mode: "holdout",
      outputDir,
      allowDataCollection: false,
      allowFeatureCacheBuild: false,
      allowCodeMutation: false,
      minNetReturnForPromotion: 0.1
    }),
    /LLM review failed: synthetic review outage/
  );

  const savedStatus = JSON.parse(await readFile(path.join(outputDir, "status.json"), "utf8"));
  assert.equal(savedStatus.phase, "failed");
  assert.match(savedStatus.message, /LLM review failed: synthetic review outage/);
});

test("auto research review failure no longer auto-promotes a promotable winner", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-auto-research-review-no-promote-"));

  const llmClient: ResearchLlmClient = {
    async proposeCandidates() {
      return {
        researchSummary: "review failure should fail even with a promotable winner",
        preparation: [],
        proposedFamilies: [],
        codeTasks: [],
        candidates: [
          {
            candidateId: "robust-lpsm",
            familyId: "leader-pullback-state-machine",
            thesis: "strong candidate",
            parameters: {
              strengthFloor: 0.7,
              pullbackAtr: 0.9,
              setupExpiryBars: 4,
              trailAtrMult: 2.2
            },
            invalidationSignals: []
          }
        ]
      };
    },
    async reviewIteration() {
      throw new Error("review worker unavailable");
    }
  };

  const orchestrator = createAutoResearchOrchestrator({
    llmClient,
    async evaluateCandidate({ candidate }) {
      return buildEvaluation(candidate, 0.12);
    },
    async prepareActions() {
      return [];
    },
    codeAgent: {
      async execute() {
        return [];
      }
    }
  });

  await assert.rejects(
    () => orchestrator.run({
      universeName: "krw-top",
      timeframe: "1h",
      marketLimit: 5,
      limit: 2000,
      holdoutDays: 180,
      iterations: 1,
      candidatesPerIteration: 1,
      mode: "holdout",
      outputDir,
      allowDataCollection: false,
      allowFeatureCacheBuild: false,
      allowCodeMutation: false,
      minNetReturnForPromotion: 0.1
    }),
    /LLM review failed: review worker unavailable/
  );

  const savedStatus = JSON.parse(await readFile(path.join(outputDir, "status.json"), "utf8"));
  assert.equal(savedStatus.phase, "failed");
});

test("auto research final keep_searching promotes an eligible candidate instead of dropping it", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-auto-research-final-promote-"));

  const llmClient: ResearchLlmClient = {
    async proposeCandidates() {
      return {
        researchSummary: "final iteration should promote the best eligible candidate",
        preparation: [],
        proposedFamilies: [],
        codeTasks: [],
        candidates: [
          {
            candidateId: "final-winner",
            familyId: "relative-breakout-rotation",
            thesis: "robust final candidate",
            parameters: {
              breakoutLookback: 20,
              strengthFloor: 0.8,
              maxExtensionAtr: 1.2,
              trailAtrMult: 2.2
            },
            invalidationSignals: []
          }
        ]
      };
    },
    async reviewIteration() {
      return {
        summary: "keep searching for another turn",
        verdict: "keep_searching",
        nextPreparation: [],
        proposedFamilies: [],
        codeTasks: [],
        nextCandidates: [
          {
            familyId: "relative-breakout-rotation",
            thesis: "another pass",
            parameters: {
              breakoutLookback: 18,
              strengthFloor: 0.78,
              maxExtensionAtr: 1.25,
              trailAtrMult: 2.1
            },
            invalidationSignals: []
          }
        ],
        retireCandidateIds: [],
        observations: []
      };
    }
  };

  const orchestrator = createAutoResearchOrchestrator({
    llmClient,
    async evaluateCandidate({ candidate }) {
      return buildEvaluation(candidate, 0.11);
    },
    async prepareActions() {
      return [];
    },
    codeAgent: {
      async execute() {
        return [];
      }
    }
  });

  const report = await orchestrator.run({
    universeName: "krw-top",
    timeframe: "1h",
    marketLimit: 5,
    limit: 2000,
    holdoutDays: 180,
    iterations: 1,
    candidatesPerIteration: 1,
    mode: "holdout",
    outputDir,
    allowDataCollection: false,
    allowFeatureCacheBuild: false,
    allowCodeMutation: false,
    minNetReturnForPromotion: 0.1
  });

  const review = report.iterations[0]?.review;

  assert.equal(review?.verdict, "promote_candidate");
  assert.equal(review?.promotedCandidateId, "final-winner");
  assert.equal(report.bestCandidate?.candidate.candidateId, "final-winner");
  assert.match(review?.observations.join("\n") ?? "", /Final iteration kept searching/i);
});

test("auto research replaces blocked llm promotions with the highest eligible candidate", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-auto-research-promotion-governance-"));

  const llmClient: ResearchLlmClient = {
    async proposeCandidates() {
      return {
        researchSummary: "llm may choose the wrong winner",
        preparation: [],
        proposedFamilies: [],
        codeTasks: [],
        candidates: [
          {
            candidateId: "fragile-candidate",
            familyId: "relative-momentum-pullback",
            thesis: "too fragile",
            parameters: {
              minStrengthPct: 0.82,
              minRiskOn: 0.1,
              pullbackZ: 0.85,
              trailAtrMult: 2.2
            },
            invalidationSignals: []
          },
          {
            candidateId: "robust-candidate",
            familyId: "leader-pullback-state-machine",
            thesis: "good enough to promote",
            parameters: {
              strengthFloor: 0.72,
              pullbackAtr: 0.9,
              setupExpiryBars: 4,
              trailAtrMult: 2.2
            },
            invalidationSignals: []
          }
        ]
      };
    },
    async reviewIteration() {
      return {
        summary: "promote the first candidate",
        verdict: "promote_candidate",
        promotedCandidateId: "fragile-candidate",
        nextPreparation: [],
        proposedFamilies: [],
        codeTasks: [],
        nextCandidates: [],
        retireCandidateIds: [],
        observations: []
      };
    }
  };

  const orchestrator = createAutoResearchOrchestrator({
    llmClient,
    async evaluateCandidate({ candidate }) {
      const evaluation = buildEvaluation(candidate, candidate.candidateId === "fragile-candidate" ? 0.14 : 0.11);

      if (candidate.candidateId === "fragile-candidate") {
        evaluation.summary.maxDrawdown = 0.45;
      }

      return evaluation;
    },
    async prepareActions() {
      return [];
    },
    codeAgent: {
      async execute() {
        return [];
      }
    }
  });

  const report = await orchestrator.run({
    universeName: "krw-top",
    timeframe: "1h",
    marketLimit: 5,
    limit: 2000,
    holdoutDays: 180,
    iterations: 1,
    candidatesPerIteration: 2,
    mode: "holdout",
    outputDir,
    allowDataCollection: false,
    allowFeatureCacheBuild: false,
    allowCodeMutation: false,
    minNetReturnForPromotion: 0.05,
    maxDrawdownForPromotion: 0.2
  });

  const review = report.iterations[0]?.review;

  assert.equal(review?.verdict, "promote_candidate");
  assert.equal(review?.promotedCandidateId, "robust-candidate");
  assert.equal(report.bestCandidate?.candidate.candidateId, "robust-candidate");
  assert.match(review?.observations.join("\n") ?? "", /objective governance selected robust-candidate/i);
});

test("auto research rejects keep_searching reviews that omit next candidates", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-auto-research-empty-next-candidates-"));

  const llmClient: ResearchLlmClient = {
    async proposeCandidates() {
      return {
        researchSummary: "empty keep_searching should not stall the run",
        preparation: [],
        proposedFamilies: [],
        codeTasks: [],
        candidates: [
          {
            familyId: "relative-momentum-pullback",
            thesis: "seed candidate",
            parameters: {
              minStrengthPct: 0.8,
              minRiskOn: 0.1,
              pullbackZ: 0.9,
              trailAtrMult: 2.2
            },
            invalidationSignals: []
          }
        ]
      };
    },
    async reviewIteration() {
      return {
        summary: "keep searching but forgot to send candidates",
        verdict: "keep_searching",
        nextPreparation: [],
        proposedFamilies: [],
        codeTasks: [],
        nextCandidates: [],
        retireCandidateIds: [],
        observations: []
      };
    }
  };

  const orchestrator = createAutoResearchOrchestrator({
    llmClient,
    async evaluateCandidate({ candidate }) {
      return buildEvaluation(candidate, candidate.candidateId.includes("fallback") ? 0.03 : 0.02);
    },
    async prepareActions() {
      return [];
    },
    codeAgent: {
      async execute() {
        return [];
      }
    }
  });

  await assert.rejects(
    () => orchestrator.run({
      universeName: "krw-top",
      timeframe: "1h",
      marketLimit: 5,
      limit: 2000,
      holdoutDays: 180,
      iterations: 2,
      candidatesPerIteration: 1,
      mode: "holdout",
      outputDir,
      allowDataCollection: false,
      allowFeatureCacheBuild: false,
      allowCodeMutation: false,
      minNetReturnForPromotion: 0.05
    }),
    /LLM review failed: LLM review returned keep_searching without any unique next candidates/
  );

  const savedStatus = JSON.parse(await readFile(path.join(outputDir, "status.json"), "utf8"));
  assert.equal(savedStatus.phase, "failed");
});

test("auto research dedupes duplicate keep_searching candidates without inventing extra ones", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-auto-research-partial-next-candidates-"));
  let reviewCalls = 0;

  const llmClient: ResearchLlmClient = {
    async proposeCandidates() {
      return {
        researchSummary: "duplicate follow-up ideas should be expanded locally",
        preparation: [],
        proposedFamilies: [],
        codeTasks: [],
        candidates: [
          {
            familyId: "relative-momentum-pullback",
            thesis: "seed candidate",
            parameters: {
              minStrengthPct: 0.8,
              minRiskOn: 0.1,
              pullbackZ: 0.9,
              trailAtrMult: 2.2
            },
            invalidationSignals: []
          }
        ]
      };
    },
    async reviewIteration() {
      reviewCalls += 1;

      if (reviewCalls === 1) {
        return {
          summary: "keep searching with duplicated follow-up ideas",
          verdict: "keep_searching",
          nextPreparation: [],
          proposedFamilies: [],
          codeTasks: [],
          nextCandidates: [
            {
              familyId: "relative-momentum-pullback",
              thesis: "duplicate A",
              parameters: {
                minStrengthPct: 0.82,
                minRiskOn: 0.1,
                pullbackZ: 1,
                trailAtrMult: 2.2
              },
              invalidationSignals: []
            },
            {
              familyId: "relative-momentum-pullback",
              thesis: "duplicate B",
              parameters: {
                minStrengthPct: 0.82,
                minRiskOn: 0.1,
                pullbackZ: 1,
                trailAtrMult: 2.2
              },
              invalidationSignals: []
            }
          ],
          retireCandidateIds: [],
          observations: []
        };
      }

      return {
        summary: "stop on second pass",
        verdict: "stop_no_edge",
        nextPreparation: [],
        proposedFamilies: [],
        codeTasks: [],
        nextCandidates: [],
        retireCandidateIds: [],
        observations: []
      };
    }
  };

  const orchestrator = createAutoResearchOrchestrator({
    llmClient,
    async evaluateCandidate({ candidate }) {
      return buildEvaluation(candidate, candidate.candidateId.includes("fallback") ? 0.04 : 0.02);
    },
    async prepareActions() {
      return [];
    },
    codeAgent: {
      async execute() {
        return [];
      }
    }
  });

  const report = await orchestrator.run({
    universeName: "krw-top",
    timeframe: "1h",
    marketLimit: 5,
    limit: 2000,
    holdoutDays: 180,
    iterations: 2,
    candidatesPerIteration: 2,
    mode: "holdout",
    outputDir,
    allowDataCollection: false,
    allowFeatureCacheBuild: false,
    allowCodeMutation: false,
    minNetReturnForPromotion: 0.05
  });

  assert.equal(report.iterations.length, 2);
  assert.equal(reviewCalls, 2);
  assert.equal(report.iterations[0]?.review.nextCandidates.length, 1);
  assert.match(report.iterations[0]?.review.observations.join("\n") ?? "", /deduped/i);
  assert.equal(report.iterations[1]?.evaluations.length, 2);
  assert.ok(
    report.iterations[1]?.evaluations.every(
      (evaluation) => !evaluation.candidate.candidateId.includes("fallback")
    )
  );
});

test("auto research review sees only the evaluated candidate batch", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-auto-research-review-batch-"));
  const reviewProposalSizes: number[] = [];
  const reviewProposalIds: string[][] = [];
  const reviewedEvaluationIds: string[][] = [];

  const llmClient: ResearchLlmClient = {
    async proposeCandidates() {
      return {
        researchSummary: "proposal can exceed evaluation limit",
        preparation: [],
        proposedFamilies: [],
        codeTasks: [],
        candidates: [
          {
            candidateId: "proposal-a",
            familyId: "relative-momentum-pullback",
            thesis: "candidate a",
            parameters: {
              minStrengthPct: 0.8,
              minRiskOn: 0.1,
              pullbackZ: 0.9,
              trailAtrMult: 2.2
            },
            invalidationSignals: []
          },
          {
            candidateId: "proposal-b",
            familyId: "relative-momentum-pullback",
            thesis: "candidate b",
            parameters: {
              minStrengthPct: 0.78,
              minRiskOn: 0.12,
              pullbackZ: 1,
              trailAtrMult: 2
            },
            invalidationSignals: []
          },
          {
            candidateId: "proposal-c",
            familyId: "relative-momentum-pullback",
            thesis: "candidate c",
            parameters: {
              minStrengthPct: 0.76,
              minRiskOn: 0.08,
              pullbackZ: 1.1,
              trailAtrMult: 2.4
            },
            invalidationSignals: []
          }
        ]
      };
    },
    async reviewIteration({ latestProposal, evaluations }) {
      reviewProposalSizes.push(latestProposal.candidates.length);
      reviewProposalIds.push(latestProposal.candidates.map((candidate) => candidate.candidateId ?? ""));
      reviewedEvaluationIds.push(evaluations.map((evaluation) => evaluation.candidate.candidateId));

      return {
        summary: "stop after verifying reviewed batch",
        verdict: "stop_no_edge",
        nextPreparation: [],
        proposedFamilies: [],
        codeTasks: [],
        nextCandidates: [],
        retireCandidateIds: [],
        observations: []
      };
    }
  };

  const orchestrator = createAutoResearchOrchestrator({
    llmClient,
    async evaluateCandidate({ candidate }) {
      return buildEvaluation(candidate, 0.03);
    },
    async prepareActions() {
      return [];
    },
    codeAgent: {
      async execute() {
        return [];
      }
    }
  });

  await orchestrator.run({
    universeName: "krw-top",
    timeframe: "1h",
    marketLimit: 5,
    limit: 2000,
    holdoutDays: 180,
    iterations: 1,
    candidatesPerIteration: 2,
    mode: "holdout",
    outputDir,
    allowDataCollection: false,
    allowFeatureCacheBuild: false,
    allowCodeMutation: false
  });

  assert.deepEqual(reviewProposalSizes, [2]);
  assert.deepEqual(reviewProposalIds, reviewedEvaluationIds);
});

test("auto research tops up undersized proposal batches before evaluation", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-auto-research-proposal-topup-"));
  const seenCandidateIds: string[] = [];

  const llmClient: ResearchLlmClient = {
    async proposeCandidates() {
      return {
        researchSummary: "single proposal should be expanded locally before evaluation",
        preparation: [],
        proposedFamilies: [],
        codeTasks: [],
        candidates: [
          {
            familyId: "relative-momentum-pullback",
            thesis: "seed candidate",
            parameters: {
              minStrengthPct: 0.8,
              minRiskOn: 0.1,
              pullbackZ: 0.9,
              trailAtrMult: 2.2
            },
            invalidationSignals: []
          }
        ]
      };
    },
    async reviewIteration() {
      return {
        summary: "stop after local proposal expansion",
        verdict: "stop_no_edge",
        nextPreparation: [],
        proposedFamilies: [],
        codeTasks: [],
        nextCandidates: [],
        retireCandidateIds: [],
        observations: []
      };
    }
  };

  const orchestrator = createAutoResearchOrchestrator({
    llmClient,
    async evaluateCandidate({ candidate }) {
      seenCandidateIds.push(candidate.candidateId);
      return buildEvaluation(candidate, candidate.candidateId.includes("proposal-topup") ? 0.04 : 0.02);
    },
    async prepareActions() {
      return [];
    },
    codeAgent: {
      async execute() {
        return [];
      }
    }
  });

  const report = await orchestrator.run({
    universeName: "krw-top",
    timeframe: "1h",
    marketLimit: 5,
    limit: 2000,
    holdoutDays: 180,
    iterations: 1,
    candidatesPerIteration: 3,
    mode: "holdout",
    outputDir,
    allowDataCollection: false,
    allowFeatureCacheBuild: false,
    allowCodeMutation: false,
    minNetReturnForPromotion: 0.05
  });

  assert.equal(report.iterations[0]?.evaluations.length, 3);
  assert.equal(seenCandidateIds.length, 3);
  assert.ok(seenCandidateIds.some((candidateId) => candidateId.includes("proposal-topup")));
  assert.ok(
    report.iterations[0]?.evaluations.some((evaluation) => evaluation.candidate.origin === "novelized")
  );
});

test("auto research augments later proposals with engine-generated mutations and seeds", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-auto-research-engine-augmentation-"));
  let reviewCalls = 0;

  const llmClient: ResearchLlmClient = {
    async proposeCandidates() {
      return {
        researchSummary: "seed one family and let the engine expand later iterations",
        preparation: [],
        proposedFamilies: [],
        codeTasks: [],
        candidates: [
          {
            familyId: "relative-momentum-pullback",
            thesis: "initial seed",
            parameters: {
              minStrengthPct: 0.8,
              minRiskOn: 0.1,
              pullbackZ: 0.9,
              trailAtrMult: 2.2
            },
            invalidationSignals: []
          }
        ]
      };
    },
    async reviewIteration() {
      reviewCalls += 1;

      if (reviewCalls === 1) {
        return {
          summary: "keep the same family but let the engine diversify",
          verdict: "keep_searching",
          nextPreparation: [],
          proposedFamilies: [],
          codeTasks: [],
          nextCandidates: [
            {
              familyId: "relative-momentum-pullback",
              thesis: "same family follow-up",
              parameters: {
                minStrengthPct: 0.82,
                minRiskOn: 0.1,
                pullbackZ: 1,
                trailAtrMult: 2.2
              },
              invalidationSignals: []
            }
          ],
          retireCandidateIds: [],
          observations: []
        };
      }

      return {
        summary: "stop on second pass",
        verdict: "stop_no_edge",
        nextPreparation: [],
        proposedFamilies: [],
        codeTasks: [],
        nextCandidates: [],
        retireCandidateIds: [],
        observations: []
      };
    }
  };

  const orchestrator = createAutoResearchOrchestrator({
    llmClient,
    async evaluateCandidate({ candidate }) {
      return buildEvaluation(candidate, candidate.origin === "engine_seed" ? 0.025 : 0.03);
    },
    async prepareActions() {
      return [];
    },
    codeAgent: {
      async execute() {
        return [];
      }
    }
  });

  const report = await orchestrator.run({
    universeName: "krw-top",
    timeframe: "1h",
    marketLimit: 5,
    limit: 2000,
    holdoutDays: 180,
    iterations: 2,
    candidatesPerIteration: 3,
    mode: "holdout",
    outputDir,
    allowDataCollection: false,
    allowFeatureCacheBuild: false,
    allowCodeMutation: false,
    minNetReturnForPromotion: 0.05
  });

  assert.equal(report.iterations.length, 2);
  assert.match(report.iterations[1]?.proposal.researchSummary ?? "", /Engine augmentation added/i);
  assert.ok(report.iterations[1]?.proposal.candidates.some((candidate) => candidate.origin === "engine_seed"));
  assert.equal(report.iterations[1]?.evaluations.length, 3);
  assert.ok(report.iterations[1]?.evaluations.some((evaluation) => evaluation.candidate.origin === "engine_seed"));
});

test("auto research persists raw rows separately even when repeat suggestions are novelized", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-auto-research-unique-board-"));
  let reviewCalls = 0;

  const llmClient: ResearchLlmClient = {
    async proposeCandidates() {
      return {
        researchSummary: "repeat one candidate across iterations",
        preparation: [],
        proposedFamilies: [],
        codeTasks: [],
        candidates: [
          {
            candidateId: "repeat-rmp",
            familyId: "relative-momentum-pullback",
            thesis: "repeat candidate",
            parameters: {
              minStrengthPct: 0.8,
              minRiskOn: 0.1,
              pullbackZ: 0.9,
              trailAtrMult: 2.2
            },
            invalidationSignals: []
          }
        ]
      };
    },
    async reviewIteration() {
      reviewCalls += 1;
      return {
        summary: "repeat same candidate again",
        verdict: "keep_searching",
        nextPreparation: [],
        proposedFamilies: [],
        codeTasks: [],
        nextCandidates: [
          {
            candidateId: "repeat-rmp",
            familyId: "relative-momentum-pullback",
            thesis: "repeat candidate",
            parameters: {
              minStrengthPct: 0.8,
              minRiskOn: 0.1,
              pullbackZ: 0.9,
              trailAtrMult: 2.2
            },
            invalidationSignals: []
          }
        ],
        retireCandidateIds: [],
        observations: []
      };
    }
  };

  const orchestrator = createAutoResearchOrchestrator({
    llmClient,
    async evaluateCandidate({ candidate }) {
      return buildEvaluation(candidate, 0.04);
    },
    async prepareActions() {
      return [];
    },
    codeAgent: {
      async execute() {
        return [];
      }
    }
  });

  await orchestrator.run({
    universeName: "krw-top",
    timeframe: "1h",
    marketLimit: 5,
    limit: 2000,
    holdoutDays: 180,
    iterations: 2,
    candidatesPerIteration: 1,
    mode: "holdout",
    outputDir,
    allowDataCollection: false,
    allowFeatureCacheBuild: false,
    allowCodeMutation: false
  });

  assert.equal(reviewCalls, 2);

  const uniqueLeaderboard = JSON.parse(await readFile(path.join(outputDir, "leaderboard.json"), "utf8"));
  const rawLeaderboard = JSON.parse(await readFile(path.join(outputDir, "leaderboard.raw.json"), "utf8"));
  const savedHtml = await readFile(path.join(outputDir, "report.html"), "utf8");

  assert.equal(uniqueLeaderboard.length, 2);
  assert.equal(rawLeaderboard.length, 2);
  assert.notEqual(uniqueLeaderboard[0].candidateId, uniqueLeaderboard[1].candidateId);
  assert.match(savedHtml, /Unique Leaderboard/);
  assert.match(savedHtml, /Raw Leaderboard/);
});

test("auto research novelizes repeated historical candidates and persists family artifacts", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-auto-research-novelize-"));

  const llmClient: ResearchLlmClient = {
    async proposeCandidates() {
      return {
        researchSummary: "repeat candidate across iterations",
        preparation: [],
        proposedFamilies: [],
        codeTasks: [],
        candidates: [
          {
            candidateId: "repeat-lpsm",
            familyId: "leader-pullback-state-machine",
            thesis: "repeat leader pullback",
            parameters: {
              strengthFloor: 0.7,
              pullbackAtr: 0.9,
              setupExpiryBars: 4,
              trailAtrMult: 2.2
            },
            invalidationSignals: []
          }
        ]
      };
    },
    async reviewIteration() {
      return {
        summary: "repeat it again",
        verdict: "keep_searching",
        nextPreparation: [],
        proposedFamilies: [],
        codeTasks: [],
        nextCandidates: [
          {
            candidateId: "repeat-lpsm",
            familyId: "leader-pullback-state-machine",
            thesis: "repeat leader pullback",
            parameters: {
              strengthFloor: 0.7,
              pullbackAtr: 0.9,
              setupExpiryBars: 4,
              trailAtrMult: 2.2
            },
            invalidationSignals: []
          }
        ],
        retireCandidateIds: [],
        observations: []
      };
    }
  };

  const orchestrator = createAutoResearchOrchestrator({
    llmClient,
    async evaluateCandidate({ candidate }) {
      return buildEvaluation(candidate, candidate.parameters.pullbackAtr > 0.9 ? 0.05 : 0.03);
    },
    async prepareActions() {
      return [];
    },
    codeAgent: {
      async execute() {
        return [];
      }
    }
  });

  const report = await orchestrator.run({
    universeName: "krw-top",
    timeframe: "1h",
    marketLimit: 5,
    limit: 2000,
    holdoutDays: 180,
    iterations: 2,
    candidatesPerIteration: 1,
    mode: "holdout",
    outputDir,
    allowDataCollection: false,
    allowFeatureCacheBuild: false,
    allowCodeMutation: false
  });

  assert.equal(report.iterations.length, 2);
  assert.equal(report.iterations[0]?.evaluations[0]?.candidate.parameters.pullbackAtr, 0.9);
  assert.notEqual(
    JSON.stringify(report.iterations[1]?.evaluations[0]?.candidate.parameters),
    JSON.stringify(report.iterations[0]?.evaluations[0]?.candidate.parameters)
  );
  assert.match(report.iterations[1]?.evaluations[0]?.candidate.candidateId ?? "", /novel-02/);

  const ledger = JSON.parse(await readFile(path.join(outputDir, "candidate-ledger.json"), "utf8"));
  const familySummary = JSON.parse(await readFile(path.join(outputDir, "family-summary.json"), "utf8"));
  const genealogy = JSON.parse(await readFile(path.join(outputDir, "candidate-genealogy.json"), "utf8"));
  const html = await readFile(path.join(outputDir, "report.html"), "utf8");

  assert.equal(ledger.length, 2);
  assert.equal(familySummary[0].familyId, "leader-pullback-state-machine");
  assert.match(html, /Family Summary/);
  assert.match(html, /Candidate Ledger/);
  assert.match(html, /Candidate Genealogy/);
  assert.equal(genealogy.length, 2);
  const novelized = genealogy.find((entry: { origin: string }) => entry.origin === "novelized");
  assert.ok(novelized);
  assert.deepEqual(novelized.parentCandidateIds, ["repeat-lpsm"]);
});

test("auto research prefers family diversity when selecting candidates for evaluation", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-auto-research-diversity-"));
  const seenFamilies: string[] = [];

  const llmClient: ResearchLlmClient = {
    async proposeCandidates() {
      return {
        researchSummary: "prefer one candidate per family first",
        preparation: [],
        proposedFamilies: [],
        codeTasks: [],
        candidates: [
          {
            familyId: "leader-pullback-state-machine",
            thesis: "leader idea A",
            parameters: {
              strengthFloor: 0.7,
              pullbackAtr: 0.7,
              setupExpiryBars: 4,
              trailAtrMult: 2.2
            },
            invalidationSignals: []
          },
          {
            familyId: "leader-pullback-state-machine",
            thesis: "leader idea B",
            parameters: {
              strengthFloor: 0.8,
              pullbackAtr: 0.8,
              setupExpiryBars: 4,
              trailAtrMult: 2.2
            },
            invalidationSignals: []
          },
          {
            familyId: "momentum-reacceleration",
            thesis: "momentum idea",
            parameters: {
              strengthFloor: 0.72,
              minRiskOn: 0.1,
              resetRsiFloor: 52,
              trailAtrMult: 2.0
            },
            invalidationSignals: []
          }
        ]
      };
    },
    async reviewIteration() {
      return {
        summary: "stop",
        verdict: "stop_no_edge",
        nextPreparation: [],
        proposedFamilies: [],
        codeTasks: [],
        nextCandidates: [],
        retireCandidateIds: [],
        observations: []
      };
    }
  };

  const orchestrator = createAutoResearchOrchestrator({
    llmClient,
    async evaluateCandidate({ candidate }) {
      seenFamilies.push(candidate.familyId);
      return buildEvaluation(candidate, 0.01);
    },
    async prepareActions() {
      return [];
    },
    codeAgent: {
      async execute() {
        return [];
      }
    }
  });

  await orchestrator.run({
    universeName: "krw-top",
    timeframe: "1h",
    marketLimit: 5,
    limit: 2000,
    holdoutDays: 180,
    iterations: 1,
    candidatesPerIteration: 2,
    mode: "holdout",
    outputDir,
    allowDataCollection: false,
    allowFeatureCacheBuild: false,
    allowCodeMutation: false
  });

  assert.deepEqual(seenFamilies.sort(), ["leader-pullback-state-machine", "momentum-reacceleration"].sort());
});

test("composed scored strategy combines component votes and parameter bindings", () => {
  const seenParameters: Record<string, number>[] = [];
  const strategy = createComposedScoredStrategy({
    name: "composed:test",
    parameters: {
      sharedStrength: 0.78,
      sharedTrail: 2.4
    },
    composition: {
      mode: "weighted_vote",
      buyThreshold: 0.5,
      sellThreshold: 0.5,
      components: [
        {
          familyId: "leader-pullback-state-machine",
          strategyName: "leader-pullback-state-machine",
          weight: 1,
          parameterBindings: {
            strengthFloor: "sharedStrength",
            trailAtrMult: "sharedTrail"
          }
        },
        {
          familyId: "momentum-reacceleration",
          strategyName: "momentum-reacceleration",
          weight: 0.8,
          parameterBindings: {
            strengthFloor: "sharedStrength"
          }
        }
      ]
    },
    createComponent(strategyName, parameters) {
      seenParameters.push(parameters ?? {});
      return {
        name: strategyName,
        parameters: parameters ?? {},
        parameterCount: Object.keys(parameters ?? {}).length,
        generateSignal() {
          return {
            signal: "BUY",
            conviction: strategyName === "leader-pullback-state-machine" ? 0.9 : 0.7
          };
        }
      };
    }
  });

  const result = strategy.generateSignal({
    candles: [],
    index: 0,
    hasPosition: false
  });

  assert.equal(result.signal, "BUY");
  assert.ok(result.conviction > 0.5);
  assert.equal(seenParameters[0]?.strengthFloor, 0.78);
  assert.equal(seenParameters[0]?.trailAtrMult, 2.4);
  assert.equal(seenParameters[1]?.strengthFloor, 0.78);
});

test("auto research proposed composed family becomes executable in the same iteration", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-auto-research-composed-family-"));
  const seenCandidates: NormalizedCandidateProposal[] = [];

  const llmClient: ResearchLlmClient = {
    async proposeCandidates() {
      return {
        researchSummary: "propose a composed family",
        preparation: [],
        proposedFamilies: [
          {
            familyId: "leader-confirmed-reacceleration",
            title: "Leader Confirmed Reacceleration",
            thesis: "Require leader pullback plus reset confirmation.",
            timeframe: "1h",
            basedOnFamilies: ["leader-pullback-state-machine", "momentum-reacceleration"],
            parameterSpecs: [
              {
                name: "sharedStrength",
                description: "shared leader strength floor",
                min: 0.6,
                max: 0.9
              },
              {
                name: "sharedTrail",
                description: "shared trail ATR multiplier",
                min: 1.5,
                max: 3
              }
            ],
            requiredData: ["1h"],
            implementationNotes: ["compose existing executable families"],
            composition: {
              mode: "weighted_vote",
              buyThreshold: 0.55,
              sellThreshold: 0.55,
              components: [
                {
                  familyId: "leader-pullback-state-machine",
                  weight: 1,
                  parameterBindings: {
                    strengthFloor: "sharedStrength",
                    trailAtrMult: "sharedTrail"
                  }
                },
                {
                  familyId: "momentum-reacceleration",
                  weight: 0.8,
                  parameterBindings: {
                    strengthFloor: "sharedStrength",
                    trailAtrMult: "sharedTrail"
                  }
                }
              ]
            }
          }
        ],
        codeTasks: [],
        candidates: [
          {
            familyId: "leader-confirmed-reacceleration",
            thesis: "composed family candidate",
            parameters: {
              sharedStrength: 0.78,
              sharedTrail: 2.2
            },
            invalidationSignals: []
          }
        ]
      };
    },
    async reviewIteration() {
      return {
        summary: "stop",
        verdict: "stop_no_edge",
        nextPreparation: [],
        proposedFamilies: [],
        codeTasks: [],
        nextCandidates: [],
        retireCandidateIds: [],
        observations: []
      };
    }
  };

  const orchestrator = createAutoResearchOrchestrator({
    llmClient,
    async evaluateCandidate({ candidate }) {
      seenCandidates.push(candidate);
      return buildEvaluation(candidate, 0.02);
    },
    async prepareActions() {
      return [];
    },
    codeAgent: {
      async execute() {
        return [];
      }
    },
    async resolveCandidateMarkets() {
      return ["KRW-BTC", "KRW-ETH", "KRW-XRP"];
    },
    async preloadReferenceCandles() {
      return buildReferenceCandles(540);
    }
  });

  await orchestrator.run({
    universeName: "krw-top",
    timeframe: "1h",
    marketLimit: 5,
    limit: 2000,
    holdoutDays: 180,
    iterations: 1,
    candidatesPerIteration: 1,
    mode: "walk-forward",
    outputDir,
    allowDataCollection: false,
    allowFeatureCacheBuild: false,
    allowCodeMutation: false
  });

  assert.equal(seenCandidates[0]?.familyId, "leader-confirmed-reacceleration");
  assert.equal(seenCandidates[0]?.strategyName, "composed:leader-confirmed-reacceleration");
  assert.equal(seenCandidates[0]?.composition?.components.length, 2);
});

test("auto research reflects executed code mutations into catalog using runtime discovery", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-auto-research-runtime-discovery-"));

  const llmClient: ResearchLlmClient = {
    async proposeCandidates() {
      return {
        researchSummary: "code mutation should add a new family",
        preparation: [],
        proposedFamilies: [
          {
            familyId: "new-llm-family",
            title: "New LLM Family",
            thesis: "created by code task",
            timeframe: "1h",
            basedOnFamilies: [],
            parameterSpecs: [
              {
                name: "minStrengthPct",
                description: "strength floor",
                min: 0.6,
                max: 0.9
              }
            ],
            requiredData: ["1h"],
            implementationNotes: ["implemented by code task"]
          }
        ],
        codeTasks: [
          {
            taskId: "impl-new-family",
            familyId: "new-llm-family",
            strategyName: "new-llm-family",
            title: "implement new llm family",
            intent: "implement_strategy",
            rationale: "needed for runtime discovery test",
            acceptanceCriteria: ["family is visible in runtime registry"],
            targetFiles: ["research/strategies/src/new-llm-family.ts"],
            prompt: "add strategy"
          }
        ],
        candidates: [
          {
            familyId: "relative-momentum-pullback",
            thesis: "baseline",
            parameters: {
              minStrengthPct: 0.8,
              minRiskOn: 0.1,
              pullbackZ: 0.9,
              trailAtrMult: 2.2
            },
            invalidationSignals: []
          }
        ]
      };
    },
    async reviewIteration() {
      return {
        summary: "stop",
        verdict: "stop_no_edge",
        nextPreparation: [],
        proposedFamilies: [],
        codeTasks: [],
        nextCandidates: [],
        retireCandidateIds: [],
        observations: []
      };
    }
  };

  const orchestrator = createAutoResearchOrchestrator({
    llmClient,
    async evaluateCandidate({ candidate }) {
      return buildEvaluation(candidate, 0.01);
    },
    async prepareActions() {
      return [];
    },
    codeAgent: {
      async execute({ tasks }) {
        return tasks.map((task) => ({
          task,
          status: "executed" as const,
          detail: "implemented"
        }));
      }
    },
    async discoverRuntimeScoredStrategies() {
      return [
        "relative-momentum-pullback",
        "leader-pullback-state-machine",
        "momentum-reacceleration",
        "new-llm-family"
      ];
    },
    async resolveCandidateMarkets() {
      return ["KRW-BTC", "KRW-ETH", "KRW-XRP"];
    },
    async preloadReferenceCandles() {
      return buildReferenceCandles(540);
    }
  });

  const report = await orchestrator.run({
    universeName: "krw-top",
    timeframe: "1h",
    marketLimit: 5,
    limit: 2000,
    holdoutDays: 180,
    iterations: 1,
    candidatesPerIteration: 1,
    mode: "walk-forward",
    outputDir,
    allowDataCollection: false,
    allowFeatureCacheBuild: false,
    allowCodeMutation: true
  });

  const discoveredFamily = report.catalog.find((entry) => entry.familyId === "new-llm-family");
  const catalogSummary = JSON.parse(await readFile(path.join(outputDir, "catalog-summary.json"), "utf8"));

  assert.equal(discoveredFamily?.state, "implemented");
  assert.equal(discoveredFamily?.strategyName, "new-llm-family");
  assert.ok(catalogSummary.families.some((entry: { familyId: string }) => entry.familyId === "new-llm-family"));
});

test("auto research run lock prevents concurrent writes to the same output dir", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-auto-research-lock-"));

  const llmClient: ResearchLlmClient = {
    async proposeCandidates() {
      return {
        researchSummary: "lock test",
        preparation: [],
        proposedFamilies: [],
        codeTasks: [],
        candidates: [
          {
            familyId: "relative-momentum-pullback",
            thesis: "lock candidate",
            parameters: {
              minStrengthPct: 0.8,
              minRiskOn: 0.1,
              pullbackZ: 0.9,
              trailAtrMult: 2.2
            },
            invalidationSignals: []
          }
        ]
      };
    },
    async reviewIteration() {
      return {
        summary: "stop",
        verdict: "stop_no_edge",
        nextPreparation: [],
        proposedFamilies: [],
        codeTasks: [],
        nextCandidates: [],
        retireCandidateIds: [],
        observations: []
      };
    }
  };

  const orchestrator = createAutoResearchOrchestrator({
    llmClient,
    async evaluateCandidate({ candidate }) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return buildEvaluation(candidate, 0.01);
    },
    async prepareActions() {
      return [];
    },
    codeAgent: {
      async execute() {
        return [];
      }
    }
  });

  const firstRun = orchestrator.run({
    universeName: "krw-top",
    timeframe: "1h",
    marketLimit: 5,
    limit: 2000,
    holdoutDays: 180,
    iterations: 1,
    candidatesPerIteration: 1,
    mode: "holdout",
    outputDir,
    allowDataCollection: false,
    allowFeatureCacheBuild: false,
    allowCodeMutation: false
  });

  await new Promise((resolve) => setTimeout(resolve, 20));

  await assert.rejects(
    orchestrator.run({
      universeName: "krw-top",
      timeframe: "1h",
      marketLimit: 5,
      limit: 2000,
      holdoutDays: 180,
      iterations: 1,
      candidatesPerIteration: 1,
      mode: "holdout",
      outputDir,
      allowDataCollection: false,
      allowFeatureCacheBuild: false,
      allowCodeMutation: false
    }),
    /already active/
  );

  await firstRun;
});

test("auto research resume continues from saved run-state", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-auto-research-resume-"));
  let proposeCalls = 0;

  const llmClient: ResearchLlmClient = {
    async proposeCandidates() {
      proposeCalls += 1;
      return {
        researchSummary: `proposal-${proposeCalls}`,
        preparation: [],
        proposedFamilies: [],
        codeTasks: [],
        candidates: [
          {
            familyId: "relative-momentum-pullback",
            thesis: "resume candidate",
            parameters: {
              minStrengthPct: 0.8,
              minRiskOn: 0.1,
              pullbackZ: 0.9,
              trailAtrMult: 2.2
            },
            invalidationSignals: ["none"]
          }
        ]
      };
    },
    async reviewIteration({ evaluations }) {
      return {
        summary: `review-${evaluations[0]?.candidate.candidateId ?? "none"}`,
        verdict: "keep_searching",
        promotedCandidateId: undefined,
        nextPreparation: [],
        proposedFamilies: [],
        codeTasks: [],
        nextCandidates: [
          {
            familyId: "relative-momentum-pullback",
            thesis: "next",
            parameters: {
              minStrengthPct: 0.82,
              minRiskOn: 0.1,
              pullbackZ: 1.0,
              trailAtrMult: 2.2
            },
            invalidationSignals: ["none"]
          }
        ],
        retireCandidateIds: [],
        observations: []
      };
    }
  };

  const orchestrator = createAutoResearchOrchestrator({
    llmClient,
    async evaluateCandidate({ candidate }) {
      return buildEvaluation(candidate, 0.01);
    },
    async prepareActions() {
      return [];
    },
    codeAgent: {
      async execute() {
        return [];
      }
    }
  });

  await orchestrator.run({
    universeName: "krw-top",
    timeframe: "1h",
    marketLimit: 5,
    limit: 2000,
    holdoutDays: 180,
    iterations: 1,
    candidatesPerIteration: 1,
    mode: "holdout",
    outputDir,
    allowDataCollection: false,
    allowFeatureCacheBuild: false,
    allowCodeMutation: false,
    maxNoTradeIterations: 0,
    minNetReturnForPromotion: 0.05
  });

  const resumed = await orchestrator.run({
    universeName: "krw-top",
    timeframe: "1h",
    marketLimit: 5,
    limit: 2000,
    holdoutDays: 180,
    iterations: 2,
    candidatesPerIteration: 1,
    mode: "holdout",
    outputDir,
    resumeFrom: outputDir,
    allowDataCollection: false,
    allowFeatureCacheBuild: false,
    allowCodeMutation: false,
    maxNoTradeIterations: 0
  });

  assert.equal(resumed.iterations.length, 2);
  assert.equal(proposeCalls, 1);
  const resumedStatus = JSON.parse(await readFile(path.join(outputDir, "status.json"), "utf8"));
  const resumedLog = await readFile(path.join(outputDir, "run.log"), "utf8");
  assert.equal(resumedStatus.phase, "partial");
  assert.match(resumedLog, /iteration 2\/2/);
});

test("auto research resume reuses saved run configuration when flags are omitted", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-auto-research-resume-config-"));

  const llmClient: ResearchLlmClient = {
    async proposeCandidates() {
      return {
        researchSummary: "proposal",
        preparation: [],
        proposedFamilies: [],
        codeTasks: [],
        candidates: [
          {
            familyId: "relative-momentum-pullback",
            thesis: "resume config candidate",
            parameters: {
              minStrengthPct: 0.8,
              minRiskOn: 0.1,
              pullbackZ: 0.9,
              trailAtrMult: 2.2
            },
            invalidationSignals: []
          }
        ]
      };
    },
    async reviewIteration() {
      return {
        summary: "keep",
        verdict: "keep_searching",
        nextPreparation: [],
        proposedFamilies: [],
        codeTasks: [],
        nextCandidates: [
          {
            familyId: "relative-momentum-pullback",
            thesis: "resume config candidate next",
            parameters: {
              minStrengthPct: 0.81,
              minRiskOn: 0.1,
              pullbackZ: 1.0,
              trailAtrMult: 2.2
            },
            invalidationSignals: []
          }
        ],
        retireCandidateIds: [],
        observations: []
      };
    }
  };

  const seenConfigs: AutoResearchRunConfig[] = [];
  const orchestrator = createAutoResearchOrchestrator({
    llmClient,
    async evaluateCandidate({ candidate, config }) {
      seenConfigs.push(config);
      return buildEvaluation(candidate, 0.02);
    },
    async prepareActions() {
      return [];
    },
    codeAgent: {
      async execute() {
        return [];
      }
    }
  });

  await orchestrator.run({
    universeName: "krw-top",
    timeframe: "1h",
    marketLimit: 7,
    limit: 12000,
    holdoutDays: 180,
    iterations: 1,
    candidatesPerIteration: 1,
    mode: "holdout",
    outputDir,
    allowDataCollection: false,
    allowFeatureCacheBuild: true,
    allowCodeMutation: false,
    maxNoTradeIterations: 0,
    minNetReturnForPromotion: 0.05
  });

  await orchestrator.run({
    universeName: "krw-top",
    timeframe: "1h",
    marketLimit: 5,
    limit: 500,
    holdoutDays: 365,
    iterations: 2,
    candidatesPerIteration: 3,
    mode: "holdout",
    outputDir,
    resumeFrom: outputDir,
    allowDataCollection: false,
    allowFeatureCacheBuild: false,
    allowCodeMutation: false,
    maxNoTradeIterations: 0
  });

  assert.equal(seenConfigs.length, 2);
  assert.equal(seenConfigs[1].marketLimit, 7);
  assert.equal(seenConfigs[1].limit, 12000);
  assert.equal(seenConfigs[1].holdoutDays, 180);
});

test("auto research minimum limit uses 1h windows instead of generic cli timeframe defaults", () => {
  assert.equal(
    calculateAutoResearchMinimumLimit({
      timeframe: "1h",
      holdoutDays: 180,
      mode: "holdout"
    }),
    9504
  );
  assert.equal(
    calculateAutoResearchMinimumLimit({
      timeframe: "1h",
      holdoutDays: 180,
      trainingDays: 360,
      stepDays: 180,
      mode: "walk-forward"
    }),
    19008
  );
});

test("auto research repairs undersized holdout limits before evaluating candidates", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-auto-research-limit-repair-"));
  const seenConfigs: AutoResearchRunConfig[] = [];

  const llmClient: ResearchLlmClient = {
    async proposeCandidates() {
      return {
        researchSummary: "repair undersized limit",
        preparation: [],
        proposedFamilies: [],
        codeTasks: [],
        candidates: [
          {
            familyId: "relative-momentum-pullback",
            thesis: "repair limit candidate",
            parameters: {
              minStrengthPct: 0.8,
              minRiskOn: 0.1,
              pullbackZ: 0.9,
              trailAtrMult: 2.2
            },
            invalidationSignals: []
          }
        ]
      };
    },
    async reviewIteration() {
      return {
        summary: "stop after repaired run",
        verdict: "stop_no_edge",
        nextPreparation: [],
        proposedFamilies: [],
        codeTasks: [],
        nextCandidates: [],
        retireCandidateIds: [],
        observations: []
      };
    }
  };

  const orchestrator = createAutoResearchOrchestrator({
    llmClient,
    async evaluateCandidate({ candidate, config }) {
      seenConfigs.push(config);
      return buildEvaluation(candidate, 0.03);
    },
    async prepareActions() {
      return [];
    },
    codeAgent: {
      async execute() {
        return [];
      }
    },
    async resolveCandidateMarkets() {
      return ["KRW-BTC", "KRW-ETH", "KRW-XRP"];
    }
  });

  const report = await orchestrator.run({
    universeName: "krw-top",
    timeframe: "1h",
    marketLimit: 5,
    limit: 500,
    holdoutDays: 180,
    iterations: 1,
    candidatesPerIteration: 1,
    mode: "holdout",
    outputDir,
    allowDataCollection: false,
    allowFeatureCacheBuild: false,
    allowCodeMutation: false,
    maxNoTradeIterations: 0
  });

  const repairedLimit = calculateAutoResearchMinimumLimit({
    timeframe: "1h",
    holdoutDays: 180,
    mode: "holdout"
  });

  assert.equal(seenConfigs.length, 1);
  assert.equal(seenConfigs[0]?.limit, repairedLimit);
  assert.equal(report.config.limit, repairedLimit);
});

test("auto research converts evaluation failures into structured artifacts instead of crashing", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-auto-research-failure-"));

  const llmClient: ResearchLlmClient = {
    async proposeCandidates() {
      return {
        researchSummary: "failure path proposal",
        preparation: [],
        proposedFamilies: [],
        codeTasks: [],
        candidates: [
          {
            familyId: "relative-momentum-pullback",
            thesis: "failure candidate",
            parameters: {
              minStrengthPct: 0.8,
              minRiskOn: 0.1,
              pullbackZ: 0.9,
              trailAtrMult: 2.2
            },
            invalidationSignals: []
          }
        ]
      };
    },
    async reviewIteration({ evaluations }) {
      assert.equal(evaluations[0]?.status, "failed");
      assert.match(evaluations[0]?.failure?.message ?? "", /split/i);
      return {
        summary: "stop on structured failure",
        verdict: "stop_no_edge",
        nextPreparation: [],
        proposedFamilies: [],
        codeTasks: [],
        nextCandidates: [],
        retireCandidateIds: [],
        observations: ["structured failure observed"]
      };
    }
  };

  const orchestrator = createAutoResearchOrchestrator({
    llmClient,
    async evaluateCandidate() {
      throw new Error("Split produced too few candles for train or test");
    },
    async prepareActions() {
      return [];
    },
    codeAgent: {
      async execute() {
        return [];
      }
    }
  });

  const report = await orchestrator.run({
    universeName: "krw-top",
    timeframe: "1h",
    marketLimit: 5,
    limit: 2000,
    holdoutDays: 180,
    iterations: 1,
    candidatesPerIteration: 1,
    mode: "holdout",
    outputDir,
    allowDataCollection: false,
    allowFeatureCacheBuild: false,
    allowCodeMutation: false
  });

  assert.equal(report.iterations.length, 1);
  assert.equal(report.iterations[0]?.evaluations[0]?.status, "failed");
  const savedIteration = JSON.parse(await readFile(path.join(outputDir, "iteration-01.json"), "utf8"));
  assert.equal(savedIteration.evaluations[0].status, "failed");
  assert.match(savedIteration.evaluations[0].failure.message, /split/i);
});

test("auto research proposal failure marks the run failed instead of inventing candidates", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-auto-research-proposal-fallback-"));

  const llmClient: ResearchLlmClient = {
    async proposeCandidates() {
      throw new Error("proposal outage");
    },
    async reviewIteration() {
      return {
        summary: "fallback proposal worked",
        verdict: "stop_no_edge",
        nextPreparation: [],
        proposedFamilies: [],
        codeTasks: [],
        nextCandidates: [],
        retireCandidateIds: [],
        observations: []
      };
    }
  };

  const orchestrator = createAutoResearchOrchestrator({
    llmClient,
    async evaluateCandidate({ candidate }) {
      return buildEvaluation(candidate, 0.01);
    },
    async prepareActions() {
      return [];
    },
    codeAgent: {
      async execute() {
        return [];
      }
    }
  });

  await assert.rejects(
    () => orchestrator.run({
      universeName: "krw-top",
      timeframe: "1h",
      marketLimit: 5,
      limit: 2000,
      holdoutDays: 180,
      iterations: 1,
      candidatesPerIteration: 2,
      mode: "holdout",
      outputDir,
      allowDataCollection: false,
      allowFeatureCacheBuild: false,
      allowCodeMutation: false
    }),
    /LLM proposal failed: proposal outage/
  );

  const savedStatus = JSON.parse(await readFile(path.join(outputDir, "status.json"), "utf8"));
  assert.equal(savedStatus.phase, "failed");
});

test("robustness-aware ranking prefers stronger walk-forward window quality over raw return alone", () => {
  const strongerWindows = buildEvaluation(
    {
      candidateId: "a",
      familyId: "leader-pullback-state-machine",
      strategyName: "leader-pullback-state-machine",
      thesis: "a",
      parameters: {
        strengthFloor: 0.7,
        pullbackAtr: 0.8,
        setupExpiryBars: 4,
        trailAtrMult: 2.2
      },
      invalidationSignals: []
    },
    0.04
  );
  strongerWindows.diagnostics.windows = {
    ...strongerWindows.diagnostics.windows,
    mode: "walk-forward",
    windowCount: 5,
    positiveWindowRatio: 0.8,
    worstWindowNetReturn: -0.01,
    totalClosedTrades: 14
  };

  const higherRawReturn = buildEvaluation(
    {
      candidateId: "b",
      familyId: "leader-pullback-state-machine",
      strategyName: "leader-pullback-state-machine",
      thesis: "b",
      parameters: {
        strengthFloor: 0.75,
        pullbackAtr: 0.9,
        setupExpiryBars: 4,
        trailAtrMult: 2.2
      },
      invalidationSignals: []
    },
    0.05
  );
  higherRawReturn.diagnostics.windows = {
    ...higherRawReturn.diagnostics.windows,
    mode: "walk-forward",
    windowCount: 5,
    positiveWindowRatio: 0.4,
    worstWindowNetReturn: -0.04,
    totalClosedTrades: 8
  };

  assert.ok(compareCandidateEvaluations(strongerWindows, higherRawReturn) < 0);
});

test("risk-adjusted score penalizes drawdown-heavy candidates even when raw return is higher", () => {
  const balanced = buildEvaluation(
    {
      candidateId: "balanced",
      familyId: "relative-momentum-pullback",
      strategyName: "relative-momentum-pullback",
      thesis: "balanced",
      parameters: {
        minStrengthPct: 0.8,
        minRiskOn: 0.1,
        pullbackZ: 0.9,
        trailAtrMult: 2.2
      },
      invalidationSignals: []
    },
    0.09
  );
  balanced.summary.maxDrawdown = 0.08;

  const fragile = buildEvaluation(
    {
      candidateId: "fragile",
      familyId: "relative-momentum-pullback",
      strategyName: "relative-momentum-pullback",
      thesis: "fragile",
      parameters: {
        minStrengthPct: 0.85,
        minRiskOn: 0.1,
        pullbackZ: 0.8,
        trailAtrMult: 2
      },
      invalidationSignals: []
    },
    0.11
  );
  fragile.summary.maxDrawdown = 0.24;

  assert.ok(calculateCandidateRiskAdjustedScore(balanced) > calculateCandidateRiskAdjustedScore(fragile));
  assert.ok(compareCandidateEvaluations(balanced, fragile) < 0);
});

test("ranking keeps profitable candidates ahead of negative-return candidates", () => {
  const profitable = buildEvaluation(
    {
      candidateId: "profitable",
      familyId: "relative-momentum-pullback",
      strategyName: "relative-momentum-pullback",
      thesis: "profitable",
      parameters: {
        minStrengthPct: 0.78,
        minRiskOn: 0.08,
        pullbackZ: 0.92,
        trailAtrMult: 2.1
      },
      invalidationSignals: []
    },
    0.015
  );
  profitable.diagnostics.windows = {
    ...profitable.diagnostics.windows,
    mode: "walk-forward",
    windowCount: 5,
    positiveWindowRatio: 0.45,
    worstWindowNetReturn: -0.012,
    totalClosedTrades: 9
  };

  const negativeButSmooth = buildEvaluation(
    {
      candidateId: "negative",
      familyId: "relative-momentum-pullback",
      strategyName: "relative-momentum-pullback",
      thesis: "negative",
      parameters: {
        minStrengthPct: 0.8,
        minRiskOn: 0.05,
        pullbackZ: 0.88,
        trailAtrMult: 2
      },
      invalidationSignals: []
    },
    -0.004
  );
  negativeButSmooth.summary.maxDrawdown = 0.03;
  negativeButSmooth.diagnostics.windows = {
    ...negativeButSmooth.diagnostics.windows,
    mode: "walk-forward",
    windowCount: 5,
    positiveWindowRatio: 0.8,
    worstWindowNetReturn: -0.005,
    totalClosedTrades: 12
  };

  assert.ok(compareCandidateEvaluations(profitable, negativeButSmooth) < 0);
});

test("ranking prefers the less negative candidate when both candidates lose money", () => {
  const lessNegative = buildEvaluation(
    {
      candidateId: "less-negative",
      familyId: "multi-tf-trend-burst",
      strategyName: "portfolio:multi-tf-trend-burst",
      thesis: "less negative",
      parameters: {
        universeTopN: 11,
        maxOpenPositions: 4,
        maxCapitalUsagePct: 0.72,
        trendBudgetPct: 0.45,
        breakoutBudgetPct: 0.33,
        trendRebalanceBars: 3,
        trendEntryFloor: 0.75,
        trendExitFloor: 0.55,
        trendSwitchGap: 0.12,
        trendMinAboveTrendRatio: 0.68,
        trendMinLiquidityScore: 0.13,
        trendMinCompositeTrend: 0.09,
        leaderStrengthFloor: 0.74,
        leaderPullbackAtr: 0.85,
        leaderSetupExpiryBars: 5,
        leaderTrailAtrMult: 2.2,
        breakoutLookback: 27,
        breakoutStrengthFloor: 0.8,
        breakoutMaxExtensionAtr: 1.4,
        breakoutTrailAtrMult: 2.3,
        cooldownBarsAfterLoss: 11,
        minBarsBetweenEntries: 3,
        universeLookbackBars: 30
      },
      invalidationSignals: []
    },
    -0.008
  );
  lessNegative.diagnostics.windows = {
    ...lessNegative.diagnostics.windows,
    mode: "walk-forward",
    windowCount: 8,
    positiveWindowRatio: 0.125,
    worstWindowNetReturn: -0.012,
    totalClosedTrades: 59
  };

  const moreNegativeButSmooth = buildEvaluation(
    {
      candidateId: "more-negative",
      familyId: "multi-tf-defensive-reclaim",
      strategyName: "portfolio:multi-tf-defensive-reclaim",
      thesis: "more negative but smoother",
      parameters: {
        universeTopN: 9,
        maxOpenPositions: 3.5,
        maxCapitalUsagePct: 0.55,
        trendBudgetPct: 0.325,
        reversionBudgetPct: 0.225,
        trendRebalanceBars: 5,
        trendEntryFloor: 0.72,
        trendExitFloor: 0.525,
        trendSwitchGap: 0.09,
        trendMinAboveTrendRatio: 0.675,
        trendMinLiquidityScore: 0.135,
        trendMinCompositeTrend: 0.08,
        leaderStrengthFloor: 0.75,
        leaderPullbackAtr: 1.1,
        leaderSetupExpiryBars: 6,
        leaderTrailAtrMult: 2.4,
        reversionEntryThreshold: 0.3,
        reversionExitThreshold: 0.175,
        reversionStopLossPct: 0.025,
        reversionMaxHoldBars: 28,
        cooldownBarsAfterLoss: 17,
        minBarsBetweenEntries: 4.5,
        universeLookbackBars: 35
      },
      invalidationSignals: []
    },
    -0.036
  );
  moreNegativeButSmooth.summary.maxDrawdown = 0.049;
  moreNegativeButSmooth.diagnostics.windows = {
    ...moreNegativeButSmooth.diagnostics.windows,
    mode: "walk-forward",
    windowCount: 8,
    positiveWindowRatio: 0.5,
    worstWindowNetReturn: -0.023,
    totalClosedTrades: 97
  };

  assert.ok(compareCandidateEvaluations(lessNegative, moreNegativeButSmooth) < 0);
});

test("promotion gate blocks fragile candidates and accepts robust ones", () => {
  const robust = buildEvaluation(
    {
      candidateId: "robust",
      familyId: "relative-breakout-rotation",
      strategyName: "relative-breakout-rotation",
      thesis: "robust",
      parameters: {
        breakoutLookback: 20,
        strengthFloor: 0.8,
        maxExtensionAtr: 1.2,
        trailAtrMult: 2.2
      },
      invalidationSignals: []
    },
    0.08
  );
  robust.diagnostics.windows = {
    ...robust.diagnostics.windows,
    mode: "walk-forward",
    windowCount: 5,
    positiveWindowRatio: 0.6,
    worstWindowNetReturn: -0.01,
    totalClosedTrades: 12
  };

  const fragile = buildEvaluation(
    {
      candidateId: "fragile",
      familyId: "relative-breakout-rotation",
      strategyName: "relative-breakout-rotation",
      thesis: "fragile",
      parameters: {
        breakoutLookback: 18,
        strengthFloor: 0.78,
        maxExtensionAtr: 1.4,
        trailAtrMult: 2.1
      },
      invalidationSignals: []
    },
    0.12
  );
  fragile.summary.maxDrawdown = 0.42;
  fragile.summary.randomPercentile = 0.41;
  fragile.diagnostics.robustness.randomPercentile = 0.41;
  fragile.diagnostics.windows = {
    ...fragile.diagnostics.windows,
    mode: "walk-forward",
    windowCount: 5,
    positiveWindowRatio: 0.2,
    worstWindowNetReturn: -0.08,
    totalClosedTrades: 6
  };
  const weak = buildEvaluation(
    {
      candidateId: "weak",
      familyId: "relative-breakout-rotation",
      strategyName: "relative-breakout-rotation",
      thesis: "weak",
      parameters: {
        breakoutLookback: 16,
        strengthFloor: 0.75,
        maxExtensionAtr: 1.3,
        trailAtrMult: 2
      },
      invalidationSignals: []
    },
    0.01
  );

  assert.equal(
    passesPromotionGate(robust, {
      minTrades: 3,
      minNetReturn: 0.02,
      maxDrawdown: 0.2,
      minPositiveWindowRatio: 0.5,
      minRandomPercentile: 0.6,
      requireBootstrapSignificance: true
    }),
    true
  );
  assert.equal(
    passesPromotionGate(fragile, {
      minTrades: 3,
      minNetReturn: 0.02,
      maxDrawdown: 0.2,
      minPositiveWindowRatio: 0.5,
      minRandomPercentile: 0.6,
      requireBootstrapSignificance: true
    }),
    false
  );
  assert.equal(passesPromotionGate(robust), true);
  assert.equal(passesPromotionGate(weak), false);
});

test("auto research marks invalid walk-forward configs before the first proposal", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-auto-research-invalid-config-"));

  const llmClient: ResearchLlmClient = {
    async proposeCandidates() {
      throw new Error("proposal should not run for invalid config");
    },
    async reviewIteration() {
      throw new Error("review should not run for invalid config");
    }
  };

  const orchestrator = createAutoResearchOrchestrator({
    llmClient,
    async resolveCandidateMarkets() {
      return ["KRW-BTC", "KRW-ETH"];
    },
    async preloadReferenceCandles() {
      return buildReferenceCandles(5);
    }
  });

  const report = await orchestrator.run({
    universeName: "krw-top",
    timeframe: "1h",
    marketLimit: 5,
    limit: 2000,
    holdoutDays: 180,
    iterations: 2,
    candidatesPerIteration: 2,
    mode: "walk-forward",
    outputDir,
    allowDataCollection: false,
    allowFeatureCacheBuild: false,
    allowCodeMutation: false
  });

  const savedStatus = JSON.parse(await readFile(path.join(outputDir, "status.json"), "utf8"));
  assert.equal(report.outcome, "invalid_config");
  assert.equal(report.iterations.length, 0);
  assert.equal(savedStatus.phase, "invalid_config");
  assert.match(savedStatus.message, /no valid walk-forward window/i);
});

test("auto research trims candidate markets for micro portfolio families before evaluation", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-auto-research-portfolio-market-cap-"));
  let evaluatedMarketCodes: string[] = [];

  const llmClient: ResearchLlmClient = {
    async proposeCandidates() {
      return {
        researchSummary: "evaluate candidate market cap directly",
        preparation: [],
        proposedFamilies: [],
        codeTasks: [],
        candidates: [
          {
            familyId: "multi-tf-regime-switch",
            thesis: "direct proposal",
            parameters: {
              universeTopN: 10,
              maxOpenPositions: 4,
              maxCapitalUsagePct: 0.7,
              trendBudgetPct: 0.3,
              breakoutBudgetPct: 0.2,
              microBudgetPct: 0.15,
              trendRebalanceBars: 4,
              trendEntryFloor: 0.78,
              trendExitFloor: 0.55,
              trendSwitchGap: 0.1,
              trendMinAboveTrendRatio: 0.68,
              trendMinLiquidityScore: 0.1,
              trendMinCompositeTrend: 0.05,
              trendMinRiskOnGate: 0.05,
              trendMinTrendScoreGate: 0.05,
              trendGateMinAboveTrendRatio: 0.6,
              trendGateMinLiquidityScore: 0.08,
              leaderStrengthFloor: 0.7,
              leaderPullbackAtr: 0.9,
              leaderSetupExpiryBars: 4,
              leaderTrailAtrMult: 2.2,
              leaderMinRiskOnGate: 0.05,
              leaderMinTrendScoreGate: 0.05,
              leaderMinLiquidityGate: 0.08,
              breakoutLookback: 20,
              breakoutStrengthFloor: 0.8,
              breakoutMaxExtensionAtr: 1.4,
              breakoutTrailAtrMult: 2.2,
              breakoutMinRiskOnGate: 0.05,
              breakoutMinLiquidityGate: 0.08,
              breakoutMinVolatilityGate: 0.015,
              reversionEntryThreshold: 0.25,
              reversionExitThreshold: 0.15,
              reversionStopLossPct: 0.02,
              reversionMaxHoldBars: 24,
              reversionMaxRiskOnGate: 0.05,
              reversionMaxTrendScoreGate: 0.05,
              reversionMaxVolatilityGate: 0.04,
              cooldownBarsAfterLoss: 8,
              minBarsBetweenEntries: 4,
              universeLookbackBars: 24,
              microLookbackBars: 10,
              microExtensionThreshold: 0.003,
              microHoldingBarsMax: 8,
              microStopAtrMult: 1.1,
              microMinVolumeSpike: 1,
              microMinRiskOnScore: 0.02,
              microMinLiquidityScore: 0.04,
              microProfitTarget: 0.004,
              microMinRiskOnGate: 0.02,
              microMinLiquidityGate: 0.04,
              microMinVolatilityGate: 0.01
            },
            invalidationSignals: []
          }
        ]
      };
    },
    async reviewIteration({ evaluations }) {
      return {
        summary: "promote evaluated candidate",
        verdict: "promote_candidate",
        promotedCandidateId: evaluations[0]?.candidate.candidateId,
        nextPreparation: [],
        proposedFamilies: [],
        codeTasks: [],
        nextCandidates: [],
        retireCandidateIds: [],
        observations: ["market cap applied before evaluation"]
      };
    }
  };

  const orchestrator = createAutoResearchOrchestrator({
    llmClient,
    async resolveCandidateMarkets() {
      return [
        "KRW-BTC",
        "KRW-ETH",
        "KRW-XRP",
        "KRW-SOL",
        "KRW-DOGE",
        "KRW-SUI",
        "KRW-ADA",
        "KRW-SHIB",
        "KRW-BSV",
        "KRW-ICX",
        "KRW-STEEM",
        "KRW-ONG"
      ];
    },
    async evaluateCandidate({ candidate, marketCodes }) {
      evaluatedMarketCodes = marketCodes;
      return buildEvaluation(candidate, 0.03);
    },
    async prepareActions() {
      return [];
    },
    codeAgent: {
      async execute() {
        return [];
      }
    }
  });

  await orchestrator.run({
    strategyFamilyIds: ["multi-tf-regime-switch"],
    universeName: "krw-top",
    timeframe: "1h",
    marketLimit: 4,
    limit: 2000,
    holdoutDays: 30,
    trainingDays: 90,
    stepDays: 30,
    iterations: 1,
    candidatesPerIteration: 1,
    parallelism: 1,
    mode: "holdout",
    outputDir,
    allowDataCollection: false,
    allowFeatureCacheBuild: false,
    allowCodeMutation: false
  });

  assert.deepEqual(evaluatedMarketCodes, [
    "KRW-BTC",
    "KRW-ETH",
    "KRW-XRP",
    "KRW-SOL",
    "KRW-DOGE",
    "KRW-SUI",
    "KRW-ADA",
    "KRW-SHIB"
  ]);
});

test("auto research candidate market requirements include hidden confirm-family data needs", () => {
  const families = getStrategyFamilies([
    "multi-tf-regime-switch-screen",
    "multi-tf-regime-switch"
  ]);
  const requirements = resolveCandidateMarketRequirements({
    config: {
      universeName: "krw-top",
      timeframe: "1h",
      marketLimit: 5,
      limit: 5000,
      holdoutDays: 30,
      trainingDays: 90,
      stepDays: 30,
      iterations: 1,
      candidatesPerIteration: 1,
      parallelism: 1,
      mode: "walk-forward",
      outputDir: "/tmp/unused",
      allowDataCollection: false,
      allowFeatureCacheBuild: false,
      allowCodeMutation: false
    },
    families
  });

  assert.deepEqual(
    requirements.map((item) => item.timeframe).sort(),
    ["1h", "1m", "5m"]
  );
  assert.equal(
    requirements.find((item) => item.timeframe === "1h")?.minCandles,
    5000
  );
  assert.equal(
    requirements.find((item) => item.timeframe === "1m")?.minCandles,
    calculateAutoResearchMinimumLimit({
      timeframe: "1m",
      holdoutDays: 30,
      trainingDays: 90,
      stepDays: 30,
      mode: "walk-forward"
    })
  );
});

test("auto research stages full regime-switch evaluation behind the screen family", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-auto-research-staged-"));
  const screenFamily = getStrategyFamilies(["multi-tf-regime-switch-screen"])[0];

  assert.ok(screenFamily);

  const screenParameters = Object.fromEntries(
    screenFamily.parameterSpecs.map((spec) => [spec.name, Number(((spec.min + spec.max) / 2).toFixed(4))])
  );
  const evaluatedFamiliesByIteration = new Map<number, string[]>();
  let proposeCalls = 0;
  let reviewCalls = 0;

  const llmClient: ResearchLlmClient = {
    async proposeCandidates() {
      proposeCalls += 1;
      return {
        researchSummary: "screen the adaptive family first",
        preparation: [],
        proposedFamilies: [],
        codeTasks: [],
        candidates: [
          {
            candidateId: "multi-tf-regime-switch-screen-proposal-01",
            familyId: "multi-tf-regime-switch-screen",
            thesis: "Fast regime-switch screen candidate.",
            parameters: screenParameters,
            invalidationSignals: ["screen loses edge after confirm"]
          }
        ]
      };
    },
    async reviewIteration() {
      reviewCalls += 1;
      return {
        summary: reviewCalls === 1 ? "keep searching after screen pass" : "stop after staged confirm",
        verdict: reviewCalls === 1 ? "keep_searching" : "stop_no_edge",
        nextPreparation: [],
        proposedFamilies: [],
        codeTasks: [],
        nextCandidates: reviewCalls === 1
          ? [{
              familyId: "multi-tf-regime-switch-screen",
              thesis: "screen follow-up to unlock confirm family staging",
              parameters: screenParameters,
              invalidationSignals: ["screen loses edge after confirm"],
              parentCandidateIds: ["multi-tf-regime-switch-screen-proposal-01"]
            }]
          : [],
        retireCandidateIds: [],
        observations: []
      };
    }
  };

  const orchestrator = createAutoResearchOrchestrator({
    llmClient,
    async evaluateCandidate({ candidate, outputDir }) {
      const iterationMatch = outputDir.match(/iteration-(\d+)/);
      const iteration = iterationMatch ? Number(iterationMatch[1]) : 0;
      const bucket = evaluatedFamiliesByIteration.get(iteration) ?? [];
      bucket.push(candidate.familyId);
      evaluatedFamiliesByIteration.set(iteration, bucket);

      return buildEvaluation(candidate, candidate.familyId === "multi-tf-regime-switch" ? 0.04 : 0.03);
    },
    async prepareActions() {
      return [];
    },
    codeAgent: {
      async execute() {
        return [];
      }
    }
  });

  await orchestrator.run({
    strategyFamilyIds: ["multi-tf-regime-switch-screen"],
    universeName: "krw-top",
    timeframe: "1h",
    marketLimit: 3,
    limit: 2000,
    holdoutDays: 30,
    trainingDays: 90,
    stepDays: 30,
    iterations: 2,
    candidatesPerIteration: 2,
    parallelism: 1,
    mode: "holdout",
    outputDir,
    allowDataCollection: false,
    allowFeatureCacheBuild: false,
    allowCodeMutation: false,
    minNetReturnForPromotion: 0.5
  });

  assert.equal(proposeCalls, 1);
  assert.ok(
    evaluatedFamiliesByIteration.get(1)?.every((familyId) => familyId === "multi-tf-regime-switch-screen")
  );
  assert.ok(evaluatedFamiliesByIteration.get(2)?.includes("multi-tf-regime-switch-screen"));
  assert.ok(evaluatedFamiliesByIteration.get(2)?.includes("multi-tf-regime-switch"));
  assert.ok(!evaluatedFamiliesByIteration.get(1)?.includes("multi-tf-regime-switch"));
});

test("auto research warm-starts iteration one with external artifact seeds", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-auto-research-seeded-"));
  const artifactPath = path.join(outputDir, "seed-report.json");
  const family = getStrategyFamilies(["relative-momentum-pullback"])[0];

  assert.ok(family);

  const midpoint = Object.fromEntries(
    family.parameterSpecs.map((spec) => [spec.name, Number(((spec.min + spec.max) / 2).toFixed(4))])
  );
  const lowEdge = Object.fromEntries(
    family.parameterSpecs.map((spec) => [spec.name, Number((spec.min + (spec.max - spec.min) * 0.2).toFixed(4))])
  );
  const highEdge = Object.fromEntries(
    family.parameterSpecs.map((spec) => [spec.name, Number((spec.min + (spec.max - spec.min) * 0.8).toFixed(4))])
  );
  const partialHighEdge = Object.fromEntries(Object.entries(highEdge).slice(0, 2));
  const partialLowEdge = Object.fromEntries(Object.entries(lowEdge).slice(0, 2));

  await writeFile(
    artifactPath,
    `${JSON.stringify({
      familyId: family.familyId,
      walkForwardTop: [
        {
          candidateId: "artifact-top-01",
          familyId: family.familyId,
          parameters: partialHighEdge,
          netReturn: 0.04,
          maxDrawdown: 0.02,
          tradeCount: 18,
          positiveWindowRatio: 1
        },
        {
          candidateId: "artifact-top-02",
          familyId: family.familyId,
          parameters: partialLowEdge,
          netReturn: 0.03,
          maxDrawdown: 0.025,
          tradeCount: 14,
          positiveWindowRatio: 0.67
        }
      ]
    }, null, 2)}\n`
  );

  const evaluatedOrigins: Array<string | undefined> = [];
  const llmClient: ResearchLlmClient = {
    async proposeCandidates() {
      return {
        researchSummary: "one llm candidate",
        preparation: [],
        proposedFamilies: [],
        codeTasks: [],
        candidates: [
          {
            candidateId: "llm-only-01",
            familyId: family.familyId,
            thesis: "LLM midpoint candidate",
            parameters: midpoint,
            invalidationSignals: ["edge is weak"]
          }
        ]
      };
    },
    async reviewIteration() {
      return {
        summary: "stop after seeded iteration",
        verdict: "stop_no_edge",
        nextPreparation: [],
        proposedFamilies: [],
        codeTasks: [],
        nextCandidates: [],
        retireCandidateIds: [],
        observations: []
      };
    }
  };

  const orchestrator = createAutoResearchOrchestrator({
    llmClient,
    async evaluateCandidate({ candidate }) {
      evaluatedOrigins.push(candidate.origin);
      return buildEvaluation(candidate, candidate.origin === "artifact_seed" ? 0.03 : 0.01);
    },
    async prepareActions() {
      return [];
    },
    codeAgent: {
      async execute() {
        return [];
      }
    }
  });

  await orchestrator.run({
    strategyFamilyIds: [family.familyId],
    universeName: "krw-top",
    timeframe: "1h",
    marketLimit: 3,
    limit: 2000,
    holdoutDays: 30,
    trainingDays: 90,
    stepDays: 30,
    iterations: 1,
    candidatesPerIteration: 3,
    parallelism: 1,
    mode: "holdout",
    outputDir,
    allowDataCollection: false,
    allowFeatureCacheBuild: false,
    allowCodeMutation: false,
    seedArtifactPaths: [artifactPath],
    seedCandidatesPerIteration: 2
  });

  assert.equal(evaluatedOrigins.length, 3);
  assert.ok(evaluatedOrigins.includes("artifact_seed"));
});

test("auto research diversification prefers distant candidates within the same family", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-auto-research-diverse-"));
  const evaluatedCandidateIds: string[] = [];
  const family = getStrategyFamilies(["relative-momentum-pullback"])[0];

  assert.ok(family);

  const specsByName = Object.fromEntries(family.parameterSpecs.map((spec) => [spec.name, spec]));
  const anchor = Object.fromEntries(
    family.parameterSpecs.map((spec) => [spec.name, Number((spec.min + (spec.max - spec.min) * 0.2).toFixed(4))])
  );
  const near = {
    ...anchor,
    [family.parameterSpecs[0]!.name]: Number(
      (
        anchor[family.parameterSpecs[0]!.name] +
        (specsByName[family.parameterSpecs[0]!.name]!.max - specsByName[family.parameterSpecs[0]!.name]!.min) * 0.02
      ).toFixed(4)
    )
  };
  const far = Object.fromEntries(
    family.parameterSpecs.map((spec) => [spec.name, Number((spec.min + (spec.max - spec.min) * 0.85).toFixed(4))])
  );

  const llmClient: ResearchLlmClient = {
    async proposeCandidates() {
      return {
        researchSummary: "same family, varied distances",
        preparation: [],
        proposedFamilies: [],
        codeTasks: [],
        candidates: [
          {
            candidateId: "candidate-a",
            familyId: family.familyId,
            thesis: "anchor candidate",
            parameters: anchor,
            invalidationSignals: ["none"]
          },
          {
            candidateId: "candidate-b",
            familyId: family.familyId,
            thesis: "near duplicate candidate",
            parameters: near,
            invalidationSignals: ["none"]
          },
          {
            candidateId: "candidate-c",
            familyId: family.familyId,
            thesis: "far candidate",
            parameters: far,
            invalidationSignals: ["none"]
          }
        ]
      };
    },
    async reviewIteration() {
      return {
        summary: "stop after one pass",
        verdict: "stop_no_edge",
        nextPreparation: [],
        proposedFamilies: [],
        codeTasks: [],
        nextCandidates: [],
        retireCandidateIds: [],
        observations: []
      };
    }
  };

  const orchestrator = createAutoResearchOrchestrator({
    llmClient,
    async evaluateCandidate({ candidate }) {
      evaluatedCandidateIds.push(candidate.candidateId);
      return buildEvaluation(candidate, 0.01);
    },
    async prepareActions() {
      return [];
    },
    codeAgent: {
      async execute() {
        return [];
      }
    }
  });

  await orchestrator.run({
    strategyFamilyIds: [family.familyId],
    universeName: "krw-top",
    timeframe: "1h",
    marketLimit: 3,
    limit: 2000,
    holdoutDays: 30,
    trainingDays: 90,
    stepDays: 30,
    iterations: 1,
    candidatesPerIteration: 2,
    parallelism: 1,
    mode: "holdout",
    outputDir,
    allowDataCollection: false,
    allowFeatureCacheBuild: false,
    allowCodeMutation: false,
    candidateDiversificationMinDistance: 0.2
  });

  assert.deepEqual(evaluatedCandidateIds, ["candidate-a", "candidate-c"]);
});

test("auto research v2 survives review failure with objective governance and persists lineage", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-auto-research-v2-review-fail-"));

  const llmClient: ResearchLlmClient = {
    async proposeCandidates() {
      return {
        researchSummary: "v2 proposal",
        preparation: [],
        proposedFamilies: [],
        codeTasks: [],
        candidates: [
          {
            candidateId: "v2-candidate-01",
            familyId: "relative-momentum-pullback",
            thesis: "base candidate",
            parameters: {
              minStrengthPct: 0.8,
              minRiskOn: 0.1,
              pullbackZ: 0.9,
              trailAtrMult: 2.1
            },
            invalidationSignals: []
          }
        ]
      };
    },
    async reviewIteration() {
      throw new Error("review transport failed");
    }
  };

  const orchestrator = createAutoResearchOrchestrator({
    llmClient,
    async evaluateCandidate({ candidate }) {
      return buildEvaluation(candidate, 0.01);
    },
    async prepareActions() {
      return [];
    },
    codeAgent: {
      async execute() {
        return [];
      }
    }
  });

  const report = await orchestrator.run({
    strategyFamilyIds: ["relative-momentum-pullback"],
    universeName: "krw-top",
    timeframe: "1h",
    marketLimit: 3,
    limit: 2000,
    holdoutDays: 30,
    trainingDays: 90,
    stepDays: 30,
    iterations: 1,
    candidatesPerIteration: 2,
    parallelism: 1,
    mode: "holdout",
    outputDir,
    allowDataCollection: false,
    allowFeatureCacheBuild: false,
    allowCodeMutation: false,
    loopVersion: "v2",
    minNetReturnForPromotion: 0.5
  });

  assert.equal(report.outcome, "completed");
  assert.ok(report.lineage);
  assert.equal(report.iterations.length, 1);
  assert.match(report.iterations[0]?.review.summary ?? "", /Objective governance/i);

  const lineageSnapshot = await loadLineageSnapshot(outputDir);
  assert.ok(lineageSnapshot);
  assert.equal(lineageSnapshot?.latestIteration, 1);

  const lineageEventsRaw = await readFile(path.join(outputDir, "research-lineage-events.jsonl"), "utf8");
  assert.match(lineageEventsRaw, /proposal_recorded/);
  assert.match(lineageEventsRaw, /iteration_reviewed/);
});

test("auto research v2 survives proposal failure with objective seed continuity", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-auto-research-v2-proposal-fail-"));

  const llmClient: ResearchLlmClient = {
    async proposeCandidates() {
      throw new Error("proposal transport failed");
    },
    async reviewIteration() {
      return {
        summary: "stop after objective seed pass",
        verdict: "stop_no_edge",
        nextPreparation: [],
        proposedFamilies: [],
        codeTasks: [],
        nextCandidates: [],
        retireCandidateIds: [],
        observations: []
      };
    }
  };

  const orchestrator = createAutoResearchOrchestrator({
    llmClient,
    async evaluateCandidate({ candidate }) {
      return buildEvaluation(candidate, 0.0125);
    },
    async prepareActions() {
      return [];
    },
    codeAgent: {
      async execute() {
        return [];
      }
    }
  });

  const report = await orchestrator.run({
    strategyFamilyIds: ["relative-momentum-pullback"],
    universeName: "krw-top",
    timeframe: "1h",
    marketLimit: 3,
    limit: 2000,
    holdoutDays: 30,
    trainingDays: 90,
    stepDays: 30,
    iterations: 1,
    candidatesPerIteration: 2,
    parallelism: 1,
    mode: "holdout",
    outputDir,
    allowDataCollection: false,
    allowFeatureCacheBuild: false,
    allowCodeMutation: false,
    loopVersion: "v2"
  });

  assert.equal(report.outcome, "completed");
  assert.equal(report.iterations.length, 1);
  assert.ok(
    report.iterations[0]?.proposal.candidates.every(
      (candidate) => candidate.origin === "engine_seed" || candidate.origin === "artifact_seed"
    )
  );
  const lineageSnapshot = await loadLineageSnapshot(outputDir);
  assert.ok(lineageSnapshot);
});

test("auto research v2 repairs empty keep_searching batches with deterministic continuation", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-auto-research-v2-empty-next-"));

  let reviewCalls = 0;
  const llmClient: ResearchLlmClient = {
    async proposeCandidates() {
      return {
        researchSummary: "v2 keep searching",
        preparation: [],
        proposedFamilies: [],
        codeTasks: [],
        candidates: [
          {
            candidateId: "v2-keep-searching-01",
            familyId: "relative-momentum-pullback",
            thesis: "base candidate",
            parameters: {
              minStrengthPct: 0.8,
              minRiskOn: 0.1,
              pullbackZ: 0.95,
              trailAtrMult: 2.3
            },
            invalidationSignals: []
          }
        ]
      };
    },
    async reviewIteration() {
      reviewCalls += 1;
      return {
        summary: "keep searching with no explicit next batch",
        verdict: "keep_searching",
        nextPreparation: [],
        proposedFamilies: [],
        codeTasks: [],
        nextCandidates: [],
        retireCandidateIds: [],
        observations: []
      };
    }
  };

  const orchestrator = createAutoResearchOrchestrator({
    llmClient,
    async evaluateCandidate({ candidate }) {
      return buildEvaluation(candidate, 0.015);
    },
    async prepareActions() {
      return [];
    },
    codeAgent: {
      async execute() {
        return [];
      }
    }
  });

  const report = await orchestrator.run({
    strategyFamilyIds: ["relative-momentum-pullback"],
    universeName: "krw-top",
    timeframe: "1h",
    marketLimit: 3,
    limit: 2000,
    holdoutDays: 30,
    trainingDays: 90,
    stepDays: 30,
    iterations: 2,
    candidatesPerIteration: 2,
    parallelism: 1,
    mode: "holdout",
    outputDir,
    allowDataCollection: false,
    allowFeatureCacheBuild: false,
    allowCodeMutation: false,
    loopVersion: "v2",
    minNetReturnForPromotion: 0.5
  });

  assert.equal(reviewCalls, 2);
  assert.equal(report.iterations.length, 2);
  assert.ok(
    report.iterations.some((iteration) =>
      iteration.review.observations.some((observation) => /Objective compiler supplied a deterministic next batch/i.test(observation))
    )
  );
});

test("auto research completed runs persist artifact audit verification and iteration provenance", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-auto-research-audit-"));

  const llmClient: ResearchLlmClient = {
    async proposeCandidates() {
      return {
        researchSummary: "verified proposal",
        preparation: [],
        proposedFamilies: [],
        codeTasks: [],
        candidates: [
          {
            candidateId: "verified-01",
            familyId: "relative-momentum-pullback",
            thesis: "verified candidate",
            parameters: {
              minStrengthPct: 0.8,
              minRiskOn: 0.1,
              pullbackZ: 0.95,
              trailAtrMult: 2.3
            },
            invalidationSignals: []
          }
        ]
      };
    },
    async reviewIteration({ evaluations }) {
      return {
        summary: "promote verified winner",
        verdict: "promote_candidate",
        promotedCandidateId: evaluations[0]?.candidate.candidateId,
        nextPreparation: [],
        proposedFamilies: [],
        codeTasks: [],
        nextCandidates: [],
        retireCandidateIds: [],
        observations: []
      };
    }
  };

  const orchestrator = createAutoResearchOrchestrator({
    llmClient,
    async evaluateCandidate({ candidate }) {
      return buildEvaluation(candidate, 0.12);
    },
    async prepareActions() {
      return [];
    },
    codeAgent: {
      async execute() {
        return [];
      }
    }
  });

  const report = await orchestrator.run({
    strategyFamilyIds: ["relative-momentum-pullback"],
    universeName: "krw-top",
    timeframe: "1h",
    marketLimit: 3,
    limit: 2000,
    holdoutDays: 30,
    trainingDays: 90,
    stepDays: 30,
    iterations: 1,
    candidatesPerIteration: 1,
    parallelism: 1,
    mode: "holdout",
    outputDir,
    allowDataCollection: false,
    allowFeatureCacheBuild: false,
    allowCodeMutation: false,
    loopVersion: "v2",
    minNetReturnForPromotion: 0.1
  });

  const savedState = JSON.parse(await readFile(path.join(outputDir, "run-state.json"), "utf8"));
  const savedStatus = JSON.parse(await readFile(path.join(outputDir, "status.json"), "utf8"));
  const savedAudit = JSON.parse(await readFile(path.join(outputDir, "artifact-audit.json"), "utf8"));

  assert.equal(report.outcome, "completed");
  assert.equal(savedStatus.phase, "completed");
  assert.equal(savedState.verification.artifactAudit.ok, true);
  assert.equal(savedAudit.ok, true);
  assert.equal(savedState.iterations[0].provenance.proposalSource, "llm");
  assert.equal(savedState.iterations[0].provenance.reviewUsedObjectiveGovernance, false);
});

test("auto research artifact audit fails after leaderboard tampering", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-auto-research-audit-tamper-"));

  const llmClient: ResearchLlmClient = {
    async proposeCandidates() {
      return {
        researchSummary: "tamper proposal",
        preparation: [],
        proposedFamilies: [],
        codeTasks: [],
        candidates: [
          {
            candidateId: "tamper-01",
            familyId: "relative-momentum-pullback",
            thesis: "tamper candidate",
            parameters: {
              minStrengthPct: 0.8,
              minRiskOn: 0.1,
              pullbackZ: 0.95,
              trailAtrMult: 2.3
            },
            invalidationSignals: []
          }
        ]
      };
    },
    async reviewIteration({ evaluations }) {
      return {
        summary: "promote tamper winner",
        verdict: "promote_candidate",
        promotedCandidateId: evaluations[0]?.candidate.candidateId,
        nextPreparation: [],
        proposedFamilies: [],
        codeTasks: [],
        nextCandidates: [],
        retireCandidateIds: [],
        observations: []
      };
    }
  };

  const orchestrator = createAutoResearchOrchestrator({
    llmClient,
    async evaluateCandidate({ candidate }) {
      return buildEvaluation(candidate, 0.12);
    },
    async prepareActions() {
      return [];
    },
    codeAgent: {
      async execute() {
        return [];
      }
    }
  });

  await orchestrator.run({
    strategyFamilyIds: ["relative-momentum-pullback"],
    universeName: "krw-top",
    timeframe: "1h",
    marketLimit: 3,
    limit: 2000,
    holdoutDays: 30,
    trainingDays: 90,
    stepDays: 30,
    iterations: 1,
    candidatesPerIteration: 1,
    parallelism: 1,
    mode: "holdout",
    outputDir,
    allowDataCollection: false,
    allowFeatureCacheBuild: false,
    allowCodeMutation: false,
    loopVersion: "v2",
    minNetReturnForPromotion: 0.1
  });

  await writeFile(
    path.join(outputDir, "leaderboard.json"),
    `${JSON.stringify([{ candidateId: "corrupted" }], null, 2)}\n`
  );

  const audit = await writeAutoResearchArtifactAudit(outputDir);
  assert.equal(audit.ok, false);
  assert.match(audit.failureReason ?? "", /leaderboard\.json/i);
});
