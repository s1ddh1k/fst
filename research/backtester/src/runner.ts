import {
  completeBacktestRun,
  createBacktestRun,
  insertBacktestMetrics,
  loadCandles,
  loadCandlesForMarkets,
  loadMarketStateFeatureSeries
} from "./db.js";
import { runBacktest } from "./engine.js";
import type { MarketStateContext } from "../../strategies/src/index.js";
import type { HoldoutBacktestSummary, Strategy, WalkForwardBacktestSummary } from "./types.js";
import { buildWalkForwardRanges, splitTrainTestByDays } from "./validation.js";

function ensureUniverseMarkets(marketCode: string, universeMarketCodes?: string[]): string[] | undefined {
  if (!universeMarketCodes || universeMarketCodes.length === 0) {
    return undefined;
  }

  return universeMarketCodes.includes(marketCode)
    ? universeMarketCodes
    : [marketCode, ...universeMarketCodes];
}

function filterUniverseCandlesByRange(
  universeCandlesByMarket: Record<string, Awaited<ReturnType<typeof loadCandles>>>,
  range: { start: Date; end: Date }
): Record<string, Awaited<ReturnType<typeof loadCandles>>> {
  return Object.fromEntries(
    Object.entries(universeCandlesByMarket).map(([marketCode, candles]) => [
      marketCode,
      candles.filter(
        (candle) => candle.candleTimeUtc >= range.start && candle.candleTimeUtc <= range.end
      )
    ])
  );
}

function filterMarketStateSeriesByRange(
  marketStateByTime: Record<string, MarketStateContext>,
  range: { start: Date; end: Date }
): Record<string, MarketStateContext> {
  return Object.fromEntries(
    Object.entries(marketStateByTime).filter(([, marketState]) => {
      return (
        marketState.referenceTime >= range.start &&
        marketState.referenceTime <= range.end
      );
    })
  );
}

function getCandlesRange(
  candles: Awaited<ReturnType<typeof loadCandles>>
): { start: Date; end: Date } | undefined {
  if (candles.length === 0) {
    return undefined;
  }

  return {
    start: candles[0].candleTimeUtc,
    end: candles[candles.length - 1].candleTimeUtc
  };
}

export async function executeHoldoutBacktest(params: {
  marketCode: string;
  timeframe: string;
  limit: number;
  holdoutDays: number;
  strategy: Strategy;
  universeName?: string;
  universeMarketCodes?: string[];
  benchmarkMarketCode?: string;
}): Promise<HoldoutBacktestSummary> {
  const candles = await loadCandles({
    marketCode: params.marketCode,
    timeframe: params.timeframe,
    limit: params.limit
  });

  if (candles.length === 0) {
    throw new Error("No candles loaded for backtest");
  }

  const { trainRange, testRange } = splitTrainTestByDays(candles, params.holdoutDays);
  const universeMarkets = ensureUniverseMarkets(params.marketCode, params.universeMarketCodes);
  const universeCandlesByMarket = universeMarkets
    ? await loadCandlesForMarkets({
        marketCodes: universeMarkets,
        timeframe: params.timeframe,
        limit: params.limit
      })
    : undefined;
  const candleRange = getCandlesRange(candles);
  const marketStateByTime =
    params.universeName && candleRange
      ? await loadMarketStateFeatureSeries({
          marketCode: params.marketCode,
          universeName: params.universeName,
          timeframe: params.timeframe,
          config: params.strategy.contextConfig,
          benchmarkMarketCode: params.benchmarkMarketCode,
          range: candleRange
        })
      : undefined;

  const backtestRunId = await createBacktestRun({
    strategyName: params.strategy.name,
    strategyVersion: "0.1.0",
    parameters: params.strategy.parameters,
    marketCode: params.marketCode,
    timeframe: params.timeframe,
    trainRange,
    testRange
  });

  const trainCandles = await loadCandles({
    marketCode: params.marketCode,
    timeframe: params.timeframe,
    range: trainRange,
    limit: params.limit
  });
  const testCandles = await loadCandles({
    marketCode: params.marketCode,
    timeframe: params.timeframe,
    range: testRange,
    limit: params.limit
  });
  const trainUniverseCandles = universeCandlesByMarket
    ? filterUniverseCandlesByRange(universeCandlesByMarket, trainRange)
    : undefined;
  const testUniverseCandles = universeCandlesByMarket
    ? filterUniverseCandlesByRange(universeCandlesByMarket, testRange)
    : undefined;
  const trainMarketStateByTime = marketStateByTime
    ? filterMarketStateSeriesByRange(marketStateByTime, trainRange)
    : undefined;
  const testMarketStateByTime = marketStateByTime
    ? filterMarketStateSeriesByRange(marketStateByTime, testRange)
    : undefined;

  const trainResult = runBacktest({
    marketCode: params.marketCode,
    timeframe: params.timeframe,
    candles: trainCandles,
    strategy: params.strategy,
    universeName: params.universeName,
    benchmarkMarketCode: params.benchmarkMarketCode,
    universeCandlesByMarket: trainUniverseCandles,
    precomputedMarketStateByTime: trainMarketStateByTime
  });
  const testResult = runBacktest({
    marketCode: params.marketCode,
    timeframe: params.timeframe,
    candles: testCandles,
    strategy: params.strategy,
    universeName: params.universeName,
    benchmarkMarketCode: params.benchmarkMarketCode,
    universeCandlesByMarket: testUniverseCandles,
    precomputedMarketStateByTime: testMarketStateByTime
  });

  await insertBacktestMetrics({
    backtestRunId,
    segmentType: "train",
    totalReturn: trainResult.metrics.totalReturn,
    grossReturn: trainResult.metrics.grossReturn,
    netReturn: trainResult.metrics.netReturn,
    maxDrawdown: trainResult.metrics.maxDrawdown,
    winRate: trainResult.metrics.winRate,
    tradeCount: trainResult.metrics.tradeCount,
    turnover: trainResult.metrics.turnover,
    avgHoldBars: trainResult.metrics.avgHoldBars,
    feePaid: trainResult.metrics.feePaid,
    slippagePaid: trainResult.metrics.slippagePaid,
    rejectedOrdersCount: trainResult.metrics.rejectedOrdersCount,
    cooldownSkipsCount: trainResult.metrics.cooldownSkipsCount
  });
  await insertBacktestMetrics({
    backtestRunId,
    segmentType: "test",
    totalReturn: testResult.metrics.totalReturn,
    grossReturn: testResult.metrics.grossReturn,
    netReturn: testResult.metrics.netReturn,
    maxDrawdown: testResult.metrics.maxDrawdown,
    winRate: testResult.metrics.winRate,
    tradeCount: testResult.metrics.tradeCount,
    turnover: testResult.metrics.turnover,
    avgHoldBars: testResult.metrics.avgHoldBars,
    feePaid: testResult.metrics.feePaid,
    slippagePaid: testResult.metrics.slippagePaid,
    rejectedOrdersCount: testResult.metrics.rejectedOrdersCount,
    cooldownSkipsCount: testResult.metrics.cooldownSkipsCount
  });
  await completeBacktestRun(backtestRunId, "success");

  return {
    backtestRunId,
    strategyName: params.strategy.name,
    marketCode: params.marketCode,
    timeframe: params.timeframe,
    holdoutDays: params.holdoutDays,
    trainRange,
    testRange,
    train: trainResult.metrics,
    test: testResult.metrics,
    parameters: params.strategy.parameters
  };
}

