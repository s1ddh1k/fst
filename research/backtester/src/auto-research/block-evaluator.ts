import type { StrategyTimeframe } from "../../../../packages/shared/src/index.js";
import { loadCandlesForMarkets } from "../db.js";
import {
  normalizeToFullGrid,
  runMultiStrategyBacktest
} from "../multi-strategy/index.js";
import type { Candle } from "../types.js";
import { buildWalkForwardRanges, splitTrainTestByDays } from "../validation.js";
// calculateAutoResearchMinimumLimit moved to candle-loader.ts
import { getBlockFamilyById } from "./block-families.js";
import {
  withRegimeGate
} from "../multi-strategy/index.js";
import type { Strategy, StrategySleeveConfig } from "../../../../packages/shared/src/index.js";
import type { RegimeGateConfig } from "../multi-strategy/RegimeGatedStrategy.js";
import type {
  AutoResearchRunConfig,
  CandidateBacktestEvaluation,
  NormalizedCandidateProposal,
  WindowPerformanceRecord
} from "./types.js";
import { buildMarketStateContexts } from "../../../strategies/src/market-state.js";
import { summarizeReferenceCandleSpan } from "./walk-forward-config.js";

type CandleMap = Record<string, Candle[]>;
type CandleLoader = typeof loadCandlesForMarkets;

