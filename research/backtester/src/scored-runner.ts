import {
  completeBacktestRun,
  createBacktestRun,
  getCandidateMarketsWithMinimumCandles,
  loadCandlesForMarkets
} from "./db.js";
import { insertScoredBacktestMetrics } from "./db-scored.js";
import { runUniverseScoredBacktest } from "./backtest/BacktestEngine.js";
import type { PositionSizer, PortfolioRiskManager, ScoredStrategy } from "../../strategies/src/types.js";
import { assertSupportedScoredDecisionTimeframe } from "../../strategies/src/scored-strategy-policy.js";
import { createVolatilityTargetSizer } from "../../strategies/src/position-sizer.js";
import { createNoOpRiskManager } from "../../strategies/src/portfolio-risk.js";
import type { Candle, HoldoutBacktestSummary, ScoredBacktestResult, WalkForwardBacktestSummary } from "./types.js";
import { buildWalkForwardRanges, splitTrainTestByDays } from "./validation.js";
import { normalizeCandlesToFullGrid } from "./universe/candle-normalizer.js";
import type { PointInTimeUniverseConfig } from "./universe/universe-selector.js";

function toUniverseMarketCode(universeName?: string): string {
  return `UNIVERSE:${universeName ?? "krw"}`;
}

function chooseReferenceCandles(
  universeCandlesByMarket: Record<string, Candle[]>,
  timeframe: string
): Candle[] {
  const normalized = normalizeCandlesToFullGrid({
    candlesByMarket: universeCandlesByMarket,
    timeframe
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

export type PreloadedMarketData = {
  universeCandlesByMarket: Record<string, Candle[]>;
  trainRange: { start: Date; end: Date };
  testRange: { start: Date; end: Date };
  referenceCandles: Candle[];
  marketCodes: string[];
};

export async function preloadMarketData(params: {
  marketCode?: string;
  timeframe: string;
  limit: number;
  holdoutDays: number;
  universeName?: string;
  universeMarketCodes?: string[];
  minCandles?: number;
  config?: import("../../strategies/src/types.js").MarketStateConfig;
}): Promise<PreloadedMarketData> {
  assertSupportedScoredDecisionTimeframe(params.timeframe);
  const marketCodes =
    params.universeMarketCodes && params.universeMarketCodes.length > 0
      ? params.universeMarketCodes
      : (
          await getCandidateMarketsWithMinimumCandles({
            timeframe: params.timeframe,
            minCandles: params.minCandles ?? params.limit
          })
        ).map((item) => item.marketCode);

  if (marketCodes.length === 0) {
    throw new Error("No candidate universe markets available");
  }

  const universeCandlesByMarket = await loadCandlesForMarkets({
    marketCodes,
    timeframe: params.timeframe,
    limit: params.limit
  });
  const referenceCandles = chooseReferenceCandles(universeCandlesByMarket, params.timeframe);

  if (referenceCandles.length === 0) {
    throw new Error("No normalized universe candles available");
  }

  const { trainRange, testRange } = splitTrainTestByDays(referenceCandles, params.holdoutDays);

  return {
    universeCandlesByMarket,
    trainRange,
    testRange,
    referenceCandles,
    marketCodes
  };
}

export async function executeScoredHoldoutBacktest(params: {
  marketCode?: string;
  timeframe: string;
  limit: number;
  holdoutDays: number;
  strategy: ScoredStrategy;
  positionSizer?: PositionSizer;
  riskManager?: PortfolioRiskManager;
  universeName?: string;
  universeMarketCodes?: string[];
  universeConfig?: Partial<PointInTimeUniverseConfig>;
  runBootstrap?: boolean;
  runRandomBenchmark?: boolean;
  preloaded?: PreloadedMarketData;
}): Promise<HoldoutBacktestSummary & {
  scoredTrain: ScoredBacktestResult;
  scoredTest: ScoredBacktestResult;
}> {
  assertSupportedScoredDecisionTimeframe(params.timeframe);
  const positionSizer = params.positionSizer ?? createVolatilityTargetSizer({ maxWeight: 0.25 });
  const riskManager = params.riskManager ?? createNoOpRiskManager();
  const preloaded = params.preloaded ?? await preloadMarketData({
    marketCode: params.marketCode,
    timeframe: params.timeframe,
    limit: params.limit,
    holdoutDays: params.holdoutDays,
    universeName: params.universeName,
    universeMarketCodes: params.universeMarketCodes,
    config: params.strategy.contextConfig
  });
  const syntheticMarketCode = params.marketCode ?? toUniverseMarketCode(params.universeName);

  const backtestRunId = await createBacktestRun({
    strategyName: params.strategy.name,
    strategyVersion: "3.0.0",
    parameters: params.strategy.parameters,
    marketCode: syntheticMarketCode,
    universeName: params.universeName ?? "krw-pit",
    marketCount: preloaded.marketCodes.length,
    timeframe: params.timeframe,
    trainRange: preloaded.trainRange,
    testRange: preloaded.testRange
  });

  const trainResult = runUniverseScoredBacktest({
    universeName: params.universeName ?? "krw-pit",
    timeframe: params.timeframe,
    candidateCandlesByMarket: preloaded.universeCandlesByMarket,
    evaluationRange: preloaded.trainRange,
    strategy: params.strategy,
    positionSizer,
    riskManager: createNoOpRiskManager(),
    universeConfig: params.universeConfig,
    runBootstrap: params.runBootstrap,
    runRandomBenchmarkFlag: false
  });
  const testResult = runUniverseScoredBacktest({
    universeName: params.universeName ?? "krw-pit",
    timeframe: params.timeframe,
    candidateCandlesByMarket: preloaded.universeCandlesByMarket,
    evaluationRange: preloaded.testRange,
    strategy: params.strategy,
    positionSizer,
    riskManager,
    universeConfig: params.universeConfig,
    runBootstrap: params.runBootstrap,
    runRandomBenchmarkFlag: params.runRandomBenchmark
  });

  await insertScoredBacktestMetrics({
    backtestRunId,
    segmentType: "train",
    result: trainResult
  });
  await insertScoredBacktestMetrics({
    backtestRunId,
    segmentType: "test",
    result: testResult
  });
  await completeBacktestRun(backtestRunId, "success");

  return {
    backtestRunId,
    strategyName: params.strategy.name,
    marketCode: syntheticMarketCode,
    timeframe: params.timeframe,
    holdoutDays: params.holdoutDays,
    trainRange: preloaded.trainRange,
    testRange: preloaded.testRange,
    train: trainResult.metrics,
    test: testResult.metrics,
    parameters: params.strategy.parameters,
    scoredTrain: trainResult,
    scoredTest: testResult
  };
}

export async function executeScoredWalkForwardBacktest(params: {
  marketCode?: string;
  timeframe: string;
  limit: number;
  holdoutDays: number;
  trainingDays: number;
  stepDays?: number;
  strategy: ScoredStrategy;
  positionSizer?: PositionSizer;
  riskManager?: PortfolioRiskManager;
  universeName?: string;
  universeMarketCodes?: string[];
  universeConfig?: Partial<PointInTimeUniverseConfig>;
  runBootstrap?: boolean;
  runRandomBenchmark?: boolean;
  preloaded?: PreloadedMarketData;
}): Promise<WalkForwardBacktestSummary & {
  scoredWindows: ScoredBacktestResult[];
}> {
  assertSupportedScoredDecisionTimeframe(params.timeframe);
  const positionSizer = params.positionSizer ?? createVolatilityTargetSizer({ maxWeight: 0.25 });
  const riskManager = params.riskManager ?? createNoOpRiskManager();
  const preloaded = params.preloaded ?? await preloadMarketData({
    marketCode: params.marketCode,
    timeframe: params.timeframe,
    limit: params.limit,
    holdoutDays: params.holdoutDays,
    universeName: params.universeName,
    universeMarketCodes: params.universeMarketCodes,
    config: params.strategy.contextConfig
  });
  const ranges = buildWalkForwardRanges({
    candles: preloaded.referenceCandles,
    trainingDays: params.trainingDays,
    holdoutDays: params.holdoutDays,
    stepDays: params.stepDays
  });
  const scoredWindows: ScoredBacktestResult[] = [];
  const windows = ranges.map(({ trainRange, testRange }) => {
    const trainResult = runUniverseScoredBacktest({
      universeName: params.universeName ?? "krw-pit",
      timeframe: params.timeframe,
      candidateCandlesByMarket: preloaded.universeCandlesByMarket,
      evaluationRange: trainRange,
      strategy: params.strategy,
      positionSizer,
      riskManager: createNoOpRiskManager(),
      universeConfig: params.universeConfig,
      runBootstrap: false,
      runRandomBenchmarkFlag: false
    });
    const testResult = runUniverseScoredBacktest({
      universeName: params.universeName ?? "krw-pit",
      timeframe: params.timeframe,
      candidateCandlesByMarket: preloaded.universeCandlesByMarket,
      evaluationRange: testRange,
      strategy: params.strategy,
      positionSizer,
      riskManager,
      universeConfig: params.universeConfig,
      runBootstrap: params.runBootstrap,
      runRandomBenchmarkFlag: params.runRandomBenchmark
    });

    scoredWindows.push(testResult);

    return {
      trainRange,
      testRange,
      train: trainResult.metrics,
      test: testResult.metrics
    };
  });

  return {
    strategyName: params.strategy.name,
    marketCode: params.marketCode ?? toUniverseMarketCode(params.universeName),
    timeframe: params.timeframe,
    trainingDays: params.trainingDays,
    holdoutDays: params.holdoutDays,
    windowCount: windows.length,
    windows,
    averageTrainReturn:
      windows.reduce((sum, window) => sum + window.train.totalReturn, 0) / windows.length,
    averageTestReturn:
      windows.reduce((sum, window) => sum + window.test.totalReturn, 0) / windows.length,
    averageTestDrawdown:
      windows.reduce((sum, window) => sum + window.test.maxDrawdown, 0) / windows.length,
    averageTestTradeCount:
      windows.reduce((sum, window) => sum + window.test.tradeCount, 0) / windows.length,
    parameters: params.strategy.parameters,
    scoredWindows
  };
}
