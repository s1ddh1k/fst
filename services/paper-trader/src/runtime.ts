import {
  assertSupportedScoredDecisionTimeframe,
  buildMarketStateContext,
  type Candle,
  type MarketStateContext
} from "../../../research/strategies/src/index.js";
import { createVolatilityTargetSizer } from "../../../research/strategies/src/position-sizer.js";
import { createDrawdownCircuitBreaker } from "../../../research/strategies/src/portfolio-risk.js";
import { getAtr } from "../../../research/strategies/src/factors/index.js";
import { PAPER_FEE_RATE, PAPER_SLIPPAGE_RATE } from "./config.js";
import {
  getPaperPosition,
  listSelectedUniverseMarkets,
  loadRecentCandlesForMarkets,
  updatePaperSession,
  upsertMarketFeatureSnapshot,
  upsertPaperPosition
} from "./db.js";
import { createMarketOrderExecutionModel } from "./execution-model.js";
import { createMarketPolicyCache } from "./market-policy-cache.js";
import { createPaperRuntimeOpsGuard } from "./ops-guard.js";
import { createPaperOrderStateBridge } from "./order-state-bridge.js";
import { applyPaperSellNetValue, resolveAvailablePaperCash } from "./runtime-balance.js";
import { createStrategyFromRecommendation, createScoredStrategyFromRecommendation, isScoredStrategy } from "./strategy-factory.js";
import {
  runRecommendedUniversePaperTrading,
  runRecommendedUniverseScoredPaperTrading
} from "./universe-runtime.js";
import { streamTickers, type UpbitTickerMessage } from "./upbit-stream.js";

type RuntimeState = {
  cash: number;
  quantity: number;
  avgEntryPrice: number;
  realizedPnl: number;
  entryCandleIndex: number | null;
  candles: Candle[];
  universeCandlesByMarket: Record<string, Candle[]>;
};

type SyntheticCandleUpdate = {
  candles: Candle[];
  openedNewBucket: boolean;
  droppedCount: number;
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
  candles: Candle[],
  timeframe: string,
  message: UpbitTickerMessage
): SyntheticCandleUpdate {
  const bucketStart = getBucketStart(message.timestamp, timeframe);
  const last = candles[candles.length - 1];

  if (!last || last.candleTimeUtc.getTime() !== bucketStart.getTime()) {
    const next = [
      ...candles,
      {
        marketCode: message.code,
        timeframe,
        candleTimeUtc: bucketStart,
        openPrice: message.trade_price,
        highPrice: message.trade_price,
        lowPrice: message.trade_price,
        closePrice: message.trade_price,
        volume: message.trade_volume,
        quoteVolume: message.trade_price * message.trade_volume,
        isSynthetic: false
      }
    ];
    const trimmed = next.slice(-400);

    return {
      candles: trimmed,
      openedNewBucket: true,
      droppedCount: Math.max(0, next.length - trimmed.length)
    };
  }

  const nextCandles = candles.slice(0, -1);
  nextCandles.push({
    ...last,
    highPrice: Math.max(last.highPrice, message.trade_price),
    lowPrice: Math.min(last.lowPrice, message.trade_price),
    closePrice: message.trade_price,
    volume: last.volume + message.trade_volume,
    quoteVolume: (last.quoteVolume ?? last.closePrice * last.volume) + message.trade_price * message.trade_volume,
    isSynthetic: false
  });
  const trimmed = nextCandles.slice(-400);

  return {
    candles: trimmed,
    openedNewBucket: false,
    droppedCount: Math.max(0, nextCandles.length - trimmed.length)
  };
}

