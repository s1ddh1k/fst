import type { StrategyTimeframe, UniverseSnapshot } from "../../../../packages/shared/src/index.js";
import { loadCandlesForMarkets } from "../db.js";
import {
  buildUniverseSnapshots,
  normalizeToFullGrid,
  runMultiStrategyBacktest,
  type FullGridCandleSet,
  type MultiStrategyBacktestResult
} from "../multi-strategy/index.js";
import type { Candle } from "../types.js";
import { buildWalkForwardRanges, splitTrainTestByDays } from "../validation.js";
import { calculateAutoResearchMinimumLimit } from "./limit-resolution.js";
import { buildPortfolioCandidateRuntime } from "./portfolio-runtime.js";
import type { AutoResearchRunConfig, CandidateBacktestEvaluation, NormalizedCandidateProposal, ValidatedBlockCatalog, WindowPerformanceRecord } from "./types.js";
import { buildMarketStateContexts } from "../../../strategies/src/market-state.js";
import { repairWalkForwardConfig, summarizeReferenceCandleSpan } from "./walk-forward-config.js";

type CandleMap = Record<string, Candle[]>;
type PortfolioCandleLoader = typeof loadCandlesForMarkets;
type PortfolioRuntime = ReturnType<typeof buildPortfolioCandidateRuntime>;

type PortfolioCandleData = {
  decisionCandles: Partial<Record<StrategyTimeframe, CandleMap>>;
  executionCandles: Partial<Record<StrategyTimeframe, CandleMap>>;
  normalizedDecisionSets: Partial<Record<StrategyTimeframe, FullGridCandleSet>>;
  normalizedExecutionSets: Partial<Record<StrategyTimeframe, FullGridCandleSet>>;
  referenceCandles: Candle[];
};

