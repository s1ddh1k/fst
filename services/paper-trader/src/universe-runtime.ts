import {
  assertSupportedScoredDecisionTimeframe,
  buildMarketStateContext,
  type Candle,
  type MarketStateConfig
} from "../../../research/strategies/src/index.js";
import { getAtr } from "../../../research/strategies/src/factors/index.js";
import { createDrawdownCircuitBreaker } from "../../../research/strategies/src/portfolio-risk.js";
import { createVolatilityTargetSizer } from "../../../research/strategies/src/position-sizer.js";
import { createPortfolioCoordinator, createInitialPortfolioState } from "../../../research/backtester/src/portfolio/PortfolioCoordinator.js";
import { PAPER_FEE_RATE, PAPER_SLIPPAGE_RATE } from "./config.js";
import {
  insertPaperOrder,
  listPaperPositions,
  listSelectedUniverseMarkets,
  loadRecentCandlesForMarkets,
  updatePaperSession,
  upsertMarketFeatureSnapshot,
  upsertPaperPosition
} from "./db.js";
import { createMarketOrderExecutionModel } from "./execution-model.js";
import { createPaperRuntimeOpsGuard } from "./ops-guard.js";
import { resolveAvailablePaperCash } from "./runtime-balance.js";
import {
  createUniverseAlphaModelFromRecommendation,
  parseUniversePortfolioRecommendation
} from "./universe-portfolio-factory.js";
import { createScoredStrategyFromRecommendation } from "./strategy-factory.js";
import { streamTickers, type UpbitTickerMessage } from "./upbit-stream.js";

type PositionState = {
  quantity: number;
  avgEntryPrice: number;
};

type UniverseRuntimeState = {
  cash: number;
  positions: Map<string, PositionState>;
  realizedPnlByMarket: Map<string, number>;
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

function latestPrice(candles: Candle[]): number | null {
  return candles[candles.length - 1]?.closePrice ?? null;
}

function latestBucketTime(candles: Candle[]): Date | null {
  return candles[candles.length - 1]?.candleTimeUtc ?? null;
}

async function persistUniverseFeatureSnapshot(params: {
  universeName: string;
  timeframe: string;
  referenceTime: Date;
  universeCandlesByMarket: Record<string, Candle[]>;
  alphaContextConfig?: MarketStateConfig;
}): Promise<void> {
  const marketCodes = Object.keys(params.universeCandlesByMarket);

  if (marketCodes.length === 0) {
    return;
  }

  const sampleMarketCode = marketCodes[0];
  const sampleMarketState = buildMarketStateContext({
    marketCode: sampleMarketCode,
    referenceTime: params.referenceTime,
    universeName: params.universeName,
    universeCandlesByMarket: params.universeCandlesByMarket,
    config: params.alphaContextConfig
  });

  if (!sampleMarketState) {
    return;
  }

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
      config: params.alphaContextConfig
    });

    if (!marketState?.relativeStrength) {
      continue;
    }

    relativeStrengthRows.push({
      marketCode,
      relativeStrength: marketState.relativeStrength
    });
  }

  await upsertMarketFeatureSnapshot({
    universeName: params.universeName,
    timeframe: params.timeframe,
    config: params.alphaContextConfig,
    referenceTime: params.referenceTime,
    sampleSize: sampleMarketState.sampleSize,
    breadth: sampleMarketState.breadth,
    benchmarkMarketCode: sampleMarketState.benchmarkMarketCode,
    benchmark: sampleMarketState.benchmark,
    relativeStrengthRows
  });
}

function bucketMs(timeframe: string): number {
  return timeframe === "1m"
    ? 60_000
    : timeframe === "5m"
      ? 5 * 60_000
      : timeframe === "1h" || timeframe === "60m"
        ? 60 * 60_000
        : 24 * 60 * 60_000;
}

function previousBucketTime(time: Date, timeframe: string): Date {
  return new Date(time.getTime() - bucketMs(timeframe));
}