function ensureSubscribedMarkets(marketCode: string, universeMarkets: string[]): string[] {
  const unique = new Set([marketCode, ...universeMarkets]);
  return [...unique];
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

async function buildSignalMarketState(params: {
  marketCode: string;
  timeframe: string;
  universeName?: string;
  benchmarkMarketCode?: string;
  referenceTime: Date;
  strategy: ReturnType<typeof createStrategyFromRecommendation>;
  universeCandlesByMarket: Record<string, Candle[]>;
}): Promise<MarketStateContext | undefined> {
  const marketCodes = Object.keys(params.universeCandlesByMarket);

  if (marketCodes.length === 0) {
    return undefined;
  }

  const sampleMarketCode = marketCodes.includes(params.marketCode)
    ? params.marketCode
    : marketCodes[0];
  const sampleMarketState = buildMarketStateContext({
    marketCode: sampleMarketCode,
    referenceTime: params.referenceTime,
    universeName: params.universeName,
    universeCandlesByMarket: params.universeCandlesByMarket,
    config: params.strategy.contextConfig
  });

  if (!sampleMarketState) {
    return undefined;
  }

  let targetMarketState =
    params.marketCode === sampleMarketCode ? sampleMarketState : undefined;
  const relativeStrengthRows = [];

  if (sampleMarketState.relativeStrength) {
    relativeStrengthRows.push({
      marketCode: sampleMarketCode,
      relativeStrength: sampleMarketState.relativeStrength
    });
  }

  for (const marketCode of marketCodes) {
    if (marketCode === sampleMarketCode) {
      continue;
    }

    const marketState = buildMarketStateContext({
      marketCode,
      referenceTime: params.referenceTime,
      universeName: params.universeName,
      universeCandlesByMarket: params.universeCandlesByMarket,
      config: params.strategy.contextConfig
    });

    if (marketCode === params.marketCode) {
      targetMarketState = marketState;
    }

    if (!marketState?.relativeStrength) {
      continue;
    }

    relativeStrengthRows.push({
      marketCode,
      relativeStrength: marketState.relativeStrength
    });
  }

  if (params.universeName) {
    await upsertMarketFeatureSnapshot({
      universeName: params.universeName,
      timeframe: params.timeframe,
      config: params.strategy.contextConfig,
      referenceTime: params.referenceTime,
      sampleSize: sampleMarketState.sampleSize,
      breadth: sampleMarketState.breadth,
      benchmarkMarketCode: sampleMarketState.benchmarkMarketCode,
      benchmark: sampleMarketState.benchmark,
      relativeStrengthRows
    });
  }

  return targetMarketState;
}

export async function runRecommendedLivePaperTrading(params: {
  sessionId: number;
  strategyType?: string;
  strategyName: string;
  parametersJson: unknown;
  marketCode: string;
  timeframe: string;
  startingBalance: number;
  currentBalance?: number;
  universeName?: string;
  benchmarkMarketCode?: string;
  maxEvents?: number;
}): Promise<void> {
  if (
    params.strategyType === "universe_portfolio" ||
    params.strategyType === "universe_scored" ||
    (params.strategyType === "single_scored" && params.marketCode.startsWith("UNIVERSE:"))
  ) {
    if (!params.universeName) {
      throw new Error("universeName is required for universe portfolio paper trading");
    }

    if (params.strategyType === "universe_scored" || params.marketCode.startsWith("UNIVERSE:")) {
      assertSupportedScoredDecisionTimeframe(params.timeframe);
    }

    if (params.strategyType === "universe_portfolio") {
      await runRecommendedUniversePaperTrading({
        sessionId: params.sessionId,
        strategyName: params.strategyName,
        parametersJson: params.parametersJson,
        timeframe: params.timeframe,
        startingBalance: params.startingBalance,
        currentBalance: params.currentBalance ?? params.startingBalance,
        universeName: params.universeName,
        maxEvents: params.maxEvents
      });
    } else {
      await runRecommendedUniverseScoredPaperTrading({
        sessionId: params.sessionId,
        strategyName: params.strategyName,
        parametersJson: params.parametersJson,
        timeframe: params.timeframe,
        startingBalance: params.startingBalance,
        currentBalance: params.currentBalance ?? params.startingBalance,
        universeName: params.universeName,
        maxEvents: params.maxEvents
      });
    }
    return;
  }

  const isScored = isScoredStrategy(params.strategyName);
  if (isScored) {
    assertSupportedScoredDecisionTimeframe(params.timeframe);
  }
  const scoredStrategy = isScored
    ? createScoredStrategyFromRecommendation({
        strategyName: params.strategyName,
        parametersJson: params.parametersJson
      })
    : undefined;
  const strategy = isScored
    ? undefined
    : createStrategyFromRecommendation({
        strategyName: params.strategyName,
        parametersJson: params.parametersJson
      });
  const positionSizer = isScored ? createVolatilityTargetSizer() : undefined;
  const riskManager = isScored ? createDrawdownCircuitBreaker() : undefined;
  const executionModel = createMarketOrderExecutionModel();
  const marketPolicyCache = createMarketPolicyCache({
    minOrderNotional: 5_000,
    takerFeeRate: PAPER_FEE_RATE
  });
  const orderStateBridge = createPaperOrderStateBridge();
  const opsGuard = createPaperRuntimeOpsGuard({
    minSignalCandles: 2
  });

  const existingPosition = await getPaperPosition({
    sessionId: params.sessionId,
    marketCode: params.marketCode
  });
  const universeMarkets = params.universeName
    ? await listSelectedUniverseMarkets({
        universeName: params.universeName,
        limit: 30
      })
    : [];
  const subscribedMarkets = ensureSubscribedMarkets(params.marketCode, universeMarkets);
  const recentCandlesByMarket = await loadRecentCandlesForMarkets({
    marketCodes: subscribedMarkets,
    timeframe: params.timeframe,
    limit: 300
  });
  const recentCandles = recentCandlesByMarket[params.marketCode] ?? [];
  const openNotional =
    existingPosition && existingPosition.quantity > 0
      ? existingPosition.quantity * (existingPosition.markPrice ?? existingPosition.avgEntryPrice)
      : 0;

  const initialEquity = params.currentBalance ?? params.startingBalance;
  let runtimePeakEquity = initialEquity;

  const state: RuntimeState = {
    cash: resolveAvailablePaperCash({
      startingBalance: params.startingBalance,
      currentBalance: params.currentBalance,
      openNotional
    }),
    quantity: existingPosition?.quantity ?? 0,
    avgEntryPrice: existingPosition?.avgEntryPrice ?? 0,
    realizedPnl: existingPosition?.realizedPnl ?? 0,
    entryCandleIndex: existingPosition ? Math.max(0, recentCandles.length - 1) : null,
    candles: recentCandles,
    universeCandlesByMarket: recentCandlesByMarket
  };

  await streamTickers({
    marketCodes: subscribedMarkets,
    maxEvents: params.maxEvents,
    onMessage: async (message) => {
      if (
        !opsGuard.acceptsTicker({
          marketCode: message.code,
          timestamp: message.timestamp
        })
      ) {
        return;
      }

      const candleUpdate = updateSyntheticCandle(
        state.universeCandlesByMarket[message.code] ?? [],
        params.timeframe,
        message
      );
      state.universeCandlesByMarket[message.code] = candleUpdate.candles;

      if (message.code !== params.marketCode) {
        return;
      }

      state.candles = candleUpdate.candles;

      if (state.entryCandleIndex !== null && candleUpdate.droppedCount > 0) {
        state.entryCandleIndex = Math.max(0, state.entryCandleIndex - candleUpdate.droppedCount);
      }

      if (
        !opsGuard.shouldEvaluateSignal({
          openedNewBucket: candleUpdate.openedNewBucket,
          candleCount: state.candles.length
        })
      ) {
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

      const signalIndex = state.candles.length - 2;
      const marketState = await buildSignalMarketState({
        marketCode: params.marketCode,
        timeframe: params.timeframe,
        universeName: params.universeName,
        benchmarkMarketCode: params.benchmarkMarketCode,
        referenceTime: state.candles[signalIndex].candleTimeUtc,
        strategy: isScored && scoredStrategy
          ? { name: scoredStrategy.name, parameters: scoredStrategy.parameters, contextConfig: scoredStrategy.contextConfig, generateSignal: (ctx) => scoredStrategy.generateSignal(ctx).signal }
          : strategy!,
        universeCandlesByMarket: state.universeCandlesByMarket
      });

      const signalContext = {
        candles: state.candles,
        index: signalIndex,
        hasPosition: state.quantity > 0,
        marketState,
        currentPosition:
          state.quantity > 0 && state.entryCandleIndex !== null
            ? {
                entryPrice: state.avgEntryPrice,
                quantity: state.quantity,
                barsHeld: Math.max(0, signalIndex - state.entryCandleIndex)
              }
            : undefined
      };

      const signal = isScored && scoredStrategy
        ? scoredStrategy.generateSignal(signalContext).signal
        : strategy!.generateSignal(signalContext);
      const conviction = isScored && scoredStrategy
        ? scoredStrategy.generateSignal(signalContext).conviction
        : 1;

      if (isScored && riskManager) {
        const currentEquity = state.cash + state.quantity * message.trade_price;
        runtimePeakEquity = Math.max(runtimePeakEquity, currentEquity);
        const riskCheck = riskManager.check({
          currentEquity,
          peakEquity: runtimePeakEquity,
          currentExposure: currentEquity === 0 ? 0 : (state.quantity * message.trade_price) / currentEquity
        });

        if (riskCheck.mustLiquidateAll && state.quantity > 0) {
          const execution = executionModel.executeSell({
            quantity: state.quantity,
            marketPrice: message.trade_price,
            avgEntryPrice: state.avgEntryPrice,
            feeRate: PAPER_FEE_RATE,
            slippageRate: PAPER_SLIPPAGE_RATE
          });

          await orderStateBridge.recordFilledOrder({
            sessionId: params.sessionId,
            marketCode: params.marketCode,
            side: "SELL",
            orderType: "market",
            requestedPrice: message.trade_price,
            executedPrice: execution.executedPrice,
            quantity: state.quantity,
            fee: execution.fee,
            slippage: message.trade_price - execution.executedPrice,
            marketPolicy: marketPolicyCache.get(params.marketCode, message.trade_price),
            reason: "risk_liquidation"
          });

          state.cash = applyPaperSellNetValue(state.cash, execution.netValue);
          state.realizedPnl += execution.realizedTradePnl;
          state.quantity = 0;
          state.avgEntryPrice = 0;
          state.entryCandleIndex = null;
        }

        riskManager.onBarClose(state.cash + state.quantity * message.trade_price);
      }

      if (signal === "BUY" && state.quantity === 0 && state.cash > 0) {
        let allocatedCash = state.cash;

        if (isScored && positionSizer) {
          const atr = getAtr(state.candles, signalIndex, 14) ?? message.trade_price * 0.02;
          const sizeResult = positionSizer.calculate({
            conviction,
            currentPrice: message.trade_price,
            atr,
            portfolioEquity: state.cash,
            currentPositionValue: 0
          });
          allocatedCash = state.cash * sizeResult.targetWeight;
        }

        const execution = executionModel.executeBuy({
          cash: allocatedCash,
          marketPrice: message.trade_price,
          feeRate: PAPER_FEE_RATE,
          slippageRate: PAPER_SLIPPAGE_RATE
        });

        await orderStateBridge.recordFilledOrder({
          sessionId: params.sessionId,
          marketCode: params.marketCode,
          side: "BUY",
          orderType: "market",
          requestedPrice: message.trade_price,
          executedPrice: execution.executedPrice,
          quantity: execution.quantity,
          fee: execution.fee,
          slippage: execution.executedPrice - message.trade_price,
          marketPolicy: marketPolicyCache.get(params.marketCode, message.trade_price),
          reason: "signal_buy"
        });

        state.cash -= allocatedCash;
        state.quantity = execution.quantity;
        state.avgEntryPrice = execution.executedPrice;
        state.entryCandleIndex = signalIndex + 1;
      }

      if (signal === "SELL" && state.quantity > 0) {
        const execution = executionModel.executeSell({
          quantity: state.quantity,
          marketPrice: message.trade_price,
          avgEntryPrice: state.avgEntryPrice,
          feeRate: PAPER_FEE_RATE,
          slippageRate: PAPER_SLIPPAGE_RATE
        });

        await orderStateBridge.recordFilledOrder({
          sessionId: params.sessionId,
          marketCode: params.marketCode,
          side: "SELL",
          orderType: "market",
          requestedPrice: message.trade_price,
          executedPrice: execution.executedPrice,
          quantity: state.quantity,
          fee: execution.fee,
          slippage: message.trade_price - execution.executedPrice,
          marketPolicy: marketPolicyCache.get(params.marketCode, message.trade_price),
          reason: "signal_sell"
        });

        state.cash = applyPaperSellNetValue(state.cash, execution.netValue);
        state.realizedPnl += execution.realizedTradePnl;
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
