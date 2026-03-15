import type { GhostTradeStudySummary } from "../types.js";
import type { CandidateSignal } from "../portfolio/portfolioTypes.js";
import type { Candle } from "../types.js";
import type { ExchangeAdapter, ExecutionPolicy } from "../execution/executionTypes.js";
import { estimateFillQuote } from "../execution/fill-quote.js";

export const DEFAULT_GHOST_HORIZONS = [6, 12, 24] as const;

type HorizonAccumulator = {
  mfe: number[];
  mae: number[];
  grossReturn: number[];
  netReturn: number[];
};

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? 0;
  }

  const left = sorted[middle - 1] ?? 0;
  const right = sorted[middle] ?? 0;
  return (left + right) / 2;
}

export function createGhostTradeStudyCollector(params: {
  exchangeAdapter: ExchangeAdapter;
  policy: ExecutionPolicy;
  evaluationEndIndex: number;
  studyNotional: number;
  horizons?: number[];
}) {
  const horizons = params.horizons ?? [...DEFAULT_GHOST_HORIZONS];
  const feeRate =
    params.policy.defaultFeeSide === "maker"
      ? params.exchangeAdapter.rules.makerFeeRate
      : params.exchangeAdapter.rules.takerFeeRate;
  const accumulators = new Map<number, HorizonAccumulator>(
    horizons.map((horizon) => [
      horizon,
      {
        mfe: [],
        mae: [],
        grossReturn: [],
        netReturn: []
      }
    ])
  );
  let ghostSignalCount = 0;

  return {
    record(paramsForSignal: {
      signal: CandidateSignal;
      candles: Candle[];
      decisionIndex: number;
      decisionLagBars: number;
    }): void {
      if (paramsForSignal.signal.signal !== "BUY" || paramsForSignal.signal.metadata?.isSyntheticBar) {
        return;
      }

      const entryBarIndex = paramsForSignal.decisionIndex + paramsForSignal.decisionLagBars;
      const entryBar = paramsForSignal.candles[entryBarIndex];

      if (!entryBar || entryBarIndex > params.evaluationEndIndex) {
        return;
      }

      ghostSignalCount += 1;
      const requestedNotional = Math.max(
        params.exchangeAdapter.rules.minOrderNotional,
        params.studyNotional
      );
      const entryQuote = estimateFillQuote({
        side: "BUY",
        candle: entryBar,
        conviction: paramsForSignal.signal.conviction,
        estimatedNotional: requestedNotional,
        avgDailyNotional: paramsForSignal.signal.metadata?.avgDailyNotional,
        estimatedSpreadBps: paramsForSignal.signal.metadata?.estimatedSpreadBps,
        exchangeAdapter: params.exchangeAdapter,
        policy: params.policy
      });

      if (!Number.isFinite(entryQuote.fillPrice) || entryQuote.fillPrice <= 0) {
        return;
      }

      const quantity = requestedNotional / (entryQuote.fillPrice * (1 + feeRate));

      if (!Number.isFinite(quantity) || quantity <= 0) {
        return;
      }

      for (const horizon of horizons) {
        const exitBarIndex = entryBarIndex + horizon;

        if (exitBarIndex > params.evaluationEndIndex) {
          continue;
        }

        const exitBar = paramsForSignal.candles[exitBarIndex];

        if (!exitBar) {
          continue;
        }

        const exitQuote = estimateFillQuote({
          side: "SELL",
          candle: exitBar,
          conviction: paramsForSignal.signal.conviction,
          estimatedNotional: quantity * exitBar.openPrice,
          avgDailyNotional: paramsForSignal.signal.metadata?.avgDailyNotional,
          estimatedSpreadBps: paramsForSignal.signal.metadata?.estimatedSpreadBps,
          exchangeAdapter: params.exchangeAdapter,
          policy: params.policy
        });
        const accumulator = accumulators.get(horizon);

        if (!accumulator) {
          continue;
        }

        let maxHigh = Number.NEGATIVE_INFINITY;
        let minLow = Number.POSITIVE_INFINITY;

        for (let index = entryBarIndex; index < exitBarIndex; index += 1) {
          const candle = paramsForSignal.candles[index];

          if (!candle) {
            continue;
          }

          maxHigh = Math.max(maxHigh, candle.highPrice);
          minLow = Math.min(minLow, candle.lowPrice);
        }

        const grossReturn =
          entryQuote.referenceOpen <= 0
            ? 0
            : (exitQuote.referenceOpen - entryQuote.referenceOpen) / entryQuote.referenceOpen;
        const exitGrossNotional = quantity * exitQuote.fillPrice;
        const netReturn =
          requestedNotional <= 0
            ? 0
            : (exitGrossNotional - exitGrossNotional * feeRate - requestedNotional) /
              requestedNotional;

        accumulator.grossReturn.push(grossReturn);
        accumulator.netReturn.push(netReturn);
        accumulator.mfe.push(
          entryQuote.referenceOpen <= 0 || !Number.isFinite(maxHigh)
            ? 0
            : (maxHigh - entryQuote.referenceOpen) / entryQuote.referenceOpen
        );
        accumulator.mae.push(
          entryQuote.referenceOpen <= 0 || !Number.isFinite(minLow)
            ? 0
            : (minLow - entryQuote.referenceOpen) / entryQuote.referenceOpen
        );
      }
    },

    getGhostSignalCount(): number {
      return ghostSignalCount;
    },

    summarize(): GhostTradeStudySummary {
      return {
        entryReference: "next_bar_open",
        horizonSummaries: horizons.map((horizon) => {
          const accumulator = accumulators.get(horizon);
          const netReturns = accumulator?.netReturn ?? [];

          return {
            horizonBars: horizon,
            sampleSize: netReturns.length,
            medianMfe: median(accumulator?.mfe ?? []),
            medianMae: median(accumulator?.mae ?? []),
            medianGrossReturn: median(accumulator?.grossReturn ?? []),
            medianNetReturn: median(netReturns),
            positiveNetRate:
              netReturns.length === 0
                ? 0
                : netReturns.filter((value) => value > 0).length / netReturns.length
          };
        })
      };
    }
  };
}

export function createEmptyGhostTradeStudySummary(
  horizons: number[] = [...DEFAULT_GHOST_HORIZONS]
): GhostTradeStudySummary {
  return {
    entryReference: "next_bar_open",
    horizonSummaries: horizons.map((horizonBars) => ({
      horizonBars,
      sampleSize: 0,
      medianMfe: 0,
      medianMae: 0,
      medianGrossReturn: 0,
      medianNetReturn: 0,
      positiveNetRate: 0
    }))
  };
}
