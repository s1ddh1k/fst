import type { StrategyTimeframe } from "../../../../packages/shared/src/index.js";
import { loadCandlesForMarkets } from "../db.js";
import {
  normalizeToFullGrid,
  runMultiStrategyBacktest
} from "../multi-strategy/index.js";
import type { Candle } from "../types.js";
import { buildWalkForwardRanges, splitTrainTestByDays } from "../validation.js";
import { calculateAutoResearchMinimumLimit } from "./limit-resolution.js";
import { getBlockFamilyById } from "./block-families.js";
import {
  createMicroBreakoutStrategy,
  createLeaderPullbackStateMachineMultiStrategy,
  createRelativeBreakoutRotationMultiStrategy,
  createRelativeMomentumPullbackMultiStrategy,
  createResidualReversionMultiStrategy,
  createRelativeStrengthRotationStrategy,
  createBollingerMeanReversionMultiStrategy,
  withRegimeGate
} from "../multi-strategy/index.js";
import type { Strategy, StrategySleeveConfig } from "../../../../packages/shared/src/index.js";
import type { RegimeGateConfig } from "../multi-strategy/RegimeGatedStrategy.js";
import type {
  AutoResearchRunConfig,
  CandidateBacktestEvaluation,
  NormalizedCandidateProposal
} from "./types.js";
import { summarizeReferenceCandleSpan } from "./walk-forward-config.js";

