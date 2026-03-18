import type { StrategyTimeframe } from "../../../../packages/shared/src/index.js";
import { loadCandlesForMarkets } from "../db.js";
import {
  normalizeToFullGrid,
  runMultiStrategyBacktest,
  type MultiStrategyBacktestResult
} from "../multi-strategy/index.js";
import type { Candle } from "../types.js";
import { buildWalkForwardRanges, splitTrainTestByDays } from "../validation.js";
import { calculateAutoResearchMinimumLimit } from "./limit-resolution.js";
import { buildPortfolioCandidateRuntime } from "./portfolio-runtime.js";
import type { AutoResearchRunConfig, CandidateBacktestEvaluation, NormalizedCandidateProposal } from "./types.js";
import { repairWalkForwardConfig, summarizeReferenceCandleSpan } from "./walk-forward-config.js";

type CandleMap = Record<string, Candle[]>;
type PortfolioCandleLoader = typeof loadCandlesForMarkets;

type PortfolioCandleData = {
  decisionCandles: Partial<Record<StrategyTimeframe, CandleMap>>;
  executionCandles: Partial<Record<StrategyTimeframe, CandleMap>>;
  referenceCandles: Candle[];
};

function selectPortfolioEvaluationMarkets(params: {
  marketCodes: string[];
  requiredTimeframes: StrategyTimeframe[];
  marketLimit: number;
}): string[] {
  if (!params.requiredTimeframes.includes("1m")) {
    return params.marketCodes;
  }

  const boundedCount = Math.max(params.marketLimit + 2, params.marketLimit * 2);
  return params.marketCodes.slice(0, Math.min(params.marketCodes.length, boundedCount));
}

function flattenFunnel(result: MultiStrategyBacktestResult): Record<string, number> {
  return Object.fromEntries(
    Object.entries(result.funnel).flatMap(([strategyId, stages]) =>
      Object.entries(stages).map(([stage, count]) => [`${strategyId}:${stage}`, count])
    )
  );
}

function mergeReasonMaps(
  target: Record<string, number>,
  source: Record<string, number>
): Record<string, number> {
  for (const [reason, count] of Object.entries(source)) {
    target[reason] = (target[reason] ?? 0) + count;
  }

  return target;
}

function aggregate5mCandlesTo15m(candlesByMarket: CandleMap): CandleMap {
  return Object.fromEntries(
    Object.entries(candlesByMarket).map(([marketCode, candles]) => {
      const buckets = new Map<number, Candle[]>();

      for (const candle of candles) {
        const bucketMs = 15 * 60_000;
        const bucket = Math.floor(candle.candleTimeUtc.getTime() / bucketMs) * bucketMs;
        const existing = buckets.get(bucket) ?? [];
        existing.push(candle);
        buckets.set(bucket, existing);
      }

      const aggregated = Array.from(buckets.entries())
        .sort((left, right) => left[0] - right[0])
        .map(([, bucketCandles]) => {
          const sorted = bucketCandles
            .slice()
            .sort((left, right) => left.candleTimeUtc.getTime() - right.candleTimeUtc.getTime());
          const first = sorted[0];
          const last = sorted[sorted.length - 1];
          const volume = sorted.reduce((sum, candle) => sum + candle.volume, 0);
          const quoteVolume = sorted.reduce(
            (sum, candle) => sum + (candle.quoteVolume ?? candle.closePrice * candle.volume),
            0
          );

          return {
            marketCode,
            timeframe: "15m",
            candleTimeUtc: new Date(Math.floor(first.candleTimeUtc.getTime() / (15 * 60_000)) * (15 * 60_000)),
            openPrice: first.openPrice,
            highPrice: Math.max(...sorted.map((candle) => candle.highPrice)),
            lowPrice: Math.min(...sorted.map((candle) => candle.lowPrice)),
            closePrice: last.closePrice,
            volume,
            quoteVolume,
            isSynthetic: sorted.every((candle) => candle.isSynthetic ?? false)
          } satisfies Candle;
        });

      return [marketCode, aggregated];
    })
  );
}