function universeSizeSummary(result: ReturnType<typeof runMultiStrategyBacktest>): {
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function finiteOrDefault(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function roundInt(value: number, min: number, max: number): number {
  return Math.round(clamp(value, min, max));
}

function isBbMeanReversionFamily(familyId: string): boolean {
  if (familyId.startsWith("block:simple-")) return false;
  return familyId.includes("bb-reversion") || familyId.includes("bb-rsi-confirmed-reversion");
}


function isBbHourlyLikeFamily(familyId: string): boolean {
  if (familyId.startsWith("block:simple-")) return false;
  return familyId.includes("hourly");
}

function isBbDailyLikeFamily(familyId: string): boolean {
  if (familyId.startsWith("block:simple-")) return false;
  return familyId.includes("daily");
}

function resolveBbPortfolioControls(familyId: string, params: Record<string, number>): {
  cooldownBarsAfterLoss: number;
  minBarsBetweenEntries: number;
} {
  if (isBbHourlyLikeFamily(familyId)) {
    return {
      cooldownBarsAfterLoss: roundInt(finiteOrDefault(params.cooldownBarsAfterLoss, 8), 2, 24),
      minBarsBetweenEntries: roundInt(finiteOrDefault(params.minBarsBetweenEntries, 4), 1, 16)
    };
  }

  if (isBbDailyLikeFamily(familyId)) {
    return {
      cooldownBarsAfterLoss: roundInt(finiteOrDefault(params.cooldownBarsAfterLoss, 16), 4, 72),
      minBarsBetweenEntries: roundInt(finiteOrDefault(params.minBarsBetweenEntries, 8), 2, 48)
    };
  }

  return {
    cooldownBarsAfterLoss: roundInt(finiteOrDefault(params.cooldownBarsAfterLoss, 36), 8, 168),
    minBarsBetweenEntries: roundInt(finiteOrDefault(params.minBarsBetweenEntries, 16), 4, 96)
  };
}

function buildBlockGateConfig(familyId: string, params: Record<string, number>): RegimeGateConfig {
  const gate: RegimeGateConfig = {};

  // Simple strategies have no regime gate — they trade in all conditions
  if (familyId.startsWith("block:simple-")) {
    gate.allowedRegimes = ["trend_up", "trend_down", "range", "volatile"];
    gate.allowUnknownRegime = true;
    return gate;
  }

  if (isBbMeanReversionFamily(familyId)) {
    // BB mean reversion works in ALL regimes — oversold happens everywhere
    gate.allowedRegimes = ["trend_up", "trend_down", "range", "volatile"];
    gate.allowUnknownRegime = true;
    return gate;
  }

  // Rotation strategies handle regime gating internally via minAboveTrendRatio
  // and minCompositeTrend. Adding an external regime gate creates double-gating
  // that's too restrictive, especially with adaptive regime where composite regime
  // is more discriminating. Allow all regimes and let the strategy decide.
  if (familyId.includes("rotation")) {
    gate.allowedRegimes = ["trend_up", "trend_down", "range", "volatile"];
    gate.allowUnknownRegime = true;
    return gate;
  }

  if (familyId.includes("rangedown") || familyId.includes("reversion")) {
    gate.allowedRegimes = ["range", "trend_down", "volatile"];
    gate.maxRiskOnScore = clamp(finiteOrDefault(params.gateMaxRiskOnScore, 0.2), -0.2, 0.35);
    gate.maxCompositeTrendScore = clamp(finiteOrDefault(params.gateMaxTrendScore, 0.15), -0.2, 0.3);
    gate.maxHistoricalVolatility = clamp(finiteOrDefault(params.gateMaxVolatility, 0.06), 0.015, 0.08);
  } else if (familyId.includes("upvol") || familyId.includes("micro")) {
    gate.allowedRegimes = ["trend_up", "volatile"];
    gate.minRiskOnScore = clamp(finiteOrDefault(params.gateMinRiskOnScore, 0.02), -0.05, 0.2);
    gate.minLiquidityScore = clamp(finiteOrDefault(params.gateMinLiquidityScore, 0.04), 0.01, 0.25);
    gate.minHistoricalVolatility = clamp(finiteOrDefault(params.gateMinVolatility, 0.008), 0.003, 0.04);
  } else {
    gate.allowedRegimes = ["trend_up"];
    gate.minRiskOnScore = clamp(finiteOrDefault(params.gateMinRiskOnScore, 0.04), -0.08, 0.25);
    gate.minCompositeTrendScore = clamp(finiteOrDefault(params.gateMinTrendScore, 0.02), -0.05, 0.2);
    gate.minAboveTrendRatio = clamp(finiteOrDefault(params.gateMinAboveTrendRatio, 0.58), 0.45, 0.8);
    gate.minLiquidityScore = clamp(finiteOrDefault(params.gateMinLiquidityScore, 0.04), 0.01, 0.25);
  }

  return gate;
}

async function createBlockStrategy(familyId: string, candidateId: string, params: Record<string, number>): Promise<Strategy> {
  const familyDef = getBlockFamilyById(familyId);
  if (familyDef.createStrategy) {
    return familyDef.createStrategy(candidateId, params);
  }

  // Dynamic fallback: try loading LLM-generated strategy
  try {
    const { loadDynamicStrategy } = await import("./dynamic-loader.js");
    const dynamicModule = await loadDynamicStrategy(familyId);
    if (dynamicModule) {
      return dynamicModule.createStrategy({
        strategyId: candidateId,
        parameters: params
      });
    }
  } catch {
    // dynamic loading failed, fall through to error
  }

  throw new Error(`Cannot create block strategy for family: ${familyId}`);
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
          const sorted = bucketCandles.slice().sort((a, b) => a.candleTimeUtc.getTime() - b.candleTimeUtc.getTime());
          const first = sorted[0]!;
          const last = sorted[sorted.length - 1]!;
          return {
            marketCode,
            timeframe: "15m",
            candleTimeUtc: new Date(Math.floor(first.candleTimeUtc.getTime() / (15 * 60_000)) * (15 * 60_000)),
            openPrice: first.openPrice,
            highPrice: Math.max(...sorted.map((c) => c.highPrice)),
            lowPrice: Math.min(...sorted.map((c) => c.lowPrice)),
            closePrice: last.closePrice,
            volume: sorted.reduce((sum, c) => sum + c.volume, 0),
            quoteVolume: sorted.reduce((sum, c) => sum + (c.quoteVolume ?? c.closePrice * c.volume), 0),
            isSynthetic: sorted.every((c) => c.isSynthetic ?? false)
          } satisfies Candle;
        });

      return [marketCode, aggregated];
    })
  );
}

function chooseReferenceCandles(candlesByMarket: CandleMap, _timeframe: StrategyTimeframe): Candle[] {
  // Use the longest market's candles as reference timeline.
  // Previously used normalizeToFullGrid which clips to the SHORTEST market's range,
  // causing walk-forward windows to miss earlier periods when short-data markets are in the universe.
  const bestMarket = Object.entries(candlesByMarket)
    .filter(([, c]) => c.length > 0)
    .sort(([, a], [, b]) => b.length - a.length)[0];
  if (!bestMarket) return [];
  return bestMarket[1].slice().sort((a, b) => a.candleTimeUtc.getTime() - b.candleTimeUtc.getTime());
}