function fillSyntheticCandlesToBucket(
  candles: Candle[],
  timeframe: string,
  marketCode: string,
  targetBucket: Date
): Candle[] {
  if (candles.length === 0) {
    return candles;
  }

  const result = candles.slice();
  let last = result[result.length - 1];
  const step = bucketMs(timeframe);

  while (last && last.candleTimeUtc.getTime() < targetBucket.getTime()) {
    const nextTime = new Date(last.candleTimeUtc.getTime() + step);

    if (nextTime.getTime() > targetBucket.getTime()) {
      break;
    }

    last = {
      marketCode,
      timeframe,
      candleTimeUtc: nextTime,
      openPrice: last.closePrice,
      highPrice: last.closePrice,
      lowPrice: last.closePrice,
      closePrice: last.closePrice,
      volume: 0,
      quoteVolume: 0,
      isSynthetic: true
    };
    result.push(last);
  }

  return result.slice(-400);
}

function findCandleIndexAtOrBefore(candles: Candle[], referenceTime: Date): number {
  let left = 0;
  let right = candles.length - 1;
  let result = -1;
  const target = referenceTime.getTime();

  while (left <= right) {
    const middle = Math.floor((left + right) / 2);
    const current = candles[middle]?.candleTimeUtc.getTime() ?? Number.NEGATIVE_INFINITY;

    if (current <= target) {
      result = middle;
      left = middle + 1;
      continue;
    }

    right = middle - 1;
  }

  return result;
}

function averageQuoteVolume(candles: Candle[], endIndex: number, window: number): number {
  const start = Math.max(0, endIndex - window + 1);
  let total = 0;
  let count = 0;

  for (let index = start; index <= endIndex; index += 1) {
    const candle = candles[index];
    total += candle?.quoteVolume ?? ((candle?.closePrice ?? 0) * (candle?.volume ?? 0));
    count += 1;
  }

  return count === 0 ? 0 : total / count;
}

function estimateSpreadBps(candle: Candle): number {
  if (candle.closePrice <= 0) {
    return 20;
  }

  const rangeBps = ((candle.highPrice - candle.lowPrice) / candle.closePrice) * 10_000;
  return Math.max(5, Math.min(40, rangeBps * 0.15));
}

function normalizeLiquidity(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(1, Math.log10(value) / 8));
}

async function syncUniverseMarksToDb(params: {
  sessionId: number;
  cash: number;
  positions: Map<string, PositionState>;
  realizedPnlByMarket: Map<string, number>;
  universeCandlesByMarket: Record<string, Candle[]>;
}): Promise<void> {
  const marketCodes = new Set([
    ...params.realizedPnlByMarket.keys(),
    ...params.positions.keys()
  ]);
  let equity = params.cash;

  for (const marketCode of marketCodes) {
    const position = params.positions.get(marketCode);
    const quantity = position?.quantity ?? 0;
    const avgEntryPrice = position?.avgEntryPrice ?? 0;
    const markPrice = latestPrice(params.universeCandlesByMarket[marketCode] ?? []) ?? avgEntryPrice;
    const unrealizedPnl = quantity === 0 ? 0 : (markPrice - avgEntryPrice) * quantity;
    const realizedPnl = params.realizedPnlByMarket.get(marketCode) ?? 0;

    equity += quantity * markPrice;

    await upsertPaperPosition({
      sessionId: params.sessionId,
      marketCode,
      quantity,
      avgEntryPrice,
      markPrice,
      unrealizedPnl,
      realizedPnl
    });
  }

  await updatePaperSession({
    sessionId: params.sessionId,
    currentBalance: equity,
    status: "running"
  });
}

function toSinglePositionMap(position?: {
  market: string;
  quantity: number;
  avgEntryPrice: number;
}): Map<string, PositionState> {
  if (!position) {
    return new Map();
  }

  return new Map([
    [
      position.market,
      {
        quantity: position.quantity,
        avgEntryPrice: position.avgEntryPrice
      }
    ]
  ]);
}

