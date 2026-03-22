import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseDeterministicBbResearchConfig,
  runDeterministicBbResearch,
  type DeterministicBbResearchConfig
} from "../src/tune-bb-blocks.js";
import { auditDeterministicBbArtifacts } from "../src/audit-deterministic-bb.js";
import type { CandidateBacktestEvaluation, NormalizedCandidateProposal } from "../src/auto-research/types.js";

function makeEvaluation(candidate: NormalizedCandidateProposal, netReturn: number): CandidateBacktestEvaluation {
  const walkForward = candidate.candidateId.endsWith("-wf");
  const tradeCount = walkForward ? 14 : 18;
  return {
    candidate,
    mode: walkForward ? "walk-forward" : "holdout",
    status: "completed",
    summary: {
      totalReturn: netReturn,
      grossReturn: netReturn + 0.01,
      netReturn,
      maxDrawdown: 0.02,
      turnover: 0.3,
      winRate: 0.58,
      avgHoldBars: 12,
      tradeCount,
      feePaid: 0.004,
      slippagePaid: 0.002,
      rejectedOrdersCount: 0,
      cooldownSkipsCount: 1,
      signalCount: 22,
      ghostSignalCount: 5,
      randomPercentile: 0.7,
      bootstrapSignificant: true
    },
    diagnostics: {
      coverage: {
        tradeCount,
        signalCount: 22,
        ghostSignalCount: 5,
        rejectedOrdersCount: 0,
        cooldownSkipsCount: 1,
        rawBuySignals: 19,
        rawSellSignals: 7,
        rawHoldSignals: 11,
        avgUniverseSize: 2,
        minUniverseSize: 2,
        maxUniverseSize: 2,
        avgConsideredBuys: 1.4,
        avgEligibleBuys: 1.1
      },
      reasons: {
        strategy: {
          "bb:regime_gate_pass": 12,
          "bb:profit_take": 4
        },
        strategyTags: {},
        coordinator: {
          blocked_signals: 1
        },
        execution: {},
        risk: {}
      },
      costs: {
        feePaid: 0.004,
        slippagePaid: 0.002,
        totalCostsPaid: 0.006
      },
      robustness: {
        randomPercentile: 0.7,
        bootstrapSignificant: true
      },
      crossChecks: [],
      windows: {
        mode: walkForward ? "walk-forward" : "holdout",
        holdoutDays: 90,
        trainingDays: walkForward ? 180 : undefined,
        stepDays: walkForward ? 90 : undefined,
        windowCount: walkForward ? 4 : 1,
        positiveWindowCount: walkForward ? 3 : undefined,
        positiveWindowRatio: walkForward ? 0.75 : 1,
        negativeWindowCount: walkForward ? 1 : 0,
        bestWindowNetReturn: 0.03,
        worstWindowNetReturn: -0.01,
        totalClosedTrades: tradeCount
      }
    }
  };
}

function makeFailedEvaluation(candidate: NormalizedCandidateProposal): CandidateBacktestEvaluation {
  return {
    ...makeEvaluation(candidate, -0.02),
    status: "failed"
  };
}

test("parseDeterministicBbResearchConfig resolves legacy json output path", () => {
  const config = parseDeterministicBbResearchConfig([
    "--families",
    "weekly,daily",
    "--output",
    "/tmp/fst-bb/report.json",
    "--generations",
    "4"
  ]);

  assert.deepEqual(config.familyKeys, ["weekly", "daily"]);
  assert.equal(config.outputDir, "/tmp/fst-bb");
  assert.equal(config.reportPath, "/tmp/fst-bb/report.json");
  assert.equal(config.legacyOutputPath, "/tmp/fst-bb/report.json");
  assert.equal(config.generations, 4);
});

