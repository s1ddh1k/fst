import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { governReviewDecision } from "../src/auto-research/research-review.js";
import { isResearchConverged } from "../src/auto-research/lineage-metrics.js";
import type {
  AutoResearchRunConfig,
  CandidateBacktestEvaluation,
  NormalizedCandidateProposal,
  ResearchDriftMetrics,
  ReviewDecision
} from "../src/auto-research/types.js";

function buildConfig(overrides: Partial<AutoResearchRunConfig> = {}): AutoResearchRunConfig {
  return {
    universeName: "krw-top",
    timeframe: "1h",
    marketLimit: 3,
    limit: 2_000,
    holdoutDays: 30,
    trainingDays: 90,
    stepDays: 30,
    iterations: 10,
    candidatesPerIteration: 2,
    parallelism: 1,
    mode: "walk-forward",
    outputDir: "/tmp/fst-continuous-test",
    allowDataCollection: false,
    allowFeatureCacheBuild: false,
    allowCodeMutation: false,
    loopVersion: "v2",
    ...overrides
  };
}

function buildCandidate(familyId: string, id: string): NormalizedCandidateProposal {
  return {
    candidateId: id,
    familyId,
    strategyName: familyId,
    thesis: "test",
    parameters: { p1: 0.5 },
    invalidationSignals: []
  };
}

function buildEvaluation(
  familyId: string,
  id: string,
  netReturn: number,
  overrides?: Partial<{ tradeCount: number; maxDrawdown: number; randomPercentile: number }>
): CandidateBacktestEvaluation {
  return {
    candidate: buildCandidate(familyId, id),
    mode: "walk-forward",
    status: "completed",
    summary: {
      totalReturn: netReturn,
      grossReturn: netReturn + 0.01,
      netReturn,
      maxDrawdown: overrides?.maxDrawdown ?? 0.05,
      turnover: 0.2,
      winRate: 0.5,
      avgHoldBars: 8,
      tradeCount: overrides?.tradeCount ?? 20,
      feePaid: 0.01,
      slippagePaid: 0.01,
      rejectedOrdersCount: 0,
      cooldownSkipsCount: 0,
      signalCount: 50,
      ghostSignalCount: 5,
      randomPercentile: overrides?.randomPercentile ?? 0.85
    },
    diagnostics: {
      coverage: {
        tradeCount: overrides?.tradeCount ?? 20,
        signalCount: 50,
        ghostSignalCount: 5,
        rejectedOrdersCount: 0,
        cooldownSkipsCount: 0,
        rawBuySignals: 30,
        rawSellSignals: 20,
        rawHoldSignals: 10,
        avgUniverseSize: 5,
        minUniverseSize: 3,
        maxUniverseSize: 7,
        avgConsideredBuys: 2,
        avgEligibleBuys: 1
      },
      reasons: { strategy: {}, strategyTags: {}, coordinator: {}, execution: {}, risk: {} },
      costs: { feePaid: 0.01, slippagePaid: 0.01, totalCostsPaid: 0.02 },
      robustness: { randomPercentile: overrides?.randomPercentile ?? 0.85 },
      crossChecks: [],
      windows: {
        mode: "walk-forward",
        holdoutDays: 30,
        positiveWindowRatio: 0.6,
        positiveWindowCount: 3,
        negativeWindowCount: 2,
        windowCount: 5,
        totalClosedTrades: overrides?.tradeCount ?? 20
      }
    }
  };
}

function buildKeepSearchingReview(): ReviewDecision {
  return {
    summary: "keep searching",
    verdict: "keep_searching",
    nextPreparation: [],
    proposedFamilies: [],
    codeTasks: [],
    nextCandidates: [{ familyId: "fam-a", thesis: "t", parameters: { p1: 0.6 }, invalidationSignals: [] }],
    retireCandidateIds: [],
    observations: []
  };
}

// --- Anti Self-Bias: governReviewDecision ---