function parseUniverseScoredRecommendation(parametersJson: unknown): {
  activeUniverseSize?: number;
} {
  const root =
    parametersJson && typeof parametersJson === "object" && !Array.isArray(parametersJson)
      ? (parametersJson as Record<string, unknown>)
      : {};

  return {
    activeUniverseSize:
      root.activeUniverseSize === undefined ? undefined : Number(root.activeUniverseSize)
  };
}

export async function runRecommendedUniverseScoredPaperTrading(params: {
  sessionId: number;
  strategyName: string;
  parametersJson: unknown;
  timeframe: string;
  startingBalance: number;
  currentBalance: number;
  universeName: string;
  maxEvents?: number;
}): Promise<void> {
  assertSupportedScoredDecisionTimeframe(params.timeframe);
  const scoredStrategy = createScoredStrategyFromRecommendation({
    strategyName: params.strategyName,
    parametersJson: params.parametersJson
  });
  const parsed = parseUniverseScoredRecommendation(params.parametersJson);
  const universeMarkets = await listSelectedUniverseMarkets({
    universeName: params.universeName,
    limit: parsed.activeUniverseSize ?? 12
  });

  if (universeMarkets.length === 0) {
    throw new Error(`No markets selected for universe: ${params.universeName}`);
  }

  const recentCandlesByMarket = await loadRecentCandlesForMarkets({
    marketCodes: universeMarkets,
    timeframe: params.timeframe,
    limit: 300
  });
  const existingPositions = await listPaperPositions(params.sessionId);
  const openPositions = existingPositions.filter((position) => position.quantity > 0);

  if (openPositions.length > 1) {
    throw new Error("Universe scored runtime requires at most one open paper position");
  }

  const openPosition = openPositions[0];
  const openNotional =
    openPosition && openPosition.quantity > 0
      ? openPosition.quantity * (openPosition.markPrice ?? openPosition.avgEntryPrice)
      : 0;
  const portfolioState = createInitialPortfolioState(
    resolveAvailablePaperCash({
      startingBalance: params.startingBalance,
      currentBalance: params.currentBalance,
      openNotional
    })
  );
  const positionCandles = openPosition
    ? recentCandlesByMarket[openPosition.marketCode] ?? []
    : [];

  if (openPosition) {
    portfolioState.position = {
      market: openPosition.marketCode,
      entryTimestamp: positionCandles[positionCandles.length - 1]?.candleTimeUtc ?? new Date(),
      entryPrice: openPosition.avgEntryPrice,
      quantity: openPosition.quantity,
      entryBarIndex: Math.max(0, positionCandles.length - 1)
    };
  }

  const realizedPnlByMarket = new Map(
    existingPositions.map((position) => [position.marketCode, position.realizedPnl])
  );
  const state: UniverseRuntimeState = {
    cash: portfolioState.cash,
    positions: toSinglePositionMap(
      portfolioState.position
        ? {
            market: portfolioState.position.market,
            quantity: portfolioState.position.quantity,
            avgEntryPrice: portfolioState.position.entryPrice
          }
        : undefined
    ),
    realizedPnlByMarket,
    universeCandlesByMarket: recentCandlesByMarket
  };
  const executionModel = createMarketOrderExecutionModel();
  const opsGuard = createPaperRuntimeOpsGuard({
    minSignalCandles: 2
  });
  const positionSizer = createVolatilityTargetSizer({ maxWeight: 0.25 });
  const riskManager = createDrawdownCircuitBreaker();
  const coordinator = createPortfolioCoordinator();
  let lastEvaluatedBucketTimeMs: number | null = null;
  let evaluationBarIndex = 0;
  let peakEquity = params.currentBalance;

  await streamTickers({
    marketCodes: universeMarkets,
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
      const currentBucketTime = latestBucketTime(candleUpdate.candles);

      if (!currentBucketTime) {
        return;
      }

      for (const marketCode of universeMarkets) {
        if (marketCode === message.code) {
          continue;
        }

        state.universeCandlesByMarket[marketCode] = fillSyntheticCandlesToBucket(
          state.universeCandlesByMarket[marketCode] ?? [],
          params.timeframe,
          marketCode,
          currentBucketTime
        );
      }

      if (
        !opsGuard.shouldEvaluateSignal({
          openedNewBucket: candleUpdate.openedNewBucket,
          candleCount: candleUpdate.candles.length
        })
      ) {
        await syncUniverseMarksToDb({
          sessionId: params.sessionId,
          cash: state.cash,
          positions: state.positions,
          realizedPnlByMarket: state.realizedPnlByMarket,
          universeCandlesByMarket: state.universeCandlesByMarket
        });
        return;
      }

      if (lastEvaluatedBucketTimeMs === currentBucketTime.getTime()) {
        return;
      }

      const referenceTime = previousBucketTime(currentBucketTime, params.timeframe);
      const signals = universeMarkets.flatMap((marketCode) => {
        const candles = state.universeCandlesByMarket[marketCode] ?? [];
        const signalIndex = findCandleIndexAtOrBefore(candles, referenceTime);

        if (signalIndex <= 0) {
          return [];
        }

        const candle = candles[signalIndex];
        const marketState = buildMarketStateContext({
          marketCode,
          referenceTime,
          universeName: params.universeName,
          universeCandlesByMarket: state.universeCandlesByMarket,
          config: scoredStrategy.contextConfig
        });
        const signalResult = scoredStrategy.generateSignal({
          candles,
          index: signalIndex,
          hasPosition: portfolioState.position?.market === marketCode,
          currentPosition:
            portfolioState.position?.market === marketCode
              ? {
                  entryPrice: portfolioState.position.entryPrice,
                  quantity: portfolioState.position.quantity,
                  barsHeld: Math.max(
                    0,
                    signalIndex - portfolioState.position.entryBarIndex
                  )
                }
              : undefined,
          marketState
        });

        return [
          {
            market: marketCode,
            timestamp: referenceTime,
            signal: signalResult.signal,
            conviction: signalResult.conviction,
            lastPrice: candle.closePrice,
            metadata: {
              estimatedSpreadBps: estimateSpreadBps(candle),
              liquidityScore: normalizeLiquidity(averageQuoteVolume(candles, signalIndex, 24)),
              avgDailyNotional: averageQuoteVolume(candles, signalIndex, 24),
              isSyntheticBar: candle.isSynthetic
            }
          }
        ];
      });

      await persistUniverseFeatureSnapshot({
        universeName: params.universeName,
        timeframe: params.timeframe,
        referenceTime,
        universeCandlesByMarket: state.universeCandlesByMarket,
        alphaContextConfig: scoredStrategy.contextConfig
      });

      evaluationBarIndex += 1;
      const heldPrice =
        portfolioState.position
          ? latestPrice(state.universeCandlesByMarket[portfolioState.position.market] ?? []) ??
            portfolioState.position.entryPrice
          : 0;
      const currentEquity =
        state.cash +
        (portfolioState.position ? portfolioState.position.quantity * heldPrice : 0);
      peakEquity = Math.max(peakEquity, currentEquity);
      const currentExposure =
        !portfolioState.position || currentEquity === 0
          ? 0
          : (portfolioState.position.quantity * heldPrice) / currentEquity;
      const riskCheck = riskManager.check({
        currentEquity,
        peakEquity,
        currentExposure
      });
      let intent = coordinator.coordinate({
        state: portfolioState,
        signals,
        timestamp: referenceTime,
        barIndex: evaluationBarIndex
      }).intent;

      if (riskCheck.mustLiquidateAll && portfolioState.position) {
        intent = {
          side: "SELL",
          market: portfolioState.position.market,
          timestamp: referenceTime,
          orderStyle: "market",
          reason: "risk_off_exit",
          conviction: 1,
          targetQuantity: portfolioState.position.quantity
        };
      }

      if (intent?.side === "BUY" && !riskCheck.canOpenNew) {
        intent = null;
      }

      if (intent?.side === "BUY") {
        const candles = state.universeCandlesByMarket[intent.market] ?? [];
        const signalIndex = findCandleIndexAtOrBefore(candles, referenceTime);
        const currentPrice = candles[signalIndex]?.closePrice ?? 0;
        const atr = getAtr(candles, signalIndex, 14) ?? currentPrice * 0.02;
        const sizeResult = positionSizer.calculate({
          conviction: intent.conviction,
          currentPrice,
          atr,
          portfolioEquity: currentEquity,
          currentPositionValue: 0
        });

        intent = {
          ...intent,
          targetNotional: state.cash * Math.min(sizeResult.targetWeight, riskCheck.maxExposure)
        };
      }

      if (intent?.side === "BUY" && (intent.targetNotional ?? 0) > 0) {
        const marketPrice = latestPrice(state.universeCandlesByMarket[intent.market] ?? []);

        if (marketPrice !== null) {
          const execution = executionModel.executeBuy({
            cash: Math.min(state.cash, intent.targetNotional ?? state.cash),
            marketPrice,
            feeRate: PAPER_FEE_RATE,
            slippageRate: PAPER_SLIPPAGE_RATE
          });

          await insertPaperOrder({
            sessionId: params.sessionId,
            marketCode: intent.market,
            side: "BUY",
            orderType: "market",
            requestedPrice: marketPrice,
            executedPrice: execution.executedPrice,
            quantity: execution.quantity,
            fee: execution.fee,
            slippage: execution.executedPrice - marketPrice
          });

          const allocatedCash = Math.min(state.cash, intent.targetNotional ?? state.cash);
          state.cash -= allocatedCash;
          portfolioState.cash = state.cash;
          coordinator.onBuyFilled({
            state: portfolioState,
            market: intent.market,
            entryPrice: execution.executedPrice,
            quantity: execution.quantity,
            barIndex: evaluationBarIndex,
            timestamp: currentBucketTime
          });
          state.positions = toSinglePositionMap({
            market: intent.market,
            quantity: execution.quantity,
            avgEntryPrice: execution.executedPrice
          });
        }
      }

      if (intent?.side === "SELL" && portfolioState.position) {
        const marketPrice = latestPrice(state.universeCandlesByMarket[intent.market] ?? []);

        if (marketPrice !== null) {
          const execution = executionModel.executeSell({
            quantity: portfolioState.position.quantity,
            marketPrice,
            avgEntryPrice: portfolioState.position.entryPrice,
            feeRate: PAPER_FEE_RATE,
            slippageRate: PAPER_SLIPPAGE_RATE
          });

          await insertPaperOrder({
            sessionId: params.sessionId,
            marketCode: intent.market,
            side: "SELL",
            orderType: "market",
            requestedPrice: marketPrice,
            executedPrice: execution.executedPrice,
            quantity: portfolioState.position.quantity,
            fee: execution.fee,
            slippage: marketPrice - execution.executedPrice
          });

          state.cash += execution.netValue;
          portfolioState.cash = state.cash;
          state.realizedPnlByMarket.set(
            intent.market,
            (state.realizedPnlByMarket.get(intent.market) ?? 0) + execution.realizedTradePnl
          );
          const pnlRatio =
            portfolioState.position.entryPrice === 0
              ? 0
              : (execution.executedPrice - portfolioState.position.entryPrice) /
                portfolioState.position.entryPrice;
          coordinator.onSellFilled({
            state: portfolioState,
            market: intent.market,
            barIndex: evaluationBarIndex,
            timestamp: currentBucketTime,
            reason: intent.reason,
            pnlRatio
          });
          state.positions = new Map();
        }
      }

      lastEvaluatedBucketTimeMs = currentBucketTime.getTime();
      riskManager.onBarClose(
        state.cash +
          (portfolioState.position
            ? portfolioState.position.quantity *
              (latestPrice(state.universeCandlesByMarket[portfolioState.position.market] ?? []) ??
                portfolioState.position.entryPrice)
            : 0)
      );

      await syncUniverseMarksToDb({
        sessionId: params.sessionId,
        cash: state.cash,
        positions: state.positions,
        realizedPnlByMarket: state.realizedPnlByMarket,
        universeCandlesByMarket: state.universeCandlesByMarket
      });
    }
  });

  await syncUniverseMarksToDb({
    sessionId: params.sessionId,
    cash: state.cash,
    positions: state.positions,
    realizedPnlByMarket: state.realizedPnlByMarket,
    universeCandlesByMarket: state.universeCandlesByMarket
  });

  await updatePaperSession({
    sessionId: params.sessionId,
    currentBalance:
      state.cash +
      [...state.positions.entries()].reduce((sum, [marketCode, position]) => {
        return (
          sum +
          position.quantity *
            (latestPrice(state.universeCandlesByMarket[marketCode] ?? []) ??
              position.avgEntryPrice)
        );
      }, 0),
    status: "stopped"
  });
}