function filterCandlesByRange(candlesByMarket: CandleMap, range: { start: Date; end: Date }): CandleMap {
  return Object.fromEntries(
    Object.entries(candlesByMarket).map(([marketCode, candles]) => [
      marketCode,
      candles.filter((c) => c.candleTimeUtc >= range.start && c.candleTimeUtc <= range.end)
    ])
  );
}

/**
 * Compute average buy-and-hold return across all markets for a given range.
 * For each market: (lastClose - firstOpen) / firstOpen, then average.
 */
function computeBuyAndHoldReturn(candlesByMarket: CandleMap, range: { start: Date; end: Date }): number {
  const returns: number[] = [];
  for (const candles of Object.values(candlesByMarket)) {
    const inRange = candles.filter((c) => c.candleTimeUtc >= range.start && c.candleTimeUtc <= range.end);
    if (inRange.length < 2) continue;
    const sorted = inRange.slice().sort((a, b) => a.candleTimeUtc.getTime() - b.candleTimeUtc.getTime());
    const firstOpen = sorted[0].openPrice;
    const lastClose = sorted[sorted.length - 1].closePrice;
    if (firstOpen > 0) {
      returns.push((lastClose - firstOpen) / firstOpen);
    }
  }
  return returns.length === 0 ? 0 : returns.reduce((s, v) => s + v, 0) / returns.length;
}

