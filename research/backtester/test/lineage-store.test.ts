import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendLineageEvent,
  buildLineageEventsFromIteration,
  buildLineageSnapshot,
  appendLineageEvents,
  loadOrCreateResearchLineage,
  loadLineageEvents,
  loadLineageSnapshot,
  saveLineageSnapshot,
  updateResearchLineageFromIterations
} from "../src/auto-research/lineage-store.js";
import {
  calculateCandidateParameterDrift,
  calculateFamilyTurnover,
  calculateLineageMetrics,
  toResearchDriftMetrics
} from "../src/auto-research/lineage-metrics.js";
import type {
  AutoResearchRunConfig,
  CandidateBacktestEvaluation,
  NormalizedCandidateProposal,
  ResearchIterationRecord
} from "../src/auto-research/types.js";

function buildCandidate(params: {
  candidateId: string;
  familyId: string;
  strategyName?: string;
  thesis?: string;
  parameters?: Record<string, number>;
  origin?: NormalizedCandidateProposal["origin"];
  parentCandidateIds?: string[];
}): NormalizedCandidateProposal {
  return {
    candidateId: params.candidateId,
    familyId: params.familyId,
    strategyName: params.strategyName ?? `${params.familyId}-strategy`,
    thesis: params.thesis ?? `${params.familyId} thesis`,
    parameters: params.parameters ?? {},
    invalidationSignals: [],
    origin: params.origin,
    parentCandidateIds: params.parentCandidateIds
  };
}

function buildEvaluation(params: {
  candidate: NormalizedCandidateProposal;
  netReturn: number;
  tradeCount: number;
  maxDrawdown?: number;
  status?: CandidateBacktestEvaluation["status"];
}): CandidateBacktestEvaluation {
  const status = params.status ?? "completed";
  return {
    candidate: params.candidate,
    mode: "holdout",
    status,
    failure: status === "failed"
      ? { stage: "backtest", message: "failed in test harness" }
      : undefined,
    summary: {
      totalReturn: params.netReturn,
      grossReturn: params.netReturn,
      netReturn: params.netReturn,
      maxDrawdown: params.maxDrawdown ?? 0.08,
      turnover: 0.2,
      winRate: 0.5,
      avgHoldBars: 6,
      tradeCount: params.tradeCount,
      feePaid: 0,
      slippagePaid: 0,
      rejectedOrdersCount: 0,
      cooldownSkipsCount: 0,
      signalCount: 10,
      ghostSignalCount: 14
    },
    diagnostics: {
      coverage: {
        tradeCount: params.tradeCount,
        signalCount: 10,
        ghostSignalCount: 14,
        rejectedOrdersCount: 0,
        cooldownSkipsCount: 0,
        rawBuySignals: 4,
        rawSellSignals: 3,
        rawHoldSignals: 3,
        avgUniverseSize: 5,
        minUniverseSize: 4,
        maxUniverseSize: 6,
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
        feePaid: 0,
        slippagePaid: 0,
        totalCostsPaid: 0
      },
      robustness: {},
      crossChecks: [],
      windows: {
        mode: "holdout",
        holdoutDays: 30
      }
    }
  };
}

function buildIteration(params: {
  iteration: number;
  evaluations: CandidateBacktestEvaluation[];
  promotedCandidateId?: string;
  retireCandidateIds?: string[];
}): ResearchIterationRecord {
  return {
    iteration: params.iteration,
    proposal: {
      researchSummary: `proposal ${params.iteration}`,
      preparation: [],
      proposedFamilies: [],
      codeTasks: [],
      candidates: params.evaluations.map((evaluation) => ({
        candidateId: evaluation.candidate.candidateId,
        familyId: evaluation.candidate.familyId,
        thesis: evaluation.candidate.thesis,
        parameters: evaluation.candidate.parameters,
        invalidationSignals: [],
        origin: evaluation.candidate.origin,
        parentCandidateIds: evaluation.candidate.parentCandidateIds
      }))
    },
    preparationResults: [],
    codeMutationResults: [],
    validationResults: [],
    evaluations: params.evaluations,
    review: {
      summary: `review ${params.iteration}`,
      verdict: params.promotedCandidateId ? "promote_candidate" : "keep_searching",
      promotedCandidateId: params.promotedCandidateId,
      nextPreparation: [],
      proposedFamilies: [],
      codeTasks: [],
      nextCandidates: [],
      retireCandidateIds: params.retireCandidateIds ?? [],
      observations: ["tracked"]
    }
  };
}

