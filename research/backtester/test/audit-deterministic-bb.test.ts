import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { auditDeterministicBbArtifacts } from "../src/audit-deterministic-bb.js";
import { runDeterministicBbResearch, type DeterministicBbResearchConfig } from "../src/tune-bb-blocks.js";
import type { CandidateBacktestEvaluation, NormalizedCandidateProposal } from "../src/auto-research/types.js";
import type { Candle } from "../src/types.js";

function buildStubCandles(timeframe: string): Candle[] {
  return Array.from({ length: 12 }, (_, index) => ({
    marketCode: "KRW-BTC",
    timeframe,
    candleTimeUtc: new Date(Date.UTC(2025, 0, 1, index)),
    openPrice: 100 + index,
    highPrice: 101 + index,
    lowPrice: 99 + index,
    closePrice: 100.5 + index,
    volume: 10 + index,
    quoteVolume: 1000 + index * 10
  }));
}

function buildEvaluation(candidate: NormalizedCandidateProposal, mode: "holdout" | "walk-forward"): CandidateBacktestEvaluation {
  const netReturn = mode === "walk-forward" ? 0.07 : 0.09;
  const tradeCount = mode === "walk-forward" ? 11 : 15;
  return {
    candidate,
    mode,
    status: "completed",
    summary: {
      totalReturn: netReturn,
      grossReturn: netReturn + 0.01,
      netReturn,
      maxDrawdown: 0.03,
      turnover: 0.4,
      winRate: 0.6,
      avgHoldBars: 9,
      tradeCount,
      feePaid: 0.004,
      slippagePaid: 0.002,
      rejectedOrdersCount: 0,
      cooldownSkipsCount: 0,
      signalCount: 20,
      ghostSignalCount: 3,
      randomPercentile: 0.8,
      bootstrapSignificant: true
    },
    diagnostics: {
      coverage: {
        tradeCount,
        signalCount: 20,
        ghostSignalCount: 3,
        rejectedOrdersCount: 0,
        cooldownSkipsCount: 0,
        rawBuySignals: 14,
        rawSellSignals: 5,
        rawHoldSignals: 7,
        avgUniverseSize: 1,
        minUniverseSize: 1,
        maxUniverseSize: 1,
        avgConsideredBuys: 1,
        avgEligibleBuys: 1
      },
      reasons: {
        strategy: { "bb:profit_take": 4 },
        strategyTags: {},
        coordinator: {},
        execution: {},
        risk: {}
      },
      costs: {
        feePaid: 0.004,
        slippagePaid: 0.002,
        totalCostsPaid: 0.006
      },
      robustness: {
        randomPercentile: 0.8,
        bootstrapSignificant: true
      },
      crossChecks: [],
      windows: {
        mode,
        holdoutDays: 90,
        trainingDays: mode === "walk-forward" ? 180 : undefined,
        stepDays: mode === "walk-forward" ? 90 : undefined,
        windowCount: mode === "walk-forward" ? 3 : undefined,
        positiveWindowRatio: 1,
        bestWindowNetReturn: netReturn,
        worstWindowNetReturn: netReturn * 0.5,
        totalClosedTrades: tradeCount
      }
    }
  };
}

async function createValidRun(): Promise<string> {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-bb-audit-"));
  const config: DeterministicBbResearchConfig = {
    familyKeys: ["daily"],
    universeName: "krw-top",
    min5mCandles: 1000,
    marketLimit: 1,
    candidateCount: 3,
    eliteCount: 1,
    generations: 1,
    walkForwardTop: 1,
    topSeedExportCount: 1,
    holdoutDays: 90,
    trainingDays: 180,
    stepDays: 90,
    limit: 1000,
    randomSeed: 3,
    outputDir,
    reportPath: path.join(outputDir, "report.json"),
    seedReports: [],
    promotionGate: {
      minTrades: 5,
      minNetReturn: 0.02,
      maxDrawdown: 0.2
    }
  };

  await runDeterministicBbResearch(config, {
    selectMarkets: async () => [{ marketCode: "KRW-BTC" }] as Array<{ marketCode: string }>,
    loadCandles: async ({ marketCodes, timeframe }) =>
      Object.fromEntries(marketCodes.map((marketCode) => [marketCode, buildStubCandles(timeframe)])),
    evaluateCandidate: async ({ config: runConfig, candidate }) => buildEvaluation(candidate, runConfig.mode)
  });
  return outputDir;
}

test("auditDeterministicBbArtifacts passes for a valid deterministic run", async () => {
  const outputDir = await createValidRun();
  const audit = await auditDeterministicBbArtifacts(outputDir);
  assert.equal(audit.ok, true);
  assert.equal(audit.errors.length, 0);
  assert.ok(fs.existsSync(path.join(outputDir, "audit.json")));
});

test("auditDeterministicBbArtifacts fails on leaderboard/report drift", async () => {
  const outputDir = await createValidRun();
  const leaderboardPath = path.join(outputDir, "daily", "leaderboard.json");
  const leaderboard = JSON.parse(await readFile(leaderboardPath, "utf8")) as Array<Record<string, unknown>>;
  leaderboard[0] = {
    ...leaderboard[0],
    netReturn: 999
  };
  await writeFile(leaderboardPath, `${JSON.stringify(leaderboard, null, 2)}\n`);

  const audit = await auditDeterministicBbArtifacts(outputDir);
  assert.equal(audit.ok, false);
  assert.ok(audit.errors.some((issue) => issue.code === "family_leaderboard_mismatch"));
});
