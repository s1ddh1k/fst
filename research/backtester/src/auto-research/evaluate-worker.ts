import { readFile } from "node:fs/promises";
import { executeScoredHoldoutBacktest, executeScoredWalkForwardBacktest, preloadMarketData } from "../scored-runner.js";
import { instantiateCandidateStrategy } from "./catalog.js";
import type { AutoResearchRunConfig, CandidateBacktestEvaluation, NormalizedCandidateProposal } from "./types.js";

function getOption(args: string[], key: string): string | undefined {
  const index = args.indexOf(key);
  return index === -1 ? undefined : args[index + 1];
}

type WorkerPayload = {
  config: AutoResearchRunConfig;
  candidate: NormalizedCandidateProposal;
  marketCodes: string[];
};

function emptyCoverage() {
  return {
    tradeCount: 0,
    signalCount: 0,
    ghostSignalCount: 0,
    rejectedOrdersCount: 0,
    cooldownSkipsCount: 0,
    rawBuySignals: 0,
    rawSellSignals: 0,
    rawHoldSignals: 0,
    avgUniverseSize: 0,
    minUniverseSize: 0,
    maxUniverseSize: 0,
    avgConsideredBuys: 0,
    avgEligibleBuys: 0
  };
}

function emptyReasons() {
  return {
    strategy: {} as Record<string, number>,
    strategyTags: {} as Record<string, number>,
    coordinator: {} as Record<string, number>,
    execution: {} as Record<string, number>,
    risk: {} as Record<string, number>
  };
}

function mergeCounts(target: Record<string, number>, source: Record<string, number>): void {
  for (const [reason, count] of Object.entries(source)) {
    target[reason] = (target[reason] ?? 0) + count;
  }
}

function buildEmptyEvaluation(params: {
  config: AutoResearchRunConfig;
  candidate: NormalizedCandidateProposal;
  stage: CandidateBacktestEvaluation["failure"] extends infer T
    ? T extends { stage: infer S }
      ? S
      : "unknown"
    : "unknown";
  message: string;
}): CandidateBacktestEvaluation {
  return {
    candidate: params.candidate,
    mode: params.config.mode,
    status: "failed",
    failure: {
      stage: params.stage,
      message: params.message
    },
    summary: {
      totalReturn: 0,
      grossReturn: 0,
      netReturn: 0,
      maxDrawdown: 0,
      turnover: 0,
      winRate: 0,
      avgHoldBars: 0,
      tradeCount: 0,
      feePaid: 0,
      slippagePaid: 0,
      rejectedOrdersCount: 0,
      cooldownSkipsCount: 0,
      signalCount: 0,
      ghostSignalCount: 0
    },
    diagnostics: {
      coverage: emptyCoverage(),
      reasons: emptyReasons(),
      costs: {
        feePaid: 0,
        slippagePaid: 0,
        totalCostsPaid: 0
      },
      robustness: {},
      crossChecks: [],
      windows: {
        mode: params.config.mode,
        holdoutDays: params.config.holdoutDays,
        trainingDays: params.config.trainingDays,
        stepDays: params.config.stepDays
      }
    }
  };
}

