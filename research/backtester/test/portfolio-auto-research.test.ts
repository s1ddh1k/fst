import test from "node:test";
import assert from "node:assert/strict";
import type { Candle } from "../src/types.js";
import {
  buildPortfolioCandidateRuntime,
  evaluatePortfolioCandidate,
  MULTI_TF_DEFENSIVE_RECLAIM_PORTFOLIO,
  MULTI_TF_REGIME_CORE_PORTFOLIO,
  MULTI_TF_REGIME_SWITCH_SCREEN_PORTFOLIO,
  MULTI_TF_REGIME_SWITCH_PORTFOLIO,
  MULTI_TF_TREND_BURST_PORTFOLIO,
  type AutoResearchRunConfig,
  type NormalizedCandidateProposal
} from "../src/auto-research/index.js";
import { createCandles } from "./test-helpers.js";

const MARKET_CODES = ["KRW-AAA", "KRW-BBB", "KRW-CCC"] as const;

type MockCandleData = {
  "1h": Record<string, Candle[]>;
  "5m": Record<string, Candle[]>;
  "1m": Record<string, Candle[]>;
};

function buildWaveSeries(params: {
  length: number;
  start: number;
  slope: number;
  amplitude: number;
  cycle: number;
  dipEvery?: number;
  dipSize?: number;
}): number[] {
  return Array.from({ length: params.length }, (_, index) => {
    const trend = params.start + index * params.slope;
    const wave = Math.sin(index / params.cycle) * params.amplitude;
    const dip =
      params.dipEvery && params.dipSize && index > 0 && index % params.dipEvery === 0
        ? -params.dipSize
        : 0;

    return Number((trend + wave + dip).toFixed(4));
  });
}

function buildVolumeSeries(length: number, base: number, cycle: number): number[] {
  return Array.from({ length }, (_, index) =>
    Number((base + Math.max(0, Math.sin(index / cycle) * base * 0.35)).toFixed(4))
  );
}

function buildMockCandleData(): MockCandleData {
  const hourlyBars = 24 * 8;
  const intradayBars = hourlyBars * 12;
  const startTime = "2024-01-01T00:00:00.000Z";

  return {
    "1h": {
      "KRW-AAA": createCandles({
        marketCode: "KRW-AAA",
        timeframe: "1h",
        closes: buildWaveSeries({
          length: hourlyBars,
          start: 1000,
          slope: 2.1,
          amplitude: 18,
          cycle: 5,
          dipEvery: 18,
          dipSize: 22
        }),
        volumes: buildVolumeSeries(hourlyBars, 220, 7),
        startTime
      }),
      "KRW-BBB": createCandles({
        marketCode: "KRW-BBB",
        timeframe: "1h",
        closes: buildWaveSeries({
          length: hourlyBars,
          start: 900,
          slope: 1.2,
          amplitude: 11,
          cycle: 6,
          dipEvery: 24,
          dipSize: 12
        }),
        volumes: buildVolumeSeries(hourlyBars, 170, 8),
        startTime
      }),
      "KRW-CCC": createCandles({
        marketCode: "KRW-CCC",
        timeframe: "1h",
        closes: buildWaveSeries({
          length: hourlyBars,
          start: 1100,
          slope: -0.15,
          amplitude: 9,
          cycle: 7,
          dipEvery: 20,
          dipSize: 8
        }),
        volumes: buildVolumeSeries(hourlyBars, 120, 9),
        startTime
      })
    },
    "5m": {
      "KRW-AAA": createCandles({
        marketCode: "KRW-AAA",
        timeframe: "5m",
        closes: buildWaveSeries({
          length: intradayBars,
          start: 1000,
          slope: 0.18,
          amplitude: 6.5,
          cycle: 15,
          dipEvery: 140,
          dipSize: 8
        }),
        volumes: buildVolumeSeries(intradayBars, 90, 18),
        startTime
      }),
      "KRW-BBB": createCandles({
        marketCode: "KRW-BBB",
        timeframe: "5m",
        closes: buildWaveSeries({
          length: intradayBars,
          start: 900,
          slope: 0.11,
          amplitude: 5,
          cycle: 17,
          dipEvery: 175,
          dipSize: 5
        }),
        volumes: buildVolumeSeries(intradayBars, 72, 21),
        startTime
      }),
      "KRW-CCC": createCandles({
        marketCode: "KRW-CCC",
        timeframe: "5m",
        closes: buildWaveSeries({
          length: intradayBars,
          start: 1100,
          slope: -0.01,
          amplitude: 4.5,
          cycle: 19,
          dipEvery: 150,
          dipSize: 4
        }),
        volumes: buildVolumeSeries(intradayBars, 55, 25),
        startTime
      })
    },
    "1m": {
      "KRW-AAA": createCandles({
        marketCode: "KRW-AAA",
        timeframe: "1m",
        closes: buildWaveSeries({
          length: hourlyBars * 60,
          start: 1000,
          slope: 0.015,
          amplitude: 2.1,
          cycle: 45,
          dipEvery: 520,
          dipSize: 2.8
        }),
        volumes: buildVolumeSeries(hourlyBars * 60, 22, 60),
        startTime
      }),
      "KRW-BBB": createCandles({
        marketCode: "KRW-BBB",
        timeframe: "1m",
        closes: buildWaveSeries({
          length: hourlyBars * 60,
          start: 900,
          slope: 0.01,
          amplitude: 1.6,
          cycle: 52,
          dipEvery: 610,
          dipSize: 1.7
        }),
        volumes: buildVolumeSeries(hourlyBars * 60, 19, 67),
        startTime
      }),
      "KRW-CCC": createCandles({
        marketCode: "KRW-CCC",
        timeframe: "1m",
        closes: buildWaveSeries({
          length: hourlyBars * 60,
          start: 1100,
          slope: -0.002,
          amplitude: 1.3,
          cycle: 58,
          dipEvery: 570,
          dipSize: 1.3
        }),
        volumes: buildVolumeSeries(hourlyBars * 60, 16, 74),
        startTime
      })
    }
  };
}