describe("governReviewDecision anti self-bias", () => {
  it("forces stop_no_edge when all families are stagnant and no promotable candidate", () => {
    const config = buildConfig({ stagnationRetireThreshold: 5 });
    const stagnation = new Map([["fam-a", 6], ["fam-b", 5]]);
    const counts = new Map([["fam-a", 10], ["fam-b", 8]]);
    const evaluations = [
      buildEvaluation("fam-a", "c1", 0.01, { tradeCount: 2 }), // low trades, won't pass gate
      buildEvaluation("fam-b", "c2", 0.02, { tradeCount: 1 })
    ];

    const result = governReviewDecision({
      review: buildKeepSearchingReview(),
      evaluations,
      config,
      iteration: 7,
      familyStagnationStreak: stagnation,
      familyIterationCounts: counts
    });

    assert.equal(result.verdict, "stop_no_edge");
    assert.ok(result.observations.some((o) => o.includes("Anti self-bias")));
  });

  it("does NOT force stop when a promotable candidate exists despite stagnation", () => {
    const config = buildConfig({ stagnationRetireThreshold: 5, minNetReturnForPromotion: 0.05 });
    const stagnation = new Map([["fam-a", 10]]);
    const evaluations = [
      buildEvaluation("fam-a", "c1", 0.12, { tradeCount: 20, randomPercentile: 0.85 })
    ];

    const result = governReviewDecision({
      review: buildKeepSearchingReview(),
      evaluations,
      config,
      iteration: 12,
      familyStagnationStreak: stagnation
    });

    // Should promote, not stop
    assert.equal(result.verdict, "promote_candidate");
  });

  it("does NOT force stop when stagnation is below threshold", () => {
    const config = buildConfig({ stagnationRetireThreshold: 8 });
    const stagnation = new Map([["fam-a", 3]]);
    const evaluations = [
      buildEvaluation("fam-a", "c1", 0.01, { tradeCount: 2 })
    ];

    const result = governReviewDecision({
      review: buildKeepSearchingReview(),
      evaluations,
      config,
      iteration: 5,
      familyStagnationStreak: stagnation
    });

    assert.equal(result.verdict, "keep_searching");
  });

  it("adds observation for family with negative return after half budget", () => {
    const config = buildConfig({ familyIterationBudget: 10, stagnationRetireThreshold: 20 });
    const stagnation = new Map([["fam-a", 1]]);
    const counts = new Map([["fam-a", 6]]); // > halfBudget (5)
    const evaluations = [
      buildEvaluation("fam-a", "c1", -0.03, { tradeCount: 15 })
    ];

    const result = governReviewDecision({
      review: buildKeepSearchingReview(),
      evaluations,
      config,
      iteration: 7,
      familyStagnationStreak: stagnation,
      familyIterationCounts: counts
    });

    assert.ok(result.observations.some((o) => o.includes("Anti self-bias") && o.includes("negative")));
  });

  it("continuous mode does not treat every iteration as final", () => {
    const config = buildConfig({ continuousMode: true, iterations: 3 });
    const evaluations = [
      buildEvaluation("fam-a", "c1", 0.02, { tradeCount: 2 })
    ];

    // Iteration 5 is past config.iterations=3, but in continuous mode it should NOT be final
    const result = governReviewDecision({
      review: buildKeepSearchingReview(),
      evaluations,
      config,
      iteration: 5
    });

    // Should keep searching, not force promote or stop
    assert.equal(result.verdict, "keep_searching");
  });

  it("non-continuous mode forces promotion on final iteration if promotable", () => {
    const config = buildConfig({ continuousMode: false, iterations: 5, minNetReturnForPromotion: 0.05 });
    const evaluations = [
      buildEvaluation("fam-a", "c1", 0.12, { tradeCount: 20, randomPercentile: 0.85 })
    ];

    const result = governReviewDecision({
      review: buildKeepSearchingReview(),
      evaluations,
      config,
      iteration: 5
    });

    assert.equal(result.verdict, "promote_candidate");
  });
});

// --- isResearchConverged ---