function filterCandlesByRange(
  candlesByMarket: CandleMap,
  range: { start: Date; end: Date }
): CandleMap {
  return Object.fromEntries(
    Object.entries(candlesByMarket).map(([marketCode, candles]) => [
      marketCode,
      candles.filter(
        (candle) => candle.candleTimeUtc >= range.start && candle.candleTimeUtc <= range.end
      )
    ])
  );
}

function chooseReferenceCandles(candlesByMarket: CandleMap, timeframe: StrategyTimeframe): Candle[] {
  const normalized = normalizeToFullGrid({
    timeframe,
    candlesByMarket
  });
  const bestMarket = Object.entries(normalized.candlesByMarket)
    .sort(([leftMarket, leftCandles], [rightMarket, rightCandles]) => {
      if (rightCandles.length !== leftCandles.length) {
        return rightCandles.length - leftCandles.length;
      }

      return leftMarket.localeCompare(rightMarket);
    })[0]?.[0];

  return bestMarket ? normalized.candlesByMarket[bestMarket] ?? [] : [];
}

function selectReferenceTimeframe(requiredTimeframes: StrategyTimeframe[]): StrategyTimeframe {
  if (requiredTimeframes.includes("1h")) {
    return "1h";
  }
  if (requiredTimeframes.includes("15m")) {
    return "15m";
  }
  if (requiredTimeframes.includes("5m")) {
    return "5m";
  }
  return "1m";
}

async function loadPortfolioCandles(params: {
  config: AutoResearchRunConfig;
  marketCodes: string[];
  requiredTimeframes: StrategyTimeframe[];
  loadCandles?: PortfolioCandleLoader;
}): Promise<PortfolioCandleData> {
  const needs1h = params.requiredTimeframes.includes("1h");
  const needs15m = params.requiredTimeframes.includes("15m");
  const needs5m = params.requiredTimeframes.includes("5m") || needs15m;
  const needs1m = params.requiredTimeframes.includes("1m");
  const loadCandles = params.loadCandles ?? loadCandlesForMarkets;

  const loadLimit = (timeframe: StrategyTimeframe) =>
    calculateAutoResearchMinimumLimit({
      timeframe,
      holdoutDays: params.config.holdoutDays,
      trainingDays: params.config.trainingDays,
      stepDays: params.config.stepDays,
      mode: params.config.mode
    });

  const [candles1h, candles5m, candles1m] = await Promise.all([
    needs1h
      ? loadCandles({
          marketCodes: params.marketCodes,
          timeframe: "1h",
          limit: Math.max(params.config.limit, loadLimit("1h"))
        })
      : Promise.resolve({}),
    needs5m
      ? loadCandles({
          marketCodes: params.marketCodes,
          timeframe: "5m",
          limit: loadLimit("5m")
        })
      : Promise.resolve({}),
    needs1m
      ? loadCandles({
          marketCodes: params.marketCodes,
          timeframe: "1m",
          limit: loadLimit("1m")
        })
      : Promise.resolve({})
  ]);

  const candles15m = needs15m ? aggregate5mCandlesTo15m(candles5m) : {};
  const referenceTimeframe = selectReferenceTimeframe(params.requiredTimeframes);
  const referenceCandles = chooseReferenceCandles(
    referenceTimeframe === "1h"
      ? (candles1h as CandleMap)
      : referenceTimeframe === "15m"
        ? candles15m
        : referenceTimeframe === "5m"
          ? (candles5m as CandleMap)
          : (candles1m as CandleMap),
    referenceTimeframe
  );

  if (referenceCandles.length === 0) {
    throw new Error("No normalized portfolio reference candles available");
  }

  return {
    decisionCandles: {
      "1h": candles1h as CandleMap,
      "15m": candles15m,
      "5m": candles5m as CandleMap,
      "1m": candles1m as CandleMap
    },
    executionCandles: {
      "5m": candles5m as CandleMap,
      "1m": candles1m as CandleMap
    },
    referenceCandles
  };
}

