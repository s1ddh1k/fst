import {
  type AccountView,
  type StrategyContext,
  type StrategySignal,
  type StrategyTimeframe
} from "../../../../packages/shared/src/index.js";
import { buildMarketStateContext } from "../../../strategies/src/market-state.js";
import { createPortfolioEngine, createInitialPortfolioEngineState, createDefaultPortfolioEngineConfig } from "./PortfolioEngine.js";
import { planOrderFromIntent } from "./OrderPlanner.js";
import { createExecutionRouter } from "./ExecutionRouter.js";
import { createEventStore } from "./EventStore.js";
import { normalizeToFullGrid } from "./full-grid-normalizer.js";
import { buildUniverseSnapshots } from "./universe-snapshot-builder.js";
import type {
  FullGridCandleSet,
  MarketStateResolver,
  MultiStrategyBacktestConfig,
  MultiStrategyBacktestResult,
  PortfolioEngineConfig
} from "./types.js";
import { applyExitRiskState } from "./RiskEngine.js";
import { floorTimeToTimeframe, timeframeToMs } from "./timeframe.js";

function buildDefaultMarketStateResolver(): MarketStateResolver {
  return (params) =>
    buildMarketStateContext({
      marketCode: params.market,
      referenceTime: params.decisionTime,
      universeName: "multi-strategy",
      universeCandlesByMarket: params.decisionCandlesByMarket,
      config: undefined
    }) as unknown as Record<string, unknown> | undefined;
}

function getEquity(account: AccountView, positions: { entryPrice: number; quantity: number }[]): number {
  return account.cash + positions.reduce((sum, position) => sum + position.entryPrice * position.quantity, 0);
}

function mapDecisionToExecutionIndex(params: {
  executionTimeline: Date[];
  decisionTime: Date;
  decisionTimeframe: StrategyTimeframe;
  executionTimeframe: StrategyTimeframe;
}): number {
  if (params.executionTimeline.length === 0) {
    return -1;
  }

  const decisionCloseTime = new Date(
    params.decisionTime.getTime() + timeframeToMs(params.decisionTimeframe)
  );
  const earliest = floorTimeToTimeframe(decisionCloseTime, params.executionTimeframe).getTime();
  const firstExecutionTime = params.executionTimeline[0]?.getTime() ?? Number.POSITIVE_INFINITY;

  if (earliest < firstExecutionTime) {
    return -1;
  }

  return params.executionTimeline.findIndex((time) => time.getTime() >= earliest);
}

