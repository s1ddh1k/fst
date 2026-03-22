import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Candle } from "../src/types.js";
import type { CandidateBacktestEvaluation, NormalizedCandidateProposal } from "../src/auto-research/types.js";
import { runDeterministicBbResearch, type DeterministicBbResearchConfig } from "../src/tune-bb-blocks.js";

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
  const signal = Math.abs(candidate.parameters.entryPercentB ?? -0.05) + (candidate.parameters.profitTakePnlThreshold ?? 0.01);
  const netReturn = mode === "walk-forward" ? 0.045 + signal * 0.1 : 0.06 + signal * 0.12;
  const tradeCount = mode === "walk-forward" ? 14 : 18;
  return {
    candidate,
    mode,
    status: "completed",
    summary: {
      totalReturn: netReturn,
      grossReturn: netReturn + 0.004,
      netReturn,
      maxDrawdown: 0.035,
      turnover: 0.9,
      winRate: 0.58,
      avgHoldBars: 11,
      tradeCount,
      feePaid: 1200,
      slippagePaid: 800,
      rejectedOrdersCount: 0,
      cooldownSkipsCount: 1,
      signalCount: 32,
      ghostSignalCount: 4,
      randomPercentile: 0.7,
      bootstrapSignificant: true
    },
    diagnostics: {
      coverage: {
        tradeCount,
        signalCount: 32,
        ghostSignalCount: 4,
        rejectedOrdersCount: 0,
        cooldownSkipsCount: 1,
        rawBuySignals: 18,
        rawSellSignals: 9,
        rawHoldSignals: 5,
        avgUniverseSize: 1,
        minUniverseSize: 1,
        maxUniverseSize: 1,
        avgConsideredBuys: 2,
        avgEligibleBuys: 1
      },
      reasons: {
        strategy: {
          "bb:entry_ok": 18,
          "bb:regime_exit_band": 6
        },
        strategyTags: {},
        coordinator: { blocked_signals: 0 },
        execution: { rejected_orders: 0 },
        risk: {}
      },
      costs: {
        feePaid: 1200,
        slippagePaid: 800,
        totalCostsPaid: 2000
      },
      robustness: {
        randomPercentile: 0.7,
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
        totalClosedTrades: tradeCount,
        availableDays: 500,
        requiredDays: 360
      }
    }
  };
}

test("deterministic BB research writes structured artifacts and promotes passing blocks", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-deterministic-bb-"));
  const config: DeterministicBbResearchConfig = {
    familyKeys: ["daily"],
    universeName: "krw-top",
    min5mCandles: 1000,
    marketLimit: 1,
    candidateCount: 4,
    eliteCount: 2,
    generations: 2,
    walkForwardTop: 2,
    topSeedExportCount: 2,
    holdoutDays: 90,
    trainingDays: 180,
    stepDays: 90,
    limit: 1000,
    randomSeed: 1,
    outputDir,
    reportPath: path.join(outputDir, "report.json"),
    seedReports: [],
    promotionGate: {
      minTrades: 5,
      minNetReturn: 0.02,
      maxDrawdown: 0.2,
      minPositiveWindowRatio: 0.5
    }
  };

  const report = await runDeterministicBbResearch(config, {
    selectMarkets: async () => [{ marketCode: "KRW-BTC" }] as Array<{ marketCode: string }>,
    loadCandles: async ({ marketCodes, timeframe }) =>
      Object.fromEntries(marketCodes.map((marketCode) => [marketCode, buildStubCandles(timeframe)])),
    evaluateCandidate: async ({ config: runConfig, candidate }) => buildEvaluation(candidate, runConfig.mode)
  });

  assert.equal(report.validatedBlockCount, 1);
  assert.ok(report.families.daily);
  assert.ok((report.families.daily?.walkForwardTop.length ?? 0) > 0);
  assert.ok((report.topSeeds.length ?? 0) > 0);

  const files = [
    path.join(outputDir, "report.json"),
    path.join(outputDir, "audit.json"),
    path.join(outputDir, "leaderboard.json"),
    path.join(outputDir, "top-seeds.json"),
    path.join(outputDir, "validated-blocks.json"),
    path.join(outputDir, "status.json"),
    path.join(outputDir, "daily", "generation-01-holdout.json"),
    path.join(outputDir, "daily", "generation-02-holdout.json"),
    path.join(outputDir, "daily", "holdout-raw", "generation-01"),
    path.join(outputDir, "daily", "holdout-raw", "generation-02"),
    path.join(outputDir, "daily", "walk-forward-evaluations.json"),
    path.join(outputDir, "daily", "promotion.json"),
    path.join(outputDir, "daily", "report.json")
  ];

  for (const filePath of files) {
    const info = await stat(filePath);
    assert.ok(info.isFile() || info.isDirectory(), `${filePath} should exist`);
  }

  const status = JSON.parse(await readFile(path.join(outputDir, "status.json"), "utf8")) as {
    phase: string;
    audit?: { ok: boolean };
    replay?: { ok: boolean };
  };
  assert.equal(status.phase, "completed");
  assert.equal(status.audit?.ok, true);
  assert.equal(status.replay?.ok, true);
});