function runPortfolioRangeBacktest(params: {
  config: AutoResearchRunConfig;
  candleData: PortfolioCandleData;
  range: { start: Date; end: Date };
  candidate: NormalizedCandidateProposal;
}): MultiStrategyBacktestResult {
  const runtime = buildPortfolioCandidateRuntime(params.candidate);

  return runMultiStrategyBacktest({
    universeName: params.config.universeName,
    initialCapital: 1_000_000,
    sleeves: runtime.sleeves,
    strategies: runtime.strategies,
    decisionCandles: Object.fromEntries(
      Object.entries(params.candleData.decisionCandles).map(([timeframe, candlesByMarket]) => [
        timeframe,
        filterCandlesByRange(candlesByMarket ?? {}, params.range)
      ])
    ),
    executionCandles: Object.fromEntries(
      Object.entries(params.candleData.executionCandles).map(([timeframe, candlesByMarket]) => [
        timeframe,
        filterCandlesByRange(candlesByMarket ?? {}, params.range)
      ])
    ),
    universeConfig: {
      topN: Math.min(runtime.universeTopN, params.config.marketLimit, Object.keys((params.candleData.decisionCandles["1h"] ?? params.candleData.decisionCandles["15m"] ?? params.candleData.decisionCandles["5m"] ?? {})).length || runtime.universeTopN),
      lookbackBars: runtime.universeLookbackBars,
      refreshEveryBars: runtime.refreshEveryBars
    },
    maxOpenPositions: runtime.maxOpenPositions,
    maxCapitalUsagePct: runtime.maxCapitalUsagePct,
    cooldownBarsAfterLoss: runtime.cooldownBarsAfterLoss,
    minBarsBetweenEntries: runtime.minBarsBetweenEntries
  });
}

function toGhostSignalCount(result: MultiStrategyBacktestResult): number {
  return Object.values(result.ghostSummary).reduce((sum, item) => sum + item.count, 0);
}

function universeSizeSummary(result: MultiStrategyBacktestResult): {
  avg: number;
  min: number;
  max: number;
} {
  const sizes = result.universeSnapshots.map((snapshot) => snapshot.markets.length);
  return {
    avg: sizes.length === 0 ? 0 : sizes.reduce((sum, value) => sum + value, 0) / sizes.length,
    min: sizes.length === 0 ? 0 : Math.min(...sizes),
    max: sizes.length === 0 ? 0 : Math.max(...sizes)
  };
}

function buildWalkForwardCrossCheck(
  evaluation: CandidateBacktestEvaluation
): CandidateBacktestEvaluation["diagnostics"]["crossChecks"][number] {
  return {
    mode: "walk-forward",
    status: "completed",
    netReturn: evaluation.summary.netReturn,
    maxDrawdown: evaluation.summary.maxDrawdown,
    tradeCount: evaluation.summary.tradeCount,
    bootstrapSignificant: evaluation.summary.bootstrapSignificant,
    randomPercentile: evaluation.summary.randomPercentile,
    testStartAt: evaluation.diagnostics.windows.testStartAt,
    testEndAt: evaluation.diagnostics.windows.testEndAt,
    windowCount: evaluation.diagnostics.windows.windowCount
  };
}

function shouldSkipPortfolioHoldoutCrossCheck(params: {
  requiredTimeframes: StrategyTimeframe[];
  testResult: MultiStrategyBacktestResult;
}): { skip: boolean; reason?: string } {
  if (!params.requiredTimeframes.includes("1m")) {
    return { skip: false };
  }

  const tradeCount = params.testResult.completedTrades.length;
  const netReturn = params.testResult.metrics.netReturn;

  if (tradeCount === 0) {
    return {
      skip: true,
      reason: "Skipped walk-forward cross-check because holdout produced no closed trades."
    };
  }

  if (netReturn <= 0) {
    return {
      skip: true,
      reason: `Skipped walk-forward cross-check because holdout netReturn ${netReturn} was non-positive.`
    };
  }

  return { skip: false };
}