function buildConfig(outputDir: string): AutoResearchRunConfig {
  return {
    universeName: "krw-top",
    timeframe: "1h",
    marketLimit: 5,
    limit: 1000,
    holdoutDays: 30,
    trainingDays: 90,
    stepDays: 30,
    iterations: 3,
    candidatesPerIteration: 2,
    parallelism: 1,
    mode: "holdout",
    outputDir,
    allowDataCollection: false,
    allowFeatureCacheBuild: false,
    allowCodeMutation: false
  };
}

function assertApprox(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) <= 2e-6, `${actual} !== ${expected}`);
}

test("lineage store appends and reloads ordered JSONL events", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-lineage-events-"));
  const iteration = buildIteration({
    iteration: 2,
    evaluations: [
      buildEvaluation({
        candidate: buildCandidate({
          candidateId: "cand-a-02",
          familyId: "family-a",
          parameters: { alpha: 1.5 },
          origin: "llm",
          parentCandidateIds: ["cand-a-01"]
        }),
        netReturn: 0.06,
        tradeCount: 5
      }),
      buildEvaluation({
        candidate: buildCandidate({
          candidateId: "cand-b-02",
          familyId: "family-b",
          parameters: { beta: 0.8 }
        }),
        netReturn: 0.01,
        tradeCount: 0
      })
    ],
    promotedCandidateId: "cand-a-02",
    retireCandidateIds: ["cand-b-01"]
  });

  const events = buildLineageEventsFromIteration(iteration, "2026-03-22T00:00:00.000Z");
  await appendLineageEvents(outputDir, events.slice(0, 2));
  await appendLineageEvents(outputDir, events.slice(2));

  const loaded = await loadLineageEvents(outputDir);
  assert.equal(loaded.length, 5);
  assert.deepEqual(loaded.map((event) => event.kind), [
    "candidate_evaluated",
    "candidate_evaluated",
    "review_completed",
    "candidate_promoted",
    "candidate_retired"
  ]);
  assert.equal(loaded[0] && "candidateId" in loaded[0] ? loaded[0].candidateId : undefined, "cand-a-02");
  assert.equal(loaded[3] && "candidateId" in loaded[3] ? loaded[3].candidateId : undefined, "cand-a-02");
  assert.equal(loaded[4] && "candidateId" in loaded[4] ? loaded[4].candidateId : undefined, "cand-b-01");
});

