import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createAutoResearchOrchestrator,
  getStrategyFamilies,
  type AutoResearchRunConfig,
  type ResearchLlmClient,
  type CandidateBacktestEvaluation,
  type NormalizedCandidateProposal
} from "../src/auto-research/index.js";

function buildEvaluation(candidate: NormalizedCandidateProposal, netReturn: number, tradeCount = 4): CandidateBacktestEvaluation {
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
      tradeCount,
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
        tradeCount,
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
        strategy: {},
        strategyTags: {},
        coordinator: {},
        execution: {},
        risk: {}
      },
      costs: { feePaid: 10, slippagePaid: 15, totalCostsPaid: 25 },
      robustness: {
        bootstrapPValue: 0.04,
        bootstrapSignificant: true,
        randomPercentile: 0.93
      },
      crossChecks: [],
      windows: {
        mode: "holdout",
        holdoutDays: 30,
        positiveWindowRatio: 0.6,
        positiveWindowCount: 3,
        negativeWindowCount: 2,
        windowCount: 5
      }
    }
  };
}

function buildConfig(outputDir: string, overrides: Partial<AutoResearchRunConfig> = {}): AutoResearchRunConfig {
  return {
    strategyFamilyIds: ["relative-momentum-pullback"],
    universeName: "krw-top",
    timeframe: "1h",
    marketLimit: 3,
    limit: 2000,
    holdoutDays: 30,
    trainingDays: 90,
    stepDays: 30,
    iterations: 20,
    candidatesPerIteration: 1,
    parallelism: 1,
    mode: "holdout",
    outputDir,
    allowDataCollection: false,
    allowFeatureCacheBuild: false,
    allowCodeMutation: false,
    minNetReturnForPromotion: 0.05,
    allowStaleData: true,
    ...overrides
  };
}

function buildKeepSearchingLlm(): ResearchLlmClient {
  return {
    async proposeCandidates() {
      return {
        researchSummary: "keep searching",
        preparation: [],
        proposedFamilies: [],
        codeTasks: [],
        candidates: [{
          familyId: "relative-momentum-pullback",
          thesis: "test",
          parameters: {
            minStrengthPct: 0.7 + Math.random() * 0.2,
            minRiskOn: 0.1,
            pullbackZ: 0.8 + Math.random() * 0.4,
            trailAtrMult: 2.0 + Math.random() * 0.5
          },
          invalidationSignals: []
        }]
      };
    },
    async reviewIteration() {
      return {
        summary: "keep searching",
        verdict: "keep_searching",
        nextPreparation: [],
        proposedFamilies: [],
        codeTasks: [],
        nextCandidates: [{
          familyId: "relative-momentum-pullback",
          thesis: "continue",
          parameters: {
            minStrengthPct: 0.7 + Math.random() * 0.2,
            minRiskOn: 0.1,
            pullbackZ: 0.8 + Math.random() * 0.4,
            trailAtrMult: 2.0 + Math.random() * 0.5
          },
          invalidationSignals: []
        }],
        retireCandidateIds: [],
        observations: []
      };
    }
  };
}