export async function runRecommendedUniversePaperTrading(params: {
  sessionId: number;
  strategyName: string;
  parametersJson: unknown;
  timeframe: string;
  startingBalance: number;
  currentBalance: number;
  universeName: string;
  maxEvents?: number;
}): Promise<void> {
  const parsed = parseUniversePortfolioRecommendation(params.parametersJson);
  const alphaModel = createUniverseAlphaModelFromRecommendation(params.parametersJson);
  const universeMarkets = await listSelectedUniverseMarkets({
    universeName: params.universeName,
    limit: parsed.portfolioParameters.marketLimit ?? 30
  });

  if (universeMarkets.length === 0) {
    throw new Error(`No markets selected for universe: ${params.universeName}`);
  }

  const recentCandlesByMarket = await loadRecentCandlesForMarkets({
    marketCodes: universeMarkets,
    timeframe: params.timeframe,
    limit: 300
  });
  const existingPositions = await listPaperPositions(params.sessionId);
  const openNotional = existingPositions.reduce((sum, position) => {
    if (position.quantity <= 0) {
      return sum;
    }

    return sum + position.quantity * (position.markPrice ?? position.avgEntryPrice);
  }, 0);
  const state: UniverseRuntimeState = {
    cash: resolveAvailablePaperCash({
      startingBalance: params.startingBalance,
      currentBalance: params.currentBalance,
      openNotional
    }),
    positions: new Map(
      existingPositions
        .filter((position) => position.quantity > 0)
        .map((position) => [
          position.marketCode,
          {
            quantity: position.quantity,
            avgEntryPrice: position.avgEntryPrice
          }
        ])
    ),
    realizedPnlByMarket: new Map(
      existingPositions.map((position) => [position.marketCode, position.realizedPnl])
    ),
    universeCandlesByMarket: recentCandlesByMarket
  };
  const executionModel = createMarketOrderExecutionModel();
  const opsGuard = createPaperRuntimeOpsGuard({
    minSignalCandles: 2
  });
  let lastEvaluatedBucketTimeMs: number | null = null;

  await streamTickers({
    marketCodes: universeMarkets,
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
      const currentBucketTime = latestBucketTime(candleUpdate.candles);

      if (
        !opsGuard.shouldEvaluateSignal({
          openedNewBucket: candleUpdate.openedNewBucket,
          candleCount: candleUpdate.candles.length
        })
      ) {
        return;
      }

      const referenceTime = candleUpdate.candles[candleUpdate.candles.length - 2]?.candleTimeUtc;

      if (!currentBucketTime || !referenceTime) {
        return;
      }

      if (lastEvaluatedBucketTimeMs === currentBucketTime.getTime()) {
        return;
      }

      lastEvaluatedBucketTimeMs = currentBucketTime.getTime();

      await persistUniverseFeatureSnapshot({
        universeName: params.universeName,
        timeframe: params.timeframe,
        referenceTime,
        universeCandlesByMarket: state.universeCandlesByMarket,
        alphaContextConfig: alphaModel.contextConfig
      });

      const ranked = alphaModel
        .rankCandidates({
          referenceTime,
          universeName: params.universeName,
          marketCodes: universeMarkets,
          universeCandlesByMarket: state.universeCandlesByMarket
        })
        .filter((candidate) => candidate.score >= parsed.portfolioParameters.minScore)
        .slice(0, parsed.portfolioParameters.maxPositions);
      const retainedPositions = new Map<string, PositionState>();

      for (const [marketCode, position] of state.positions.entries()) {
        const candles = state.universeCandlesByMarket[marketCode] ?? [];
        const marketBucketTime = latestBucketTime(candles);
        const marketPrice = latestPrice(candles);

        if (
          marketBucketTime === null ||
          marketBucketTime.getTime() !== currentBucketTime.getTime() ||
          marketPrice === null
        ) {
          retainedPositions.set(marketCode, position);
          continue;
        }

        const execution = executionModel.executeSell({
          quantity: position.quantity,
          marketPrice,
          avgEntryPrice: position.avgEntryPrice,
          feeRate: PAPER_FEE_RATE,
          slippageRate: PAPER_SLIPPAGE_RATE
        });

        await insertPaperOrder({
          sessionId: params.sessionId,
          marketCode,
          side: "SELL",
          orderType: "market",
          requestedPrice: marketPrice,
          executedPrice: execution.executedPrice,
          quantity: position.quantity,
          fee: execution.fee,
          slippage: marketPrice - execution.executedPrice
        });

        state.cash += execution.netValue;
        state.realizedPnlByMarket.set(
          marketCode,
          (state.realizedPnlByMarket.get(marketCode) ?? 0) + execution.realizedTradePnl
        );
      }

      state.positions = retainedPositions;

      const buyable = ranked.filter((candidate) => {
        const candles = state.universeCandlesByMarket[candidate.marketCode] ?? [];
        const marketBucketTime = latestBucketTime(candles);

        return (
          marketBucketTime !== null &&
          marketBucketTime.getTime() === currentBucketTime.getTime() &&
          !state.positions.has(candidate.marketCode)
        );
      });
      const allocation = buyable.length === 0 ? 0 : state.cash / buyable.length;

      for (const candidate of buyable) {
        const marketPrice = latestPrice(state.universeCandlesByMarket[candidate.marketCode] ?? []);

        if (marketPrice === null || allocation <= 0) {
          continue;
        }

        const execution = executionModel.executeBuy({
          cash: allocation,
          marketPrice,
          feeRate: PAPER_FEE_RATE,
          slippageRate: PAPER_SLIPPAGE_RATE
        });

        await insertPaperOrder({
          sessionId: params.sessionId,
          marketCode: candidate.marketCode,
          side: "BUY",
          orderType: "market",
          requestedPrice: marketPrice,
          executedPrice: execution.executedPrice,
          quantity: execution.quantity,
          fee: execution.fee,
          slippage: execution.executedPrice - marketPrice
        });

        state.cash -= allocation;
        state.positions.set(candidate.marketCode, {
          quantity: execution.quantity,
          avgEntryPrice: execution.executedPrice
        });
      }

      await syncUniverseMarksToDb({
        sessionId: params.sessionId,
        cash: state.cash,
        positions: state.positions,
        realizedPnlByMarket: state.realizedPnlByMarket,
        universeCandlesByMarket: state.universeCandlesByMarket
      });
    }
  });

  await syncUniverseMarksToDb({
    sessionId: params.sessionId,
    cash: state.cash,
    positions: state.positions,
    realizedPnlByMarket: state.realizedPnlByMarket,
    universeCandlesByMarket: state.universeCandlesByMarket
  });

  await updatePaperSession({
    sessionId: params.sessionId,
    currentBalance: state.cash + [...state.positions.entries()].reduce((sum, [marketCode, position]) => {
      return sum + position.quantity * (latestPrice(state.universeCandlesByMarket[marketCode] ?? []) ?? position.avgEntryPrice);
    }, 0),
    status: "stopped"
  });
}