function buildCandidate(
  parameters: Record<string, number> = {},
  overrides?: Partial<Pick<NormalizedCandidateProposal, "candidateId" | "familyId" | "strategyName" | "thesis">>
): NormalizedCandidateProposal {
  return {
    candidateId: overrides?.candidateId ?? "portfolio-core-01",
    familyId: overrides?.familyId ?? "multi-tf-regime-core",
    strategyName: overrides?.strategyName ?? MULTI_TF_REGIME_CORE_PORTFOLIO,
    thesis: overrides?.thesis ?? "Blend intraday rotation with hourly pullback and breakout sleeves.",
    parameters,
    invalidationSignals: ["portfolio loses breadth leadership"]
  };
}

function buildConfig(overrides: Partial<AutoResearchRunConfig> = {}): AutoResearchRunConfig {
  return {
    universeName: "krw-top",
    timeframe: "1h",
    marketLimit: 3,
    limit: 500,
    holdoutDays: 2,
    trainingDays: 4,
    stepDays: 1,
    iterations: 1,
    candidatesPerIteration: 1,
    parallelism: 1,
    mode: "holdout",
    outputDir: "/tmp/fst-portfolio-auto-research-test",
    allowDataCollection: false,
    allowFeatureCacheBuild: false,
    allowCodeMutation: false,
    ...overrides
  };
}