// Integration test 1: stagnation retirement terminates the loop
test("continuous mode retires stagnant families and completes", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-cont-stagnation-"));
  let evalCount = 0;

  try {
    const orchestrator = createAutoResearchOrchestrator({
      llmClient: buildKeepSearchingLlm(),
      async evaluateCandidate({ candidate }) {
        evalCount++;
        // Always return the same netReturn — never improves → stagnation
        return buildEvaluation(candidate, 0.02, 3);
      },
      async prepareActions() { return []; },
      codeAgent: { async execute() { return []; } },
      async resolveCandidateMarkets() { return ["KRW-BTC", "KRW-ETH"]; },
      async preloadReferenceCandles() { return []; }
    });

    const report = await orchestrator.run(buildConfig(outputDir, {
      continuousMode: true,
      stagnationRetireThreshold: 3, // retire after 3 stagnant iterations
      familyIterationBudget: 20,
      iterations: 100 // high limit — should stop via stagnation, not iteration count
    }));

    // Should have stopped WELL before 100 iterations
    assert.ok(report.iterations.length <= 10, `Expected <= 10 iterations but got ${report.iterations.length}`);
    assert.ok(report.iterations.length >= 3, `Expected >= 3 iterations but got ${report.iterations.length}`);
    assert.equal(report.outcome, "completed");
    assert.ok(evalCount >= 3, `Should have evaluated at least 3 times, got ${evalCount}`);

    // Check that the run log records retirement progress
    const runLog = await readFile(path.join(outputDir, "run.log"), "utf8");
    assert.ok(
      runLog.includes("retiring family") || runLog.includes("stagnant") || runLog.includes("stop_no_edge"),
      "Run log should mention family retirement progress"
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

// Integration test 2: LLM failure fails the run directly
test("orchestrator fails immediately when LLM is unavailable", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-cont-llm-fail-"));

  try {
    const failingLlm: ResearchLlmClient = {
      async proposeCandidates() {
        throw new Error("LLM_ALL_PROVIDERS_EXHAUSTED: all failed");
      },
      async reviewIteration() {
        throw new Error("LLM_ALL_PROVIDERS_EXHAUSTED: all failed");
      }
    };

    const orchestrator = createAutoResearchOrchestrator({
      llmClient: failingLlm,
      async evaluateCandidate({ candidate }) {
        return buildEvaluation(candidate, 0.03, 5);
      },
      async prepareActions() { return []; },
      codeAgent: { async execute() { return []; } },
      async resolveCandidateMarkets() { return ["KRW-BTC", "KRW-ETH"]; },
      async preloadReferenceCandles() { return []; }
    });

    await assert.rejects(
      () => orchestrator.run(buildConfig(outputDir, {
        iterations: 3,
      })),
      /LLM proposal failed: LLM_ALL_PROVIDERS_EXHAUSTED: all failed/
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

// Integration test 3: heartbeat file is written during iterations
test("orchestrator writes heartbeat file during iteration", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-cont-heartbeat-"));

  try {
    const orchestrator = createAutoResearchOrchestrator({
      llmClient: buildKeepSearchingLlm(),
      async evaluateCandidate({ candidate }) {
        return buildEvaluation(candidate, 0.08, 10);
      },
      async prepareActions() { return []; },
      codeAgent: { async execute() { return []; } },
      async resolveCandidateMarkets() { return ["KRW-BTC"]; },
      async preloadReferenceCandles() { return []; }
    });

    await orchestrator.run(buildConfig(outputDir, {
      iterations: 1,
      continuousMode: false
    }));

    // Check heartbeat file was created
    const heartbeatPath = path.join(outputDir, "heartbeat.json");
    const heartbeat = JSON.parse(await readFile(heartbeatPath, "utf8"));
    assert.ok(heartbeat.pid > 0, "heartbeat should have PID");
    assert.ok(heartbeat.iteration >= 1, "heartbeat should have iteration number");
    assert.ok(heartbeat.updatedAt, "heartbeat should have updatedAt");
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

// Integration test 4: WAL checkpoint is attempted (no crash)
test("WAL checkpoint runs without crashing after iteration", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-cont-wal-"));

  try {
    const orchestrator = createAutoResearchOrchestrator({
      llmClient: buildKeepSearchingLlm(),
      async evaluateCandidate({ candidate }) {
        return buildEvaluation(candidate, 0.06, 8);
      },
      async prepareActions() { return []; },
      codeAgent: { async execute() { return []; } },
      async resolveCandidateMarkets() { return ["KRW-BTC"]; },
      async preloadReferenceCandles() { return []; }
    });

    // Should complete without crash even if WAL checkpoint fails (test env may not have DB)
    const report = await orchestrator.run(buildConfig(outputDir, {
      iterations: 2,
      continuousMode: true,
      stagnationRetireThreshold: 1
    }));

    assert.ok(report.iterations.length >= 1);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

// Integration test 5: iteration budget retires families
test("family iteration budget exhaustion retires the family", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-cont-budget-"));
  let evalCount = 0;

  try {
    const orchestrator = createAutoResearchOrchestrator({
      llmClient: buildKeepSearchingLlm(),
      async evaluateCandidate({ candidate }) {
        evalCount++;
        // Slight improvement each time so stagnation doesn't fire first
        return buildEvaluation(candidate, 0.01 + evalCount * 0.001, 5);
      },
      async prepareActions() { return []; },
      codeAgent: { async execute() { return []; } },
      async resolveCandidateMarkets() { return ["KRW-BTC"]; },
      async preloadReferenceCandles() { return []; }
    });

    const report = await orchestrator.run(buildConfig(outputDir, {
      continuousMode: true,
      familyIterationBudget: 4, // retire after 4 iterations
      stagnationRetireThreshold: 100, // effectively disabled
      iterations: 50 // should stop at budget, not here
    }));

    // Should stop after budget exhaustion (4 iterations) + some overhead
    assert.ok(report.iterations.length <= 8, `Expected <= 8 iterations but got ${report.iterations.length}`);
    assert.ok(report.iterations.length >= 4, `Expected >= 4 iterations but got ${report.iterations.length}`);
    // In non-block continuous mode, outcome is partial or completed
    assert.ok(
      report.outcome === "completed" || report.outcome === "partial",
      `Expected completed or partial but got ${report.outcome}`
    );

    const runLog = await readFile(path.join(outputDir, "run.log"), "utf8");
    assert.ok(runLog.includes("retiring family"), "Run log should mention family retirement");
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});