async function main(): Promise<void> {
  const payloadPath = getOption(process.argv, "--payload");

  if (!payloadPath) {
    throw new Error("Missing required option: --payload");
  }

  const payload = JSON.parse(await readFile(payloadPath, "utf8")) as WorkerPayload;
  const strategy = instantiateCandidateStrategy(payload.candidate);
  let preloaded: Awaited<ReturnType<typeof preloadMarketData>>;
  try {
    preloaded = await preloadMarketData({
      timeframe: payload.config.timeframe,
      limit: payload.config.limit,
      holdoutDays: payload.config.holdoutDays,
      universeName: payload.config.universeName,
      universeMarketCodes: payload.marketCodes
    });
  } catch (error) {
    console.log(
      JSON.stringify(
        buildEmptyEvaluation({
          config: payload.config,
          candidate: payload.candidate,
          stage: "preload",
          message: error instanceof Error ? error.message : String(error)
        }),
        null,
        2
      )
    );
    return;
  }

  let evaluation: CandidateBacktestEvaluation;

  try {
    if (payload.config.mode === "walk-forward") {
      const summary = await executeScoredWalkForwardBacktest({
        timeframe: payload.config.timeframe,
        limit: payload.config.limit,
        holdoutDays: payload.config.holdoutDays,
        trainingDays: payload.config.trainingDays ?? payload.config.holdoutDays * 2,
        stepDays: payload.config.stepDays,
        strategy,
        universeName: payload.config.universeName,
        universeMarketCodes: payload.marketCodes,
        universeConfig: { topN: payload.config.marketLimit },
        runBootstrap: true,
        runRandomBenchmark: true,
        preloaded
      });
      let holdoutCrossCheck: CandidateBacktestEvaluation["diagnostics"]["crossChecks"][number] | undefined;
      try {
        const holdout = await executeScoredHoldoutBacktest({
          timeframe: payload.config.timeframe,
          limit: payload.config.limit,
          holdoutDays: payload.config.holdoutDays,
          strategy,
          universeName: payload.config.universeName,
          universeMarketCodes: payload.marketCodes,
          universeConfig: { topN: payload.config.marketLimit },
          runBootstrap: true,
          runRandomBenchmark: true,
          preloaded
        });
        holdoutCrossCheck = {
          mode: "holdout",
          status: "completed",
          netReturn: holdout.test.netReturn,
          maxDrawdown: holdout.test.maxDrawdown,
          tradeCount: holdout.test.tradeCount,
          bootstrapSignificant: holdout.scoredTest.bootstrap?.isSignificant,
          randomPercentile: holdout.scoredTest.randomBenchmark?.percentileVsRandom,
          testStartAt: holdout.testRange.start.toISOString(),
          testEndAt: holdout.testRange.end.toISOString()
        };
      } catch (error) {
        holdoutCrossCheck = {
          mode: "holdout",
          status: "failed",
          failureMessage: error instanceof Error ? error.message : String(error),
          netReturn: 0,
          maxDrawdown: 0,
          tradeCount: 0
        };
      }

      const aggregateSignals = summary.scoredWindows.reduce(
        (accumulator, window) => ({
          signalCount: accumulator.signalCount + window.signalCount,
          ghostSignalCount: accumulator.ghostSignalCount + window.ghostSignalCount,
          rawBuySignals: accumulator.rawBuySignals + window.decisionCounts.rawBuySignals,
          rawSellSignals: accumulator.rawSellSignals + window.decisionCounts.rawSellSignals,
          rawHoldSignals: accumulator.rawHoldSignals + window.decisionCounts.rawHoldSignals,
          avgUniverseSize: accumulator.avgUniverseSize + window.coverageSummary.avgUniverseSize,
          minUniverseSize:
            accumulator.minUniverseSize === 0
              ? window.coverageSummary.minUniverseSize
              : Math.min(accumulator.minUniverseSize, window.coverageSummary.minUniverseSize),
          maxUniverseSize: Math.max(accumulator.maxUniverseSize, window.coverageSummary.maxUniverseSize),
          avgConsideredBuys: accumulator.avgConsideredBuys + window.coverageSummary.avgConsideredBuys,
          avgEligibleBuys: accumulator.avgEligibleBuys + window.coverageSummary.avgEligibleBuys
        }),
        {
          signalCount: 0,
          ghostSignalCount: 0,
          rawBuySignals: 0,
          rawSellSignals: 0,
          rawHoldSignals: 0,
          avgUniverseSize: 0,
          minUniverseSize: 0,
          maxUniverseSize: 0,
          avgConsideredBuys: 0,
          avgEligibleBuys: 0
        }
      );
      const aggregateReasons = summary.scoredWindows.reduce((accumulator, window) => {
        mergeCounts(accumulator.strategy, window.reasonCounts.strategy);
        mergeCounts(accumulator.strategyTags, window.reasonCounts.strategyTags);
        mergeCounts(accumulator.coordinator, window.reasonCounts.coordinator);
        mergeCounts(accumulator.execution, window.reasonCounts.execution);
        mergeCounts(accumulator.risk, window.reasonCounts.risk);
        return accumulator;
      }, emptyReasons());
      const bootstrapPasses = summary.scoredWindows.filter((window) => window.bootstrap?.isSignificant).length;
      const randomPercentiles = summary.scoredWindows
        .map((window) => window.randomBenchmark?.percentileVsRandom)
        .filter((value): value is number => typeof value === "number");

      const feePaid = summary.scoredWindows.reduce((sum, window) => sum + window.metrics.feePaid, 0);
      const slippagePaid = summary.scoredWindows.reduce((sum, window) => sum + window.metrics.slippagePaid, 0);
      evaluation = {
        candidate: payload.candidate,
        mode: "walk-forward",
        status: "completed",
        summary: {
          totalReturn: summary.averageTestReturn,
          grossReturn: summary.averageTestReturn,
          netReturn: summary.averageTestReturn,
          maxDrawdown: summary.averageTestDrawdown,
          turnover:
            summary.scoredWindows.reduce((sum, window) => sum + window.metrics.turnover, 0) /
            Math.max(summary.scoredWindows.length, 1),
          winRate:
            summary.scoredWindows.reduce((sum, window) => sum + window.metrics.winRate, 0) /
            Math.max(summary.scoredWindows.length, 1),
          avgHoldBars:
            summary.scoredWindows.reduce((sum, window) => sum + window.metrics.avgHoldBars, 0) /
            Math.max(summary.scoredWindows.length, 1),
          tradeCount: summary.averageTestTradeCount,
          feePaid,
          slippagePaid,
          rejectedOrdersCount: summary.scoredWindows.reduce(
            (sum, window) => sum + window.metrics.rejectedOrdersCount,
            0
          ),
          cooldownSkipsCount: summary.scoredWindows.reduce(
            (sum, window) => sum + window.metrics.cooldownSkipsCount,
            0
          ),
          signalCount: aggregateSignals.signalCount,
          ghostSignalCount: aggregateSignals.ghostSignalCount,
          bootstrapSignificant: bootstrapPasses / Math.max(summary.scoredWindows.length, 1) >= 0.5,
          randomPercentile:
            randomPercentiles.reduce((sum, value) => sum + value, 0) / Math.max(randomPercentiles.length, 1)
        },
        diagnostics: {
          coverage: {
            tradeCount: summary.averageTestTradeCount,
            signalCount: aggregateSignals.signalCount,
            ghostSignalCount: aggregateSignals.ghostSignalCount,
            rejectedOrdersCount: summary.scoredWindows.reduce(
              (sum, window) => sum + window.metrics.rejectedOrdersCount,
              0
            ),
            cooldownSkipsCount: summary.scoredWindows.reduce(
              (sum, window) => sum + window.metrics.cooldownSkipsCount,
              0
            ),
            rawBuySignals: aggregateSignals.rawBuySignals,
            rawSellSignals: aggregateSignals.rawSellSignals,
            rawHoldSignals: aggregateSignals.rawHoldSignals,
            avgUniverseSize:
              aggregateSignals.avgUniverseSize / Math.max(summary.scoredWindows.length, 1),
            minUniverseSize: aggregateSignals.minUniverseSize,
            maxUniverseSize: aggregateSignals.maxUniverseSize,
            avgConsideredBuys:
              aggregateSignals.avgConsideredBuys / Math.max(summary.scoredWindows.length, 1),
            avgEligibleBuys:
              aggregateSignals.avgEligibleBuys / Math.max(summary.scoredWindows.length, 1)
          },
          reasons: aggregateReasons,
          costs: {
            feePaid,
            slippagePaid,
            totalCostsPaid: feePaid + slippagePaid
          },
          robustness: {
            bootstrapSignificant: bootstrapPasses / Math.max(summary.scoredWindows.length, 1) >= 0.5,
            randomPercentile:
              randomPercentiles.reduce((sum, value) => sum + value, 0) / Math.max(randomPercentiles.length, 1)
          },
          crossChecks: holdoutCrossCheck ? [holdoutCrossCheck] : [],
          windows: {
            mode: payload.config.mode,
            holdoutDays: payload.config.holdoutDays,
            trainingDays: payload.config.trainingDays ?? payload.config.holdoutDays * 2,
            stepDays: payload.config.stepDays,
            windowCount: summary.scoredWindows.length
          }
        },
        rawSummary: summary
      };
    } else {
      const summary = await executeScoredHoldoutBacktest({
        timeframe: payload.config.timeframe,
        limit: payload.config.limit,
        holdoutDays: payload.config.holdoutDays,
        strategy,
        universeName: payload.config.universeName,
        universeMarketCodes: payload.marketCodes,
        universeConfig: { topN: payload.config.marketLimit },
        runBootstrap: true,
        runRandomBenchmark: true,
        preloaded
      });

      evaluation = {
        candidate: payload.candidate,
        mode: "holdout",
        status: "completed",
        summary: {
          totalReturn: summary.test.totalReturn,
          grossReturn: summary.test.grossReturn,
          netReturn: summary.test.netReturn,
          maxDrawdown: summary.test.maxDrawdown,
          turnover: summary.test.turnover,
          winRate: summary.test.winRate,
          avgHoldBars: summary.test.avgHoldBars,
          tradeCount: summary.test.tradeCount,
          feePaid: summary.test.feePaid,
          slippagePaid: summary.test.slippagePaid,
          rejectedOrdersCount: summary.test.rejectedOrdersCount,
          cooldownSkipsCount: summary.test.cooldownSkipsCount,
          signalCount: summary.scoredTest.signalCount,
          ghostSignalCount: summary.scoredTest.ghostSignalCount,
          bootstrapPValue: summary.scoredTest.bootstrap?.pValue,
          bootstrapSignificant: summary.scoredTest.bootstrap?.isSignificant,
          randomPercentile: summary.scoredTest.randomBenchmark?.percentileVsRandom
        },
        diagnostics: {
          coverage: {
            tradeCount: summary.test.tradeCount,
            signalCount: summary.scoredTest.signalCount,
            ghostSignalCount: summary.scoredTest.ghostSignalCount,
            rejectedOrdersCount: summary.test.rejectedOrdersCount,
            cooldownSkipsCount: summary.test.cooldownSkipsCount,
            rawBuySignals: summary.scoredTest.decisionCounts.rawBuySignals,
            rawSellSignals: summary.scoredTest.decisionCounts.rawSellSignals,
            rawHoldSignals: summary.scoredTest.decisionCounts.rawHoldSignals,
            avgUniverseSize: summary.scoredTest.coverageSummary.avgUniverseSize,
            minUniverseSize: summary.scoredTest.coverageSummary.minUniverseSize,
            maxUniverseSize: summary.scoredTest.coverageSummary.maxUniverseSize,
            avgConsideredBuys: summary.scoredTest.coverageSummary.avgConsideredBuys,
            avgEligibleBuys: summary.scoredTest.coverageSummary.avgEligibleBuys
          },
          reasons: summary.scoredTest.reasonCounts,
          costs: {
            feePaid: summary.test.feePaid,
            slippagePaid: summary.test.slippagePaid,
            totalCostsPaid: summary.test.feePaid + summary.test.slippagePaid
          },
          robustness: {
            bootstrapPValue: summary.scoredTest.bootstrap?.pValue,
            bootstrapSignificant: summary.scoredTest.bootstrap?.isSignificant,
            randomPercentile: summary.scoredTest.randomBenchmark?.percentileVsRandom
          },
          crossChecks: [],
          windows: {
            mode: payload.config.mode,
            holdoutDays: payload.config.holdoutDays,
            trainStartAt: summary.trainRange.start.toISOString(),
            trainEndAt: summary.trainRange.end.toISOString(),
            testStartAt: summary.testRange.start.toISOString(),
            testEndAt: summary.testRange.end.toISOString()
          }
        },
        rawSummary: summary
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stage = /Split produced too few candles/i.test(message) ? "split" : "backtest";
    evaluation = buildEmptyEvaluation({
      config: payload.config,
      candidate: payload.candidate,
      stage,
      message
    });
  }

  console.log(JSON.stringify(evaluation, null, 2));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
