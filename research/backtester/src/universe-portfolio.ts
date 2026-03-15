import {
  DEFAULT_FEE_RATE,
  DEFAULT_INITIAL_CAPITAL,
  DEFAULT_SLIPPAGE_RATE
} from "./config.js";
import {
  createBarOpenExecutionModel,
  type ExecutionModel
} from "./execution-model.js";
import type { Candle } from "../../strategies/src/index.js";
import type {
  UniverseBacktestMetrics,
  UniverseBacktestResult
} from "./types.js";
import type { UniverseAlphaModel } from "./universe-alpha-model.js";

type PositionState = {
  quantity: number;
  entryPrice: number;
};

function calculateMetrics(
  equityCurve: number[],
  initialCapital: number,
  tradeCount: number,
  rebalanceCount: number,
  averagePositions: number,
  turnover: number
): UniverseBacktestMetrics {
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
    grossReturn: initialCapital === 0 ? 0 : (finalCapital - initialCapital) / initialCapital,
    netReturn: initialCapital === 0 ? 0 : (finalCapital - initialCapital) / initialCapital,
    maxDrawdown,
    tradeCount,
    winRate: 0,
    avgHoldBars: 0,
    feePaid: 0,
    slippagePaid: 0,
    rejectedOrdersCount: 0,
    cooldownSkipsCount: 0,
    rebalanceCount,
    averagePositions,
    turnover
  };
}

function buildReferenceTimeline(
  universeCandlesByMarket: Record<string, Candle[]>,
  referenceMarketCode?: string
): Date[] {
  const preferred = referenceMarketCode
    ? universeCandlesByMarket[referenceMarketCode]
    : undefined;

  if (preferred && preferred.length > 0) {
    return preferred.map((candle) => candle.candleTimeUtc);
  }

  const firstSeries = Object.values(universeCandlesByMarket)
    .slice()
    .sort((left, right) => right.length - left.length)[0];

  return firstSeries?.map((candle) => candle.candleTimeUtc) ?? [];
}

function buildIndexByTime(candles: Candle[]): Map<string, number> {
  return new Map(candles.map((candle, index) => [candle.candleTimeUtc.toISOString(), index]));
}

function markToMarket(
  cash: number,
  positions: Map<string, PositionState>,
  universeCandlesByMarket: Record<string, Candle[]>,
  indexByTimeByMarket: Record<string, Map<string, number>>,
  time: Date
): number {
  let equity = cash;
  const key = time.toISOString();

  for (const [marketCode, position] of positions.entries()) {
    const candleIndex = indexByTimeByMarket[marketCode]?.get(key);
    const closePrice =
      candleIndex === undefined
        ? universeCandlesByMarket[marketCode]?.[universeCandlesByMarket[marketCode].length - 1]?.closePrice
        : universeCandlesByMarket[marketCode]?.[candleIndex]?.closePrice;

    if (closePrice !== undefined) {
      equity += position.quantity * closePrice;
    }
  }

  return equity;
}