type PortfolioWindowEvaluation = {
  result: MultiStrategyBacktestResult;
  summary: MultiStrategyBacktestResult["metrics"];
  completedTrades: MultiStrategyBacktestResult["completedTrades"];
  decisionCoverage: MultiStrategyBacktestResult["decisionCoverageSummary"];
  universeCoverage: MultiStrategyBacktestResult["universeCoverageSummary"];
  ghostSignalCount: number;
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

function chooseReferenceCandles(candleSet: FullGridCandleSet | undefined): Candle[] {
  if (!candleSet) {
    return [];
  }

  const bestMarket = Object.entries(candleSet.candlesByMarket)
    .sort(([leftMarket, leftCandles], [rightMarket, rightCandles]) => {
      if (rightCandles.length !== leftCandles.length) {
        return rightCandles.length - leftCandles.length;
      }

      return leftMarket.localeCompare(rightMarket);
    })[0]?.[0];

  return bestMarket ? candleSet.candlesByMarket[bestMarket] ?? [] : [];
}

function normalizeCandleSets(
  candlesByTimeframe: Partial<Record<StrategyTimeframe, CandleMap>>
): Partial<Record<StrategyTimeframe, FullGridCandleSet>> {
  return Object.fromEntries(
    Object.entries(candlesByTimeframe)
      .filter(([, candlesByMarket]) => Object.keys(candlesByMarket ?? {}).length > 0)
      .map(([timeframe, candlesByMarket]) => [
        timeframe,
        normalizeToFullGrid({
          timeframe: timeframe as StrategyTimeframe,
          candlesByMarket: candlesByMarket ?? {}
        })
      ])
  ) as Partial<Record<StrategyTimeframe, FullGridCandleSet>>;
}

function buildPortfolioUniverseSnapshots(params: {
  config: AutoResearchRunConfig;
  runtime: PortfolioRuntime;
  normalizedDecisionSets: Partial<Record<StrategyTimeframe, FullGridCandleSet>>;
}): Partial<Record<StrategyTimeframe, Map<string, UniverseSnapshot>>> {
  return Object.fromEntries(
    Object.entries(params.normalizedDecisionSets).map(([timeframe, candleSet]) => [
      timeframe,
      buildUniverseSnapshots({
        candleSet,
        config: {
          topN: Math.min(
            params.runtime.universeTopN,
            params.config.marketLimit,
            Object.keys(candleSet.candlesByMarket).length || params.runtime.universeTopN
          ),
          lookbackBars: params.runtime.universeLookbackBars,
          refreshEveryBars: params.runtime.refreshEveryBars
        }
      })
    ])
  ) as Partial<Record<StrategyTimeframe, Map<string, UniverseSnapshot>>>;
}

function findFirstTimeIndexAtOrAfter(timeline: Date[], targetMs: number): number {
  let left = 0;
  let right = timeline.length - 1;
  let result = -1;

  while (left <= right) {
    const middle = Math.floor((left + right) / 2);
    const currentMs = timeline[middle]?.getTime() ?? Number.POSITIVE_INFINITY;

    if (currentMs >= targetMs) {
      result = middle;
      right = middle - 1;
      continue;
    }

    left = middle + 1;
  }

  return result;
}

function findLastTimeIndexAtOrBefore(timeline: Date[], targetMs: number): number {
  let left = 0;
  let right = timeline.length - 1;
  let result = -1;

  while (left <= right) {
    const middle = Math.floor((left + right) / 2);
    const currentMs = timeline[middle]?.getTime() ?? Number.NEGATIVE_INFINITY;

    if (currentMs <= targetMs) {
      result = middle;
      left = middle + 1;
      continue;
    }

    right = middle - 1;
  }

  return result;
}

function sliceFullGridCandleSetByRange(
  candleSet: FullGridCandleSet,
  range: { start: Date; end: Date }
): FullGridCandleSet {
  const startIndex = findFirstTimeIndexAtOrAfter(candleSet.timeline, range.start.getTime());
  const endIndex = findLastTimeIndexAtOrBefore(candleSet.timeline, range.end.getTime());

  if (
    startIndex === -1 ||
    endIndex === -1 ||
    startIndex > endIndex
  ) {
    return {
      timeframe: candleSet.timeframe,
      timeline: [],
      candlesByMarket: Object.fromEntries(
        Object.keys(candleSet.candlesByMarket).map((marketCode) => [marketCode, []])
      )
    };
  }

  if (startIndex === 0 && endIndex === candleSet.timeline.length - 1) {
    return candleSet;
  }

  return {
    timeframe: candleSet.timeframe,
    timeline: candleSet.timeline.slice(startIndex, endIndex + 1),
    candlesByMarket: Object.fromEntries(
      Object.entries(candleSet.candlesByMarket).map(([marketCode, candles]) => [
        marketCode,
        candles.slice(startIndex, endIndex + 1)
      ])
    )
  };
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
  runtime: PortfolioRuntime;
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
  const decisionCandles = {
    "1h": candles1h as CandleMap,
    "15m": candles15m,
    "5m": candles5m as CandleMap,
    "1m": candles1m as CandleMap
  } satisfies Partial<Record<StrategyTimeframe, CandleMap>>;
  const executionCandles = {
    "5m": candles5m as CandleMap,
    "1m": candles1m as CandleMap
  } satisfies Partial<Record<StrategyTimeframe, CandleMap>>;
  const normalizedDecisionSets = normalizeCandleSets(decisionCandles);
  const normalizedExecutionSets = Object.fromEntries(
    Object.entries(executionCandles)
      .map(([timeframe, candlesByMarket]) => {
        const normalized =
          normalizedDecisionSets[timeframe as StrategyTimeframe] ??
          (Object.keys(candlesByMarket ?? {}).length > 0
            ? normalizeToFullGrid({
                timeframe: timeframe as StrategyTimeframe,
                candlesByMarket: candlesByMarket ?? {}
              })
            : undefined);

        return normalized ? ([timeframe, normalized] as const) : undefined;
      })
      .filter((entry): entry is readonly [string, FullGridCandleSet] => entry !== undefined)
  ) as Partial<Record<StrategyTimeframe, FullGridCandleSet>>;
  const referenceTimeframe = selectReferenceTimeframe(params.requiredTimeframes);
  const referenceCandles = chooseReferenceCandles(normalizedDecisionSets[referenceTimeframe]);

  if (referenceCandles.length === 0) {
    throw new Error("No normalized portfolio reference candles available");
  }

  return {
    decisionCandles,
    executionCandles,
    normalizedDecisionSets,
    normalizedExecutionSets,
    referenceCandles
  };
}

function runPortfolioRangeBacktest(params: {
  config: AutoResearchRunConfig;
  runtime: PortfolioRuntime;
  candleData: PortfolioCandleData;
  simulationRange: { start: Date; end: Date };
  evaluationRange: { start: Date; end: Date };
  candidate: NormalizedCandidateProposal;
  blockCatalog?: ValidatedBlockCatalog;
}): PortfolioWindowEvaluation {
  const slicedSetCache = new Map<FullGridCandleSet, FullGridCandleSet>();
  const getSlicedSet = (candleSet: FullGridCandleSet | undefined): FullGridCandleSet | undefined => {
    if (!candleSet) {
      return undefined;
    }

    const cached = slicedSetCache.get(candleSet);
    if (cached) {
      return cached;
    }

    const sliced = sliceFullGridCandleSetByRange(candleSet, params.simulationRange);
    slicedSetCache.set(candleSet, sliced);
    return sliced;
  };
  const decisionSets = Object.fromEntries(
    Object.entries(params.candleData.normalizedDecisionSets)
      .map(([timeframe, candleSet]) => {
        const sliced = getSlicedSet(candleSet);
        return sliced ? ([timeframe, sliced] as const) : undefined;
      })
      .filter((entry): entry is readonly [string, FullGridCandleSet] => entry !== undefined)
  ) as Partial<Record<StrategyTimeframe, FullGridCandleSet>>;
  const executionSets = Object.fromEntries(
    Array.from(
      new Map([
        ...Object.entries(params.candleData.normalizedExecutionSets),
        ...Object.entries(decisionSets)
      ]).entries()
    )
      .map(([timeframe, candleSet]) => {
        const sliced = getSlicedSet(candleSet);
        return sliced ? ([timeframe, sliced] as const) : undefined;
      })
      .filter((entry): entry is readonly [string, FullGridCandleSet] => entry !== undefined)
  ) as Partial<Record<StrategyTimeframe, FullGridCandleSet>>;
  const referenceMarketCount =
    Object.keys(
      params.candleData.normalizedDecisionSets["1h"]?.candlesByMarket ??
      params.candleData.normalizedDecisionSets["15m"]?.candlesByMarket ??
      params.candleData.normalizedDecisionSets["5m"]?.candlesByMarket ??
      params.candleData.normalizedDecisionSets["1m"]?.candlesByMarket ??
      {}
    ).length || params.runtime.universeTopN;
  const universeSnapshotsByTf = buildPortfolioUniverseSnapshots({
    config: params.config,
    runtime: params.runtime,
    normalizedDecisionSets: decisionSets
  });

  const rawResult = runMultiStrategyBacktest({
    universeName: params.config.universeName,
    initialCapital: 1_000_000,
    sleeves: params.runtime.sleeves,
    strategies: params.runtime.strategies,
    decisionCandles: Object.fromEntries(
      Object.entries(decisionSets).map(([timeframe, candleSet]) => [timeframe, candleSet.candlesByMarket])
    ),
    executionCandles: Object.fromEntries(
      Object.entries(executionSets).map(([timeframe, candleSet]) => [timeframe, candleSet.candlesByMarket])
    ),
    preNormalizedDecisionSets: decisionSets,
    preNormalizedExecutionSets: executionSets,
    precomputedUniverseSnapshotsByTf: universeSnapshotsByTf,
    captureTraceArtifacts: true,
    captureUniverseSnapshots: false,
    universeConfig: {
      topN: Math.min(params.runtime.universeTopN, params.config.marketLimit, referenceMarketCount),
      lookbackBars: params.runtime.universeLookbackBars,
      refreshEveryBars: params.runtime.refreshEveryBars
    },
    maxOpenPositions: params.runtime.maxOpenPositions,
    maxCapitalUsagePct: params.runtime.maxCapitalUsagePct,
    cooldownBarsAfterLoss: params.runtime.cooldownBarsAfterLoss,
    minBarsBetweenEntries: params.runtime.minBarsBetweenEntries
  });

  return evaluatePortfolioWindow({
    result: rawResult,
    evaluationRange: params.evaluationRange,
    universeSnapshotsByTf
  });
}

function toGhostSignalCount(result: MultiStrategyBacktestResult): number {
  return Object.values(result.ghostSummary).reduce((sum, item) => sum + item.count, 0);
}

function universeSizeSummary(result: MultiStrategyBacktestResult): {
  avg: number;
  min: number;
  max: number;
  observationCount: number;
} {
  if (result.universeCoverageSummary.observationCount > 0) {
    return result.universeCoverageSummary;
  }

  let total = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  let observationCount = 0;

  for (const snapshot of result.universeSnapshots) {
    const size = snapshot.markets.length;
    total += size;
    min = Math.min(min, size);
    max = Math.max(max, size);
    observationCount += 1;
  }

  return {
    avg: observationCount === 0 ? 0 : total / observationCount,
    min: Number.isFinite(min) ? min : 0,
    max: observationCount === 0 ? 0 : max,
    observationCount
  };
}

function calculateDrawdown(equityCurve: number[]): number {
  let peak = equityCurve[0] ?? 0;
  let maxDrawdown = 0;

  for (const equity of equityCurve) {
    peak = Math.max(peak, equity);
    const drawdown = peak === 0 ? 0 : (peak - equity) / peak;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
  }

  return maxDrawdown;
}

function sliceEquityWindow(params: {
  equityCurve: number[];
  equityTimeline: Date[];
  evaluationRange: { start: Date; end: Date };
}): number[] {
  const startMs = params.evaluationRange.start.getTime();
  const endMs = params.evaluationRange.end.getTime();
  let startIndex = 0;

  for (let index = 0; index < params.equityTimeline.length; index += 1) {
    const timeMs = params.equityTimeline[index]?.getTime() ?? Number.POSITIVE_INFINITY;
    if (timeMs <= startMs) {
      startIndex = index;
      continue;
    }
    break;
  }

  let endIndex = params.equityTimeline.length - 1;
  for (let index = startIndex; index < params.equityTimeline.length; index += 1) {
    const timeMs = params.equityTimeline[index]?.getTime() ?? Number.NEGATIVE_INFINITY;
    if (timeMs > endMs) {
      endIndex = Math.max(startIndex, index - 1);
      break;
    }
  }

  return params.equityCurve.slice(startIndex, endIndex + 1);
}

function summarizeUniverseCoverageForRange(params: {
  universeSnapshotsByTf: Partial<Record<StrategyTimeframe, Map<string, UniverseSnapshot>>>;
  evaluationRange: { start: Date; end: Date };
}): MultiStrategyBacktestResult["universeCoverageSummary"] {
  const startMs = params.evaluationRange.start.getTime();
  const endMs = params.evaluationRange.end.getTime();
  let total = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  let observationCount = 0;

  for (const snapshotMap of Object.values(params.universeSnapshotsByTf)) {
    if (!snapshotMap) {
      continue;
    }

    for (const snapshot of snapshotMap.values()) {
      const timeMs = snapshot.asOf.getTime();
      if (timeMs < startMs || timeMs > endMs) {
        continue;
      }
      const size = snapshot.markets.length;
      total += size;
      min = Math.min(min, size);
      max = Math.max(max, size);
      observationCount += 1;
    }
  }

  return {
    avg: observationCount === 0 ? 0 : total / observationCount,
    min: Number.isFinite(min) ? min : 0,
    max: observationCount === 0 ? 0 : max,
    observationCount
  };
}

function evaluatePortfolioWindow(params: {
  result: MultiStrategyBacktestResult;
  evaluationRange: { start: Date; end: Date };
  universeSnapshotsByTf: Partial<Record<StrategyTimeframe, Map<string, UniverseSnapshot>>>;
}): PortfolioWindowEvaluation {
  const startMs = params.evaluationRange.start.getTime();
  const endMs = params.evaluationRange.end.getTime();
  const completedTrades = params.result.completedTrades.filter(
    (trade) => trade.exitTime.getTime() >= startMs && trade.exitTime.getTime() <= endMs
  );
  const rawSignals = params.result.rawSignals.filter((signal) => {
    const timeMs = signal.decisionTime.getTime();
    return timeMs >= startMs && timeMs <= endMs;
  });
  const decisions = params.result.decisions.filter((decision) => {
    const timeMs = decision.time.getTime();
    return timeMs >= startMs && timeMs <= endMs;
  });
  const fills = params.result.fills.filter((fill) => {
    const timeMs = fill.fillTime?.getTime();
    return timeMs !== undefined && timeMs >= startMs && timeMs <= endMs;
  });
  const equityCurve = sliceEquityWindow({
    equityCurve: params.result.equityCurve,
    equityTimeline: params.result.equityTimeline,
    evaluationRange: params.evaluationRange
  });
  const startEquity = equityCurve[0] ?? 0;
  const endEquity = equityCurve[equityCurve.length - 1] ?? startEquity;
  const filledNotional = fills.reduce((sum, fill) => sum + (fill.filledNotional ?? 0), 0);
  const feePaid = fills.reduce((sum, fill) => sum + fill.feePaid, 0);
  const slippagePaid = fills.reduce((sum, fill) => sum + fill.slippagePaid, 0);
  const rawBuySignals = rawSignals.filter((signal) => signal.signal === "BUY").length;
  const rawSellSignals = rawSignals.filter((signal) => signal.signal === "SELL").length;
  const rawHoldSignals = rawSignals.filter((signal) => signal.signal === "HOLD").length;
  const blockedSignalCount = decisions.reduce((sum, decision) => sum + decision.blockedSignals.length, 0);
  const cooldownSkipsCount = decisions.reduce(
    (sum, decision) =>
      sum +
      decision.blockedSignals.filter((signal) => /cooldown/i.test(signal.reason)).length,
    0
  );
  const rejectedOrdersCount = fills.filter((fill) => fill.status === "REJECTED").length;
  const winningTrades = completedTrades.filter((trade) => trade.netPnl > 0).length;
  const holdBars = completedTrades.map((trade) => {
    const diffMs = trade.exitTime.getTime() - trade.entryTime.getTime();
    return diffMs / (60 * 60 * 1000);
  });
  const universeCoverage = summarizeUniverseCoverageForRange({
    universeSnapshotsByTf: params.universeSnapshotsByTf,
    evaluationRange: params.evaluationRange
  });

  return {
    result: params.result,
    summary: {
      grossReturn: startEquity === 0 ? 0 : (endEquity + feePaid + slippagePaid - startEquity) / startEquity,
      netReturn: startEquity === 0 ? 0 : (endEquity - startEquity) / startEquity,
      turnover: startEquity === 0 ? 0 : filledNotional / startEquity,
      winRate: completedTrades.length === 0 ? 0 : winningTrades / completedTrades.length,
      avgHoldBars: holdBars.length === 0 ? 0 : holdBars.reduce((sum, value) => sum + value, 0) / holdBars.length,
      maxDrawdown: calculateDrawdown(equityCurve),
      feePaid,
      slippagePaid,
      rejectedOrdersCount,
      cooldownSkipsCount,
      signalCount: rawSignals.length,
      blockedSignalCount,
      openPositionCount: params.result.finalPositions.length
    },
    completedTrades,
    decisionCoverage: {
      observationCount: decisions.length,
      rawBuySignals,
      rawSellSignals,
      rawHoldSignals,
      avgConsideredBuys: decisions.length === 0
        ? 0
        : decisions.reduce((sum, decision) => sum + decision.intents.filter((intent) => intent.side === "BUY").length, 0) /
          decisions.length,
      avgEligibleBuys: decisions.length === 0
        ? 0
        : decisions.reduce(
          (sum, decision) =>
            sum + decision.intents.filter((intent) => intent.side === "BUY").length,
          0
        ) / decisions.length
    },
    universeCoverage,
    ghostSignalCount: rawSignals.filter((signal) => signal.signal === "BUY").length
  };
}

function buildWalkForwardCrossCheck(
  evaluation: CandidateBacktestEvaluation
): CandidateBacktestEvaluation["diagnostics"]["crossChecks"][number] {
  const tradeCount =
    evaluation.diagnostics.windows.totalClosedTrades ?? evaluation.summary.tradeCount;
  const maxDrawdown =
    evaluation.diagnostics.windows.worstWindowMaxDrawdown ?? evaluation.summary.maxDrawdown;

  return {
    mode: "walk-forward",
    status: "completed",
    netReturn: evaluation.summary.netReturn,
    maxDrawdown,
    tradeCount,
    bootstrapSignificant: evaluation.summary.bootstrapSignificant,
    randomPercentile: evaluation.summary.randomPercentile,
    testStartAt: evaluation.diagnostics.windows.testStartAt,
    testEndAt: evaluation.diagnostics.windows.testEndAt,
    windowCount: evaluation.diagnostics.windows.windowCount
  };
}

function shouldSkipPortfolioHoldoutCrossCheck(params: {
  requiredTimeframes: StrategyTimeframe[];
  testResult: PortfolioWindowEvaluation;
}): { skip: boolean; reason?: string } {
  if (!params.requiredTimeframes.includes("1m")) {
    return { skip: false };
  }

  const tradeCount = params.testResult.completedTrades.length;
  const netReturn = params.testResult.summary.netReturn;

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
    bestWindowMaxDrawdown: evaluation.diagnostics.windows.bestWindowMaxDrawdown,
    worstWindowMaxDrawdown: evaluation.diagnostics.windows.worstWindowMaxDrawdown,
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
  testResult: PortfolioWindowEvaluation;
  crossChecks?: CandidateBacktestEvaluation["diagnostics"]["crossChecks"];
  crossCheckWindows?: Partial<CandidateBacktestEvaluation["diagnostics"]["windows"]>;
}): CandidateBacktestEvaluation {
  const testUniverse = params.testResult.universeCoverage;
  const signalCount = params.testResult.summary.signalCount;
  const ghostSignalCount = params.testResult.ghostSignalCount;
  const decisionCoverage = params.testResult.decisionCoverage;

  return {
    candidate: params.candidate,
    mode: "holdout",
    status: "completed",
    summary: {
      totalReturn: params.testResult.summary.netReturn,
      grossReturn: params.testResult.summary.grossReturn,
      netReturn: params.testResult.summary.netReturn,
      maxDrawdown: params.testResult.summary.maxDrawdown,
      turnover: params.testResult.summary.turnover,
      winRate: params.testResult.summary.winRate,
      avgHoldBars: params.testResult.summary.avgHoldBars,
      tradeCount: params.testResult.completedTrades.length,
      feePaid: params.testResult.summary.feePaid,
      slippagePaid: params.testResult.summary.slippagePaid,
      rejectedOrdersCount: params.testResult.summary.rejectedOrdersCount,
      cooldownSkipsCount: params.testResult.summary.cooldownSkipsCount,
      signalCount,
      ghostSignalCount
    },
    diagnostics: {
      coverage: {
        tradeCount: params.testResult.completedTrades.length,
        signalCount,
        ghostSignalCount,
        rejectedOrdersCount: params.testResult.summary.rejectedOrdersCount,
        cooldownSkipsCount: params.testResult.summary.cooldownSkipsCount,
        rawBuySignals: decisionCoverage.rawBuySignals,
        rawSellSignals: decisionCoverage.rawSellSignals,
        rawHoldSignals: decisionCoverage.rawHoldSignals,
        avgUniverseSize: testUniverse.avg,
        minUniverseSize: testUniverse.min,
        maxUniverseSize: testUniverse.max,
        avgConsideredBuys: decisionCoverage.avgConsideredBuys,
        avgEligibleBuys: decisionCoverage.avgEligibleBuys
      },
      reasons: {
        strategy: flattenFunnel(params.testResult.result),
        strategyTags: {},
        coordinator: {
          blocked_signals: params.testResult.summary.blockedSignalCount
        },
        execution: {
          rejected_orders: params.testResult.summary.rejectedOrdersCount
        },
        risk: {}
      },
      costs: {
        feePaid: params.testResult.summary.feePaid,
        slippagePaid: params.testResult.summary.slippagePaid,
        totalCostsPaid: params.testResult.summary.feePaid + params.testResult.summary.slippagePaid
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
        bestWindowMaxDrawdown: params.crossCheckWindows?.bestWindowMaxDrawdown,
        worstWindowMaxDrawdown: params.crossCheckWindows?.worstWindowMaxDrawdown,
        totalClosedTrades: params.crossCheckWindows?.totalClosedTrades,
        windowCount: params.crossCheckWindows?.windowCount
      }
    }
  };
}

