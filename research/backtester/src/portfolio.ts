import { DEFAULT_INITIAL_CAPITAL } from "./config.js";
import { runBacktest } from "./engine.js";
import type { BacktestMetrics, Candle, PortfolioBacktestSummary, Strategy } from "./types.js";

function calculatePortfolioMetrics(
  equityCurve: number[],
  initialCapital: number
): BacktestMetrics {
  let peak = initialCapital;
  let maxDrawdown = 0;

  for (const equity of equityCurve) {
    peak = Math.max(peak, equity);
    const drawdown = peak === 0 ? 0 : (peak - equity) / peak;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
  }

  const finalCapital = equityCurve[equityCurve.length - 1] ?? initialCapital;

  return {
    initialCapital,
    finalCapital,
    totalReturn: initialCapital === 0 ? 0 : (finalCapital - initialCapital) / initialCapital,
    maxDrawdown,
    tradeCount: 0,
    winRate: 0
  };
}

function combineEquityCurves(curves: number[][]): number[] {
  const maxLength = Math.max(...curves.map((curve) => curve.length));
  const combined: number[] = [];

  for (let index = 0; index < maxLength; index += 1) {
    let total = 0;

    for (const curve of curves) {
      total += curve[index] ?? curve[curve.length - 1] ?? 0;
    }

    combined.push(total);
  }

  return combined;
}

export function runPortfolioBacktest(params: {
  marketCode: string;
  timeframe: string;
  holdoutDays: number;
  trainCandles: Candle[];
  testCandles: Candle[];
  weightedStrategies: Array<{ strategy: Strategy; weight: number }>;
  initialCapital?: number;
}): PortfolioBacktestSummary {
  const initialCapital = params.initialCapital ?? DEFAULT_INITIAL_CAPITAL;
  const trainCurves: number[][] = [];
  const testCurves: number[][] = [];

  for (const weighted of params.weightedStrategies) {
    const capital = initialCapital * weighted.weight;

    const train = runBacktest({
      marketCode: params.marketCode,
      timeframe: params.timeframe,
      candles: params.trainCandles,
      strategy: weighted.strategy,
      initialCapital: capital
    });
    const test = runBacktest({
      marketCode: params.marketCode,
      timeframe: params.timeframe,
      candles: params.testCandles,
      strategy: weighted.strategy,
      initialCapital: capital
    });

    trainCurves.push(train.equityCurve);
    testCurves.push(test.equityCurve);
  }

  return {
    marketCode: params.marketCode,
    timeframe: params.timeframe,
    holdoutDays: params.holdoutDays,
    strategies: params.weightedStrategies.map((weighted) => ({
      strategyName: weighted.strategy.name,
      parameters: weighted.strategy.parameters,
      weight: weighted.weight
    })),
    train: calculatePortfolioMetrics(combineEquityCurves(trainCurves), initialCapital),
    test: calculatePortfolioMetrics(combineEquityCurves(testCurves), initialCapital)
  };
}
