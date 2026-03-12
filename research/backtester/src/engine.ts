import {
  DEFAULT_FEE_RATE,
  DEFAULT_INITIAL_CAPITAL,
  DEFAULT_SLIPPAGE_RATE
} from "./config.js";
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
    maxDrawdown,
    tradeCount: trades.length,
    winRate: completedTradeCount === 0 ? 0 : winningTradeCount / completedTradeCount
  };
}

export function runBacktest(params: {
  marketCode: string;
  timeframe: string;
  candles: Candle[];
  strategy: Strategy;
  initialCapital?: number;
  feeRate?: number;
  slippageRate?: number;
}): BacktestResult {
  const initialCapital = params.initialCapital ?? DEFAULT_INITIAL_CAPITAL;
  const feeRate = params.feeRate ?? DEFAULT_FEE_RATE;
  const slippageRate = params.slippageRate ?? DEFAULT_SLIPPAGE_RATE;

  let cash = initialCapital;
  let positionQuantity = 0;
  const trades: Trade[] = [];
  const equityCurve: number[] = [];

  for (let index = 1; index < params.candles.length; index += 1) {
    const signalIndex = index - 1;
    const signal = params.strategy.generateSignal({
      candles: params.candles,
      index: signalIndex,
      hasPosition: positionQuantity > 0
    });
    const candle = params.candles[index];
    const executionPrice =
      signal === "BUY"
        ? candle.openPrice * (1 + slippageRate)
        : candle.openPrice * (1 - slippageRate);

    if (signal === "BUY" && positionQuantity === 0 && cash > 0) {
      const grossQuantity = cash / executionPrice;
      const fee = cash * feeRate;
      const netCash = cash - fee;
      positionQuantity = netCash / executionPrice;
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
