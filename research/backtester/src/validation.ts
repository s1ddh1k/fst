import type { Candle, PeriodRange } from "./types.js";

export function splitTrainTestByDays(candles: Candle[], holdoutDays: number): {
  trainRange: PeriodRange;
  testRange: PeriodRange;
} {
  if (candles.length < 2) {
    throw new Error("Need at least two candles to split train and test ranges");
  }

  const testEnd = candles[candles.length - 1].candleTimeUtc;
  const testStart = new Date(testEnd.getTime() - holdoutDays * 24 * 60 * 60 * 1000);
  const trainCandles = candles.filter((candle) => candle.candleTimeUtc < testStart);
  const testCandles = candles.filter((candle) => candle.candleTimeUtc >= testStart);

  if (trainCandles.length < 2 || testCandles.length < 2) {
    throw new Error("Split produced too few candles for train or test");
  }

  return {
    trainRange: {
      start: trainCandles[0].candleTimeUtc,
      end: trainCandles[trainCandles.length - 1].candleTimeUtc
    },
    testRange: {
      start: testCandles[0].candleTimeUtc,
      end: testCandles[testCandles.length - 1].candleTimeUtc
    }
  };
}

export function buildWalkForwardRanges(params: {
  candles: Candle[];
  trainingDays: number;
  holdoutDays: number;
  stepDays?: number;
}): Array<{ trainRange: PeriodRange; testRange: PeriodRange }> {
  if (params.candles.length < 2) {
    throw new Error("Need at least two candles to build walk-forward ranges");
  }

  const trainingMs = params.trainingDays * 24 * 60 * 60 * 1000;
  const holdoutMs = params.holdoutDays * 24 * 60 * 60 * 1000;
  const stepMs = (params.stepDays ?? params.holdoutDays) * 24 * 60 * 60 * 1000;
  const startTime = params.candles[0].candleTimeUtc.getTime();
  const endTime = params.candles[params.candles.length - 1].candleTimeUtc.getTime();
  const ranges: Array<{ trainRange: PeriodRange; testRange: PeriodRange }> = [];

  for (
    let trainStartTime = startTime;
    trainStartTime + trainingMs + holdoutMs <= endTime;
    trainStartTime += stepMs
  ) {
    const trainEndTime = trainStartTime + trainingMs;
    const testEndTime = trainEndTime + holdoutMs;

    const trainCandles = params.candles.filter((candle) => {
      const time = candle.candleTimeUtc.getTime();
      return time >= trainStartTime && time < trainEndTime;
    });
    const testCandles = params.candles.filter((candle) => {
      const time = candle.candleTimeUtc.getTime();
      return time >= trainEndTime && time <= testEndTime;
    });

    if (trainCandles.length < 2 || testCandles.length < 2) {
      continue;
    }

    ranges.push({
      trainRange: {
        start: trainCandles[0].candleTimeUtc,
        end: trainCandles[trainCandles.length - 1].candleTimeUtc
      },
      testRange: {
        start: testCandles[0].candleTimeUtc,
        end: testCandles[testCandles.length - 1].candleTimeUtc
      }
    });
  }

  if (ranges.length === 0) {
    throw new Error("Walk-forward split produced no valid windows");
  }

  return ranges;
}