test("runDeterministicBbResearch writes report, seeds, and validated blocks without DB access", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "fst-bb-det-test-"));
  const config: DeterministicBbResearchConfig = {
    familyKeys: ["weekly"],
    universeName: "krw-top",
    min5mCandles: 1000,
    marketLimit: 2,
    candidateCount: 2,
    eliteCount: 1,
    generations: 1,
    walkForwardTop: 1,
    topSeedExportCount: 1,
    holdoutDays: 90,
    trainingDays: 180,
    stepDays: 90,
    limit: 1000,
    randomSeed: 42,
    outputDir,
    reportPath: path.join(outputDir, "report.json"),
    seedReports: [],
    promotionGate: {
      minTrades: 5,
      minNetReturn: 0.05,
      maxDrawdown: 0.1,
      minPositiveWindowRatio: 0.5,
      minRandomPercentile: 0.5,
      requireBootstrapSignificance: true
    }
  };

  const report = await runDeterministicBbResearch(config, {
    selectMarkets: async () => [{ marketCode: "KRW-BTC" }, { marketCode: "KRW-ETH" }] as never,
    loadCandles: async ({ marketCodes, timeframe }) =>
      Object.fromEntries(
        marketCodes.map((marketCode) => [
          marketCode,
          [{
            marketCode,
            timeframe,
            candleTimeUtc: new Date("2026-03-01T00:00:00Z"),
            openPrice: 1,
            highPrice: 1,
            lowPrice: 1,
            closePrice: 1,
            volume: 1,
            quoteVolume: 1
          }]
        ])
      ),
    evaluateCandidate: async ({ candidate }) =>
      makeEvaluation(candidate, candidate.candidateId.endsWith("-wf") ? 0.12 : 0.08)
  });

  assert.equal(report.validatedBlockCount, 1);
  assert.equal(report.families.weekly?.promotion.promoted, true);
  assert.equal(fs.existsSync(path.join(outputDir, "report.json")), true);
  assert.equal(fs.existsSync(path.join(outputDir, "top-seeds.json")), true);
  assert.equal(fs.existsSync(path.join(outputDir, "validated-blocks.json")), true);
  assert.equal(fs.existsSync(path.join(outputDir, "weekly", "promotion.json")), true);
  assert.equal(fs.existsSync(path.join(outputDir, "report.md")), true);
  assert.equal(fs.existsSync(path.join(outputDir, "audit.json")), true);

  const audit = await auditDeterministicBbArtifacts(outputDir);
  assert.equal(audit.ok, true);

  const reportMarkdown = fs.readFileSync(path.join(outputDir, "report.md"), "utf8");
  assert.match(reportMarkdown, /Deterministic BB Research/);
  assert.match(reportMarkdown, /weekly/);

  const topSeeds = JSON.parse(fs.readFileSync(path.join(outputDir, "top-seeds.json"), "utf8")) as Array<{ netReturn: number }>;
  assert.equal(topSeeds.length, 1);
  assert.equal(topSeeds[0]?.netReturn, 0.12);
});

test("runDeterministicBbResearch isolates candidate failures instead of failing the whole run", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "fst-bb-det-failure-"));
  const config: DeterministicBbResearchConfig = {
    familyKeys: ["daily"],
    universeName: "krw-top",
    min5mCandles: 1000,
    marketLimit: 2,
    candidateCount: 2,
    eliteCount: 1,
    generations: 1,
    walkForwardTop: 1,
    topSeedExportCount: 1,
    holdoutDays: 90,
    trainingDays: 180,
    stepDays: 90,
    limit: 1000,
    randomSeed: 7,
    outputDir,
    reportPath: path.join(outputDir, "report.json"),
    seedReports: [],
    promotionGate: {
      minTrades: 5,
      minNetReturn: 0.01,
      maxDrawdown: 0.2
    }
  };

  const report = await runDeterministicBbResearch(config, {
    selectMarkets: async () => [{ marketCode: "KRW-BTC" }, { marketCode: "KRW-ETH" }] as never,
    loadCandles: async ({ marketCodes, timeframe }) =>
      Object.fromEntries(
        marketCodes.map((marketCode) => [
          marketCode,
          [{
            marketCode,
            timeframe,
            candleTimeUtc: new Date("2026-03-01T00:00:00Z"),
            openPrice: 1,
            highPrice: 1,
            lowPrice: 1,
            closePrice: 1,
            volume: 1,
            quoteVolume: 1
          }]
        ])
      ),
    evaluateCandidate: async ({ candidate }) => {
      if (candidate.candidateId === "bb-daily-g01-mut-02") {
        throw new Error("boom");
      }
      return makeEvaluation(candidate, candidate.candidateId.endsWith("-wf") ? 0.06 : 0.04);
    }
  });

  assert.equal(report.families.daily?.failureCounts.holdout, 1);
  assert.equal(report.families.daily?.failureCounts.walkForward, 0);
  assert.equal(report.families.daily?.holdoutAttemptedCount, 2);
  assert.equal(report.families.daily?.holdoutSucceededCount, 1);
  assert.equal(report.families.daily?.walkForwardAttemptedCount, 1);
  assert.equal(report.families.daily?.walkForwardSucceededCount, 1);
  assert.equal(report.overallLeaderboard.length, 1);
  assert.equal(fs.existsSync(path.join(outputDir, "report.json")), true);
});

