import {
  DEFAULT_FEE_RATE,
  DEFAULT_INITIAL_CAPITAL,
  DEFAULT_SLIPPAGE_RATE
} from "./config.js";
import { buildMarketStateContext } from "../../strategies/src/index.js";
import type { MarketStateContext } from "../../strategies/src/index.js";
import {
  createBarOpenExecutionModel,
  type ExecutionModel
} from "./execution-model.js";
import type { BacktestMetrics, BacktestResult, Candle, Strategy, Trade } from "./types.js";

function calculateMetrics(
  trades: Trade[],
  equityCurve: number[],
  initialCapital: number,
  finalCapital: number
): BacktestMetrics {
  let peak = initialCapital;
  let maxDrawdown = 0;

  for (const equity of equityCurve) {
    peak = Math.max(peak, equity);
    const drawdown = peak === 0 ? 0 : (peak - equity) / peak;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
  }

  let completedTradeCount = 0;
  let winningTradeCount = 0;

  for (let index = 1; index < trades.length; index += 2) {
    const buyTrade = trades[index - 1];
    const sellTrade = trades[index];

    if (buyTrade.side === "BUY" && sellTrade.side === "SELL") {
      completedTradeCount += 1;

      if (sellTrade.price > buyTrade.price) {
        winningTradeCount += 1;
      }
    }
  }

  return {
    initialCapital,
    finalCapital,
    totalReturn: initialCapital === 0 ? 0 : (finalCapital - initialCapital) / initialCapital,
    grossReturn: initialCapital === 0 ? 0 : (finalCapital - initialCapital) / initialCapital,
    netReturn: initialCapital === 0 ? 0 : (finalCapital - initialCapital) / initialCapital,
    maxDrawdown,
    tradeCount: trades.length,
    winRate: completedTradeCount === 0 ? 0 : winningTradeCount / completedTradeCount,
    turnover: 0,
    avgHoldBars: 0,
    feePaid: trades.reduce((sum, trade) => sum + trade.fee, 0),
    slippagePaid: 0,
    rejectedOrdersCount: 0,
    cooldownSkipsCount: 0
  };
}

export function runBacktest(params: {
  marketCode: string;
  timeframe: string;
  candles: Candle[];
  strategy: Strategy;
  universeName?: string;
  benchmarkMarketCode?: string;
  universeCandlesByMarket?: Record<string, Candle[]>;
  precomputedMarketStateByTime?: Record<string, MarketStateContext>;
  executionModel?: ExecutionModel;
  initialCapital?: number;
  feeRate?: number;
  slippageRate?: number;
}): BacktestResult {
  const initialCapital = params.initialCapital ?? DEFAULT_INITIAL_CAPITAL;
  const feeRate = params.feeRate ?? DEFAULT_FEE_RATE;
  const slippageRate = params.slippageRate ?? DEFAULT_SLIPPAGE_RATE;
  const executionModel = params.executionModel ?? createBarOpenExecutionModel();

  let cash = initialCapital;
  let positionQuantity = 0;
  let entryPrice = 0;
  let entryIndex: number | null = null;
  const trades: Trade[] = [];
  const equityCurve: number[] = [];

  for (let index = 1; index < params.candles.length; index += 1) {
    const signalIndex = index - 1;
    const referenceTime = params.candles[signalIndex]?.candleTimeUtc;
    const precomputedMarketState =
      referenceTime === undefined
        ? undefined
        : params.precomputedMarketStateByTime?.[referenceTime.toISOString()];
    const signal = params.strategy.generateSignal({
      candles: params.candles,
      index: signalIndex,
      hasPosition: positionQuantity > 0,
      marketState:
        precomputedMarketState ??
        (params.universeCandlesByMarket
          ? buildMarketStateContext({
              marketCode: params.marketCode,
              candles: params.candles,
              index: signalIndex,
              universeName: params.universeName,
              benchmarkMarketCode: params.benchmarkMarketCode,
              universeCandlesByMarket: params.universeCandlesByMarket,
              config: params.strategy.contextConfig
            })
          : undefined),
      currentPosition:
        positionQuantity > 0 && entryIndex !== null
          ? {
              entryPrice,
              quantity: positionQuantity,
              barsHeld: Math.max(0, signalIndex - entryIndex)
            }
          : undefined
    });
    const candle = params.candles[index];
    const executionPrice = executionModel.getExecutionPrice({
      side: signal === "BUY" ? "BUY" : "SELL",
      openPrice: candle.openPrice,
      slippageRate
    });

    if (signal === "BUY" && positionQuantity === 0 && cash > 0) {
      const grossQuantity = cash / executionPrice;
      const fee = cash * feeRate;
      const netCash = cash - fee;
      positionQuantity = netCash / executionPrice;
      entryPrice = executionPrice;
      entryIndex = index;
      cash = 0;

      trades.push({
        side: "BUY",
        time: candle.candleTimeUtc,
        price: executionPrice,
        quantity: grossQuantity,
        fee
      });
    }

    if (signal === "SELL" && positionQuantity > 0) {
      const grossValue = positionQuantity * executionPrice;
      const fee = grossValue * feeRate;
      cash = grossValue - fee;

      trades.push({
        side: "SELL",
        time: candle.candleTimeUtc,
        price: executionPrice,
        quantity: positionQuantity,
        fee
      });

      positionQuantity = 0;
      entryPrice = 0;
      entryIndex = null;
    }

    const equity = cash + positionQuantity * candle.closePrice;
    equityCurve.push(equity);
  }

  const lastClosePrice = params.candles[params.candles.length - 1]?.closePrice ?? 0;
  const finalCapital = cash + positionQuantity * lastClosePrice;

  return {
    strategyName: params.strategy.name,
    marketCode: params.marketCode,
    timeframe: params.timeframe,
    candleCount: params.candles.length,
    trades,
    equityCurve,
    metrics: calculateMetrics(trades, equityCurve, initialCapital, finalCapital)
  };
}