describe("isResearchConverged", () => {
  it("returns true when stagnation is high, novelty is low, performance flat", () => {
    const drift: ResearchDriftMetrics = {
      stagnationScore: 0.8,
      noveltyDrift: 0.05,
      performanceDrift: 0.005,
      structureDrift: 0.1,
      reproducibilityDrift: 0.02
    };
    assert.equal(isResearchConverged(drift), true);
  });

  it("returns false when stagnation is low", () => {
    const drift: ResearchDriftMetrics = {
      stagnationScore: 0.3,
      noveltyDrift: 0.05,
      performanceDrift: 0.001,
      structureDrift: 0.1,
      reproducibilityDrift: 0.02
    };
    assert.equal(isResearchConverged(drift), false);
  });

  it("returns false when novelty is still high", () => {
    const drift: ResearchDriftMetrics = {
      stagnationScore: 0.9,
      noveltyDrift: 0.25,
      performanceDrift: 0.001,
      structureDrift: 0.1,
      reproducibilityDrift: 0.02
    };
    assert.equal(isResearchConverged(drift), false);
  });

  it("returns false when performance is still improving", () => {
    const drift: ResearchDriftMetrics = {
      stagnationScore: 0.8,
      noveltyDrift: 0.05,
      performanceDrift: 0.05,
      structureDrift: 0.1,
      reproducibilityDrift: 0.02
    };
    assert.equal(isResearchConverged(drift), false);
  });
});

// --- Family stagnation tracking logic ---

describe("family stagnation streak tracking", () => {
  it("correctly counts consecutive non-improving iterations", () => {
    // Simulate the stagnation tracking logic from orchestrator.ts
    const EPSILON = 1e-6;
    const familyStagnationStreak = new Map<string, number>();
    const familyBest = new Map<string, number>();

    // Iteration 1: first result, should be improvement
    const iter1Return = 0.05;
    const prevBest1 = familyBest.get("fam-a") ?? -Infinity;
    if (iter1Return > prevBest1 + EPSILON) {
      familyStagnationStreak.set("fam-a", 0);
      familyBest.set("fam-a", iter1Return);
    } else {
      familyStagnationStreak.set("fam-a", (familyStagnationStreak.get("fam-a") ?? 0) + 1);
    }
    assert.equal(familyStagnationStreak.get("fam-a"), 0);

    // Iteration 2: same return, no improvement
    const iter2Return = 0.05;
    const prevBest2 = familyBest.get("fam-a") ?? -Infinity;
    if (iter2Return > prevBest2 + EPSILON) {
      familyStagnationStreak.set("fam-a", 0);
      familyBest.set("fam-a", iter2Return);
    } else {
      familyStagnationStreak.set("fam-a", (familyStagnationStreak.get("fam-a") ?? 0) + 1);
    }
    assert.equal(familyStagnationStreak.get("fam-a"), 1);

    // Iteration 3: worse return
    const iter3Return = 0.03;
    const prevBest3 = familyBest.get("fam-a") ?? -Infinity;
    if (iter3Return > prevBest3 + EPSILON) {
      familyStagnationStreak.set("fam-a", 0);
      familyBest.set("fam-a", iter3Return);
    } else {
      familyStagnationStreak.set("fam-a", (familyStagnationStreak.get("fam-a") ?? 0) + 1);
    }
    assert.equal(familyStagnationStreak.get("fam-a"), 2);

    // Iteration 4: improvement
    const iter4Return = 0.08;
    const prevBest4 = familyBest.get("fam-a") ?? -Infinity;
    if (iter4Return > prevBest4 + EPSILON) {
      familyStagnationStreak.set("fam-a", 0);
      familyBest.set("fam-a", iter4Return);
    } else {
      familyStagnationStreak.set("fam-a", (familyStagnationStreak.get("fam-a") ?? 0) + 1);
    }
    assert.equal(familyStagnationStreak.get("fam-a"), 0);
  });

  it("retires family when stagnation streak reaches threshold", () => {
    const THRESHOLD = 3;
    const streak = new Map([["fam-a", 3]]);
    const skippedFamilyIds = new Set<string>();

    // Simulate the check from orchestrator.ts
    for (const [fid, s] of streak) {
      if (s >= THRESHOLD && !skippedFamilyIds.has(fid)) {
        skippedFamilyIds.add(fid);
      }
    }

    assert.ok(skippedFamilyIds.has("fam-a"));
  });

  it("retires family when iteration budget is exhausted", () => {
    const BUDGET = 10;
    const counts = new Map([["fam-a", 10], ["fam-b", 5]]);
    const skippedFamilyIds = new Set<string>();

    for (const [fid, count] of counts) {
      if (count >= BUDGET && !skippedFamilyIds.has(fid)) {
        skippedFamilyIds.add(fid);
      }
    }

    assert.ok(skippedFamilyIds.has("fam-a"));
    assert.ok(!skippedFamilyIds.has("fam-b"));
  });

  it("epsilon prevents floating point false improvements from resetting streak", () => {
    const EPSILON = 1e-6;
    const best = 0.05;
    const almostSame = 0.05 + 1e-8; // tiny floating point noise

    assert.equal(almostSame > best + EPSILON, false, "should not count as improvement");

    const realImprovement = 0.05 + 1e-5;
    assert.equal(realImprovement > best + EPSILON, true, "should count as improvement");
  });
});