type CandleMap = Record<string, Candle[]>;
type CandleLoader = typeof loadCandlesForMarkets;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function finiteOrDefault(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function roundInt(value: number, min: number, max: number): number {
  return Math.round(clamp(value, min, max));
}

function buildBlockGateConfig(familyId: string, params: Record<string, number>): RegimeGateConfig {
  const gate: RegimeGateConfig = {};

  if (familyId.includes("bb-reversion")) {
    // BB mean reversion works in ALL regimes — oversold happens everywhere
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

function createBlockStrategy(familyId: string, candidateId: string, params: Record<string, number>): Strategy {
  if (familyId.includes("rotation")) {
    return createRelativeStrengthRotationStrategy({
      strategyId: `${candidateId}-rotation`,
      rebalanceBars: roundInt(finiteOrDefault(params.rebalanceBars, 5), 4, 8),
      entryFloor: clamp(finiteOrDefault(params.entryFloor, 0.80), 0.72, 0.92),
      reEntryCooldownBars: 3,
      exitFloor: clamp(finiteOrDefault(params.exitFloor, 0.56), 0.42, 0.72),
      switchGap: clamp(finiteOrDefault(params.switchGap, 0.12), 0.06, 0.18),
      minAboveTrendRatio: clamp(finiteOrDefault(params.minAboveTrendRatio, 0.68), 0.55, 0.86),
      minLiquidityScore: clamp(finiteOrDefault(params.minLiquidityScore, 0.07), 0.02, 0.25),
      minCompositeTrend: clamp(finiteOrDefault(params.minCompositeTrend, 0.02), -0.05, 0.18)
    });
  }

  if (familyId.includes("leader")) {
    return createLeaderPullbackStateMachineMultiStrategy({
      strategyId: `${candidateId}-leader`,
      strengthFloor: clamp(finiteOrDefault(params.strengthFloor, 0.74), 0.55, 0.92),
      pullbackAtr: clamp(finiteOrDefault(params.pullbackAtr, 1), 0.4, 1.6),
      setupExpiryBars: roundInt(finiteOrDefault(params.setupExpiryBars, 5), 2, 10),
      trailAtrMult: clamp(finiteOrDefault(params.trailAtrMult, 2.2), 1.2, 3.4)
    });
  }

  if (familyId.includes("micro")) {
    return createMicroBreakoutStrategy({
      strategyId: `${candidateId}-micro`,
      lookbackBars: roundInt(finiteOrDefault(params.lookbackBars, 10), 5, 18),
      extensionThreshold: clamp(finiteOrDefault(params.extensionThreshold, 0.003), 0.0015, 0.009),
      holdingBarsMax: roundInt(finiteOrDefault(params.holdingBarsMax, 8), 4, 20),
      stopAtrMult: clamp(finiteOrDefault(params.stopAtrMult, 1.05), 0.8, 1.8),
      minVolumeSpike: clamp(finiteOrDefault(params.minVolumeSpike, 0.95), 0.8, 1.5),
      minRiskOnScore: clamp(finiteOrDefault(params.minRiskOnScore, 0.01), -0.02, 0.2),
      minLiquidityScore: clamp(finiteOrDefault(params.minLiquidityScore, 0.03), 0.02, 0.12),
      profitTarget: clamp(finiteOrDefault(params.profitTarget, 0.004), 0.0015, 0.012)
    });
  }

  if (familyId.includes("breakout")) {
    return createRelativeBreakoutRotationMultiStrategy({
      strategyId: `${candidateId}-breakout`,
      breakoutLookback: roundInt(finiteOrDefault(params.breakoutLookback, 20), 12, 36),
      strengthFloor: clamp(finiteOrDefault(params.strengthFloor, 0.8), 0.65, 0.95),
      maxExtensionAtr: clamp(finiteOrDefault(params.maxExtensionAtr, 1.3), 0.8, 2.2),
      trailAtrMult: clamp(finiteOrDefault(params.trailAtrMult, 2.2), 1.2, 3.4)
    });
  }

  if (familyId.includes("bb-reversion") && familyId.includes("daily")) {
    return createBollingerMeanReversionMultiStrategy({
      strategyId: `${candidateId}-bb-daily`,
      bbWindow: roundInt(finiteOrDefault(params.bbWindow, 72), 48, 120),
      bbMultiplier: clamp(finiteOrDefault(params.bbMultiplier, 2.5), 2.0, 3.0),
      rsiPeriod: roundInt(finiteOrDefault(params.rsiPeriod, 48), 24, 72),
      exitRsi: clamp(finiteOrDefault(params.exitRsi, 45), 38, 50),
      stopLossPct: clamp(finiteOrDefault(params.stopLossPct, 0.15), 0.10, 0.25),
      maxHoldBars: roundInt(finiteOrDefault(params.maxHoldBars, 120), 48, 240),
      entryPercentB: clamp(finiteOrDefault(params.entryPercentB, -0.05), -0.15, 0.0)
    });
  }

  if (familyId.includes("bb-reversion")) {
    return createBollingerMeanReversionMultiStrategy({
      strategyId: `${candidateId}-bb-weekly`,
      bbWindow: roundInt(finiteOrDefault(params.bbWindow, 336), 336, 504),
      bbMultiplier: clamp(finiteOrDefault(params.bbMultiplier, 3.0), 2.5, 3.5),
      rsiPeriod: roundInt(finiteOrDefault(params.rsiPeriod, 120), 72, 168),
      exitRsi: clamp(finiteOrDefault(params.exitRsi, 50), 45, 60),
      stopLossPct: clamp(finiteOrDefault(params.stopLossPct, 0.30), 0.20, 0.35),
      maxHoldBars: roundInt(finiteOrDefault(params.maxHoldBars, 504), 336, 1008),
      entryPercentB: clamp(finiteOrDefault(params.entryPercentB, -0.1), -0.2, 0.0)
    });
  }

  if (familyId.includes("reversion")) {
    return createResidualReversionMultiStrategy({
      strategyId: `${candidateId}-reversion`,
      entryThreshold: clamp(finiteOrDefault(params.entryThreshold, 0.24), 0.15, 0.45),
      exitThreshold: clamp(finiteOrDefault(params.exitThreshold, 0.13), 0.05, 0.3),
      stopLossPct: clamp(finiteOrDefault(params.stopLossPct, 0.022), 0.01, 0.04),
      maxHoldBars: roundInt(finiteOrDefault(params.maxHoldBars, 20), 8, 48)
    });
  }

  if (familyId.includes("pullback")) {
    return createRelativeMomentumPullbackMultiStrategy({
      strategyId: `${candidateId}-pullback`,
      minStrengthPct: clamp(finiteOrDefault(params.minStrengthPct, 0.8), 0.6, 0.95),
      minRiskOn: clamp(finiteOrDefault(params.minRiskOn, 0.1), -0.05, 0.35),
      pullbackZ: clamp(finiteOrDefault(params.pullbackZ, 0.9), 0.4, 1.8),
      trailAtrMult: clamp(finiteOrDefault(params.trailAtrMult, 2.2), 1.2, 3.2)
    });
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

function chooseReferenceCandles(candlesByMarket: CandleMap, timeframe: StrategyTimeframe): Candle[] {
  const normalized = normalizeToFullGrid({ timeframe, candlesByMarket });
  const bestMarket = Object.entries(normalized.candlesByMarket)
    .sort(([, a], [, b]) => b.length - a.length)[0]?.[0];
  return bestMarket ? normalized.candlesByMarket[bestMarket] ?? [] : [];
}

function filterCandlesByRange(candlesByMarket: CandleMap, range: { start: Date; end: Date }): CandleMap {
  return Object.fromEntries(
    Object.entries(candlesByMarket).map(([marketCode, candles]) => [
      marketCode,
      candles.filter((c) => c.candleTimeUtc >= range.start && c.candleTimeUtc <= range.end)
    ])
  );
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

  const loadLimit = (tf: StrategyTimeframe) =>
    calculateAutoResearchMinimumLimit({
      timeframe: tf,
      holdoutDays: config.holdoutDays,
      trainingDays: config.trainingDays,
      stepDays: config.stepDays,
      mode: config.mode
    });

  const needs1h = requiredTimeframes.includes("1h");
  const needs5m = requiredTimeframes.includes("5m") || requiredTimeframes.includes("15m");
  const needs1m = requiredTimeframes.includes("1m");

  // Cap 1m candles to 6 months — scalping strategies don't benefit from longer history
  // and 1m bar-by-bar simulation is extremely CPU-heavy
  const MAX_1M_CANDLES = 180 * 24 * 60; // 6 months of 1m data = ~259,200 per market
  const limit1m = needs1m ? Math.min(loadLimit("1m"), MAX_1M_CANDLES) : 0;
  const marketCodes1m = needs1m ? marketCodes.slice(0, Math.max(config.marketLimit, 3)) : [];

  // Ensure execution timeframe candles cover at least the same time span as decision candles.
  // Without this, 1h decisions spanning ~1685 days have no 5m execution data for early windows.
  const limit1h = needs1h ? Math.max(config.limit, loadLimit("1h")) : 0;
  const limit5m = needs5m
    ? Math.max(loadLimit("5m"), needs1h ? limit1h * 12 : 0)
    : 0;

  const [candles1h, candles5m, candles1m] = await Promise.all([
    needs1h ? loadCandles({ marketCodes, timeframe: "1h", limit: limit1h }) : Promise.resolve({}),
    needs5m ? loadCandles({ marketCodes, timeframe: "5m", limit: limit5m }) : Promise.resolve({}),
    needs1m ? loadCandles({ marketCodes: marketCodes1m, timeframe: "1m", limit: limit1m }) : Promise.resolve({})
  ]);

  const candles15m = requiredTimeframes.includes("15m") ? aggregate5mCandlesTo15m(candles5m as CandleMap) : {};

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
    const execCandles = Object.values(executionCandleMap).flat();
    if (execCandles.length > 0) {
      const execStart = execCandles.reduce((min, c) => c.candleTimeUtc < min ? c.candleTimeUtc : min, execCandles[0].candleTimeUtc);
      const execEnd = execCandles.reduce((max, c) => c.candleTimeUtc > max ? c.candleTimeUtc : max, execCandles[0].candleTimeUtc);
      clippedReferenceCandleMap = Object.fromEntries(
        Object.entries(referenceCandleMap).map(([market, candles]) => [
          market,
          candles.filter((c: { candleTimeUtc: Date }) => c.candleTimeUtc >= execStart && c.candleTimeUtc <= execEnd)
        ])
      );
    }
  }

  const referenceCandles = chooseReferenceCandles(clippedReferenceCandleMap, referenceTimeframe);

  if (referenceCandles.length === 0) {
    throw new Error(`No reference candles for block evaluation (${familyDef.timeframe})`);
  }

  const availableSpan = summarizeReferenceCandleSpan(referenceCandles);
  const baseStrategy = createBlockStrategy(candidate.familyId, candidate.candidateId, candidate.parameters);
  const gateConfig = buildBlockGateConfig(candidate.familyId, candidate.parameters);
  const strategy = withRegimeGate({ strategy: baseStrategy, gate: gateConfig });

  const sleeveId: "trend" | "breakout" | "micro" = candidate.familyId.includes("reversion") ? "micro"
    : candidate.familyId.includes("micro") ? "micro"
      : candidate.familyId.includes("breakout") ? "breakout"
        : "trend";

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
    "5m": candles5m as CandleMap,
    "1m": candles1m as CandleMap
  };

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
      universeConfig: {
        topN: Math.min(config.marketLimit, marketCodes.length),
        lookbackBars: 28,
        refreshEveryBars: 4
      },
      maxOpenPositions: 8,
      maxCapitalUsagePct: 0.95,
      cooldownBarsAfterLoss: 0,
      minBarsBetweenEntries: 0
    });

  if (config.mode === "holdout") {
    const { trainRange, testRange } = splitTrainTestByDays(referenceCandles, config.holdoutDays);
    const testResult = runBacktest(testRange);
    const signalCount = testResult.metrics.signalCount;
    const ghostSignalCount = Object.values(testResult.ghostSummary).reduce((sum, item) => sum + item.count, 0);

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
        ghostSignalCount
      },
      diagnostics: {
        coverage: {
          tradeCount: testResult.completedTrades.length,
          signalCount,
          ghostSignalCount,
          rejectedOrdersCount: testResult.metrics.rejectedOrdersCount,
          cooldownSkipsCount: testResult.metrics.cooldownSkipsCount,
          rawBuySignals: Object.values(testResult.strategyMetrics).reduce((s, m) => s + m.buySignals, 0),
          rawSellSignals: Object.values(testResult.strategyMetrics).reduce((s, m) => s + m.sellSignals, 0),
          rawHoldSignals: 0,
          avgUniverseSize: testResult.universeSnapshots.length > 0
            ? testResult.universeSnapshots.reduce((s, snap) => s + snap.markets.length, 0) / testResult.universeSnapshots.length
            : 0,
          minUniverseSize: testResult.universeSnapshots.length > 0
            ? Math.min(...testResult.universeSnapshots.map((s) => s.markets.length))
            : 0,
          maxUniverseSize: testResult.universeSnapshots.length > 0
            ? Math.max(...testResult.universeSnapshots.map((s) => s.markets.length))
            : 0,
          avgConsideredBuys: 0,
          avgEligibleBuys: 0
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
  const windows = buildWalkForwardRanges({ candles: referenceCandles, trainingDays, holdoutDays: config.holdoutDays, stepDays });

  if (windows.length === 0) {
    throw new Error("No valid block walk-forward windows.");
  }

  // E1+E3: Run windows progressively; bail early if no trades detected
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

    // After first EARLY_EXIT_WINDOW_COUNT windows, check if all had 0 trades
    if (i + 1 === EARLY_EXIT_WINDOW_COUNT) {
      const allZeroTrades = results.every((r) => r.test.completedTrades.length === 0);
      if (allZeroTrades) {
        earlyExitZeroTrade = true;
        break;
      }
    }
  }

  const testReturns = results.map((r) => r.test.metrics.netReturn);
  const positiveWindowCount = testReturns.filter((v) => v > 0).length;
  const totalClosedTrades = results.reduce((s, r) => s + r.test.completedTrades.length, 0);
  const signalCount = results.reduce((s, r) => s + r.test.metrics.signalCount, 0);
  const ghostSignalCount = results.reduce(
    (s, r) => s + Object.values(r.test.ghostSummary).reduce((gs, item) => gs + item.count, 0),
    0
  );
  const feePaid = results.reduce((s, r) => s + r.test.metrics.feePaid, 0);
  const slippagePaid = results.reduce((s, r) => s + r.test.metrics.slippagePaid, 0);

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
      ghostSignalCount
    },
    diagnostics: {
      coverage: {
        tradeCount: totalClosedTrades,
        signalCount,
        ghostSignalCount,
        rejectedOrdersCount: results.reduce((s, r) => s + r.test.metrics.rejectedOrdersCount, 0),
        cooldownSkipsCount: results.reduce((s, r) => s + r.test.metrics.cooldownSkipsCount, 0),
        rawBuySignals: results.reduce(
          (s, r) => s + Object.values(r.test.strategyMetrics).reduce((inner, m) => inner + m.buySignals, 0), 0
        ),
        rawSellSignals: results.reduce(
          (s, r) => s + Object.values(r.test.strategyMetrics).reduce((inner, m) => inner + m.sellSignals, 0), 0
        ),
        rawHoldSignals: 0,
        avgUniverseSize: 0,
        minUniverseSize: 0,
        maxUniverseSize: 0,
        avgConsideredBuys: 0,
        avgEligibleBuys: 0
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
        totalClosedTrades
      }
    }
  };
}