function completedCrossCheckWindowStats(
  evaluation: CandidateBacktestEvaluation
): Partial<CandidateBacktestEvaluation["diagnostics"]["windows"]> {
  return {
    trainingDays: evaluation.diagnostics.windows.trainingDays,
    stepDays: evaluation.diagnostics.windows.stepDays,
    requiredDays: evaluation.diagnostics.windows.requiredDays,
    positiveWindowCount: evaluation.diagnostics.windows.positiveWindowCount,
    positiveWindowRatio: evaluation.diagnostics.windows.positiveWindowRatio,
    negativeWindowCount: evaluation.diagnostics.windows.negativeWindowCount,
    bestWindowNetReturn: evaluation.diagnostics.windows.bestWindowNetReturn,
    worstWindowNetReturn: evaluation.diagnostics.windows.worstWindowNetReturn,
    totalClosedTrades: evaluation.diagnostics.windows.totalClosedTrades,
    windowCount: evaluation.diagnostics.windows.windowCount
  };
}

function buildHoldoutEvaluation(params: {
  config: AutoResearchRunConfig;
  candidate: NormalizedCandidateProposal;
  availableSpan: ReturnType<typeof summarizeReferenceCandleSpan>;
  trainRange: { start: Date; end: Date };
  testRange: { start: Date; end: Date };
  trainResult: MultiStrategyBacktestResult;
  testResult: MultiStrategyBacktestResult;
  crossChecks?: CandidateBacktestEvaluation["diagnostics"]["crossChecks"];
  crossCheckWindows?: Partial<CandidateBacktestEvaluation["diagnostics"]["windows"]>;
}): CandidateBacktestEvaluation {
  const testUniverse = universeSizeSummary(params.testResult);
  const signalCount = params.testResult.metrics.signalCount;
  const ghostSignalCount = toGhostSignalCount(params.testResult);
  const buySignals = Object.values(params.testResult.strategyMetrics).reduce(
    (sum, item) => sum + item.buySignals,
    0
  );

  return {
    candidate: params.candidate,
    mode: "holdout",
    status: "completed",
    summary: {
      totalReturn: params.testResult.metrics.netReturn,
      grossReturn: params.testResult.metrics.grossReturn,
      netReturn: params.testResult.metrics.netReturn,
      maxDrawdown: params.testResult.metrics.maxDrawdown,
      turnover: params.testResult.metrics.turnover,
      winRate: params.testResult.metrics.winRate,
      avgHoldBars: params.testResult.metrics.avgHoldBars,
      tradeCount: params.testResult.completedTrades.length,
      feePaid: params.testResult.metrics.feePaid,
      slippagePaid: params.testResult.metrics.slippagePaid,
      rejectedOrdersCount: params.testResult.metrics.rejectedOrdersCount,
      cooldownSkipsCount: params.testResult.metrics.cooldownSkipsCount,
      signalCount,
      ghostSignalCount
    },
    diagnostics: {
      coverage: {
        tradeCount: params.testResult.completedTrades.length,
        signalCount,
        ghostSignalCount,
        rejectedOrdersCount: params.testResult.metrics.rejectedOrdersCount,
        cooldownSkipsCount: params.testResult.metrics.cooldownSkipsCount,
        rawBuySignals: buySignals,
        rawSellSignals: Object.values(params.testResult.strategyMetrics).reduce(
          (sum, item) => sum + item.sellSignals,
          0
        ),
        rawHoldSignals: Math.max(0, signalCount - buySignals),
        avgUniverseSize: testUniverse.avg,
        minUniverseSize: testUniverse.min,
        maxUniverseSize: testUniverse.max,
        avgConsideredBuys: signalCount === 0 ? 0 : buySignals / Math.max(params.testResult.universeSnapshots.length, 1),
        avgEligibleBuys: signalCount === 0 ? 0 : buySignals / Math.max(params.testResult.universeSnapshots.length, 1)
      },
      reasons: {
        strategy: flattenFunnel(params.testResult),
        strategyTags: {},
        coordinator: {
          blocked_signals: params.testResult.metrics.blockedSignalCount
        },
        execution: {
          rejected_orders: params.testResult.metrics.rejectedOrdersCount
        },
        risk: {}
      },
      costs: {
        feePaid: params.testResult.metrics.feePaid,
        slippagePaid: params.testResult.metrics.slippagePaid,
        totalCostsPaid: params.testResult.metrics.feePaid + params.testResult.metrics.slippagePaid
      },
      robustness: {},
      crossChecks: params.crossChecks ?? [],
      windows: {
        mode: "holdout",
        holdoutDays: params.config.holdoutDays,
        trainingDays: params.crossCheckWindows?.trainingDays,
        stepDays: params.crossCheckWindows?.stepDays,
        trainStartAt: params.trainRange.start.toISOString(),
        trainEndAt: params.trainRange.end.toISOString(),
        testStartAt: params.testRange.start.toISOString(),
        testEndAt: params.testRange.end.toISOString(),
        availableStartAt: params.availableSpan.startAt?.toISOString(),
        availableEndAt: params.availableSpan.endAt?.toISOString(),
        availableDays: params.availableSpan.availableDays,
        requiredDays: params.crossCheckWindows?.requiredDays,
        positiveWindowCount: params.crossCheckWindows?.positiveWindowCount,
        positiveWindowRatio: params.crossCheckWindows?.positiveWindowRatio,
        negativeWindowCount: params.crossCheckWindows?.negativeWindowCount,
        bestWindowNetReturn: params.crossCheckWindows?.bestWindowNetReturn,
        worstWindowNetReturn: params.crossCheckWindows?.worstWindowNetReturn,
        totalClosedTrades: params.crossCheckWindows?.totalClosedTrades,
        windowCount: params.crossCheckWindows?.windowCount
      }
    }
  };
}