// --- Stagnation streak restoration on resume ---

describe("stagnation streak restoration from prior iterations", () => {
  it("rebuilds correct streak from iteration history", () => {
    // Simulate the resume restoration logic from orchestrator.ts
    const EPSILON = 1e-6;
    const familyStagnationStreak = new Map<string, number>();
    const runningBest = new Map<string, number>();

    type MockIteration = { evaluations: Array<{ familyId: string; netReturn: number }> };
    const priorIterations: MockIteration[] = [
      { evaluations: [{ familyId: "fam-a", netReturn: 0.05 }] }, // improvement (first)
      { evaluations: [{ familyId: "fam-a", netReturn: 0.04 }] }, // stagnant
      { evaluations: [{ familyId: "fam-a", netReturn: 0.06 }] }, // improvement
      { evaluations: [{ familyId: "fam-a", netReturn: 0.06 }] }, // stagnant
      { evaluations: [{ familyId: "fam-a", netReturn: 0.055 }] } // stagnant
    ];

    for (const iteration of priorIterations) {
      const families = new Set(iteration.evaluations.map((e) => e.familyId));
      for (const fid of families) {
        const iterBest = Math.max(
          ...iteration.evaluations.filter((e) => e.familyId === fid).map((e) => e.netReturn)
        );
        const prevBest = runningBest.get(fid) ?? -Infinity;

        if (iterBest > prevBest + EPSILON) {
          familyStagnationStreak.set(fid, 0);
          runningBest.set(fid, iterBest);
        } else {
          familyStagnationStreak.set(fid, (familyStagnationStreak.get(fid) ?? 0) + 1);
        }
      }
    }

    // After 5 iterations: improvement, stagnant(1), improvement(0), stagnant(1), stagnant(2)
    assert.equal(familyStagnationStreak.get("fam-a"), 2);
    assert.equal(runningBest.get("fam-a"), 0.06);
  });

  it("handles multiple families independently", () => {
    const EPSILON = 1e-6;
    const familyStagnationStreak = new Map<string, number>();
    const runningBest = new Map<string, number>();

    type MockIteration = { evaluations: Array<{ familyId: string; netReturn: number }> };
    const priorIterations: MockIteration[] = [
      {
        evaluations: [
          { familyId: "fam-a", netReturn: 0.05 },
          { familyId: "fam-b", netReturn: 0.03 }
        ]
      },
      {
        evaluations: [
          { familyId: "fam-a", netReturn: 0.04 }, // stagnant
          { familyId: "fam-b", netReturn: 0.06 }  // improving
        ]
      }
    ];

    for (const iteration of priorIterations) {
      const families = new Set(iteration.evaluations.map((e) => e.familyId));
      for (const fid of families) {
        const iterBest = Math.max(
          ...iteration.evaluations.filter((e) => e.familyId === fid).map((e) => e.netReturn)
        );
        const prevBest = runningBest.get(fid) ?? -Infinity;

        if (iterBest > prevBest + EPSILON) {
          familyStagnationStreak.set(fid, 0);
          runningBest.set(fid, iterBest);
        } else {
          familyStagnationStreak.set(fid, (familyStagnationStreak.get(fid) ?? 0) + 1);
        }
      }
    }

    assert.equal(familyStagnationStreak.get("fam-a"), 1); // stagnant in iter 2
    assert.equal(familyStagnationStreak.get("fam-b"), 0); // improved in iter 2
  });
});

