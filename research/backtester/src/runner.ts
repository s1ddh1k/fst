import {
  completeBacktestRun,
  createBacktestRun,
  insertBacktestMetrics,
  loadCandles
} from "./db.js";
import { runBacktest } from "./engine.js";
import type { HoldoutBacktestSummary, Strategy, WalkForwardBacktestSummary } from "./types.js";
import { buildWalkForwardRanges, splitTrainTestByDays } from "./validation.js";

export async function executeHoldoutBacktest(params: {
  marketCode: string;
  timeframe: string;
  limit: number;
  holdoutDays: number;
  strategy: Strategy;
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

  const trainResult = runBacktest({
    marketCode: params.marketCode,
    timeframe: params.timeframe,
    candles: trainCandles,
    strategy: params.strategy
  });
  const testResult = runBacktest({
    marketCode: params.marketCode,
    timeframe: params.timeframe,
    candles: testCandles,
    strategy: params.strategy
  });

  await insertBacktestMetrics({
    backtestRunId,
    segmentType: "train",
    totalReturn: trainResult.metrics.totalReturn,
    maxDrawdown: trainResult.metrics.maxDrawdown,
    winRate: trainResult.metrics.winRate,
    tradeCount: trainResult.metrics.tradeCount
  });
  await insertBacktestMetrics({
    backtestRunId,
    segmentType: "test",
    totalReturn: testResult.metrics.totalReturn,
    maxDrawdown: testResult.metrics.maxDrawdown,
    winRate: testResult.metrics.winRate,
    tradeCount: testResult.metrics.tradeCount
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
      strategy: params.strategy
    });
    const testResult = runBacktest({
      marketCode: params.marketCode,
      timeframe: params.timeframe,
      candles: testCandles,
      strategy: params.strategy
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