test("portfolio auto-research runtime builds bounded multi-timeframe sleeves", () => {
  const runtime = buildPortfolioCandidateRuntime(
    buildCandidate({
      maxCapitalUsagePct: 0.6,
      trendBudgetPct: 0.55,
      breakoutBudgetPct: 0.35,
      maxOpenPositions: 5
    })
  );

  assert.deepEqual(runtime.requiredTimeframes, ["1h", "15m", "5m"]);
  assert.equal(runtime.strategies.length, 3);
  assert.equal(runtime.sleeves.length, 2);
  assert.ok(runtime.sleeves.every((sleeve) => sleeve.capitalBudgetPct > 0));
  assert.ok(
    runtime.sleeves.reduce((sum, sleeve) => sum + sleeve.capitalBudgetPct, 0) <=
      runtime.maxCapitalUsagePct + 1e-9
  );
  assert.deepEqual(
    runtime.strategies.map((strategy) => strategy.decisionTimeframe),
    ["1h", "1h", "1h"]
  );

  const trendBurstRuntime = buildPortfolioCandidateRuntime(
    buildCandidate(
      {
        maxCapitalUsagePct: 0.72,
        trendBudgetPct: 0.38,
        breakoutBudgetPct: 0.31
      },
      {
        candidateId: "portfolio-trend-burst-01",
        familyId: "multi-tf-trend-burst",
        strategyName: MULTI_TF_TREND_BURST_PORTFOLIO,
        thesis: "Aggressive trend burst portfolio."
      }
    )
  );
  const defensiveRuntime = buildPortfolioCandidateRuntime(
    buildCandidate(
      {
        maxCapitalUsagePct: 0.55,
        trendBudgetPct: 0.25,
        reversionBudgetPct: 0.18
      },
      {
        candidateId: "portfolio-defensive-01",
        familyId: "multi-tf-defensive-reclaim",
        strategyName: MULTI_TF_DEFENSIVE_RECLAIM_PORTFOLIO,
        thesis: "Defensive reclaim and reversion portfolio."
      }
    )
  );

  assert.equal(trendBurstRuntime.strategies.length, 3);
  assert.equal(defensiveRuntime.strategies.length, 3);
  assert.ok(defensiveRuntime.sleeves.some((sleeve) => sleeve.sleeveId === "micro"));
  assert.ok(defensiveRuntime.strategies.some((strategy) => strategy.family === "meanreversion"));

  const regimeSwitchRuntime = buildPortfolioCandidateRuntime(
    buildCandidate(
      {
        maxCapitalUsagePct: 0.68,
        trendBudgetPct: 0.24,
        breakoutBudgetPct: 0.18,
        microBudgetPct: 0.12,
        maxOpenPositions: 4
      },
      {
        candidateId: "portfolio-regime-switch-01",
        familyId: "multi-tf-regime-switch",
        strategyName: MULTI_TF_REGIME_SWITCH_PORTFOLIO,
        thesis: "Adaptive regime switch portfolio."
      }
    )
  );

  assert.deepEqual(regimeSwitchRuntime.requiredTimeframes, ["1h", "15m", "5m", "1m"]);
  assert.equal(regimeSwitchRuntime.strategies.length, 5);
  assert.equal(regimeSwitchRuntime.sleeves.length, 3);
  assert.ok(
    regimeSwitchRuntime.strategies.some((strategy) => strategy.decisionTimeframe === "1m")
  );

  const regimeSwitchScreenRuntime = buildPortfolioCandidateRuntime(
    buildCandidate(
      {
        maxCapitalUsagePct: 0.68,
        trendBudgetPct: 0.24,
        breakoutBudgetPct: 0.18,
        microBudgetPct: 0.12,
        maxOpenPositions: 4
      },
      {
        candidateId: "portfolio-regime-switch-screen-01",
        familyId: "multi-tf-regime-switch-screen",
        strategyName: MULTI_TF_REGIME_SWITCH_SCREEN_PORTFOLIO,
        thesis: "Adaptive regime switch screen portfolio."
      }
    )
  );

  assert.deepEqual(regimeSwitchScreenRuntime.requiredTimeframes, ["1h", "15m", "5m"]);
  assert.equal(regimeSwitchScreenRuntime.strategies.length, 4);
  assert.equal(regimeSwitchScreenRuntime.sleeves.length, 3);
  assert.ok(
    regimeSwitchScreenRuntime.strategies.every((strategy) => strategy.decisionTimeframe !== "1m")
  );
});

test("portfolio auto-research evaluates holdout candidates on synthetic multi-timeframe data", async () => {
  const data = buildMockCandleData();
  const evaluation = await evaluatePortfolioCandidate({
    config: buildConfig({
      mode: "holdout",
      holdoutDays: 2
    }),
    candidate: buildCandidate(),
    marketCodes: [...MARKET_CODES],
    loadCandles: async ({ marketCodes, timeframe, limit }) =>
      Object.fromEntries(
        marketCodes.map((marketCode) => [
          marketCode,
          (data[timeframe as keyof MockCandleData]?.[marketCode] ?? []).slice(-limit)
        ])
      )
  });

  assert.equal(evaluation.status, "completed");
  assert.equal(evaluation.mode, "holdout");
  assert.equal(evaluation.diagnostics.windows.mode, "holdout");
  assert.ok((evaluation.diagnostics.windows.availableDays ?? 0) >= 7);
  assert.ok(evaluation.summary.signalCount > 0);
  assert.equal(
    evaluation.diagnostics.coverage.rawBuySignals +
      evaluation.diagnostics.coverage.rawSellSignals +
      evaluation.diagnostics.coverage.rawHoldSignals,
    evaluation.summary.signalCount
  );
  assert.ok(
    evaluation.diagnostics.coverage.avgEligibleBuys <=
      evaluation.diagnostics.coverage.avgConsideredBuys + 1e-9
  );
  assert.ok(Object.keys(evaluation.diagnostics.reasons.strategy).length > 0);
  assert.equal(evaluation.diagnostics.crossChecks[0]?.status, "completed");
  assert.ok((evaluation.diagnostics.windows.windowCount ?? 0) >= 1);
  assert.ok(typeof evaluation.diagnostics.windows.positiveWindowRatio === "number");
  assert.ok(evaluation.diagnostics.coverage.maxUniverseSize <= MARKET_CODES.length);
});