test("lineage metrics compute drift and stagnation across iterations", () => {
  const iteration1 = buildIteration({
    iteration: 1,
    evaluations: [
      buildEvaluation({
        candidate: buildCandidate({
          candidateId: "cand-a-01",
          familyId: "family-a",
          parameters: { alpha: 1 }
        }),
        netReturn: 0.05,
        tradeCount: 4
      }),
      buildEvaluation({
        candidate: buildCandidate({
          candidateId: "cand-b-01",
          familyId: "family-b",
          parameters: { beta: 2 }
        }),
        netReturn: 0.02,
        tradeCount: 1
      })
    ]
  });
  const iteration2 = buildIteration({
    iteration: 2,
    evaluations: [
      buildEvaluation({
        candidate: buildCandidate({
          candidateId: "cand-a-02",
          familyId: "family-a",
          parameters: { alpha: 1.5 },
          origin: "llm",
          parentCandidateIds: ["cand-a-01"]
        }),
        netReturn: 0.06,
        tradeCount: 6
      }),
      buildEvaluation({
        candidate: buildCandidate({
          candidateId: "cand-c-01",
          familyId: "family-c",
          parameters: { gamma: 0.4 }
        }),
        netReturn: 0.01,
        tradeCount: 0
      })
    ]
  });
  const iteration3 = buildIteration({
    iteration: 3,
    evaluations: [
      buildEvaluation({
        candidate: buildCandidate({
          candidateId: "cand-a-03",
          familyId: "family-a",
          parameters: { alpha: 1.75 },
          origin: "llm",
          parentCandidateIds: ["cand-a-02"]
        }),
        netReturn: 0.055,
        tradeCount: 3
      })
    ]
  });

  const metrics = calculateLineageMetrics([iteration1, iteration2, iteration3]);

  assert.equal(metrics.iterationCount, 3);
  assert.equal(metrics.uniqueCandidateCount, 5);
  assert.equal(metrics.uniqueFamilyCount, 3);
  assert.equal(metrics.stagnantIterationCount, 1);
  assert.equal(metrics.currentStagnationStreak, 1);
  assert.equal(metrics.longestStagnationStreak, 1);
  assertApprox(metrics.bestNetReturnDrift, 0.005);
  assertApprox(metrics.averageNetReturnDrift, 0.02);
  assertApprox(metrics.averageFamilyTurnover, 0.583334);
  assertApprox(metrics.latestFamilyTurnover, 0.5);
  assertApprox(metrics.averageBestParameterDrift, 0.333334);
  assertApprox(metrics.latestBestParameterDrift, 0.166667);
  assert.equal(metrics.iterationSummaries[2]?.stagnationStreak, 1);
});

test("lineage snapshot persists candidate, family, and metric summaries", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-lineage-snapshot-"));
  const iteration1 = buildIteration({
    iteration: 1,
    evaluations: [
      buildEvaluation({
        candidate: buildCandidate({
          candidateId: "cand-a-01",
          familyId: "family-a",
          parameters: { alpha: 1 }
        }),
        netReturn: 0.05,
        tradeCount: 4
      }),
      buildEvaluation({
        candidate: buildCandidate({
          candidateId: "cand-b-01",
          familyId: "family-b",
          parameters: { beta: 2 }
        }),
        netReturn: -0.01,
        tradeCount: 0
      })
    ]
  });
  const iteration2 = buildIteration({
    iteration: 2,
    evaluations: [
      buildEvaluation({
        candidate: buildCandidate({
          candidateId: "cand-a-02",
          familyId: "family-a",
          parameters: { alpha: 1.25 },
          origin: "llm",
          parentCandidateIds: ["cand-a-01"]
        }),
        netReturn: 0.06,
        tradeCount: 5
      })
    ],
    promotedCandidateId: "cand-a-02",
    retireCandidateIds: ["cand-b-01"]
  });

  const events = [
    ...buildLineageEventsFromIteration(iteration1, "2026-03-22T01:00:00.000Z"),
    ...buildLineageEventsFromIteration(iteration2, "2026-03-22T02:00:00.000Z")
  ];
  const snapshot = buildLineageSnapshot({
    iterations: [iteration1, iteration2],
    config: buildConfig(outputDir),
    savedAt: "2026-03-22T03:00:00.000Z",
    eventCount: events.length
  });

  await saveLineageSnapshot(outputDir, snapshot);
  const loaded = await loadLineageSnapshot(outputDir);

  assert.ok(loaded);
  assert.equal(loaded?.summary.candidateCount, 3);
  assert.equal(loaded?.summary.familyCount, 2);
  assert.equal(loaded?.summary.promotedCandidateCount, 1);
  assert.equal(loaded?.eventCount, events.length);
  assert.equal(loaded?.run?.universeName, "krw-top");
  assert.equal(loaded?.metrics.iterationCount, 2);
  assert.equal(loaded?.families[0]?.familyId, "family-a");
  assert.equal(loaded?.families[0]?.promotedCandidateIds[0], "cand-a-02");
  assert.equal(loaded?.candidates.find((candidate) => candidate.candidateId === "cand-a-02")?.promoted, true);
  assert.deepEqual(
    loaded?.candidates.find((candidate) => candidate.candidateId === "cand-a-02")?.parentCandidateIds,
    ["cand-a-01"]
  );
});

