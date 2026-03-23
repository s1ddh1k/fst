import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { autoPromoteFromRunState } from "../src/auto-research/auto-promote.js";
import type { AutoResearchRunState } from "../src/auto-research/run-manager.js";
import type { CandidateBacktestEvaluation, ResearchIterationRecord } from "../src/auto-research/types.js";

function makeEvaluation(overrides?: Partial<{
  candidateId: string;
  familyId: string;
  netReturn: number;
  maxDrawdown: number;
  tradeCount: number;
}>): CandidateBacktestEvaluation {
  return {
    candidate: {
      candidateId: overrides?.candidateId ?? "candidate-01",
      familyId: overrides?.familyId ?? "block:rotation-15m-trend-up",
      strategyName: overrides?.familyId ?? "block:rotation-15m-trend-up",
      thesis: "test",
      parameters: { rebalanceBars: 5, entryFloor: 0.78 },
      invalidationSignals: []
    },
    mode: "walk-forward",
    status: "completed",
    summary: {
      totalReturn: overrides?.netReturn ?? 0.12,
      grossReturn: (overrides?.netReturn ?? 0.12) + 0.02,
      netReturn: overrides?.netReturn ?? 0.12,
      maxDrawdown: overrides?.maxDrawdown ?? 0.05,
      turnover: 0.3,
      winRate: 0.55,
      avgHoldBars: 12,
      tradeCount: overrides?.tradeCount ?? 20,
      feePaid: 0.01,
      slippagePaid: 0.01,
      rejectedOrdersCount: 0,
      cooldownSkipsCount: 0,
      signalCount: 100,
      ghostSignalCount: 5
    },
    diagnostics: {
      coverage: {
        tradeCount: overrides?.tradeCount ?? 20,
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
      reasons: { strategy: {}, strategyTags: {}, coordinator: {}, execution: {}, risk: {} },
      costs: { feePaid: 0.01, slippagePaid: 0.01, totalCostsPaid: 0.02 },
      robustness: { randomPercentile: 0.85 },
      crossChecks: [],
      windows: {
        mode: "walk-forward",
        holdoutDays: 14,
        windowCount: 3,
        positiveWindowRatio: 0.67,
        positiveWindowCount: 2,
        negativeWindowCount: 1,
        totalClosedTrades: overrides?.tradeCount ?? 20
      }
    }
  };
}

function makeRunState(overrides?: {
  outcome?: string;
  evaluations?: CandidateBacktestEvaluation[];
}): AutoResearchRunState {
  const evaluations = overrides?.evaluations ?? [makeEvaluation()];
  const iteration: ResearchIterationRecord = {
    iteration: 1,
    evaluations,
    review: {
      verdict: "promote_candidate",
      promotedCandidateId: evaluations[0]?.candidate.candidateId,
      retireCandidateIds: [],
      nextCandidates: [],
      observations: []
    }
  };

  return {
    generatedAt: new Date().toISOString(),
    config: {
      universeName: "krw-top",
      timeframe: "1h",
      marketLimit: 10,
      limit: 5000,
      holdoutDays: 14,
      iterations: 3,
      candidatesPerIteration: 4,
      mode: "walk-forward",
      outputDir: "/tmp/test",
      allowDataCollection: false,
      allowFeatureCacheBuild: false,
      allowCodeMutation: false,
      researchStage: "block"
    },
    families: [],
    catalog: [],
    marketCodes: ["KRW-BTC", "KRW-ETH"],
    iterations: [iteration],
    outcome: (overrides?.outcome ?? "completed") as "completed",
    outcomeReason: undefined,
    configRepairs: [],
    bestCandidate: evaluations[0],
    noTradeIterations: 0
  };
}

let tmpDir: string;

describe("auto-promote", () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "fst-auto-promote-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("promotes candidates from a completed run (dry run)", async () => {
    const state = makeRunState();
    state.config.outputDir = tmpDir;
    await writeFile(path.join(tmpDir, "run-state.json"), JSON.stringify(state));

    const result = await autoPromoteFromRunState({
      outputDir: tmpDir,
      dryRun: true
    });

    assert.equal(result.promoted, false);
    assert.ok(result.reason.includes("Dry run"));
    assert.equal(result.candidateCount, 1);
    assert.equal(result.candidates[0]?.candidateId, "candidate-01");
    assert.equal(result.candidates[0]?.rank, 1);
  });

  it("skips promotion for non-completed runs", async () => {
    const state = makeRunState({ outcome: "failed" });
    state.config.outputDir = tmpDir;
    await writeFile(path.join(tmpDir, "run-state.json"), JSON.stringify(state));

    const result = await autoPromoteFromRunState({ outputDir: tmpDir });

    assert.equal(result.promoted, false);
    assert.ok(result.reason.includes("failed"));
  });

  it("skips when no candidates pass promotion gate", async () => {
    const weakEval = makeEvaluation({ netReturn: 0.01, tradeCount: 2 });
    const state = makeRunState({ evaluations: [weakEval] });
    state.config.outputDir = tmpDir;
    await writeFile(path.join(tmpDir, "run-state.json"), JSON.stringify(state));

    const result = await autoPromoteFromRunState({ outputDir: tmpDir, dryRun: true });

    assert.equal(result.promoted, false);
    assert.ok(result.reason.includes("No candidates"));
  });

  it("ranks multiple candidates correctly", async () => {
    const eval1 = makeEvaluation({ candidateId: "c1", netReturn: 0.12, tradeCount: 20 });
    const eval2 = makeEvaluation({ candidateId: "c2", netReturn: 0.20, tradeCount: 30 });
    const eval3 = makeEvaluation({ candidateId: "c3", netReturn: 0.08, tradeCount: 15 });
    const state = makeRunState({ evaluations: [eval1, eval2, eval3] });
    state.config.outputDir = tmpDir;
    await writeFile(path.join(tmpDir, "run-state.json"), JSON.stringify(state));

    const result = await autoPromoteFromRunState({ outputDir: tmpDir, dryRun: true });

    assert.equal(result.candidateCount, 3);
    assert.equal(result.candidates[0]?.candidateId, "c2");
    assert.ok(result.candidates[0]!.netReturn > result.candidates[1]!.netReturn);
  });
});