function buildPortfolioWalkForwardEvaluation(params: {
  config: AutoResearchRunConfig;
  candidate: NormalizedCandidateProposal;
  candleData: PortfolioCandleData;
  availableSpan: ReturnType<typeof summarizeReferenceCandleSpan>;
}): CandidateBacktestEvaluation {
  const trainingDays = params.config.trainingDays ?? params.config.holdoutDays * 2;
  const stepDays = params.config.stepDays ?? params.config.holdoutDays;
  const windows = buildWalkForwardRanges({
    candles: params.candleData.referenceCandles,
    trainingDays,
    holdoutDays: params.config.holdoutDays,
    stepDays
  });

  if (windows.length === 0) {
    throw new Error("No valid portfolio walk-forward windows could be constructed.");
  }

  const results = windows.map((window) => ({
    trainRange: window.trainRange,
    testRange: window.testRange,
    train: runPortfolioRangeBacktest({
      config: params.config,
      candleData: params.candleData,
      range: window.trainRange,
      candidate: params.candidate
    }),
    test: runPortfolioRangeBacktest({
      config: params.config,
      candleData: params.candleData,
      range: window.testRange,
      candidate: params.candidate
    })
  }));

  const testReturns = results.map((window) => window.test.metrics.netReturn);
  const positiveWindowCount = testReturns.filter((value) => value > 0).length;
  const negativeWindowCount = testReturns.filter((value) => value < 0).length;
  const totalClosedTrades = results.reduce((sum, window) => sum + window.test.completedTrades.length, 0);
  const signalCount = results.reduce((sum, window) => sum + window.test.metrics.signalCount, 0);
  const ghostSignalCount = results.reduce((sum, window) => sum + toGhostSignalCount(window.test), 0);
  const rejectedOrdersCount = results.reduce(
    (sum, window) => sum + window.test.metrics.rejectedOrdersCount,
    0
  );
  const cooldownSkipsCount = results.reduce(
    (sum, window) => sum + window.test.metrics.cooldownSkipsCount,
    0
  );
  const feePaid = results.reduce((sum, window) => sum + window.test.metrics.feePaid, 0);
  const slippagePaid = results.reduce((sum, window) => sum + window.test.metrics.slippagePaid, 0);
  const universeStats = results.map((window) => universeSizeSummary(window.test));
  const avgUniverseSize =
    universeStats.reduce((sum, window) => sum + window.avg, 0) / Math.max(results.length, 1);
  const minUniverseSize = Math.min(...universeStats.map((window) => window.min));
  const maxUniverseSize = Math.max(...universeStats.map((window) => window.max));
  const buySignals = results.reduce(
    (sum, window) =>
      sum +
      Object.values(window.test.strategyMetrics).reduce((inner, item) => inner + item.buySignals, 0),
    0
  );

  return {
    candidate: params.candidate,
    mode: "walk-forward",
    status: "completed",
    summary: {
      totalReturn: testReturns.reduce((sum, value) => sum + value, 0) / results.length,
      grossReturn:
        results.reduce((sum, window) => sum + window.test.metrics.grossReturn, 0) / results.length,
      netReturn: testReturns.reduce((sum, value) => sum + value, 0) / results.length,
      maxDrawdown:
        results.reduce((sum, window) => sum + window.test.metrics.maxDrawdown, 0) / results.length,
      turnover: results.reduce((sum, window) => sum + window.test.metrics.turnover, 0) / results.length,
      winRate: results.reduce((sum, window) => sum + window.test.metrics.winRate, 0) / results.length,
      avgHoldBars:
        results.reduce((sum, window) => sum + window.test.metrics.avgHoldBars, 0) / results.length,
      tradeCount: totalClosedTrades / results.length,
      feePaid,
      slippagePaid,
      rejectedOrdersCount,
      cooldownSkipsCount,
      signalCount,
      ghostSignalCount
    },
    diagnostics: {
      coverage: {
        tradeCount: totalClosedTrades,
        signalCount,
        ghostSignalCount,
        rejectedOrdersCount,
        cooldownSkipsCount,
        rawBuySignals: buySignals,
        rawSellSignals: results.reduce(
          (sum, window) =>
            sum +
            Object.values(window.test.strategyMetrics).reduce((inner, item) => inner + item.sellSignals, 0),
          0
        ),
        rawHoldSignals: Math.max(0, signalCount - buySignals),
        avgUniverseSize,
        minUniverseSize: Number.isFinite(minUniverseSize) ? minUniverseSize : 0,
        maxUniverseSize: Number.isFinite(maxUniverseSize) ? maxUniverseSize : 0,
        avgConsideredBuys: buySignals / Math.max(signalCount, 1),
        avgEligibleBuys: buySignals / Math.max(signalCount, 1)
      },
      reasons: {
        strategy: results.reduce(
          (accumulator, window) => mergeReasonMaps(accumulator, flattenFunnel(window.test)),
          {} as Record<string, number>
        ),
        strategyTags: {},
        coordinator: {
          blocked_signals: results.reduce(
            (sum, window) => sum + window.test.metrics.blockedSignalCount,
            0
          )
        },
        execution: {
          rejected_orders: rejectedOrdersCount
        },
        risk: {}
      },
      costs: {
        feePaid,
        slippagePaid,
        totalCostsPaid: feePaid + slippagePaid
      },
      robustness: {},
      crossChecks: [],
      windows: {
        mode: "walk-forward",
        holdoutDays: params.config.holdoutDays,
        trainingDays,
        stepDays,
        trainStartAt: results[0]?.trainRange.start.toISOString(),
        trainEndAt: results[results.length - 1]?.trainRange.end.toISOString(),
        testStartAt: results[0]?.testRange.start.toISOString(),
        testEndAt: results[results.length - 1]?.testRange.end.toISOString(),
        windowCount: results.length,
        availableStartAt: params.availableSpan.startAt?.toISOString(),
        availableEndAt: params.availableSpan.endAt?.toISOString(),
        availableDays: params.availableSpan.availableDays,
        requiredDays: trainingDays + params.config.holdoutDays,
        positiveWindowCount,
        positiveWindowRatio: positiveWindowCount / results.length,
        negativeWindowCount,
        bestWindowNetReturn: Math.max(...testReturns),
        worstWindowNetReturn: Math.min(...testReturns),
        totalClosedTrades
      }
    }
  };
}