test("research lineage state persists and updates from iterations", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-research-lineage-"));
  const iteration1 = buildIteration({
    iteration: 1,
    evaluations: [
      buildEvaluation({
        candidate: buildCandidate({
          candidateId: "cand-a-01",
          familyId: "family-a",
          parameters: { alpha: 1 }
        }),
        netReturn: 0.05,
        tradeCount: 4
      }),
      buildEvaluation({
        candidate: buildCandidate({
          candidateId: "cand-b-01",
          familyId: "family-b",
          parameters: { beta: 2 }
        }),
        netReturn: -0.01,
        tradeCount: 0
      })
    ]
  });
  const iteration2 = buildIteration({
    iteration: 2,
    evaluations: [
      buildEvaluation({
        candidate: buildCandidate({
          candidateId: "cand-a-02",
          familyId: "family-a",
          parameters: { alpha: 1.25 },
          origin: "llm",
          parentCandidateIds: ["cand-a-01"]
        }),
        netReturn: 0.06,
        tradeCount: 5
      })
    ],
    promotedCandidateId: "cand-a-02",
    retireCandidateIds: ["cand-b-01"]
  });

  const lineage = await loadOrCreateResearchLineage({
    outputDir,
    stage: "auto",
    objective: "test lineage objective"
  });
  await appendLineageEvent({
    outputDir,
    event: {
      eventId: "evt-001",
      lineageId: lineage.lineageId,
      at: "2026-03-22T04:00:00.000Z",
      type: "iteration_completed",
      payload: { iteration: 2 }
    }
  });
  const updated = await updateResearchLineageFromIterations({
    outputDir,
    lineage,
    iterations: [iteration1, iteration2],
    updatedAt: "2026-03-22T05:00:00.000Z"
  });

  assert.equal(updated.activeHypothesisIds[0], "cand-a-02");
  assert.deepEqual(updated.convergedFamilyIds, ["family-a"]);
  assert.deepEqual(updated.retiredHypothesisIds, ["cand-b-01"]);
  assert.equal(updated.drift.performanceDrift, 0.01);
  assert.equal(updated.updatedAt, "2026-03-22T05:00:00.000Z");
});

test("standalone drift helpers stay bounded and deterministic", () => {
  assertApprox(calculateFamilyTurnover(["a", "b"], ["a", "c"]), 0.666667);
  assertApprox(
    calculateCandidateParameterDrift(
      { familyId: "family-a", parameters: { alpha: 1, beta: 2 } },
      { familyId: "family-a", parameters: { alpha: 1.5, beta: 1 } }
    ),
    0.5
  );
  assert.equal(
    calculateCandidateParameterDrift(
      { familyId: "family-a", parameters: { alpha: 1 } },
      { familyId: "family-b", parameters: { alpha: 1 } }
    ),
    1
  );
  assert.deepEqual(
    toResearchDriftMetrics(
      calculateLineageMetrics([
        buildIteration({
          iteration: 1,
          evaluations: [
            buildEvaluation({
              candidate: buildCandidate({
                candidateId: "cand-a-01",
                familyId: "family-a",
                parameters: { alpha: 1 }
              }),
              netReturn: 0.05,
              tradeCount: 4
            })
          ]
        }),
        buildIteration({
          iteration: 2,
          evaluations: [
            buildEvaluation({
              candidate: buildCandidate({
                candidateId: "cand-a-02",
                familyId: "family-a",
                parameters: { alpha: 1.2 }
              }),
              netReturn: 0.05,
              tradeCount: 3
            })
          ]
        })
      ])
    ),
    {
      performanceDrift: 0,
      noveltyDrift: 0,
      structureDrift: 0.2,
      reproducibilityDrift: 0,
      stagnationScore: 1
    }
  );
});
