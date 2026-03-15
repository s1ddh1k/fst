import {
  assertSupportedScoredDecisionTimeframe,
  buildMarketStateContext
} from "../../../strategies/src/index.js";
import type { PositionContext } from "../../../strategies/src/types.js";
import { getAtr } from "../../../strategies/src/factors/index.js";
import {
  DEFAULT_FEE_RATE,
  DEFAULT_INITIAL_CAPITAL
} from "../config.js";
import { runBootstrapValidation } from "../bootstrap.js";
import { runRandomBenchmark } from "../random-benchmark.js";
import type { ScoredBacktestResult, Trade } from "../types.js";
import type { UniverseScoredBacktestParams } from "./backtest-types.js";
import { normalizeCandlesToFullGrid } from "../universe/candle-normalizer.js";
import { buildPointInTimeUniverse } from "../universe/universe-selector.js";
import {
  createPortfolioCoordinator,
  createInitialPortfolioState
} from "../portfolio/PortfolioCoordinator.js";
import type { CandidateSignal, OrderIntent } from "../portfolio/portfolioTypes.js";
import { createExecutionSimulator } from "../execution/ExecutionSimulator.js";
import { createUpbitKrwExchangeAdapter } from "../execution/exchangeAdapter.js";
import {
  createEmptyGhostTradeStudySummary,
  createGhostTradeStudyCollector
} from "../ghost/ghost-trade-study.js";

function calculateMetrics(params: {
  trades: Trade[];
  equityCurve: number[];
  initialCapital: number;
  feePaid: number;
  slippagePaid: number;
  turnover: number;
  rejectedOrdersCount: number;
  cooldownSkipsCount: number;
  holdBars: number[];
}): ScoredBacktestResult["metrics"] {
  let peak = params.initialCapital;
  let maxDrawdown = 0;

  for (const equity of params.equityCurve) {
    peak = Math.max(peak, equity);
    const drawdown = peak === 0 ? 0 : (peak - equity) / peak;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
  }

  let completedTradeCount = 0;
  let winningTradeCount = 0;

  for (let index = 1; index < params.trades.length; index += 2) {
    const buy = params.trades[index - 1];
    const sell = params.trades[index];

    if (buy.side === "BUY" && sell.side === "SELL" && buy.price > 0) {
      completedTradeCount += 1;
      const grossReturn = (sell.price - buy.price) / buy.price;
      const feeImpact = (buy.fee + sell.fee) / (buy.price * buy.quantity);

      if (grossReturn - feeImpact > 0) {
        winningTradeCount += 1;
      }
    }
  }

  const finalCapital = params.equityCurve[params.equityCurve.length - 1] ?? params.initialCapital;
  const grossCapital = finalCapital + params.feePaid + params.slippagePaid;
  const avgHoldBars =
    params.holdBars.length === 0
      ? 0
      : params.holdBars.reduce((sum, value) => sum + value, 0) / params.holdBars.length;
  const netReturn =
    params.initialCapital === 0 ? 0 : (finalCapital - params.initialCapital) / params.initialCapital;
  const grossReturn =
    params.initialCapital === 0 ? 0 : (grossCapital - params.initialCapital) / params.initialCapital;

  return {
    initialCapital: params.initialCapital,
    finalCapital,
    totalReturn: netReturn,
    grossReturn,
    netReturn,
    maxDrawdown,
    tradeCount: params.trades.length,
    winRate: completedTradeCount === 0 ? 0 : winningTradeCount / completedTradeCount,
    turnover: params.initialCapital === 0 ? 0 : params.turnover / params.initialCapital,
    avgHoldBars,
    feePaid: params.feePaid,
    slippagePaid: params.slippagePaid,
    rejectedOrdersCount: params.rejectedOrdersCount,
    cooldownSkipsCount: params.cooldownSkipsCount
  };
}

function markToMarket(params: {
  cash: number;
  position?: { market: string; quantity: number };
  candlesByMarket: Record<string, import("../types.js").Candle[]>;
  index: number;
}): number {
  if (!params.position) {
    return params.cash;
  }

  const closePrice = params.candlesByMarket[params.position.market]?.[params.index]?.closePrice;
  return params.cash + params.position.quantity * (closePrice ?? 0);
}