test("portfolio auto-research evaluates defensive reclaim family on synthetic data", async () => {
  const data = buildMockCandleData();
  const evaluation = await evaluatePortfolioCandidate({
    config: buildConfig({
      mode: "holdout",
      holdoutDays: 2
    }),
    candidate: buildCandidate(
      {
        maxCapitalUsagePct: 0.52,
        trendBudgetPct: 0.24,
        reversionBudgetPct: 0.18,
        reversionEntryThreshold: 0.22,
        reversionExitThreshold: 0.12
      },
      {
        candidateId: "portfolio-defensive-01",
        familyId: "multi-tf-defensive-reclaim",
        strategyName: MULTI_TF_DEFENSIVE_RECLAIM_PORTFOLIO,
        thesis: "Defensive reclaim and residual reversion portfolio."
      }
    ),
    marketCodes: [...MARKET_CODES],
    loadCandles: async ({ marketCodes, timeframe, limit }) =>
      Object.fromEntries(
        marketCodes.map((marketCode) => [
          marketCode,
          (data[timeframe as keyof MockCandleData]?.[marketCode] ?? []).slice(-limit)
        ])
      )
  });

  assert.equal(evaluation.status, "completed");
  assert.equal(evaluation.mode, "holdout");
  assert.ok(evaluation.summary.signalCount > 0);
  assert.ok(
    Object.keys(evaluation.diagnostics.reasons.strategy).some((key) => key.includes("reversion"))
  );
});

test("portfolio auto-research evaluates regime-switch family on synthetic data", async () => {
  const data = buildMockCandleData();
  const requestedMarketCounts: number[] = [];
  const evaluationMarkets = [...MARKET_CODES, "KRW-DDD", "KRW-EEE", "KRW-FFF", "KRW-GGG"];
  const evaluation = await evaluatePortfolioCandidate({
    config: buildConfig({
      mode: "holdout",
      holdoutDays: 2,
      marketLimit: 2
    }),
    candidate: buildCandidate(
      {
        maxCapitalUsagePct: 0.68,
        trendBudgetPct: 0.24,
        breakoutBudgetPct: 0.18,
        microBudgetPct: 0.12,
        maxOpenPositions: 4
      },
      {
        candidateId: "portfolio-regime-switch-02",
        familyId: "multi-tf-regime-switch",
        strategyName: MULTI_TF_REGIME_SWITCH_PORTFOLIO,
        thesis: "Adaptive regime switch portfolio."
      }
    ),
    marketCodes: evaluationMarkets,
    loadCandles: async ({ marketCodes, timeframe, limit }) => {
      requestedMarketCounts.push(marketCodes.length);
      return Object.fromEntries(
        marketCodes.map((marketCode) => [
          marketCode,
          (data[timeframe as keyof MockCandleData]?.[marketCode] ?? []).slice(-limit)
        ])
      );
    }
  });

  assert.equal(evaluation.status, "completed");
  assert.ok(["completed", "failed"].includes(evaluation.diagnostics.crossChecks[0]?.status ?? ""));
  if (evaluation.diagnostics.crossChecks[0]?.status === "failed") {
    assert.match(evaluation.diagnostics.crossChecks[0]?.failureMessage ?? "", /Skipped walk-forward cross-check/i);
    assert.equal(evaluation.diagnostics.windows.windowCount, undefined);
  } else {
    assert.ok((evaluation.diagnostics.windows.windowCount ?? 0) >= 1);
  }
  assert.ok(
    Object.keys(evaluation.diagnostics.reasons.strategy).some((key) => key.includes("-micro"))
  );
  assert.ok(requestedMarketCounts.every((count) => count <= 4));
});