function calculateDrawdown(equityCurve: number[]): number {
  let peak = equityCurve[0] ?? 0;
  let maxDrawdown = 0;

  for (const equity of equityCurve) {
    peak = Math.max(peak, equity);
    const drawdown = peak === 0 ? 0 : (peak - equity) / peak;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
  }

  return maxDrawdown;
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function positionKey(position: { market: string; strategyId: string }): string {
  return `${position.strategyId}::${position.market}`;
}

function normalizeDecisionCandles(config: MultiStrategyBacktestConfig): Record<StrategyTimeframe, FullGridCandleSet> {
  const entries = Object.entries(config.decisionCandles) as Array<[StrategyTimeframe, FullGridCandleSet["candlesByMarket"]]>;
  return Object.fromEntries(
    entries.map(([timeframe, candlesByMarket]) => [
      timeframe,
      normalizeToFullGrid({ timeframe, candlesByMarket: candlesByMarket ?? {} })
    ])
  ) as Record<StrategyTimeframe, FullGridCandleSet>;
}

function normalizeExecutionCandles(config: MultiStrategyBacktestConfig): Record<StrategyTimeframe, FullGridCandleSet> {
  const entries = Object.entries(config.executionCandles) as Array<[StrategyTimeframe, FullGridCandleSet["candlesByMarket"]]>;
  return Object.fromEntries(
    entries.map(([timeframe, candlesByMarket]) => [
      timeframe,
      normalizeToFullGrid({ timeframe, candlesByMarket: candlesByMarket ?? {} })
    ])
  ) as Record<StrategyTimeframe, FullGridCandleSet>;
}

function buildTimeIndexLookup(timeline: Date[]): Map<string, number> {
  return new Map(timeline.map((time, index) => [time.toISOString(), index]));
}

function collectDecisionTimeline(
  strategies: MultiStrategyBacktestConfig["strategies"],
  decisionSets: Record<StrategyTimeframe, FullGridCandleSet>
): Date[] {
  const times = new Set<number>();

  for (const strategy of strategies) {
    const timeline = decisionSets[strategy.decisionTimeframe]?.timeline ?? [];
    for (const time of timeline) {
      times.add(time.getTime());
    }
  }

  return Array.from(times)
    .sort((left, right) => left - right)
    .map((time) => new Date(time));
}

export function runMultiStrategyBacktest(config: MultiStrategyBacktestConfig): MultiStrategyBacktestResult {
  const eventStore = createEventStore();
  const decisionSets = normalizeDecisionCandles(config);
  const executionSets = normalizeExecutionCandles(config);
  const universeSnapshotsByTf = Object.fromEntries(
    Object.entries(decisionSets).map(([timeframe, set]) => [
      timeframe,
      buildUniverseSnapshots({ candleSet: set, config: config.universeConfig })
    ])
  ) as Record<string, Map<string, import("../../../../packages/shared/src/index.js").UniverseSnapshot>>;
  const portfolioConfig: PortfolioEngineConfig = {
    ...createDefaultPortfolioEngineConfig(),
    sleeves: config.sleeves,
    maxOpenPositions: config.maxOpenPositions ?? 5,
    maxCapitalUsagePct: config.maxCapitalUsagePct ?? 0.95,
    cooldownBarsAfterLoss: config.cooldownBarsAfterLoss ?? 12,
    minBarsBetweenEntries: config.minBarsBetweenEntries ?? 1
  };
  const portfolioEngine = createPortfolioEngine(portfolioConfig);
  const state = createInitialPortfolioEngineState(config.initialCapital);
  const router = createExecutionRouter({ exchangeAdapter: config.exchangeAdapter });
  const marketStateResolver = buildDefaultMarketStateResolver();
  const allSignals: StrategySignal[] = [];
  const orderIntents: MultiStrategyBacktestResult["orderIntents"] = [];
  const fills: MultiStrategyBacktestResult["fills"] = [];
  const completedTrades: MultiStrategyBacktestResult["completedTrades"] = [];
  const decisions: MultiStrategyBacktestResult["decisions"] = [];
  const equityCurve: number[] = [config.initialCapital];
  const holdBars: number[] = [];
  let turnover = 0;
  let feePaid = 0;
  let slippagePaid = 0;
  let rejectedOrdersCount = 0;
  let cooldownSkipsCount = 0;
  const strategyMetrics: MultiStrategyBacktestResult["strategyMetrics"] = {};
  const sleeveMetrics: MultiStrategyBacktestResult["sleeveMetrics"] = {};
  const decisionTimeline = collectDecisionTimeline(config.strategies, decisionSets);
  const entryLedger = new Map<string, {
    strategyId: string;
    sleeveId: string;
    market: string;
    entryTime: Date;
    entryPrice: number;
    quantity: number;
    filledNotional: number;
    feePaid: number;
    slippagePaid: number;
  }>();
  const decisionLookups = Object.fromEntries(
    Object.entries(decisionSets).map(([timeframe, set]) => [timeframe, buildTimeIndexLookup(set.timeline)])
  ) as Record<StrategyTimeframe, Map<string, number>>;

  for (const decisionTime of decisionTimeline) {
    const rawSignalsForStep: StrategySignal[] = [];
    let currentBarIndex = 0;

    for (const strategy of config.strategies) {
      const decisionSet = decisionSets[strategy.decisionTimeframe];
      const executionSet = executionSets[strategy.executionTimeframe];
      const decisionIndex = decisionLookups[strategy.decisionTimeframe]?.get(decisionTime.toISOString());
      if (!decisionSet || !executionSet || decisionIndex === undefined) {
        continue;
      }
      currentBarIndex = Math.max(currentBarIndex, decisionIndex);
      const universeSnapshot = universeSnapshotsByTf[strategy.decisionTimeframe]?.get(decisionTime.toISOString());
      if (!universeSnapshot) {
        continue;
      }

      for (const market of universeSnapshot.markets) {
        const candles = decisionSet.candlesByMarket[market];
        if (!candles || decisionIndex >= candles.length) {
          continue;
        }

        const existingPosition = state.positions.find(
          (position) => position.market === market && position.strategyId === strategy.id
        );
        const strategyContext: StrategyContext = {
          strategyId: strategy.id,
          market,
          decisionTime,
          decisionTimeframe: strategy.decisionTimeframe,
          executionTimeframe: strategy.executionTimeframe,
          universeSnapshot,
          existingPosition,
          accountState: {
            equity: getEquity({ equity: state.cash, cash: state.cash, capitalInUse: 0 }, state.positions),
            cash: state.cash,
            capitalInUse: 0
          },
          featureView: {
            candles,
            decisionIndex,
            executionIndex: mapDecisionToExecutionIndex({
              executionTimeline: executionSet.timeline,
              decisionTime,
              decisionTimeframe: strategy.decisionTimeframe,
              executionTimeframe: strategy.executionTimeframe
            }),
            trailingCandles: candles.slice(Math.max(0, decisionIndex - 100), decisionIndex + 1)
          },
          marketState: marketStateResolver({
            strategy,
            market,
            decisionIndex,
            decisionTime,
            decisionCandlesByMarket: decisionSet.candlesByMarket,
            universeSnapshot
          })
        };
        const signal = strategy.generateSignal(strategyContext);
        strategyMetrics[signal.strategyId] ??= {
          rawSignals: 0,
          buySignals: 0,
          sellSignals: 0,
          blockedSignals: 0,
          filledOrders: 0,
          rejectedOrders: 0
        };
        sleeveMetrics[signal.sleeveId] ??= {
          intents: 0,
          fills: 0,
          blockedSignals: 0
        };
        strategyMetrics[signal.strategyId].rawSignals += 1;
        if (signal.signal === "BUY") {
          strategyMetrics[signal.strategyId].buySignals += 1;
        } else if (signal.signal === "SELL") {
          strategyMetrics[signal.strategyId].sellSignals += 1;
        }
        allSignals.push(signal);
        rawSignalsForStep.push(signal);
        eventStore.append({
          kind: "raw_signal",
          at: decisionTime,
          strategyId: signal.strategyId,
          sleeveId: signal.sleeveId,
          market: signal.market,
          payload: {
            signal: signal.signal,
            conviction: signal.conviction,
            reason: signal.reason
          }
        });
        eventStore.append({
          kind: "ghost_signal",
          at: decisionTime,
          strategyId: signal.strategyId,
          sleeveId: signal.sleeveId,
          market: signal.market,
          payload: {
            signal: signal.signal
          }
        });
        for (const [stage, passed] of Object.entries(signal.stages)) {
          if (passed) {
            eventStore.append({
              kind: "funnel_stage",
              at: decisionTime,
              strategyId: signal.strategyId,
              sleeveId: signal.sleeveId,
              market: signal.market,
              payload: { stage }
            });
          }
        }
      }
    }

    const account: AccountView = {
      equity: state.cash + state.positions.reduce((sum, position) => sum + position.entryPrice * position.quantity, 0),
      cash: state.cash,
      capitalInUse: state.positions.reduce((sum, position) => sum + position.entryPrice * position.quantity, 0)
    };
    const portfolioDecision = portfolioEngine.decide({
      signals: rawSignalsForStep,
      state,
      currentBarIndex,
      account
    });
    decisions.push({
      time: decisionTime,
      intents: portfolioDecision.intents,
      blockedSignals: portfolioDecision.blockedSignals
    });
    cooldownSkipsCount += portfolioDecision.blockedSignals.filter((item) => item.reason === "cooldown").length;
    for (const blocked of portfolioDecision.blockedSignals) {
      const blockedStrategy = config.strategies.find((item) => item.id === blocked.strategyId);
      strategyMetrics[blocked.strategyId] ??= {
        rawSignals: 0,
        buySignals: 0,
        sellSignals: 0,
        blockedSignals: 0,
        filledOrders: 0,
        rejectedOrders: 0
      };
      strategyMetrics[blocked.strategyId].blockedSignals += 1;
      eventStore.append({
        kind: "blocked_signal",
        at: decisionTime,
        strategyId: blocked.strategyId,
        sleeveId: blockedStrategy?.sleeveId,
        market: blocked.market,
        payload: { reason: blocked.reason }
      });
    }

    for (const intent of portfolioDecision.intents) {
      sleeveMetrics[intent.sleeveId] ??= {
        intents: 0,
        fills: 0,
        blockedSignals: 0
      };
      sleeveMetrics[intent.sleeveId].intents += 1;
      const strategy = config.strategies.find((item) => item.id === intent.strategyId);
      if (!strategy) {
        continue;
      }
      const decisionSet = decisionSets[strategy.decisionTimeframe];
      const executionSet = executionSets[strategy.executionTimeframe];
      const decisionIndex = decisionLookups[strategy.decisionTimeframe]?.get(decisionTime.toISOString());
      if (!decisionSet || !executionSet || decisionIndex === undefined) {
        continue;
      }
      const plan = planOrderFromIntent(intent, decisionTime);
      orderIntents.push(plan.orderIntent);
      eventStore.append({
        kind: "order_intent",
        at: decisionTime,
        strategyId: intent.strategyId,
        sleeveId: intent.sleeveId,
        market: intent.market,
        payload: {
          side: intent.side,
          targetNotional: intent.targetNotional
        }
      });

      const executionIndex = mapDecisionToExecutionIndex({
        executionTimeline: executionSet.timeline,
        decisionTime,
        decisionTimeframe: strategy.decisionTimeframe,
        executionTimeframe: strategy.executionTimeframe
      });
      if (executionIndex < 0) {
        eventStore.append({
          kind: "blocked_signal",
          at: decisionTime,
          strategyId: intent.strategyId,
          sleeveId: intent.sleeveId,
          market: intent.market,
          payload: { reason: "no_execution_window" }
        });
        strategyMetrics[intent.strategyId] ??= {
          rawSignals: 0,
          buySignals: 0,
          sellSignals: 0,
          blockedSignals: 0,
          filledOrders: 0,
          rejectedOrders: 0
        };
        strategyMetrics[intent.strategyId].blockedSignals += 1;
        sleeveMetrics[intent.sleeveId] ??= {
          intents: 0,
          fills: 0,
          blockedSignals: 0
        };
        sleeveMetrics[intent.sleeveId].blockedSignals += 1;
        continue;
      }
      const nextExecutionBar =
        executionIndex >= 0 ? executionSet.candlesByMarket[intent.market]?.[executionIndex] : undefined;
      const currentPosition = state.positions.find(
        (position) => position.market === intent.market && position.strategyId === intent.strategyId
      );
      const fill = router.route({
        orderIntent: plan.orderIntent,
        childOrders: plan.childOrders,
        decisionBarIndex: decisionIndex,
        executionBarIndex: executionIndex,
        nextExecutionBar,
        cashAvailable: state.cash,
        currentPosition
      });
      fills.push(fill);
      feePaid += fill.feePaid;
      slippagePaid += fill.slippagePaid;
      if (fill.status !== "FILLED") {
        rejectedOrdersCount += 1;
        strategyMetrics[intent.strategyId] ??= {
          rawSignals: 0,
          buySignals: 0,
          sellSignals: 0,
          blockedSignals: 0,
          filledOrders: 0,
          rejectedOrders: 0
        };
        strategyMetrics[intent.strategyId].rejectedOrders += 1;
        continue;
      }

      turnover += fill.filledNotional ?? 0;
      strategyMetrics[intent.strategyId] ??= {
        rawSignals: 0,
        buySignals: 0,
        sellSignals: 0,
        blockedSignals: 0,
        filledOrders: 0,
        rejectedOrders: 0
      };
      strategyMetrics[intent.strategyId].filledOrders += 1;
      sleeveMetrics[intent.sleeveId].fills += 1;
      eventStore.append({
        kind: "order_fill",
        at: fill.fillTime ?? decisionTime,
        strategyId: intent.strategyId,
        sleeveId: intent.sleeveId,
        market: intent.market,
        payload: {
          side: fill.side,
          fillPrice: fill.fillPrice,
          filledQuantity: fill.filledQuantity
        }
      });

      if (fill.side === "BUY") {
        state.cash -= (fill.filledNotional ?? 0) + fill.feePaid;
        state.lastEntryBarByMarket[intent.market] = currentBarIndex;
        if (
          fill.fillTime !== undefined &&
          fill.fillPrice !== undefined &&
          fill.filledQuantity !== undefined &&
          fill.filledNotional !== undefined
        ) {
          entryLedger.set(positionKey({ market: intent.market, strategyId: intent.strategyId }), {
            strategyId: intent.strategyId,
            sleeveId: intent.sleeveId,
            market: intent.market,
            entryTime: fill.fillTime,
            entryPrice: fill.fillPrice,
            quantity: fill.filledQuantity,
            filledNotional: fill.filledNotional,
            feePaid: fill.feePaid,
            slippagePaid: fill.slippagePaid
          });
        }
      } else {
        const matchedPosition = state.positions.find(
          (position) => position.market === intent.market && position.strategyId === intent.strategyId
        );
        if (matchedPosition && fill.fillPrice !== undefined) {
          const pnlRatio = matchedPosition.entryPrice === 0 ? 0 : (fill.fillPrice - matchedPosition.entryPrice) / matchedPosition.entryPrice;
          holdBars.push(
            Math.max(
              1,
              Math.round(((fill.fillTime?.getTime() ?? decisionTime.getTime()) - matchedPosition.entryTime.getTime()) / 60_000)
            )
          );
          applyExitRiskState({
            state,
            position: matchedPosition,
            currentBarIndex,
            pnlRatio,
            config: portfolioConfig
          });
        }
        const ledgerKey = positionKey({ market: intent.market, strategyId: intent.strategyId });
        const entry = entryLedger.get(ledgerKey);
        if (
          entry &&
          fill.fillTime !== undefined &&
          fill.fillPrice !== undefined &&
          fill.filledQuantity !== undefined &&
          fill.filledNotional !== undefined
        ) {
          const grossPnl = fill.filledNotional - entry.filledNotional;
          const totalFees = entry.feePaid + fill.feePaid;
          const totalSlippage = entry.slippagePaid + fill.slippagePaid;
          const netPnl = grossPnl - totalFees;
          completedTrades.push({
            strategyId: intent.strategyId,
            sleeveId: intent.sleeveId,
            market: intent.market,
            entryTime: entry.entryTime,
            exitTime: fill.fillTime,
            entryPrice: entry.entryPrice,
            exitPrice: fill.fillPrice,
            quantity: fill.filledQuantity,
            grossPnl,
            feePaid: totalFees,
            slippagePaid: totalSlippage,
            netPnl,
            returnPct: entry.filledNotional <= 0 ? 0 : netPnl / entry.filledNotional
          });
          entryLedger.delete(ledgerKey);
        }
        state.cash += (fill.filledNotional ?? 0) - fill.feePaid;
      }

      portfolioEngine.applyFill({
        fill,
        strategyId: intent.strategyId,
        sleeveId: intent.sleeveId,
        fillTime: fill.fillTime ?? decisionTime,
        state
      });
    }

    const equity =
      state.cash +
      state.positions.reduce((sum, position) => {
        for (const strategy of config.strategies) {
          const set = decisionSets[strategy.decisionTimeframe];
          const lookup = decisionLookups[strategy.decisionTimeframe];
          const index = lookup?.get(decisionTime.toISOString());
          if (set && index !== undefined) {
            const close = set.candlesByMarket[position.market]?.[index]?.closePrice;
            if (close !== undefined) {
              return sum + close * position.quantity;
            }
          }
        }

        return sum + position.entryPrice * position.quantity;
      }, 0);
    equityCurve.push(equity);
  }

  for (const blockedEvent of eventStore.byKind("blocked_signal")) {
    if (blockedEvent.sleeveId) {
      sleeveMetrics[blockedEvent.sleeveId] ??= {
        intents: 0,
        fills: 0,
        blockedSignals: 0
      };
      sleeveMetrics[blockedEvent.sleeveId].blockedSignals += 1;
    }
  }

  const winningTrades = completedTrades.filter((trade) => trade.netPnl > 0).length;

  const finalEquity = equityCurve[equityCurve.length - 1] ?? config.initialCapital;
  const grossReturn = config.initialCapital === 0 ? 0 : (finalEquity + feePaid + slippagePaid - config.initialCapital) / config.initialCapital;
  const netReturn = config.initialCapital === 0 ? 0 : (finalEquity - config.initialCapital) / config.initialCapital;
  const funnel: MultiStrategyBacktestResult["funnel"] = {};
  const ghostByStrategy = new Map<string, { count: number; sum: number }>();

  for (const event of eventStore.byKind("funnel_stage")) {
    const strategyId = event.strategyId ?? "unknown";
    const stage = String(event.payload.stage ?? "unknown");
    funnel[strategyId] ??= {};
    funnel[strategyId][stage] = (funnel[strategyId][stage] ?? 0) + 1;
  }

  for (const signal of allSignals.filter((item) => item.signal === "BUY")) {
    const decisionSet = decisionSets[signal.decisionTimeframe];
    const candles = decisionSet?.candlesByMarket[signal.market] ?? [];
    const index = candles.findIndex((candle) => candle.candleTimeUtc.getTime() === signal.decisionTime.getTime());
    const current = candles[index];
    const forward = candles[index + 4];
    if (!current || !forward || current.closePrice <= 0) {
      continue;
    }
    const entry = ghostByStrategy.get(signal.strategyId) ?? { count: 0, sum: 0 };
    entry.count += 1;
    entry.sum += (forward.closePrice - current.closePrice) / current.closePrice;
    ghostByStrategy.set(signal.strategyId, entry);
  }

  return {
    completedTrades,
    decisions,
    fills,
    events: eventStore.list(),
    metrics: {
      grossReturn,
      netReturn,
      turnover: config.initialCapital === 0 ? 0 : turnover / config.initialCapital,
      winRate: completedTrades.length === 0 ? 0 : winningTrades / completedTrades.length,
      avgHoldBars: average(holdBars),
      maxDrawdown: calculateDrawdown(equityCurve),
      feePaid,
      slippagePaid,
      rejectedOrdersCount,
      cooldownSkipsCount,
      signalCount: allSignals.length,
      blockedSignalCount: eventStore.byKind("blocked_signal").length,
      openPositionCount: state.positions.length
    },
    strategyMetrics,
    sleeveMetrics,
    funnel,
    ghostSummary: Object.fromEntries(
      Array.from(ghostByStrategy.entries()).map(([strategyId, value]) => [
        strategyId,
        {
          count: value.count,
          avgForwardReturn: value.count === 0 ? 0 : value.sum / value.count
        }
      ])
    ),
    finalAccount: {
      equity: finalEquity,
      cash: state.cash,
      capitalInUse: state.positions.reduce((sum, position) => sum + position.entryPrice * position.quantity, 0)
    },
    finalPositions: state.positions,
    rawSignals: allSignals,
    universeSnapshots: Object.values(universeSnapshotsByTf).flatMap((snapshots) => Array.from(snapshots.values())),
    orderIntents
  };
}
