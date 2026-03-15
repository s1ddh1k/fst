import type { Candle, RandomBenchmarkResult } from "./types.js";
import {
  DEFAULT_FEE_RATE,
  DEFAULT_INITIAL_CAPITAL,
  DEFAULT_SLIPPAGE_RATE
} from "./config.js";

function runSingleRandomTrial(params: {
  candles: Candle[];
  avgTradesPerHundredBars: number;
  initialCapital: number;
  feeRate: number;
  slippageRate: number;
}): number {
  const { candles, avgTradesPerHundredBars, initialCapital, feeRate, slippageRate } = params;
  const entryProbability = avgTradesPerHundredBars / 100;
  let cash = initialCapital;
  let positionQty = 0;
  let entryPrice = 0;

  for (let i = 1; i < candles.length; i += 1) {
    const price = candles[i].openPrice;

    if (positionQty === 0) {
      if (Math.random() < entryProbability && cash > 0) {
        const execPrice = price * (1 + slippageRate);
        const fee = cash * feeRate;
        positionQty = (cash - fee) / execPrice;
        entryPrice = execPrice;
        cash = 0;
      }
    } else {
      const holdBars = Math.floor(Math.random() * 48) + 1;

      if (Math.random() < 1 / holdBars) {
        const execPrice = price * (1 - slippageRate);
        const gross = positionQty * execPrice;
        const fee = gross * feeRate;
        cash = gross - fee;
        positionQty = 0;
        entryPrice = 0;
      }
    }
  }

  if (positionQty > 0) {
    const lastPrice = candles[candles.length - 1].closePrice;
    const execPrice = lastPrice * (1 - slippageRate);
    const gross = positionQty * execPrice;
    const fee = gross * feeRate;
    cash = gross - fee;
  }

  return (cash - initialCapital) / initialCapital;
}

export function runRandomBenchmark(params: {
  candles: Candle[];
  strategyReturn: number;
  strategyTradeCount: number;
  iterations?: number;
  initialCapital?: number;
  feeRate?: number;
  slippageRate?: number;
}): RandomBenchmarkResult {
  const iterations = params.iterations ?? 1000;
  const initialCapital = params.initialCapital ?? DEFAULT_INITIAL_CAPITAL;
  const feeRate = params.feeRate ?? DEFAULT_FEE_RATE;
  const slippageRate = params.slippageRate ?? DEFAULT_SLIPPAGE_RATE;
  const totalBars = params.candles.length;
  const completedTrades = Math.floor(params.strategyTradeCount / 2);
  const avgTradesPerHundredBars = totalBars === 0 ? 0 : (completedTrades / totalBars) * 100;

  if (avgTradesPerHundredBars <= 0 || totalBars < 10) {
    return {
      strategyReturn: params.strategyReturn,
      randomMeanReturn: 0,
      randomMedianReturn: 0,
      percentileVsRandom: 0,
      beatsRandomPct: 0
    };
  }

  const randomReturns: number[] = [];

  for (let i = 0; i < iterations; i += 1) {
    randomReturns.push(
      runSingleRandomTrial({
        candles: params.candles,
        avgTradesPerHundredBars,
        initialCapital,
        feeRate,
        slippageRate
      })
    );
  }

  randomReturns.sort((a, b) => a - b);

  const mean = randomReturns.reduce((s, v) => s + v, 0) / iterations;
  const medianIdx = Math.floor(iterations / 2);
  const median = randomReturns[medianIdx];
  const beatenCount = randomReturns.filter((r) => params.strategyReturn > r).length;
  const percentile = beatenCount / iterations;

  return {
    strategyReturn: params.strategyReturn,
    randomMeanReturn: mean,
    randomMedianReturn: median,
    percentileVsRandom: percentile,
    beatsRandomPct: percentile
  };
}