test("portfolio auto-research skips walk-forward cross-check for weak holdout candidates", async () => {
  const data = buildMockCandleData();
  const evaluation = await evaluatePortfolioCandidate({
    config: buildConfig({
      mode: "holdout",
      holdoutDays: 2
    }),
    candidate: buildCandidate(
      {
        trendEntryFloor: 0.999,
        trendExitFloor: 0.999,
        leaderStrengthFloor: 0.999,
        leaderPullbackAtr: 0.01,
        breakoutStrengthFloor: 0.999,
        breakoutMaxExtensionAtr: 0.01,
        microMinVolumeSpike: 99,
        microProfitTarget: 0.02,
        maxCapitalUsagePct: 0.1,
        minBarsBetweenEntries: 24
      },
      {
        candidateId: "portfolio-switch-weak-01",
        familyId: "multi-tf-regime-switch",
        strategyName: MULTI_TF_REGIME_SWITCH_PORTFOLIO,
        thesis: "Overly restrictive regime-switch portfolio."
      }
    ),
    marketCodes: [...MARKET_CODES],
    loadCandles: async ({ marketCodes, timeframe, limit }) =>
      Object.fromEntries(
        marketCodes.map((marketCode) => [
          marketCode,
          (data[timeframe as keyof MockCandleData]?.[marketCode] ?? []).slice(-limit)
        ])
      )
  });

  assert.equal(evaluation.status, "completed");
  assert.equal(evaluation.mode, "holdout");
  assert.equal(evaluation.diagnostics.crossChecks[0]?.status, "failed");
  assert.match(evaluation.diagnostics.crossChecks[0]?.failureMessage ?? "", /Skipped walk-forward cross-check/i);
});

test("portfolio auto-research uses warmup-aware universe snapshots inside each holdout window", async () => {
  const data = buildMockCandleData();
  const evaluation = await evaluatePortfolioCandidate({
    config: buildConfig({
      mode: "holdout",
      holdoutDays: 0.5
    }),
    candidate: buildCandidate({
      universeLookbackBars: 60
    }),
    marketCodes: [...MARKET_CODES],
    loadCandles: async ({ marketCodes, timeframe, limit }) =>
      Object.fromEntries(
        marketCodes.map((marketCode) => [
          marketCode,
          (data[timeframe as keyof MockCandleData]?.[marketCode] ?? []).slice(-limit)
        ])
      )
  });

  assert.equal(evaluation.status, "completed");
  assert.equal(evaluation.mode, "holdout");
  assert.ok(evaluation.summary.signalCount > 0);
  assert.ok(evaluation.diagnostics.coverage.avgUniverseSize > 0);
  assert.ok(evaluation.diagnostics.coverage.rawBuySignals > 0);
});

test("portfolio auto-research evaluates walk-forward candidates and preserves window diagnostics", async () => {
  const data = buildMockCandleData();
  const evaluation = await evaluatePortfolioCandidate({
    config: buildConfig({
      mode: "walk-forward",
      holdoutDays: 1,
      trainingDays: 3,
      stepDays: 1
    }),
    candidate: buildCandidate({
      trendRebalanceBars: 2,
      trendEntryFloor: 0.64,
      breakoutLookback: 18
    }),
    marketCodes: [...MARKET_CODES],
    loadCandles: async ({ marketCodes, timeframe, limit }) =>
      Object.fromEntries(
        marketCodes.map((marketCode) => [
          marketCode,
          (data[timeframe as keyof MockCandleData]?.[marketCode] ?? []).slice(-limit)
        ])
      )
  });

  assert.equal(evaluation.status, "completed");
  assert.equal(evaluation.mode, "walk-forward");
  assert.equal(evaluation.diagnostics.windows.mode, "walk-forward");
  assert.ok((evaluation.diagnostics.windows.windowCount ?? 0) >= 2);
  assert.ok((evaluation.diagnostics.windows.positiveWindowCount ?? 0) >= 0);
  assert.ok(typeof evaluation.diagnostics.windows.worstWindowMaxDrawdown === "number");
  assert.ok((evaluation.diagnostics.windows.worstWindowMaxDrawdown ?? 0) >= 0);
  assert.ok(evaluation.summary.signalCount > 0);
  assert.equal(
    evaluation.diagnostics.coverage.rawBuySignals +
      evaluation.diagnostics.coverage.rawSellSignals +
      evaluation.diagnostics.coverage.rawHoldSignals,
    evaluation.summary.signalCount
  );
  assert.ok(
    evaluation.diagnostics.coverage.avgEligibleBuys <=
      evaluation.diagnostics.coverage.avgConsideredBuys + 1e-9
  );
  assert.ok(Object.keys(evaluation.diagnostics.reasons.strategy).length > 0);
});