export function runUniversePortfolioBacktest(params: {
  strategyName: string;
  universeName: string;
  timeframe: string;
  marketCodes: string[];
  universeCandlesByMarket: Record<string, Candle[]>;
  alphaModel: UniverseAlphaModel;
  referenceMarketCode?: string;
  maxPositions?: number;
  minScore?: number;
  rebalanceEveryBars?: number;
  executionModel?: ExecutionModel;
  initialCapital?: number;
  feeRate?: number;
  slippageRate?: number;
}): UniverseBacktestResult {
  const maxPositions = params.maxPositions ?? 5;
  const minScore = params.minScore ?? 0;
  const rebalanceEveryBars = params.rebalanceEveryBars ?? 1;
  const initialCapital = params.initialCapital ?? DEFAULT_INITIAL_CAPITAL;
  const feeRate = params.feeRate ?? DEFAULT_FEE_RATE;
  const slippageRate = params.slippageRate ?? DEFAULT_SLIPPAGE_RATE;
  const executionModel = params.executionModel ?? createBarOpenExecutionModel();
  const timeline = buildReferenceTimeline(
    params.universeCandlesByMarket,
    params.referenceMarketCode
  );
  const indexByTimeByMarket = Object.fromEntries(
    Object.entries(params.universeCandlesByMarket).map(([marketCode, candles]) => [
      marketCode,
      buildIndexByTime(candles)
    ])
  );

  let cash = initialCapital;
  const positions = new Map<string, PositionState>();
  const trades: UniverseBacktestResult["trades"] = [];
  const equityCurve: number[] = [];
  const selectedHistory: UniverseBacktestResult["selectedHistory"] = [];
  let rebalanceCount = 0;
  let selectedCountTotal = 0;
  let turnoverNotional = 0;

  for (let timeIndex = 0; timeIndex < timeline.length - 1; timeIndex += 1) {
    const referenceTime = timeline[timeIndex];
    const executionTime = timeline[timeIndex + 1];

    if ((timeIndex + 1) % rebalanceEveryBars === 0) {
      const ranked = params.alphaModel
        .rankCandidates({
          referenceTime,
          universeName: params.universeName,
          marketCodes: params.marketCodes,
          universeCandlesByMarket: params.universeCandlesByMarket
        })
        .filter((candidate) => candidate.score >= minScore)
        .slice(0, maxPositions);

      const equityBeforeRebalance = markToMarket(
        cash,
        positions,
        params.universeCandlesByMarket,
        indexByTimeByMarket,
        referenceTime
      );
      const retainedPositions = new Map<string, PositionState>();

      for (const [marketCode, position] of positions.entries()) {
        const executionIndex = indexByTimeByMarket[marketCode]?.get(executionTime.toISOString());
        const candle =
          executionIndex === undefined
            ? undefined
            : params.universeCandlesByMarket[marketCode]?.[executionIndex];

        if (!candle) {
          retainedPositions.set(marketCode, position);
          continue;
        }

        const executionPrice = executionModel.getExecutionPrice({
          side: "SELL",
          openPrice: candle.openPrice,
          slippageRate
        });
        const grossValue = position.quantity * executionPrice;
        const fee = grossValue * feeRate;
        cash += grossValue - fee;
        turnoverNotional += grossValue;

        trades.push({
          marketCode,
          side: "SELL",
          time: candle.candleTimeUtc,
          price: executionPrice,
          quantity: position.quantity,
          fee,
          score: null,
          weight: null
        });
      }

      positions.clear();

      for (const [marketCode, position] of retainedPositions.entries()) {
        positions.set(marketCode, position);
      }

      const buyable = ranked.filter((candidate) =>
        indexByTimeByMarket[candidate.marketCode]?.has(executionTime.toISOString()) &&
        !positions.has(candidate.marketCode)
      );
      const allocation = buyable.length === 0 ? 0 : cash / buyable.length;

      for (const candidate of buyable) {
        const executionIndex = indexByTimeByMarket[candidate.marketCode]?.get(executionTime.toISOString());
        const candle =
          executionIndex === undefined
            ? undefined
            : params.universeCandlesByMarket[candidate.marketCode]?.[executionIndex];

        if (!candle || allocation <= 0) {
          continue;
        }

        const executionPrice = executionModel.getExecutionPrice({
          side: "BUY",
          openPrice: candle.openPrice,
          slippageRate
        });
        const fee = allocation * feeRate;
        const quantity = (allocation - fee) / executionPrice;
        cash -= allocation;
        turnoverNotional += allocation;

        positions.set(candidate.marketCode, {
          quantity,
          entryPrice: executionPrice
        });
        trades.push({
          marketCode: candidate.marketCode,
          side: "BUY",
          time: candle.candleTimeUtc,
          price: executionPrice,
          quantity,
          fee,
          score: candidate.score,
          weight: buyable.length === 0 ? null : 1 / buyable.length
        });
      }

      selectedHistory.push({
        time: referenceTime,
        marketCodes: buyable.map((candidate) => candidate.marketCode)
      });
      rebalanceCount += 1;
      selectedCountTotal += buyable.length;

      const equityAfterRebalance = markToMarket(
        cash,
        positions,
        params.universeCandlesByMarket,
        indexByTimeByMarket,
        executionTime
      );

      equityCurve.push(equityAfterRebalance);

      if (equityBeforeRebalance <= 0) {
        continue;
      }
    } else {
      equityCurve.push(
        markToMarket(
          cash,
          positions,
          params.universeCandlesByMarket,
          indexByTimeByMarket,
          executionTime
        )
      );
    }
  }

  const finalTime = timeline[timeline.length - 1];
  const finalCapital = markToMarket(
    cash,
    positions,
    params.universeCandlesByMarket,
    indexByTimeByMarket,
    finalTime
  );

  if (equityCurve.length === 0 || equityCurve[equityCurve.length - 1] !== finalCapital) {
    equityCurve.push(finalCapital);
  }

  return {
    strategyName: params.strategyName,
    universeName: params.universeName,
    timeframe: params.timeframe,
    marketCount: params.marketCodes.length,
    trades,
    equityCurve,
    metrics: calculateMetrics(
      equityCurve,
      initialCapital,
      trades.length,
      rebalanceCount,
      rebalanceCount === 0 ? 0 : selectedCountTotal / rebalanceCount,
      initialCapital === 0 ? 0 : turnoverNotional / initialCapital
    ),
    selectedHistory
  };
}