test("runDeterministicBbResearch counts returned failed evaluations as failures", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "fst-bb-det-returned-failure-"));
  const config: DeterministicBbResearchConfig = {
    familyKeys: ["hourly"],
    universeName: "krw-top",
    min5mCandles: 1000,
    marketLimit: 2,
    candidateCount: 2,
    eliteCount: 1,
    generations: 1,
    walkForwardTop: 1,
    topSeedExportCount: 1,
    holdoutDays: 90,
    trainingDays: 180,
    stepDays: 90,
    limit: 1000,
    randomSeed: 11,
    outputDir,
    reportPath: path.join(outputDir, "report.json"),
    seedReports: [],
    promotionGate: {}
  };

  const report = await runDeterministicBbResearch(config, {
    selectMarkets: async () => [{ marketCode: "KRW-BTC" }, { marketCode: "KRW-ETH" }] as never,
    loadCandles: async ({ marketCodes, timeframe }) =>
      Object.fromEntries(
        marketCodes.map((marketCode) => [
          marketCode,
          [{
            marketCode,
            timeframe,
            candleTimeUtc: new Date("2026-03-01T00:00:00Z"),
            openPrice: 1,
            highPrice: 1,
            lowPrice: 1,
            closePrice: 1,
            volume: 1,
            quoteVolume: 1
          }]
        ])
      ),
    evaluateCandidate: async ({ candidate }) =>
      candidate.candidateId === "bb-hourly-g01-mut-02"
        ? makeFailedEvaluation(candidate)
        : makeEvaluation(candidate, candidate.candidateId.endsWith("-wf") ? 0.03 : 0.02)
  });

  assert.equal(report.families.hourly?.failureCounts.holdout, 1);
  assert.equal(report.families.hourly?.holdoutSucceededCount, 1);
  assert.equal(report.families.hourly?.holdoutAttemptedCount, 2);
  assert.equal(report.families.hourly?.walkForwardSucceededCount, 1);
  assert.equal(report.families.hourly?.topSeedsSource, "walk-forward");
  assert.equal(report.overallLeaderboard.some((item) => item.candidateId === "bb-hourly-g01-mut-02"), false);
});

test("auditDeterministicBbArtifacts catches tampered walk-forward summary metrics", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "fst-bb-det-audit-"));
  const config: DeterministicBbResearchConfig = {
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
    randomSeed: 19,
    outputDir,
    reportPath: path.join(outputDir, "report.json"),
    seedReports: [],
    promotionGate: {}
  };

  await runDeterministicBbResearch(config, {
    selectMarkets: async () => [{ marketCode: "KRW-BTC" }] as never,
    loadCandles: async ({ marketCodes, timeframe }) =>
      Object.fromEntries(
        marketCodes.map((marketCode) => [
          marketCode,
          [{
            marketCode,
            timeframe,
            candleTimeUtc: new Date("2026-03-01T00:00:00Z"),
            openPrice: 1,
            highPrice: 1,
            lowPrice: 1,
            closePrice: 1,
            volume: 1,
            quoteVolume: 1
          }]
        ])
      ),
    evaluateCandidate: async ({ candidate }) =>
      makeEvaluation(candidate, candidate.candidateId.endsWith("-wf") ? 0.05 : 0.04)
  });

  const walkForwardPath = path.join(outputDir, "daily", "walk-forward-evaluations.json");
  const walkForwardSummaries = JSON.parse(fs.readFileSync(walkForwardPath, "utf8")) as Array<Record<string, number>>;
  walkForwardSummaries[0] = { ...walkForwardSummaries[0], netReturn: 999 };
  fs.writeFileSync(walkForwardPath, `${JSON.stringify(walkForwardSummaries, null, 2)}\n`);

  const audit = await auditDeterministicBbArtifacts(outputDir);
  assert.equal(audit.ok, false);
  assert.equal(audit.errors.some((issue) => issue.code === "raw_walk_forward_metric_mismatch"), true);
});
