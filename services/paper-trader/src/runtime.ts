import { PAPER_FEE_RATE, PAPER_SLIPPAGE_RATE } from "./config.js";
import {
  getPaperPosition,
  insertPaperOrder,
  loadRecentCandles,
  updatePaperSession,
  upsertPaperPosition
} from "./db.js";
import { createStrategyFromRecommendation } from "./strategy-factory.js";
import { streamTicker, type UpbitTickerMessage } from "./upbit-stream.js";

type RuntimeState = {
  cash: number;
  quantity: number;
  avgEntryPrice: number;
  realizedPnl: number;
  entryCandleIndex: number | null;
  candles: Array<{
    marketCode: string;
    timeframe: string;
    candleTimeUtc: Date;
    openPrice: number;
    highPrice: number;
    lowPrice: number;
    closePrice: number;
    volume: number;
  }>;
};

function getBucketStart(timestamp: number, timeframe: string): Date {
  const current = new Date(timestamp);

  if (timeframe === "1d") {
    return new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate()));
  }

  const minutes =
    timeframe === "1m" ? 1 : timeframe === "5m" ? 5 : timeframe === "1h" ? 60 : timeframe === "60m" ? 60 : 1;
  const bucketMs = minutes * 60 * 1000;
  return new Date(Math.floor(timestamp / bucketMs) * bucketMs);
}

function updateSyntheticCandle(
  candles: RuntimeState["candles"],
  timeframe: string,
  message: UpbitTickerMessage
): RuntimeState["candles"] {
  const bucketStart = getBucketStart(message.timestamp, timeframe);
  const last = candles[candles.length - 1];

  if (!last || last.candleTimeUtc.getTime() !== bucketStart.getTime()) {
    return [
      ...candles,
      {
        marketCode: message.code,
        timeframe,
        candleTimeUtc: bucketStart,
        openPrice: message.trade_price,
        highPrice: message.trade_price,
        lowPrice: message.trade_price,
        closePrice: message.trade_price,
        volume: message.trade_volume
      }
    ];
  }

  const nextCandles = candles.slice(0, -1);
  nextCandles.push({
    ...last,
    highPrice: Math.max(last.highPrice, message.trade_price),
    lowPrice: Math.min(last.lowPrice, message.trade_price),
    closePrice: message.trade_price,
    volume: last.volume + message.trade_volume
  });
  return nextCandles;
}

async function syncMarkToDb(params: {
  sessionId: number;
  marketCode: string;
  cash: number;
  quantity: number;
  avgEntryPrice: number;
  realizedPnl: number;
  markPrice: number;
}): Promise<void> {
  const unrealizedPnl =
    params.quantity === 0 ? 0 : (params.markPrice - params.avgEntryPrice) * params.quantity;
  const equity = params.cash + params.quantity * params.markPrice;

  await upsertPaperPosition({
    sessionId: params.sessionId,
    marketCode: params.marketCode,
    quantity: params.quantity,
    avgEntryPrice: params.avgEntryPrice,
    markPrice: params.markPrice,
    unrealizedPnl,
    realizedPnl: params.realizedPnl
  });

  await updatePaperSession({
    sessionId: params.sessionId,
    currentBalance: equity,
    status: "running"
  });
}

export async function runRecommendedLivePaperTrading(params: {
  sessionId: number;
  strategyName: string;
  parametersJson: unknown;
  marketCode: string;
  timeframe: string;
  startingBalance: number;
  maxEvents?: number;
}): Promise<void> {
  const strategy = createStrategyFromRecommendation({
    strategyName: params.strategyName,
    parametersJson: params.parametersJson
  });

  const existingPosition = await getPaperPosition({
    sessionId: params.sessionId,
    marketCode: params.marketCode
  });
  const recentCandles = await loadRecentCandles({
    marketCode: params.marketCode,
    timeframe: params.timeframe,
    limit: 300
  });

  const state: RuntimeState = {
    cash: existingPosition ? 0 : params.startingBalance,
    quantity: existingPosition?.quantity ?? 0,
    avgEntryPrice: existingPosition?.avgEntryPrice ?? 0,
    realizedPnl: existingPosition?.realizedPnl ?? 0,
    entryCandleIndex: existingPosition ? Math.max(0, recentCandles.length - 1) : null,
    candles: recentCandles
  };

  await streamTicker({
    marketCode: params.marketCode,
    maxEvents: params.maxEvents,
    onMessage: async (message) => {
      state.candles = updateSyntheticCandle(state.candles, params.timeframe, message);

      if (state.candles.length < 3) {
        await syncMarkToDb({
          sessionId: params.sessionId,
          marketCode: params.marketCode,
          cash: state.cash,
          quantity: state.quantity,
          avgEntryPrice: state.avgEntryPrice,
          realizedPnl: state.realizedPnl,
          markPrice: message.trade_price
        });
        return;
      }

      const signal = strategy.generateSignal({
        candles: state.candles,
        index: state.candles.length - 1,
        hasPosition: state.quantity > 0,
        currentPosition:
          state.quantity > 0 && state.entryCandleIndex !== null
            ? {
                entryPrice: state.avgEntryPrice,
                quantity: state.quantity,
                barsHeld: Math.max(0, state.candles.length - 1 - state.entryCandleIndex)
              }
            : undefined
      });

      if (signal === "BUY" && state.quantity === 0 && state.cash > 0) {
        const executedPrice = message.trade_price * (1 + PAPER_SLIPPAGE_RATE);
        const fee = state.cash * PAPER_FEE_RATE;
        const netCash = state.cash - fee;
        const quantity = netCash / executedPrice;

        await insertPaperOrder({
          sessionId: params.sessionId,
          side: "BUY",
          orderType: "market",
          requestedPrice: message.trade_price,
          executedPrice,
          quantity,
          fee,
          slippage: executedPrice - message.trade_price
        });

        state.cash = 0;
        state.quantity = quantity;
        state.avgEntryPrice = executedPrice;
        state.entryCandleIndex = state.candles.length - 1;
      }

      if (signal === "SELL" && state.quantity > 0) {
        const executedPrice = message.trade_price * (1 - PAPER_SLIPPAGE_RATE);
        const grossValue = state.quantity * executedPrice;
        const fee = grossValue * PAPER_FEE_RATE;
        const netValue = grossValue - fee;
        const realizedTradePnl = (executedPrice - state.avgEntryPrice) * state.quantity - fee;

        await insertPaperOrder({
          sessionId: params.sessionId,
          side: "SELL",
          orderType: "market",
          requestedPrice: message.trade_price,
          executedPrice,
          quantity: state.quantity,
          fee,
          slippage: message.trade_price - executedPrice
        });

        state.cash = netValue;
        state.realizedPnl += realizedTradePnl;
        state.quantity = 0;
        state.avgEntryPrice = 0;
        state.entryCandleIndex = null;
      }

      await syncMarkToDb({
        sessionId: params.sessionId,
        marketCode: params.marketCode,
        cash: state.cash,
        quantity: state.quantity,
        avgEntryPrice: state.avgEntryPrice,
        realizedPnl: state.realizedPnl,
        markPrice: message.trade_price
      });
    }
  });

  const finalMark = state.candles[state.candles.length - 1]?.closePrice ?? state.avgEntryPrice;

  await updatePaperSession({
    sessionId: params.sessionId,
    currentBalance: state.cash + state.quantity * finalMark,
    status: "stopped"
  });
}