function buildPortfolioWalkForwardEvaluation(params: {
  config: AutoResearchRunConfig;
  candidate: NormalizedCandidateProposal;
  runtime: PortfolioRuntime;
  candleData: PortfolioCandleData;
  availableSpan: ReturnType<typeof summarizeReferenceCandleSpan>;
  blockCatalog?: ValidatedBlockCatalog;
}): CandidateBacktestEvaluation {
  const trainingDays = params.config.trainingDays ?? params.config.holdoutDays * 2;
  const stepDays = params.config.stepDays ?? params.config.holdoutDays;
  let windows = buildWalkForwardRanges({
    candles: params.candleData.referenceCandles,
    trainingDays,
    holdoutDays: params.config.holdoutDays,
    stepDays
  });
  if (params.config.testStartDate && params.config.testEndDate) {
    windows = windows.filter((w) =>
      w.testRange.start < params.config.testEndDate! && w.testRange.end > params.config.testStartDate!
    );
  }

  if (windows.length === 0) {
    throw new Error("No valid portfolio walk-forward windows could be constructed.");
  }

  const results = windows.map((window) => ({
    trainRange: window.trainRange,
    testRange: window.testRange,
    test: runPortfolioRangeBacktest({
      config: params.config,
      runtime: params.runtime,
      candleData: params.candleData,
      simulationRange: {
        start: window.trainRange.start,
        end: window.testRange.end
      },
      evaluationRange: window.testRange,
      candidate: params.candidate,
      blockCatalog: params.blockCatalog
    })
  }));

  const testReturns = results.map((window) => window.test.summary.netReturn);
  const testDrawdowns = results.map((window) => window.test.summary.maxDrawdown);
  const positiveWindowCount = testReturns.filter((value) => value > 0).length;
  const negativeWindowCount = testReturns.filter((value) => value < 0).length;
  const totalClosedTrades = results.reduce((sum, window) => sum + window.test.completedTrades.length, 0);
  const signalCount = results.reduce((sum, window) => sum + window.test.summary.signalCount, 0);
  const ghostSignalCount = results.reduce((sum, window) => sum + window.test.ghostSignalCount, 0);
  const rejectedOrdersCount = results.reduce(
    (sum, window) => sum + window.test.summary.rejectedOrdersCount,
    0
  );
  const cooldownSkipsCount = results.reduce(
    (sum, window) => sum + window.test.summary.cooldownSkipsCount,
    0
  );
  const feePaid = results.reduce((sum, window) => sum + window.test.summary.feePaid, 0);
  const slippagePaid = results.reduce((sum, window) => sum + window.test.summary.slippagePaid, 0);
  const totalDecisionObservations = results.reduce(
    (sum, window) => sum + window.test.decisionCoverage.observationCount,
    0
  );
  const universeStats = results.map((window) => window.test.universeCoverage);
  const totalUniverseObservations = universeStats.reduce(
    (sum, window) => sum + window.observationCount,
    0
  );
  const avgUniverseSize = totalUniverseObservations === 0
    ? 0
    : universeStats.reduce(
      (sum, window) => sum + (window.avg * window.observationCount),
      0
    ) / totalUniverseObservations;
  let minUniverseSize = Number.POSITIVE_INFINITY;
  let maxUniverseSize = 0;

  for (const window of universeStats) {
    if (window.observationCount === 0) {
      continue;
    }

    minUniverseSize = Math.min(minUniverseSize, window.min);
    maxUniverseSize = Math.max(maxUniverseSize, window.max);
  }
  const rawBuySignals = results.reduce(
    (sum, window) => sum + window.test.decisionCoverage.rawBuySignals,
    0
  );
  const rawSellSignals = results.reduce(
    (sum, window) => sum + window.test.decisionCoverage.rawSellSignals,
    0
  );
  const rawHoldSignals = results.reduce(
    (sum, window) => sum + window.test.decisionCoverage.rawHoldSignals,
    0
  );
  const avgConsideredBuys = totalDecisionObservations === 0
    ? 0
    : results.reduce(
      (sum, window) =>
        sum +
        (window.test.decisionCoverage.avgConsideredBuys *
          window.test.decisionCoverage.observationCount),
      0
    ) / totalDecisionObservations;
  const avgEligibleBuys = totalDecisionObservations === 0
    ? 0
    : results.reduce(
      (sum, window) =>
        sum +
        (window.test.decisionCoverage.avgEligibleBuys *
          window.test.decisionCoverage.observationCount),
      0
    ) / totalDecisionObservations;

  // Per-window regime-tagged performance records (composite regime: weekly 50% + daily 35% + intraday 15%)
  const sampleCandleMap = (params.candleData.decisionCandles["1h"] ?? {}) as Record<string, Candle[]>;
  const sampleMarket = Object.keys(sampleCandleMap).sort(
    (a, b) => (sampleCandleMap[b]?.length ?? 0) - (sampleCandleMap[a]?.length ?? 0)
  )[0];
  const windowDetails: WindowPerformanceRecord[] = results.map((r) => {
    const startMs = r.testRange.start.getTime();
    const endMs = r.testRange.end.getTime();
    const counts: Record<string, number> = {};
    let total = 0;
    if (sampleMarket) {
      const windowCandles = (sampleCandleMap[sampleMarket] ?? []).filter(
        (c) => c.candleTimeUtc.getTime() >= startMs && c.candleTimeUtc.getTime() <= endMs
      );
      const sampleInterval = 24;
      for (let idx = 0; idx < windowCandles.length; idx += sampleInterval) {
        const ctx = buildMarketStateContexts({
          referenceTime: windowCandles[idx].candleTimeUtc,
          universeCandlesByMarket: sampleCandleMap
        });
        const regime = ctx[sampleMarket]?.composite?.regime ?? "unknown";
        counts[regime] = (counts[regime] ?? 0) + 1;
        total++;
      }
    }
    let dominantRegime = "unknown";
    let maxCount = 0;
    const regimeDistribution: Record<string, number> = {};
    for (const [regime, count] of Object.entries(counts)) {
      const ratio = Math.round((count / Math.max(total, 1)) * 100) / 100;
      if (ratio > 0) regimeDistribution[regime] = ratio;
      if (count > maxCount) { maxCount = count; dominantRegime = regime; }
    }
    return {
      testStartAt: r.testRange.start.toISOString(),
      testEndAt: r.testRange.end.toISOString(),
      netReturn: r.test.summary.netReturn,
      maxDrawdown: r.test.summary.maxDrawdown,
      tradeCount: r.test.completedTrades.length,
      winRate: r.test.summary.winRate,
      buyAndHoldReturn: 0,
      dominantRegime,
      regimeDistribution
    };
  });

  return {
    candidate: params.candidate,
    mode: "walk-forward",
    status: "completed",
    summary: {
      totalReturn: testReturns.reduce((sum, value) => sum + value, 0) / results.length,
      grossReturn:
        results.reduce((sum, window) => sum + window.test.summary.grossReturn, 0) / results.length,
      netReturn: testReturns.reduce((sum, value) => sum + value, 0) / results.length,
      maxDrawdown:
        results.reduce((sum, window) => sum + window.test.summary.maxDrawdown, 0) / results.length,
      turnover: results.reduce((sum, window) => sum + window.test.summary.turnover, 0) / results.length,
      winRate: results.reduce((sum, window) => sum + window.test.summary.winRate, 0) / results.length,
      avgHoldBars:
        results.reduce((sum, window) => sum + window.test.summary.avgHoldBars, 0) / results.length,
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
        rawBuySignals,
        rawSellSignals,
        rawHoldSignals,
        avgUniverseSize,
        minUniverseSize: Number.isFinite(minUniverseSize) ? minUniverseSize : 0,
        maxUniverseSize: Number.isFinite(maxUniverseSize) ? maxUniverseSize : 0,
        avgConsideredBuys,
        avgEligibleBuys
      },
      reasons: {
        strategy: results.reduce(
          (accumulator, window) => mergeReasonMaps(accumulator, flattenFunnel(window.test.result)),
          {} as Record<string, number>
        ),
        strategyTags: {},
        coordinator: {
          blocked_signals: results.reduce(
            (sum, window) => sum + window.test.summary.blockedSignalCount,
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
        bestWindowMaxDrawdown: Math.min(...testDrawdowns),
        worstWindowMaxDrawdown: Math.max(...testDrawdowns),
        totalClosedTrades,
        details: windowDetails
      }
    }
  };
}

export async function evaluatePortfolioCandidate(params: {
  config: AutoResearchRunConfig;
  candidate: NormalizedCandidateProposal;
  marketCodes: string[];
  loadCandles?: PortfolioCandleLoader;
  blockCatalog?: ValidatedBlockCatalog;
}): Promise<CandidateBacktestEvaluation> {
  const runtime = buildPortfolioCandidateRuntime(params.candidate);
  const evaluationMarketCodes = selectPortfolioEvaluationMarkets({
    marketCodes: params.marketCodes,
    requiredTimeframes: runtime.requiredTimeframes,
    marketLimit: params.config.marketLimit
  });
  const candleData = await loadPortfolioCandles({
    config: params.config,
    runtime,
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
    const testResult = runPortfolioRangeBacktest({
      config: params.config,
      runtime,
      candleData,
      simulationRange: {
        start: trainRange.start,
        end: testRange.end
      },
      evaluationRange: testRange,
      candidate: params.candidate,
      blockCatalog: params.blockCatalog
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
            runtime,
            candleData,
            availableSpan,
            blockCatalog: params.blockCatalog
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
      testResult,
      crossChecks,
      crossCheckWindows
    });
  }

  return buildPortfolioWalkForwardEvaluation({
    config: params.config,
    candidate: params.candidate,
    runtime,
    candleData,
    availableSpan,
    blockCatalog: params.blockCatalog
  });
}