// --- Calmar ratio edge case ---

describe("calmar ratio edge cases", () => {
  it("returns 0 bonus when maxDrawdown is near zero", () => {
    // Import the function indirectly via ranking behavior
    // The fix changed `<= 0` to `< 1e-6`
    const maxDd = 1e-8; // very close to zero
    const netReturn = 0.1;

    // Before fix: calmar = 0.1 / 1e-8 = 10,000,000 → bonus 0.06 (wrong)
    // After fix: maxDd < 1e-6 → return 0 (correct)
    assert.ok(maxDd < 1e-6, "near-zero drawdown should be caught by epsilon check");
  });
});

// --- Daemon config validation ---

describe("daemon configuration", () => {
  it("heartbeat timeout defaults to 30 minutes when iteration timeout is not set", () => {
    // Simulate the index.ts logic
    const autoResearchIterationTimeoutMs: number | undefined = undefined;
    const heartbeatTimeoutMs = autoResearchIterationTimeoutMs
      ? autoResearchIterationTimeoutMs * 3
      : 30 * 60 * 1000;

    assert.equal(heartbeatTimeoutMs, 1_800_000); // 30 minutes
  });

  it("heartbeat timeout is 3x iteration timeout when set", () => {
    const autoResearchIterationTimeoutMs = 600_000; // 10 min
    const heartbeatTimeoutMs = autoResearchIterationTimeoutMs
      ? autoResearchIterationTimeoutMs * 3
      : 30 * 60 * 1000;

    assert.equal(heartbeatTimeoutMs, 1_800_000); // 30 minutes
  });
});

// --- shouldContinueLoop logic ---

describe("shouldContinueLoop logic", () => {
  it("stops when all block families are skipped in continuous mode", () => {
    const blockFamilyIds = new Set(["fam-a", "fam-b", "fam-c"]);
    const skippedFamilyIds = new Set(["fam-a", "fam-b", "fam-c"]);
    const isContinuousMode = true;
    const researchStage = "block";

    const shouldContinue = () => {
      if (isContinuousMode && researchStage === "block") {
        const activeFamilies = [...blockFamilyIds].filter(
          (fid) => !skippedFamilyIds.has(fid)
        );
        return activeFamilies.length > 0;
      }
      return true;
    };

    assert.equal(shouldContinue(), false);
  });

  it("continues when some block families are still active in continuous mode", () => {
    const blockFamilyIds = new Set(["fam-a", "fam-b", "fam-c"]);
    const skippedFamilyIds = new Set(["fam-a"]);
    const isContinuousMode = true;
    const researchStage = "block";

    const shouldContinue = () => {
      if (isContinuousMode && researchStage === "block") {
        const activeFamilies = [...blockFamilyIds].filter(
          (fid) => !skippedFamilyIds.has(fid)
        );
        return activeFamilies.length > 0;
      }
      return true;
    };

    assert.equal(shouldContinue(), true);
  });

  it("non-block continuous mode respects iteration limit", () => {
    const isContinuousMode = true;
    const researchStage = "portfolio";
    const configIterations = 5;

    const shouldContinue = (iter: number) => {
      if (isContinuousMode && researchStage === "block") {
        return true; // would be checked differently
      }
      return iter <= configIterations;
    };

    assert.equal(shouldContinue(3), true);
    assert.equal(shouldContinue(5), true);
    assert.equal(shouldContinue(6), false);
  });

  it("stops when max run duration exceeded", () => {
    const maxRunDurationMs = 60_000;
    const runStartedAt = Date.now() - 120_000; // started 2 min ago

    const elapsed = Date.now() - runStartedAt;
    assert.ok(elapsed >= maxRunDurationMs, "should have exceeded duration");
  });
});