function findFirstIndexAtOrAfter(timeline: Date[], target: Date): number {
  let left = 0;
  let right = timeline.length - 1;
  let result = timeline.length;
  const targetMs = target.getTime();

  while (left <= right) {
    const middle = Math.floor((left + right) / 2);
    const current = timeline[middle]?.getTime() ?? Number.POSITIVE_INFINITY;

    if (current >= targetMs) {
      result = middle;
      right = middle - 1;
      continue;
    }

    left = middle + 1;
  }

  return result;
}

function findLastIndexAtOrBefore(timeline: Date[], target: Date): number {
  let left = 0;
  let right = timeline.length - 1;
  let result = -1;
  const targetMs = target.getTime();

  while (left <= right) {
    const middle = Math.floor((left + right) / 2);
    const current = timeline[middle]?.getTime() ?? Number.NEGATIVE_INFINITY;

    if (current <= targetMs) {
      result = middle;
      left = middle + 1;
      continue;
    }

    right = middle - 1;
  }

  return result;
}

function averageQuoteVolume(
  candles: import("../types.js").Candle[],
  endIndex: number,
  window: number
): number {
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

function estimateSpreadBps(candle: import("../types.js").Candle): number {
  if (candle.closePrice <= 0) {
    return 20;
  }

  const rangeBps = ((candle.highPrice - candle.lowPrice) / candle.closePrice) * 10_000;
  return Math.max(5, Math.min(40, rangeBps * 0.15));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function buildPositionContext(params: {
  entryPrice: number;
  quantity: number;
  entryBarIndex: number;
  currentIndex: number;
}): PositionContext {
  return {
    entryPrice: params.entryPrice,
    quantity: params.quantity,
    barsHeld: Math.max(0, params.currentIndex - params.entryBarIndex)
  };
}

function buildCandidateSignals(params: {
  decisionIndex: number;
  decisionTime: Date;
  marketCodes: string[];
  normalizedCandlesByMarket: Record<string, import("../types.js").Candle[]>;
  strategy: UniverseScoredBacktestParams["strategy"];
  universeName: string;
  position?: {
    market: string;
    entryPrice: number;
    quantity: number;
    entryBarIndex: number;
  };
}): CandidateSignal[] {
  const signals: CandidateSignal[] = [];
  const universeCandlesByMarket = Object.fromEntries(
    params.marketCodes
      .filter((marketCode) => (params.normalizedCandlesByMarket[marketCode]?.length ?? 0) > params.decisionIndex)
      .map((marketCode) => [marketCode, params.normalizedCandlesByMarket[marketCode]])
  );

  for (const marketCode of params.marketCodes) {
    const candles = params.normalizedCandlesByMarket[marketCode];
    const candle = candles?.[params.decisionIndex];

    if (!candles || !candle) {
      continue;
    }

    const positionContext =
      params.position && params.position.market === marketCode
        ? buildPositionContext({
            entryPrice: params.position.entryPrice,
            quantity: params.position.quantity,
            entryBarIndex: params.position.entryBarIndex,
            currentIndex: params.decisionIndex
          })
        : undefined;
    const marketState = buildMarketStateContext({
      marketCode,
      referenceTime: params.decisionTime,
      universeName: params.universeName,
      universeCandlesByMarket,
      config: params.strategy.contextConfig
    });
    const signalResult = params.strategy.generateSignal({
      candles,
      index: params.decisionIndex,
      hasPosition: positionContext !== undefined,
      currentPosition: positionContext,
      marketState
    });
    const avgDailyNotional = averageQuoteVolume(candles, params.decisionIndex, 24);
    const liquidityScore = clamp01(avgDailyNotional <= 0 ? 0 : Math.log10(avgDailyNotional) / 8);

    signals.push({
      market: marketCode,
      timestamp: params.decisionTime,
      signal: signalResult.signal,
      conviction: signalResult.conviction,
      lastPrice: candle.closePrice,
      metadata: {
        estimatedSpreadBps: estimateSpreadBps(candle),
        liquidityScore,
        avgDailyNotional,
        isSyntheticBar: candle.isSynthetic
      }
    });
  }

  return signals;
}

function toSyntheticMarketCode(universeName: string): string {
  return `UNIVERSE:${universeName}`;
}

export function runUniverseScoredBacktest(params: UniverseScoredBacktestParams): ScoredBacktestResult {
  assertSupportedScoredDecisionTimeframe(params.timeframe);
  const initialCapital = params.initialCapital ?? DEFAULT_INITIAL_CAPITAL;
  const exchangeAdapter =
    params.exchangeAdapter ??
    createUpbitKrwExchangeAdapter({
      makerFeeRate: params.feeRate ?? DEFAULT_FEE_RATE,
      takerFeeRate: params.feeRate ?? DEFAULT_FEE_RATE
    });
  const normalized = normalizeCandlesToFullGrid({
    candlesByMarket: params.candidateCandlesByMarket,
    timeframe: params.timeframe
  });
  const timeline = normalized.timeline;
  const marketCodes = Object.keys(normalized.candlesByMarket).sort((left, right) =>
    left.localeCompare(right)
  );
  const decisionLagBars =
    params.executionPolicy?.decisionToExecutionLagBars ??
    createExecutionSimulator({
      exchangeAdapter,
      policy: params.executionPolicy
    }).policy.decisionToExecutionLagBars;
  const evaluationStartIndex = params.evaluationRange
    ? findFirstIndexAtOrAfter(timeline, params.evaluationRange.start)
    : 0;
  const evaluationEndIndex = params.evaluationRange
    ? findLastIndexAtOrBefore(timeline, params.evaluationRange.end)
    : timeline.length - 1;
  const maxDecisionExclusive = Math.min(
    timeline.length - decisionLagBars,
    evaluationEndIndex - decisionLagBars + 1
  );
  const evaluationCandleCount =
    evaluationStartIndex > evaluationEndIndex ? 0 : evaluationEndIndex - evaluationStartIndex + 1;

  if (
    timeline.length < 2 ||
    marketCodes.length === 0 ||
    evaluationStartIndex >= timeline.length ||
    evaluationCandleCount <= 0 ||
    maxDecisionExclusive <= evaluationStartIndex
  ) {
    return {
      strategyName: params.strategy.name,
      marketCode: toSyntheticMarketCode(params.universeName),
      timeframe: params.timeframe,
      candleCount: Math.max(0, evaluationCandleCount),
      trades: [],
      equityCurve: [initialCapital],
      metrics: calculateMetrics({
        trades: [],
        equityCurve: [initialCapital],
        initialCapital,
        feePaid: 0,
        slippagePaid: 0,
        turnover: 0,
        rejectedOrdersCount: 0,
        cooldownSkipsCount: 0,
        holdBars: []
      }),
      positionSizing: params.positionSizer.name,
      riskManagement: params.riskManager.name,
      averagePositionWeight: 0,
      maxPositionWeight: 0,
      circuitBreakerTriggered: 0,
      signalCount: 0,
      ghostSignalCount: 0,
      ghostStudy: createEmptyGhostTradeStudySummary(),
      universeName: params.universeName,
      marketCount: marketCodes.length
    };
  }

  const universeSchedule = buildPointInTimeUniverse({
    candlesByMarket: normalized.candlesByMarket,
    timeline,
    config: params.universeConfig
  });
  const coordinator = createPortfolioCoordinator(params.coordinatorConfig);
  const executionSimulator = createExecutionSimulator({
    exchangeAdapter,
    policy: params.executionPolicy
  });
  const portfolioState = createInitialPortfolioState(initialCapital);
  const trades: Trade[] = [];
  const equityCurve: number[] = [initialCapital];
  const holdBars: number[] = [];
  let feePaidTotal = 0;
  let slippagePaidTotal = 0;
  let turnoverNotional = 0;
  let cooldownSkipsCount = 0;
  let rejectedOrdersCount = 0;
  let weightSum = 0;
  let weightCount = 0;
  let maxWeight = 0;
  let circuitBreakerTriggered = 0;
  let signalCount = 0;
  let peakEquity = initialCapital;
  const ghostStudyCollector = createGhostTradeStudyCollector({
    exchangeAdapter,
    policy: executionSimulator.policy,
    evaluationEndIndex,
    studyNotional: Math.max(exchangeAdapter.rules.minOrderNotional, initialCapital * 0.25)
  });

  for (let decisionIndex = evaluationStartIndex; decisionIndex < maxDecisionExclusive; decisionIndex += 1) {
    const decisionTime = timeline[decisionIndex];
    const executionIndex = decisionIndex + executionSimulator.policy.decisionToExecutionLagBars;
    const currentEquity = markToMarket({
      cash: portfolioState.cash,
      position: portfolioState.position,
      candlesByMarket: normalized.candlesByMarket,
      index: decisionIndex
    });
    peakEquity = Math.max(peakEquity, currentEquity);
    const currentExposure =
      !portfolioState.position || currentEquity === 0
        ? 0
        : (portfolioState.position.quantity *
            (normalized.candlesByMarket[portfolioState.position.market]?.[decisionIndex]?.closePrice ?? 0)) /
          currentEquity;
    const riskCheck = params.riskManager.check({
      currentEquity,
      peakEquity,
      currentExposure
    });
    const activeSnapshot = universeSchedule.get(decisionTime.toISOString());
    const activeMarkets = new Set(activeSnapshot?.marketCodes ?? []);

    if (portfolioState.position) {
      activeMarkets.add(portfolioState.position.market);
    }

    const signals = buildCandidateSignals({
      decisionIndex,
      decisionTime,
      marketCodes: [...activeMarkets].sort((left, right) => left.localeCompare(right)),
      normalizedCandlesByMarket: normalized.candlesByMarket,
      strategy: params.strategy,
      universeName: params.universeName,
      position: portfolioState.position
    });
    for (const signal of signals) {
      const candles = normalized.candlesByMarket[signal.market];

      if (!candles) {
        continue;
      }

      ghostStudyCollector.record({
        signal,
        candles,
        decisionIndex,
        decisionLagBars
      });
    }
    const coordination = coordinator.coordinate({
      state: portfolioState,
      signals,
      timestamp: decisionTime,
      barIndex: decisionIndex
    });
    cooldownSkipsCount += coordination.diagnostics.cooldownSkips;
    let intent: OrderIntent | null = coordination.intent;

    if (intent?.side === "BUY") {
      signalCount += 1;
    }

    if (riskCheck.mustLiquidateAll && portfolioState.position) {
      intent = {
        side: "SELL",
        market: portfolioState.position.market,
        timestamp: decisionTime,
        orderStyle: "best_ioc",
        reason: "risk_off_exit",
        conviction: 1,
        targetQuantity: portfolioState.position.quantity
      };
      circuitBreakerTriggered += 1;
    }

    if (intent?.side === "BUY" && !riskCheck.canOpenNew) {
      intent = null;
    }

    if (intent?.side === "BUY") {
      const candles = normalized.candlesByMarket[intent.market] ?? [];
      const priceForSizing = candles[decisionIndex]?.closePrice ?? 0;
      const atr = getAtr(candles, decisionIndex, 14) ?? priceForSizing * 0.02;
      const sizeResult = params.positionSizer.calculate({
        conviction: intent.conviction,
        currentPrice: priceForSizing,
        atr,
        portfolioEquity: currentEquity,
        currentPositionValue: 0
      });
      const targetWeight = Math.min(sizeResult.targetWeight, riskCheck.maxExposure);

      if (targetWeight <= 0) {
        intent = null;
      } else {
        intent = {
          ...intent,
          targetNotional: portfolioState.cash * targetWeight
        };
      }
    }

    if (intent) {
      const signal = signals.find((candidate) => candidate.market === intent?.market);
      const fill = executionSimulator.simulate({
        orderIntent: intent,
        decisionBarIndex: decisionIndex,
        executionBarIndex: executionIndex,
        nextBar: normalized.candlesByMarket[intent.market]?.[executionIndex],
        cashAvailable: portfolioState.cash,
        positionQuantity: portfolioState.position?.market === intent.market
          ? portfolioState.position.quantity
          : 0,
        avgDailyNotional: signal?.metadata?.avgDailyNotional,
        estimatedSpreadBps: signal?.metadata?.estimatedSpreadBps
      });

      if (fill.status === "FILLED" && fill.fillPrice !== undefined && fill.fillTimestamp) {
        feePaidTotal += fill.feePaid ?? 0;
        slippagePaidTotal += fill.slippagePaid ?? 0;
        turnoverNotional += fill.filledNotional ?? 0;

        if (fill.side === "BUY" && fill.filledQuantity !== undefined && fill.filledNotional !== undefined) {
          portfolioState.cash -= fill.filledNotional + (fill.feePaid ?? 0);
          coordinator.onBuyFilled({
            state: portfolioState,
            market: fill.market,
            entryPrice: fill.fillPrice,
            quantity: fill.filledQuantity,
            barIndex: executionIndex,
            timestamp: fill.fillTimestamp
          });
          const weight = currentEquity === 0 ? 0 : fill.filledNotional / currentEquity;
          weightSum += weight;
          weightCount += 1;
          maxWeight = Math.max(maxWeight, weight);
        } else if (
          fill.side === "SELL" &&
          fill.filledQuantity !== undefined &&
          fill.filledNotional !== undefined &&
          portfolioState.position
        ) {
          const previousPosition = portfolioState.position;
          portfolioState.cash += fill.filledNotional - (fill.feePaid ?? 0);
          holdBars.push(executionIndex - previousPosition.entryBarIndex);
          const pnlRatio =
            previousPosition.entryPrice === 0
              ? 0
              : (fill.fillPrice - previousPosition.entryPrice) / previousPosition.entryPrice;
          coordinator.onSellFilled({
            state: portfolioState,
            market: fill.market,
            barIndex: executionIndex,
            timestamp: fill.fillTimestamp,
            reason: intent.reason,
            pnlRatio
          });
        }

        trades.push({
          marketCode: fill.market,
          side: fill.side,
          time: fill.fillTimestamp,
          price: fill.fillPrice,
          quantity: fill.filledQuantity ?? 0,
          fee: fill.feePaid ?? 0,
          slippage: fill.slippagePaid ?? 0,
          reason: intent.reason
        });
      } else if (fill.status !== "UNFILLED") {
        rejectedOrdersCount += 1;
      }
    }

    const equity = markToMarket({
      cash: portfolioState.cash,
      position: portfolioState.position,
      candlesByMarket: normalized.candlesByMarket,
      index: executionIndex
    });
    equityCurve.push(equity);
    params.riskManager.onBarClose(equity);
  }

  const referenceCandles = (normalized.candlesByMarket[marketCodes[0]] ?? []).filter((candle) => {
    if (!params.evaluationRange) {
      return true;
    }

    return (
      candle.candleTimeUtc >= params.evaluationRange.start &&
      candle.candleTimeUtc <= params.evaluationRange.end
    );
  });
  const metrics = calculateMetrics({
    trades,
    equityCurve,
    initialCapital,
    feePaid: feePaidTotal,
    slippagePaid: slippagePaidTotal,
    turnover: turnoverNotional,
    rejectedOrdersCount,
    cooldownSkipsCount,
    holdBars
  });
  const result: ScoredBacktestResult = {
    strategyName: params.strategy.name,
    marketCode: toSyntheticMarketCode(params.universeName),
    timeframe: params.timeframe,
    candleCount: evaluationCandleCount,
    trades,
    equityCurve,
    metrics,
    positionSizing: params.positionSizer.name,
    riskManagement: params.riskManager.name,
    averagePositionWeight: weightCount === 0 ? 0 : weightSum / weightCount,
    maxPositionWeight: maxWeight,
    circuitBreakerTriggered,
    signalCount,
    ghostSignalCount: ghostStudyCollector.getGhostSignalCount(),
    ghostStudy: ghostStudyCollector.summarize(),
    universeName: params.universeName,
    marketCount: marketCodes.length
  };

  if (params.runBootstrap) {
    result.bootstrap = runBootstrapValidation({
      trades,
      parameterCount: params.strategy.parameterCount
    });
  }

  if (params.runRandomBenchmarkFlag) {
    result.randomBenchmark = runRandomBenchmark({
      candles: referenceCandles,
      strategyReturn: metrics.totalReturn,
      strategyTradeCount: metrics.tradeCount
    });
  }

  return result;
}
