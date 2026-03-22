import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDeterministicBbResearch, type DeterministicBbResearchConfig } from "../src/tune-bb-blocks.js";
import { replayDeterministicBbArtifacts } from "../src/replay-deterministic-bb.js";
import type { CandidateBacktestEvaluation, NormalizedCandidateProposal } from "../src/auto-research/types.js";

function buildEvaluation(
  candidate: NormalizedCandidateProposal,
  netReturn: number,
  overrides: Partial<CandidateBacktestEvaluation["summary"]> = {},
  robustnessOverrides: Partial<CandidateBacktestEvaluation["diagnostics"]["robustness"]> = {}
): CandidateBacktestEvaluation {
  const walkForward = candidate.candidateId.endsWith("-wf");
  const tradeCount = walkForward ? 8 : 12;
  return {
    candidate,
    mode: walkForward ? "walk-forward" : "holdout",
    status: "completed",
    summary: {
      totalReturn: netReturn,
      grossReturn: netReturn + 0.004,
      netReturn,
      maxDrawdown: 0.02,
      turnover: 0.4,
      winRate: 0.61,
      avgHoldBars: 9,
      tradeCount,
      feePaid: 10,
      slippagePaid: 5,
      rejectedOrdersCount: 0,
      cooldownSkipsCount: 1,
      signalCount: 21,
      ghostSignalCount: 2,
      randomPercentile: 0.6,
      bootstrapSignificant: true,
      ...overrides
    },
    diagnostics: {
      coverage: {
        tradeCount,
        signalCount: 21,
        ghostSignalCount: 2,
        rejectedOrdersCount: 0,
        cooldownSkipsCount: 1,
        rawBuySignals: 9,
        rawSellSignals: 4,
        rawHoldSignals: 8,
        avgUniverseSize: 1,
        minUniverseSize: 1,
        maxUniverseSize: 1,
        avgConsideredBuys: 1,
        avgEligibleBuys: 1
      },
      reasons: {
        strategy: { "bb:entry": 9, "bb:exit": 4 },
        strategyTags: {},
        coordinator: {},
        execution: {},
        risk: {}
      },
      costs: {
        feePaid: 10,
        slippagePaid: 5,
        totalCostsPaid: 15
      },
      robustness: {
        randomPercentile: 0.6,
        bootstrapSignificant: true,
        ...robustnessOverrides
      },
      crossChecks: [],
      windows: {
        mode: walkForward ? "walk-forward" : "holdout",
        holdoutDays: 90,
        trainingDays: walkForward ? 180 : undefined,
        stepDays: walkForward ? 90 : undefined,
        windowCount: walkForward ? 3 : 1,
        positiveWindowCount: walkForward ? 2 : undefined,
        positiveWindowRatio: walkForward ? 0.67 : 1,
        negativeWindowCount: walkForward ? 1 : 0,
        bestWindowNetReturn: 0.02,
        worstWindowNetReturn: -0.01,
        totalClosedTrades: tradeCount,
        availableDays: 400,
        requiredDays: 270
      }
    }
  };
}

function testConfig(outputDir: string): DeterministicBbResearchConfig {
  return {
    familyKeys: ["daily"],
    universeName: "krw-top",
    min5mCandles: 1000,
    marketLimit: 1,
    candidateCount: 2,
    eliteCount: 1,
    generations: 1,
    walkForwardTop: 1,
    topSeedExportCount: 1,
    holdoutDays: 90,
    trainingDays: 180,
    stepDays: 90,
    limit: 1000,
    randomSeed: 123,
    outputDir,
    reportPath: path.join(outputDir, "report.json"),
    seedReports: [],
    promotionGate: {}
  };
}

async function stubLoadCandles(params: { marketCodes: string[]; timeframe: string }) {
  return Object.fromEntries(
    params.marketCodes.map((marketCode) => [
      marketCode,
      [{
        marketCode,
        timeframe: params.timeframe,
        candleTimeUtc: new Date("2026-03-01T00:00:00Z"),
        openPrice: 1,
        highPrice: 1,
        lowPrice: 1,
        closePrice: 1,
        volume: 1,
        quoteVolume: 1
      }]
    ])
  );
}

test("replayDeterministicBbArtifacts passes on a valid deterministic run", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "fst-bb-replay-pass-"));
  await runDeterministicBbResearch(testConfig(outputDir), {
    selectMarkets: async () => [{ marketCode: "KRW-BTC" }] as never,
    loadCandles: stubLoadCandles as never,
    evaluateCandidate: async ({ candidate }) =>
      buildEvaluation(candidate, candidate.candidateId.endsWith("-wf") ? 0.05 : 0.04)
  });

  const replay = await replayDeterministicBbArtifacts(outputDir, {
    loadCandles: stubLoadCandles as never,
    evaluateCandidate: async ({ candidate }) =>
      buildEvaluation(candidate, candidate.candidateId.endsWith("-wf") ? 0.05 : 0.04)
  });

  assert.equal(replay.ok, true);
  assert.equal(replay.errors.length, 0);
});

test("replayDeterministicBbArtifacts ignores robustness-only drift", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "fst-bb-replay-robustness-"));
  await runDeterministicBbResearch(testConfig(outputDir), {
    selectMarkets: async () => [{ marketCode: "KRW-BTC" }] as never,
    loadCandles: stubLoadCandles as never,
    evaluateCandidate: async ({ candidate }) =>
      buildEvaluation(candidate, candidate.candidateId.endsWith("-wf") ? 0.05 : 0.04)
  });

  const replay = await replayDeterministicBbArtifacts(outputDir, {
    loadCandles: stubLoadCandles as never,
    evaluateCandidate: async ({ candidate }) =>
      buildEvaluation(
        candidate,
        candidate.candidateId.endsWith("-wf") ? 0.05 : 0.04,
        { randomPercentile: 0.1, bootstrapSignificant: false },
        { randomPercentile: 0.1, bootstrapSignificant: false }
      )
  });

  assert.equal(replay.ok, true);
  assert.equal(replay.errors.length, 0);
});

test("replayDeterministicBbArtifacts fails on stable metric drift", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "fst-bb-replay-drift-"));
  await runDeterministicBbResearch(testConfig(outputDir), {
    selectMarkets: async () => [{ marketCode: "KRW-BTC" }] as never,
    loadCandles: stubLoadCandles as never,
    evaluateCandidate: async ({ candidate }) =>
      buildEvaluation(candidate, candidate.candidateId.endsWith("-wf") ? 0.05 : 0.04)
  });

  const replay = await replayDeterministicBbArtifacts(outputDir, {
    loadCandles: stubLoadCandles as never,
    evaluateCandidate: async ({ candidate }) =>
      buildEvaluation(candidate, candidate.candidateId.endsWith("-wf") ? 0.08 : 0.04)
  });

  assert.equal(replay.ok, false);
  assert.equal(replay.errors.some((issue) => issue.code === "replay_metric_mismatch"), true);
});