export async function evaluateBlockCandidate(params: {
  config: AutoResearchRunConfig;
  candidate: NormalizedCandidateProposal;
  marketCodes: string[];
  loadCandles?: CandleLoader;
}): Promise<CandidateBacktestEvaluation> {
  const { config, candidate, marketCodes } = params;
  const familyDef = getBlockFamilyById(candidate.familyId);
  const requiredTimeframes = (familyDef.requiredData ?? [familyDef.timeframe]) as StrategyTimeframe[];
  const loadCandles = params.loadCandles ?? loadCandlesForMarkets;

  // Load candles: use the provided loader (orchestrator cache) when available,
  // fall back to centralized candle-loader for standalone usage
  const loadedCandles: Partial<Record<StrategyTimeframe, Record<string, Candle[]>>> = {};
  if (params.loadCandles) {
    // Orchestrator already loaded candles with correct range — use its cache
    for (const tf of requiredTimeframes) {
      loadedCandles[tf] = await params.loadCandles({ marketCodes, timeframe: tf });
    }
  } else {
    // Standalone: use centralized candle-loader
    const { loadCandlesForTimeframes: loadTimeframeCandles } = await import("./candle-loader.js");
    const loaded = await loadTimeframeCandles({ timeframes: requiredTimeframes, marketCodes, config });
    for (const tf of requiredTimeframes) {
      loadedCandles[tf] = loaded[tf] ?? {};
    }
  }
  const candles1h = loadedCandles["1h"] ?? {};
  const candles15m = loadedCandles["15m"] ?? {};
  const candles5m = loadedCandles["5m"] ?? {};
  const candles1m = loadedCandles["1m"] ?? {};


  const referenceTimeframe = familyDef.timeframe as StrategyTimeframe;
  const referenceCandleMap = referenceTimeframe === "1h"
    ? (candles1h as CandleMap)
    : referenceTimeframe === "15m"
      ? candles15m
      : referenceTimeframe === "5m"
        ? (candles5m as CandleMap)
        : (candles1m as CandleMap);

  // Clip reference candles to the available execution data range.
  // Without this, 1h reference candles spanning 1685 days create WF windows
  // in periods where 5m execution data doesn't exist, causing 100% no_execution_window blocks.
  const executionTimeframe = (familyDef.requiredData ?? [familyDef.timeframe]).includes("5m") ? "5m"
    : (familyDef.requiredData ?? [familyDef.timeframe]).includes("1m") ? "1m" : null;
  const executionCandleMap = executionTimeframe === "5m" ? (candles5m as CandleMap)
    : executionTimeframe === "1m" ? (candles1m as CandleMap) : null;
  let clippedReferenceCandleMap = referenceCandleMap;
  if (executionCandleMap && referenceTimeframe !== executionTimeframe) {
    let execStart: Date | undefined;
    let execEnd: Date | undefined;

    for (const candles of Object.values(executionCandleMap)) {
      for (const candle of candles) {
        if (!execStart || candle.candleTimeUtc < execStart) {
          execStart = candle.candleTimeUtc;
        }
        if (!execEnd || candle.candleTimeUtc > execEnd) {
          execEnd = candle.candleTimeUtc;
        }
      }
    }

    if (execStart && execEnd) {
      clippedReferenceCandleMap = Object.fromEntries(
        Object.entries(referenceCandleMap).map(([market, candles]) => [
          market,
          (candles as Candle[]).filter((c) => c.candleTimeUtc >= execStart && c.candleTimeUtc <= execEnd)
        ])
      ) as CandleMap;
    }
  }

  const referenceCandles = chooseReferenceCandles(clippedReferenceCandleMap, referenceTimeframe);

  if (referenceCandles.length === 0) {
    throw new Error(`No reference candles for block evaluation (${familyDef.timeframe})`);
  }

  const availableSpan = summarizeReferenceCandleSpan(referenceCandles);
  const baseStrategy = await createBlockStrategy(candidate.familyId, candidate.candidateId, candidate.parameters);
  const gateConfig = buildBlockGateConfig(candidate.familyId, candidate.parameters);
  const strategy = withRegimeGate({ strategy: baseStrategy, gate: gateConfig });
  const bbPortfolioControls = isBbMeanReversionFamily(candidate.familyId)
    ? resolveBbPortfolioControls(candidate.familyId, candidate.parameters)
    : null;

  // Sleeve resolution: from family definition (single source of truth)
  const sleeveId: "trend" | "breakout" | "micro" = familyDef.sleeveId ?? "micro";

  const sleeves: StrategySleeveConfig[] = [{
    sleeveId,
    capitalBudgetPct: 0.95,
    maxOpenPositions: 8,
    maxSinglePositionPct: 0.3,
    priority: 10
  }];

  const decisionCandles: Partial<Record<StrategyTimeframe, CandleMap>> = {
    "1h": candles1h as CandleMap,
    "15m": candles15m,
    "5m": candles5m as CandleMap,
    "1m": candles1m as CandleMap
  };
  const executionCandles: Partial<Record<StrategyTimeframe, CandleMap>> = {
    "1h": candles1h as CandleMap,
    "15m": candles15m,
    "5m": candles5m as CandleMap,
    "1m": candles1m as CandleMap
  };

  // Use adaptive regime for rotation strategies — crypto-optimized regime detection
  // that doesn't suppress valid signals with the volatile override
  const useAdaptiveRegime = candidate.familyId.includes("rotation");

  const runBacktest = (range: { start: Date; end: Date }) =>
    runMultiStrategyBacktest({
      universeName: config.universeName,
      initialCapital: 1_000_000,
      sleeves,
      strategies: [strategy],
      decisionCandles: Object.fromEntries(
        Object.entries(decisionCandles).map(([tf, cm]) => [tf, filterCandlesByRange(cm ?? {}, range)])
      ),
      executionCandles: Object.fromEntries(
        Object.entries(executionCandles).map(([tf, cm]) => [tf, filterCandlesByRange(cm ?? {}, range)])
      ),
      ...(useAdaptiveRegime ? { marketStateConfig: { useAdaptiveRegime: true } } : {}),
      universeConfig: {
        topN: Math.min(config.marketLimit, marketCodes.length),
        lookbackBars: 28,
        refreshEveryBars: 4
      },
      captureTraceArtifacts: false,
      captureUniverseSnapshots: false,
      maxOpenPositions: 8,
      maxCapitalUsagePct: 0.95,
      cooldownBarsAfterLoss: bbPortfolioControls?.cooldownBarsAfterLoss ?? 0,
      minBarsBetweenEntries: bbPortfolioControls?.minBarsBetweenEntries ?? 0
    });

  if (config.mode === "holdout") {
    const split = splitTrainTestByDays(referenceCandles, config.holdoutDays);
    const trainRange = split.trainRange;
    const testRange = (config.testStartDate && config.testEndDate)
      ? { start: config.testStartDate, end: config.testEndDate }
      : split.testRange;
    const testResult = runBacktest(testRange);
    const testUniverse = universeSizeSummary(testResult);
    const signalCount = testResult.metrics.signalCount;
    const ghostSignalCount = Object.values(testResult.ghostSummary).reduce((sum, item) => sum + item.count, 0);
    const decisionCoverage = testResult.decisionCoverageSummary;
    const buyAndHoldReturn = computeBuyAndHoldReturn(referenceCandleMap, testRange);

    return {
      candidate,
      mode: "holdout",
      status: "completed",
      summary: {
        totalReturn: testResult.metrics.netReturn,
        grossReturn: testResult.metrics.grossReturn,
        netReturn: testResult.metrics.netReturn,
        maxDrawdown: testResult.metrics.maxDrawdown,
        turnover: testResult.metrics.turnover,
        winRate: testResult.metrics.winRate,
        avgHoldBars: testResult.metrics.avgHoldBars,
        tradeCount: testResult.completedTrades.length,
        feePaid: testResult.metrics.feePaid,
        slippagePaid: testResult.metrics.slippagePaid,
        rejectedOrdersCount: testResult.metrics.rejectedOrdersCount,
        cooldownSkipsCount: testResult.metrics.cooldownSkipsCount,
        signalCount,
        ghostSignalCount,
        buyAndHoldReturn
      },
      diagnostics: {
        coverage: {
          tradeCount: testResult.completedTrades.length,
          signalCount,
          ghostSignalCount,
          rejectedOrdersCount: testResult.metrics.rejectedOrdersCount,
          cooldownSkipsCount: testResult.metrics.cooldownSkipsCount,
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
          strategy: Object.fromEntries(
            Object.entries(testResult.funnel).flatMap(([sid, stages]) =>
              Object.entries(stages).map(([stage, count]) => [`${sid}:${stage}`, count])
            )
          ),
          strategyTags: {},
          coordinator: { blocked_signals: testResult.metrics.blockedSignalCount },
          execution: { rejected_orders: testResult.metrics.rejectedOrdersCount },
          risk: {}
        },
        costs: {
          feePaid: testResult.metrics.feePaid,
          slippagePaid: testResult.metrics.slippagePaid,
          totalCostsPaid: testResult.metrics.feePaid + testResult.metrics.slippagePaid
        },
        robustness: {},
        crossChecks: [],
        windows: {
          mode: "holdout",
          holdoutDays: config.holdoutDays,
          trainStartAt: trainRange.start.toISOString(),
          trainEndAt: trainRange.end.toISOString(),
          testStartAt: testRange.start.toISOString(),
          testEndAt: testRange.end.toISOString(),
          availableStartAt: availableSpan.startAt?.toISOString(),
          availableEndAt: availableSpan.endAt?.toISOString(),
          availableDays: availableSpan.availableDays
        }
      }
    };
  }

  // walk-forward with early exit for 0-trade candidates
  const trainingDays = config.trainingDays ?? config.holdoutDays * 2;
  const stepDays = config.stepDays ?? config.holdoutDays;
  let windows = buildWalkForwardRanges({ candles: referenceCandles, trainingDays, holdoutDays: config.holdoutDays, stepDays });
  if (config.testStartDate && config.testEndDate) {
    // Keep windows whose test range overlaps with the specified period
    windows = windows.filter((w) =>
      w.testRange.start < config.testEndDate! && w.testRange.end > config.testStartDate!
    );
  }

  if (windows.length === 0) {
    throw new Error("No valid block walk-forward windows.");
  }

  // Progressive early exit: bail on hopeless candidates to save compute
  const EARLY_EXIT_WINDOW_COUNT = Math.min(4, windows.length);
  const results: Array<{ trainRange: { start: Date; end: Date }; testRange: { start: Date; end: Date }; test: ReturnType<typeof runBacktest> }> = [];
  let earlyExitZeroTrade = false;

  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    results.push({
      trainRange: w.trainRange,
      testRange: w.testRange,
      test: runBacktest(w.testRange)
    });

    // Check after first EARLY_EXIT_WINDOW_COUNT windows
    if (i + 1 === EARLY_EXIT_WINDOW_COUNT) {
      const totalTrades = results.reduce((s, r) => s + r.test.completedTrades.length, 0);
      const allNegative = results.every((r) => r.test.metrics.netReturn < 0);
      const avgReturn = results.reduce((s, r) => s + r.test.metrics.netReturn, 0) / results.length;

      // Exit 1: zero or near-zero trades — entry conditions are too restrictive
      if (totalTrades < 3) {
        earlyExitZeroTrade = true;
        break;
      }

      // Exit 2: all windows losing AND average return below -3% — consistently bad
      if (allNegative && avgReturn < -0.03) {
        earlyExitZeroTrade = true;
        break;
      }

      // Exit 3: losing to buy-and-hold in every window with meaningful margin
      const windowBhReturns = results.map((r) => computeBuyAndHoldReturn(referenceCandleMap, r.testRange));
      const allBelowBH = results.every((r, idx) =>
        r.test.metrics.netReturn < windowBhReturns[idx] - 0.01
      );
      if (allBelowBH && avgReturn < 0) {
        earlyExitZeroTrade = true;
        break;
      }
    }
  }

  const testReturns = results.map((r) => r.test.metrics.netReturn);
  const testDrawdowns = results.map((r) => r.test.metrics.maxDrawdown);
  const positiveWindowCount = testReturns.filter((v) => v > 0).length;
  const totalClosedTrades = results.reduce((s, r) => s + r.test.completedTrades.length, 0);
  const windowBuyAndHoldReturns = results.map((r) => computeBuyAndHoldReturn(referenceCandleMap, r.testRange));
  const avgBuyAndHoldReturn = windowBuyAndHoldReturns.length === 0
    ? 0
    : windowBuyAndHoldReturns.reduce((s, v) => s + v, 0) / windowBuyAndHoldReturns.length;

  // Per-window regime-tagged performance records (composite regime: weekly 50% + daily 35% + intraday 15%)
  // Use the best available candle map for regime sampling: prefer 1h, fall back to 15m, then 5m
  const sampleCandleMap: CandleMap = Object.keys(candles1h as CandleMap).length > 0
    ? (candles1h as CandleMap)
    : Object.keys(candles15m).length > 0
      ? (candles15m as CandleMap)
      : (candles5m as CandleMap);
  const sampleBarsPer24h = Object.keys(candles1h as CandleMap).length > 0
    ? 24    // 1h: 24 bars/day
    : Object.keys(candles15m).length > 0
      ? 96  // 15m: 96 bars/day
      : 288; // 5m: 288 bars/day
  const sampleMarket = Object.keys(sampleCandleMap).sort(
    (a, b) => (sampleCandleMap[b]?.length ?? 0) - (sampleCandleMap[a]?.length ?? 0)
  )[0];
  const windowDetails: WindowPerformanceRecord[] = results.map((r, i) => {
    const startMs = r.testRange.start.getTime();
    const endMs = r.testRange.end.getTime();
    // Sample composite regime every 24h within the window
    const counts: Record<string, number> = {};
    let total = 0;
    if (sampleMarket) {
      const windowCandles = (sampleCandleMap[sampleMarket] ?? []).filter(
        (c) => c.candleTimeUtc.getTime() >= startMs && c.candleTimeUtc.getTime() <= endMs
      );
      const sampleInterval = sampleBarsPer24h; // sample once per day regardless of timeframe
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
      netReturn: r.test.metrics.netReturn,
      maxDrawdown: r.test.metrics.maxDrawdown,
      tradeCount: r.test.completedTrades.length,
      winRate: r.test.metrics.winRate,
      buyAndHoldReturn: windowBuyAndHoldReturns[i],
      dominantRegime,
      regimeDistribution
    };
  });

  const signalCount = results.reduce((s, r) => s + r.test.metrics.signalCount, 0);
  const ghostSignalCount = results.reduce(
    (s, r) => s + Object.values(r.test.ghostSummary).reduce((gs, item) => gs + item.count, 0),
    0
  );
  const feePaid = results.reduce((s, r) => s + r.test.metrics.feePaid, 0);
  const slippagePaid = results.reduce((s, r) => s + r.test.metrics.slippagePaid, 0);
  const universeStats = results.map((r) => universeSizeSummary(r.test));
  const totalUniverseObservations = universeStats.reduce(
    (sum, window) => sum + ("observationCount" in window ? window.observationCount : 0),
    0
  );
  const avgUniverseSize = totalUniverseObservations === 0
    ? 0
    : universeStats.reduce(
      (sum, window) =>
        sum + (window.avg * ("observationCount" in window ? window.observationCount : 0)),
      0
    ) / totalUniverseObservations;
  let minUniverseSize = Number.POSITIVE_INFINITY;
  let maxUniverseSize = 0;

  for (const window of universeStats) {
    const observationCount = "observationCount" in window ? window.observationCount : 0;
    if (observationCount === 0) {
      continue;
    }

    minUniverseSize = Math.min(minUniverseSize, window.min);
    maxUniverseSize = Math.max(maxUniverseSize, window.max);
  }
  const totalDecisionObservations = results.reduce(
    (sum, window) => sum + window.test.decisionCoverageSummary.observationCount,
    0
  );
  const rawBuySignals = results.reduce(
    (sum, window) => sum + window.test.decisionCoverageSummary.rawBuySignals,
    0
  );
  const rawSellSignals = results.reduce(
    (sum, window) => sum + window.test.decisionCoverageSummary.rawSellSignals,
    0
  );
  const rawHoldSignals = results.reduce(
    (sum, window) => sum + window.test.decisionCoverageSummary.rawHoldSignals,
    0
  );
  const avgConsideredBuys = totalDecisionObservations === 0
    ? 0
    : results.reduce(
      (sum, window) =>
        sum +
        (window.test.decisionCoverageSummary.avgConsideredBuys *
          window.test.decisionCoverageSummary.observationCount),
      0
    ) / totalDecisionObservations;
  const avgEligibleBuys = totalDecisionObservations === 0
    ? 0
    : results.reduce(
      (sum, window) =>
        sum +
        (window.test.decisionCoverageSummary.avgEligibleBuys *
          window.test.decisionCoverageSummary.observationCount),
      0
    ) / totalDecisionObservations;

  return {
    candidate,
    mode: "walk-forward",
    status: "completed",
    summary: {
      totalReturn: testReturns.reduce((s, v) => s + v, 0) / results.length,
      grossReturn: results.reduce((s, r) => s + r.test.metrics.grossReturn, 0) / results.length,
      netReturn: testReturns.reduce((s, v) => s + v, 0) / results.length,
      maxDrawdown: results.reduce((s, r) => s + r.test.metrics.maxDrawdown, 0) / results.length,
      turnover: results.reduce((s, r) => s + r.test.metrics.turnover, 0) / results.length,
      winRate: results.reduce((s, r) => s + r.test.metrics.winRate, 0) / results.length,
      avgHoldBars: results.reduce((s, r) => s + r.test.metrics.avgHoldBars, 0) / results.length,
      tradeCount: totalClosedTrades / results.length,
      feePaid,
      slippagePaid,
      rejectedOrdersCount: results.reduce((s, r) => s + r.test.metrics.rejectedOrdersCount, 0),
      cooldownSkipsCount: results.reduce((s, r) => s + r.test.metrics.cooldownSkipsCount, 0),
      signalCount,
      ghostSignalCount,
      buyAndHoldReturn: avgBuyAndHoldReturn
    },
    diagnostics: {
      coverage: {
        tradeCount: totalClosedTrades,
        signalCount,
        ghostSignalCount,
        rejectedOrdersCount: results.reduce((s, r) => s + r.test.metrics.rejectedOrdersCount, 0),
        cooldownSkipsCount: results.reduce((s, r) => s + r.test.metrics.cooldownSkipsCount, 0),
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
        strategy: results.reduce((acc, r) => {
          for (const [sid, stages] of Object.entries(r.test.funnel)) {
            for (const [stage, count] of Object.entries(stages)) {
              const key = `${sid}:${stage}`;
              acc[key] = (acc[key] ?? 0) + count;
            }
          }
          return acc;
        }, {} as Record<string, number>),
        strategyTags: {},
        coordinator: { blocked_signals: results.reduce((s, r) => s + r.test.metrics.blockedSignalCount, 0) },
        execution: { rejected_orders: results.reduce((s, r) => s + r.test.metrics.rejectedOrdersCount, 0) },
        risk: {}
      },
      costs: { feePaid, slippagePaid, totalCostsPaid: feePaid + slippagePaid },
      robustness: {},
      crossChecks: [],
      windows: {
        mode: "walk-forward",
        holdoutDays: config.holdoutDays,
        trainingDays,
        stepDays,
        windowCount: results.length,
        availableStartAt: availableSpan.startAt?.toISOString(),
        availableEndAt: availableSpan.endAt?.toISOString(),
        availableDays: availableSpan.availableDays,
        requiredDays: trainingDays + config.holdoutDays,
        positiveWindowCount,
        positiveWindowRatio: positiveWindowCount / results.length,
        negativeWindowCount: testReturns.filter((v) => v < 0).length,
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