export async function evaluatePortfolioCandidate(params: {
  config: AutoResearchRunConfig;
  candidate: NormalizedCandidateProposal;
  marketCodes: string[];
  loadCandles?: PortfolioCandleLoader;
}): Promise<CandidateBacktestEvaluation> {
  const runtime = buildPortfolioCandidateRuntime(params.candidate);
  const evaluationMarketCodes = selectPortfolioEvaluationMarkets({
    marketCodes: params.marketCodes,
    requiredTimeframes: runtime.requiredTimeframes,
    marketLimit: params.config.marketLimit
  });
  const candleData = await loadPortfolioCandles({
    config: params.config,
    marketCodes: evaluationMarketCodes,
    requiredTimeframes: runtime.requiredTimeframes,
    loadCandles: params.loadCandles
  });
  const availableSpan = summarizeReferenceCandleSpan(candleData.referenceCandles);

  if (params.config.mode === "holdout") {
    const { trainRange, testRange } = splitTrainTestByDays(
      candleData.referenceCandles,
      params.config.holdoutDays
    );
    const trainResult = runPortfolioRangeBacktest({
      config: params.config,
      candleData,
      range: trainRange,
      candidate: params.candidate
    });
    const testResult = runPortfolioRangeBacktest({
      config: params.config,
      candleData,
      range: testRange,
      candidate: params.candidate
    });
    let crossChecks: CandidateBacktestEvaluation["diagnostics"]["crossChecks"];
    let crossCheckWindows: Partial<CandidateBacktestEvaluation["diagnostics"]["windows"]>;
    const skipCrossCheck = shouldSkipPortfolioHoldoutCrossCheck({
      requiredTimeframes: runtime.requiredTimeframes,
      testResult
    });

    if (skipCrossCheck.skip) {
      crossChecks = [{
        mode: "walk-forward",
        status: "failed",
        failureMessage: skipCrossCheck.reason,
        netReturn: 0,
        maxDrawdown: 0,
        tradeCount: 0
      }];
      crossCheckWindows = {
        trainingDays: params.config.trainingDays,
        stepDays: params.config.stepDays,
        requiredDays: (params.config.trainingDays ?? params.config.holdoutDays * 2) + params.config.holdoutDays
      };
    } else {
      const walkForwardResolution = repairWalkForwardConfig({
        config: {
          ...params.config,
          mode: "walk-forward"
        },
        referenceCandles: candleData.referenceCandles
      });

      if (walkForwardResolution.windowCount > 0) {
        try {
          const walkForwardCrossCheck = buildPortfolioWalkForwardEvaluation({
            config: walkForwardResolution.config,
            candidate: params.candidate,
            candleData,
            availableSpan
          });
          crossChecks = [buildWalkForwardCrossCheck(walkForwardCrossCheck)];
          crossCheckWindows = completedCrossCheckWindowStats(walkForwardCrossCheck);
        } catch (error) {
          crossChecks = [{
            mode: "walk-forward",
            status: "failed",
            failureMessage: error instanceof Error ? error.message : String(error),
            netReturn: 0,
            maxDrawdown: 0,
            tradeCount: 0
          }];
          crossCheckWindows = {
            trainingDays: walkForwardResolution.config.trainingDays,
            stepDays: walkForwardResolution.config.stepDays,
            requiredDays:
              (walkForwardResolution.config.trainingDays ?? walkForwardResolution.config.holdoutDays * 2) +
              walkForwardResolution.config.holdoutDays
          };
        }
      } else {
        crossChecks = [{
          mode: "walk-forward",
          status: "failed",
          failureMessage:
            walkForwardResolution.invalidReason ??
            "No valid walk-forward window could be constructed from the available candle span.",
          netReturn: 0,
          maxDrawdown: 0,
          tradeCount: 0
        }];
        crossCheckWindows = {
          trainingDays: walkForwardResolution.config.trainingDays,
          stepDays: walkForwardResolution.config.stepDays,
          requiredDays:
            (walkForwardResolution.config.trainingDays ?? walkForwardResolution.config.holdoutDays * 2) +
            walkForwardResolution.config.holdoutDays
        };
      }
    }

    return buildHoldoutEvaluation({
      config: params.config,
      candidate: params.candidate,
      availableSpan,
      trainRange,
      testRange,
      trainResult,
      testResult,
      crossChecks,
      crossCheckWindows
    });
  }

  return buildPortfolioWalkForwardEvaluation({
    config: params.config,
    candidate: params.candidate,
    candleData,
    availableSpan
  });
}