export async function executeWalkForwardBacktest(params: {
  marketCode: string;
  timeframe: string;
  limit: number;
  holdoutDays: number;
  trainingDays: number;
  stepDays?: number;
  strategy: Strategy;
  universeName?: string;
  universeMarketCodes?: string[];
  benchmarkMarketCode?: string;
}): Promise<WalkForwardBacktestSummary> {
  const candles = await loadCandles({
    marketCode: params.marketCode,
    timeframe: params.timeframe,
    limit: params.limit
  });

  if (candles.length === 0) {
    throw new Error("No candles loaded for walk-forward backtest");
  }

  const ranges = buildWalkForwardRanges({
    candles,
    trainingDays: params.trainingDays,
    holdoutDays: params.holdoutDays,
    stepDays: params.stepDays
  });
  const universeMarkets = ensureUniverseMarkets(params.marketCode, params.universeMarketCodes);
  const universeCandlesByMarket = universeMarkets
    ? await loadCandlesForMarkets({
        marketCodes: universeMarkets,
        timeframe: params.timeframe,
        limit: params.limit
      })
    : undefined;
  const candleRange = getCandlesRange(candles);
  const marketStateByTime =
    params.universeName && candleRange
      ? await loadMarketStateFeatureSeries({
          marketCode: params.marketCode,
          universeName: params.universeName,
          timeframe: params.timeframe,
          config: params.strategy.contextConfig,
          benchmarkMarketCode: params.benchmarkMarketCode,
          range: candleRange
        })
      : undefined;

  const windows = ranges.map(({ trainRange, testRange }) => {
    const trainCandles = candles.filter(
      (candle) => candle.candleTimeUtc >= trainRange.start && candle.candleTimeUtc <= trainRange.end
    );
    const testCandles = candles.filter(
      (candle) => candle.candleTimeUtc >= testRange.start && candle.candleTimeUtc <= testRange.end
    );

    const trainResult = runBacktest({
      marketCode: params.marketCode,
      timeframe: params.timeframe,
      candles: trainCandles,
      strategy: params.strategy,
      universeName: params.universeName,
      benchmarkMarketCode: params.benchmarkMarketCode,
      universeCandlesByMarket: universeCandlesByMarket
        ? filterUniverseCandlesByRange(universeCandlesByMarket, trainRange)
        : undefined,
      precomputedMarketStateByTime: marketStateByTime
        ? filterMarketStateSeriesByRange(marketStateByTime, trainRange)
        : undefined
    });
    const testResult = runBacktest({
      marketCode: params.marketCode,
      timeframe: params.timeframe,
      candles: testCandles,
      strategy: params.strategy,
      universeName: params.universeName,
      benchmarkMarketCode: params.benchmarkMarketCode,
      universeCandlesByMarket: universeCandlesByMarket
        ? filterUniverseCandlesByRange(universeCandlesByMarket, testRange)
        : undefined,
      precomputedMarketStateByTime: marketStateByTime
        ? filterMarketStateSeriesByRange(marketStateByTime, testRange)
        : undefined
    });

    return {
      trainRange,
      testRange,
      train: trainResult.metrics,
      test: testResult.metrics
    };
  });

  return {
    strategyName: params.strategy.name,
    marketCode: params.marketCode,
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
    parameters: params.strategy.parameters
  };
}
