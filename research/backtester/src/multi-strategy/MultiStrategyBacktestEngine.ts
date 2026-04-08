import {
  type AccountView,
  type Candle,
  type StrategyContext,
  type StrategySignal,
  type StrategyTimeframe
} from "../../../../packages/shared/src/index.js";
import { buildMarketStateContexts } from "../../../strategies/src/market-state.js";
import { createPortfolioEngine, createInitialPortfolioEngineState, createDefaultPortfolioEngineConfig } from "./PortfolioEngine.js";
import { planOrderFromIntent } from "./OrderPlanner.js";
import { createExecutionRouter } from "./ExecutionRouter.js";
import { createEventStore } from "./EventStore.js";
import { normalizeToFullGrid } from "./full-grid-normalizer.js";
import { buildUniverseSnapshots } from "./universe-snapshot-builder.js";
import type {
  FullGridCandleSet,
  MultiStrategyBacktestConfig,
  MultiStrategyBacktestResult,
  PortfolioEngineConfig
} from "./types.js";
import { applyExitRiskState } from "./RiskEngine.js";
import { floorTimeToTimeframe, timeframeToMs } from "./timeframe.js";

function getEquity(account: AccountView, positions: { entryPrice: number; quantity: number }[]): number {
  return account.cash + positions.reduce((sum, position) => sum + position.entryPrice * position.quantity, 0);
}

function findFirstTimeIndexAtOrAfter(timeline: Date[], targetMs: number): number {
  let left = 0;
  let right = timeline.length - 1;
  let result = -1;

  while (left <= right) {
    const middle = Math.floor((left + right) / 2);
    const currentMs = timeline[middle]?.getTime() ?? Number.POSITIVE_INFINITY;

    if (currentMs >= targetMs) {
      result = middle;
      right = middle - 1;
      continue;
    }

    left = middle + 1;
  }

  return result;
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

  return findFirstTimeIndexAtOrAfter(params.executionTimeline, earliest);
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
  const normalized = Object.fromEntries(
    entries.map(([timeframe, candlesByMarket]) => [
      timeframe,
      normalizeToFullGrid({ timeframe, candlesByMarket: candlesByMarket ?? {} })
    ])
  ) as Record<StrategyTimeframe, FullGridCandleSet>;

  return {
    ...normalized,
    ...(config.preNormalizedDecisionSets ?? {})
  } as Record<StrategyTimeframe, FullGridCandleSet>;
}

function normalizeExecutionCandles(config: MultiStrategyBacktestConfig): Record<StrategyTimeframe, FullGridCandleSet> {
  const entries = Object.entries(config.executionCandles) as Array<[StrategyTimeframe, FullGridCandleSet["candlesByMarket"]]>;
  const normalized = Object.fromEntries(
    entries.map(([timeframe, candlesByMarket]) => [
      timeframe,
      normalizeToFullGrid({ timeframe, candlesByMarket: candlesByMarket ?? {} })
    ])
  ) as Record<StrategyTimeframe, FullGridCandleSet>;

  return {
    ...normalized,
    ...(config.preNormalizedExecutionSets ?? {})
  } as Record<StrategyTimeframe, FullGridCandleSet>;
}

function buildUniverseSnapshotsByTimeframe(params: {
  decisionSets: Record<StrategyTimeframe, FullGridCandleSet>;
  universeConfig: MultiStrategyBacktestConfig["universeConfig"];
  precomputedUniverseSnapshotsByTf?: MultiStrategyBacktestConfig["precomputedUniverseSnapshotsByTf"];
}): Record<string, Map<string, import("../../../../packages/shared/src/index.js").UniverseSnapshot>> {
  const built = Object.fromEntries(
    Object.entries(params.decisionSets).map(([timeframe, set]) => [
      timeframe,
      buildUniverseSnapshots({ candleSet: set, config: params.universeConfig })
    ])
  );

  return {
    ...built,
    ...(params.precomputedUniverseSnapshotsByTf ?? {})
  } as Record<string, Map<string, import("../../../../packages/shared/src/index.js").UniverseSnapshot>>;
}

function updateGhostSummary(params: {
  ghostByStrategy: Map<string, { count: number; sum: number }>;
  signal: StrategySignal;
  candles: Candle[];
  decisionIndex: number;
}): void {
  if (params.signal.signal !== "BUY") {
    return;
  }

  const current = params.candles[params.decisionIndex];
  const forward = params.candles[params.decisionIndex + 4];
  if (!current || !forward || current.closePrice <= 0) {
    return;
  }

  const entry = params.ghostByStrategy.get(params.signal.strategyId) ?? { count: 0, sum: 0 };
  entry.count += 1;
  entry.sum += (forward.closePrice - current.closePrice) / current.closePrice;
  params.ghostByStrategy.set(params.signal.strategyId, entry);
}

function summarizeUniverseCoverage(params: {
  universeSnapshotsByTf: Record<string, Map<string, import("../../../../packages/shared/src/index.js").UniverseSnapshot>>;
  decisionSets: Record<StrategyTimeframe, FullGridCandleSet>;
  usedTimeframes: StrategyTimeframe[];
  captureUniverseSnapshots: boolean;
}): {
  snapshots: import("../../../../packages/shared/src/index.js").UniverseSnapshot[];
  summary: MultiStrategyBacktestResult["universeCoverageSummary"];
} {
  const snapshots: import("../../../../packages/shared/src/index.js").UniverseSnapshot[] = [];
  let total = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  let observationCount = 0;

  for (const timeframe of params.usedTimeframes) {
    const snapshotMap = params.universeSnapshotsByTf[timeframe];
    const timeline = params.decisionSets[timeframe]?.timeline ?? [];

    if (!snapshotMap) {
      continue;
    }

    for (const time of timeline) {
      const snapshot = snapshotMap.get(time.toISOString());
      if (!snapshot) {
        continue;
      }

      const size = snapshot.markets.length;
      total += size;
      min = Math.min(min, size);
      max = Math.max(max, size);
      observationCount += 1;

      if (params.captureUniverseSnapshots) {
        snapshots.push(snapshot);
      }
    }
  }

  return {
    snapshots,
    summary: {
      avg: observationCount === 0 ? 0 : total / observationCount,
      min: Number.isFinite(min) ? min : 0,
      max: observationCount === 0 ? 0 : max,
      observationCount
    }
  };
}

function buildTimeIndexLookup(timeline: Date[]): Map<string, number> {
  return new Map(timeline.map((time, index) => [time.toISOString(), index]));
}

function validateBacktestInputs(params: {
  config: MultiStrategyBacktestConfig;
  decisionSets: Record<StrategyTimeframe, FullGridCandleSet>;
  executionSets: Record<StrategyTimeframe, FullGridCandleSet>;
  universeSnapshotsByTf: Record<string, Map<string, import("../../../../packages/shared/src/index.js").UniverseSnapshot>>;
}): void {
  for (const strategy of params.config.strategies) {
    const decisionSet = params.decisionSets[strategy.decisionTimeframe];
    if (!decisionSet || decisionSet.timeline.length === 0) {
      throw new Error(
        `Missing decision candle coverage for strategy=${strategy.id} timeframe=${strategy.decisionTimeframe}`
      );
    }

    const executionSet = params.executionSets[strategy.executionTimeframe];
    if (!executionSet || executionSet.timeline.length === 0) {
      throw new Error(
        `Missing execution candle coverage for strategy=${strategy.id} timeframe=${strategy.executionTimeframe}`
      );
    }

    if (!params.universeSnapshotsByTf[strategy.decisionTimeframe]) {
      throw new Error(
        `Missing universe snapshot coverage for strategy=${strategy.id} timeframe=${strategy.decisionTimeframe}`
      );
    }
  }
}

function validateBacktestResult(params: {
  result: MultiStrategyBacktestResult;
  captureTraceArtifacts: boolean;
}): void {
  const epsilon = 1e-9;
  const rawSignalsFromStrategies = Object.values(params.result.strategyMetrics).reduce(
    (sum, metric) => sum + metric.rawSignals,
    0
  );
  const buySignalsFromStrategies = Object.values(params.result.strategyMetrics).reduce(
    (sum, metric) => sum + metric.buySignals,
    0
  );
  const sellSignalsFromStrategies = Object.values(params.result.strategyMetrics).reduce(
    (sum, metric) => sum + metric.sellSignals,
    0
  );
  const accountedSignals =
    params.result.decisionCoverageSummary.rawBuySignals +
    params.result.decisionCoverageSummary.rawSellSignals +
    params.result.decisionCoverageSummary.rawHoldSignals;

  if (rawSignalsFromStrategies !== params.result.metrics.signalCount) {
    throw new Error(
      `Signal accounting mismatch: strategy raw=${rawSignalsFromStrategies} engine=${params.result.metrics.signalCount}`
    );
  }

  if (buySignalsFromStrategies !== params.result.decisionCoverageSummary.rawBuySignals) {
    throw new Error(
      `Buy signal accounting mismatch: strategy buy=${buySignalsFromStrategies} engine=${params.result.decisionCoverageSummary.rawBuySignals}`
    );
  }

  if (sellSignalsFromStrategies !== params.result.decisionCoverageSummary.rawSellSignals) {
    throw new Error(
      `Sell signal accounting mismatch: strategy sell=${sellSignalsFromStrategies} engine=${params.result.decisionCoverageSummary.rawSellSignals}`
    );
  }

  if (accountedSignals !== params.result.metrics.signalCount) {
    throw new Error(
      `Decision coverage mismatch: covered=${accountedSignals} engine=${params.result.metrics.signalCount}`
    );
  }

  if (
    params.result.decisionCoverageSummary.avgEligibleBuys >
    params.result.decisionCoverageSummary.avgConsideredBuys + epsilon
  ) {
    throw new Error("Eligible buys exceeded considered buys");
  }

  const universe = params.result.universeCoverageSummary;
  if (params.result.metrics.signalCount > 0 && universe.observationCount === 0) {
    throw new Error("Signals were generated without universe coverage observations");
  }

  if (universe.observationCount > 0) {
    if (universe.min > universe.max) {
      throw new Error(`Universe coverage bounds invalid: min=${universe.min} max=${universe.max}`);
    }

    if (universe.avg + epsilon < universe.min || universe.avg - epsilon > universe.max) {
      throw new Error(
        `Universe coverage average out of bounds: avg=${universe.avg} min=${universe.min} max=${universe.max}`
      );
    }
  }

  for (const trade of params.result.completedTrades) {
    if (trade.exitTime.getTime() < trade.entryTime.getTime()) {
      throw new Error(`Trade exited before entry: strategy=${trade.strategyId} market=${trade.market}`);
    }

    if (!Number.isFinite(trade.returnPct)) {
      throw new Error(`Trade return is not finite: strategy=${trade.strategyId} market=${trade.market}`);
    }
  }

  if (params.captureTraceArtifacts && params.result.rawSignals.length !== params.result.metrics.signalCount) {
    throw new Error(
      `Trace rawSignals mismatch: trace=${params.result.rawSignals.length} engine=${params.result.metrics.signalCount}`
    );
  }
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
  const captureTraceArtifacts = config.captureTraceArtifacts ?? true;
  const captureUniverseSnapshots = config.captureUniverseSnapshots ?? true;
  const eventStore = createEventStore();
  const decisionSets = normalizeDecisionCandles(config);
  const executionSets = normalizeExecutionCandles(config);
  const universeSnapshotsByTf = buildUniverseSnapshotsByTimeframe({
    decisionSets,
    universeConfig: config.universeConfig,
    precomputedUniverseSnapshotsByTf: config.precomputedUniverseSnapshotsByTf
  });
  validateBacktestInputs({
    config,
    decisionSets,
    executionSets,
    universeSnapshotsByTf
  });
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
  const allSignals: StrategySignal[] = [];
  const orderIntents: MultiStrategyBacktestResult["orderIntents"] = [];
  const fills: MultiStrategyBacktestResult["fills"] = [];
  const completedTrades: MultiStrategyBacktestResult["completedTrades"] = [];
  const decisions: MultiStrategyBacktestResult["decisions"] = [];
  const equityCurve: number[] = [config.initialCapital];
  const latestPriceByMarket = new Map<string, number>();
  const holdBars: number[] = [];
  let turnover = 0;
  let feePaid = 0;
  let slippagePaid = 0;
  let rejectedOrdersCount = 0;
  let cooldownSkipsCount = 0;
  let signalCount = 0;
  let blockedSignalCount = 0;
  let rawBuySignals = 0;
  let rawSellSignals = 0;
  let rawHoldSignals = 0;
  let consideredBuysTotal = 0;
  let eligibleBuysTotal = 0;
  let decisionObservationCount = 0;
  const strategyMetrics: MultiStrategyBacktestResult["strategyMetrics"] = {};
  const sleeveMetrics: MultiStrategyBacktestResult["sleeveMetrics"] = {};
  const decisionTimeline = collectDecisionTimeline(config.strategies, decisionSets);
  const equityTimeline: Date[] = [decisionTimeline[0] ?? new Date(0)];
  const usedDecisionTimeframes = Array.from(
    new Set(config.strategies.map((strategy) => strategy.decisionTimeframe))
  );
  const funnel: MultiStrategyBacktestResult["funnel"] = {};
  const ghostByStrategy = new Map<string, { count: number; sum: number }>();
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
    const executionIndexByStrategyId = new Map<string, number>();
    const marketStateContextsByTimeframe = new Map<
      StrategyTimeframe,
      ReturnType<typeof buildMarketStateContexts>
    >();
    const trailingCandlesByTimeframe = new Map<StrategyTimeframe, Map<string, Candle[]>>();
    const openPositionsByKey = new Map(
      state.positions.map((position) => [positionKey(position), position])
    );
    const currentEquity = getEquity(
      { equity: state.cash, cash: state.cash, capitalInUse: 0 },
      state.positions
    );
    let currentBarIndex = 0;

    for (const strategy of config.strategies) {
      const decisionSet = decisionSets[strategy.decisionTimeframe];
      const executionSet = executionSets[strategy.executionTimeframe];
      const decisionIndex = decisionLookups[strategy.decisionTimeframe]?.get(decisionTime.toISOString());
      if (!decisionSet || !executionSet || decisionIndex === undefined) {
        continue;
      }
      currentBarIndex = Math.max(currentBarIndex, decisionIndex);
      const executionIndex = mapDecisionToExecutionIndex({
        executionTimeline: executionSet.timeline,
        decisionTime,
        decisionTimeframe: strategy.decisionTimeframe,
        executionTimeframe: strategy.executionTimeframe
      });
      executionIndexByStrategyId.set(strategy.id, executionIndex);
      const universeSnapshot = universeSnapshotsByTf[strategy.decisionTimeframe]?.get(decisionTime.toISOString());
      if (!universeSnapshot) {
        continue;
      }
      const cachedMarketStates = marketStateContextsByTimeframe.get(strategy.decisionTimeframe) ??
        buildMarketStateContexts({
          referenceTime: decisionTime,
          alignedIndex: decisionIndex,
          marketCodes: universeSnapshot.markets,
          universeName: "multi-strategy",
          universeCandlesByMarket: decisionSet.candlesByMarket,
          config: config.marketStateConfig as any
        });
      if (!marketStateContextsByTimeframe.has(strategy.decisionTimeframe)) {
        marketStateContextsByTimeframe.set(strategy.decisionTimeframe, cachedMarketStates);
      }
      const trailingByMarket = trailingCandlesByTimeframe.get(strategy.decisionTimeframe) ?? new Map<string, Candle[]>();
      if (!trailingCandlesByTimeframe.has(strategy.decisionTimeframe)) {
        trailingCandlesByTimeframe.set(strategy.decisionTimeframe, trailingByMarket);
      }

      for (const market of universeSnapshot.markets) {
        const candles = decisionSet.candlesByMarket[market];
        if (!candles || decisionIndex >= candles.length) {
          continue;
        }

        const existingPosition = openPositionsByKey.get(positionKey({ market, strategyId: strategy.id }));
        const trailingCandles = trailingByMarket.get(market) ?? candles.slice(
          Math.max(0, decisionIndex - 100),
          decisionIndex + 1
        );
        if (!trailingByMarket.has(market)) {
          trailingByMarket.set(market, trailingCandles);
        }
        const strategyContext: StrategyContext = {
          strategyId: strategy.id,
          market,
          decisionTime,
          decisionTimeframe: strategy.decisionTimeframe,
          executionTimeframe: strategy.executionTimeframe,
          universeSnapshot,
          existingPosition,
          accountState: {
            equity: currentEquity,
            cash: state.cash,
            capitalInUse: 0
          },
          featureView: {
            candles,
            decisionIndex,
            executionIndex,
            trailingCandles
          },
          marketState: cachedMarketStates[market]
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
          rawBuySignals += 1;
        } else if (signal.signal === "SELL") {
          strategyMetrics[signal.strategyId].sellSignals += 1;
          rawSellSignals += 1;
        } else {
          rawHoldSignals += 1;
        }
        signalCount += 1;
        updateGhostSummary({
          ghostByStrategy,
          signal,
          candles,
          decisionIndex
        });
        if (captureTraceArtifacts) {
          allSignals.push(signal);
        }
        rawSignalsForStep.push(signal);
        if (captureTraceArtifacts) {
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
        }
        for (const [stage, passed] of Object.entries(signal.stages)) {
          if (passed) {
            funnel[signal.strategyId] ??= {};
            funnel[signal.strategyId][stage] = (funnel[signal.strategyId][stage] ?? 0) + 1;
            if (captureTraceArtifacts) {
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
    consideredBuysTotal += portfolioDecision.diagnostics.consideredBuys;
    eligibleBuysTotal += portfolioDecision.diagnostics.eligibleBuys;
    decisionObservationCount += 1;
    if (captureTraceArtifacts) {
      decisions.push({
        time: decisionTime,
        intents: portfolioDecision.intents,
        blockedSignals: portfolioDecision.blockedSignals
      });
    }
    cooldownSkipsCount += portfolioDecision.blockedSignals.filter((item) => item.reason === "cooldown").length;
    for (const blocked of portfolioDecision.blockedSignals) {
      const blockedStrategy = config.strategies.find((item) => item.id === blocked.strategyId);
      blockedSignalCount += 1;
      strategyMetrics[blocked.strategyId] ??= {
        rawSignals: 0,
        buySignals: 0,
        sellSignals: 0,
        blockedSignals: 0,
        filledOrders: 0,
        rejectedOrders: 0
      };
      strategyMetrics[blocked.strategyId].blockedSignals += 1;
      if (blockedStrategy?.sleeveId) {
        sleeveMetrics[blockedStrategy.sleeveId] ??= {
          intents: 0,
          fills: 0,
          blockedSignals: 0
        };
        sleeveMetrics[blockedStrategy.sleeveId].blockedSignals += 1;
      }
      if (captureTraceArtifacts) {
        eventStore.append({
          kind: "blocked_signal",
          at: decisionTime,
          strategyId: blocked.strategyId,
          sleeveId: blockedStrategy?.sleeveId,
          market: blocked.market,
          payload: { reason: blocked.reason }
        });
      }
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
      if (captureTraceArtifacts) {
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
      }

      const executionIndex = executionIndexByStrategyId.get(strategy.id) ?? mapDecisionToExecutionIndex({
        executionTimeline: executionSet.timeline,
        decisionTime,
        decisionTimeframe: strategy.decisionTimeframe,
        executionTimeframe: strategy.executionTimeframe
      });
      if (executionIndex < 0) {
        blockedSignalCount += 1;
        if (captureTraceArtifacts) {
          eventStore.append({
            kind: "blocked_signal",
            at: decisionTime,
            strategyId: intent.strategyId,
            sleeveId: intent.sleeveId,
            market: intent.market,
            payload: { reason: "no_execution_window" }
          });
        }
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
      if (captureTraceArtifacts) {
        fills.push(fill);
      }
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
      if (captureTraceArtifacts) {
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
      }

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
              Math.round(
                ((fill.fillTime?.getTime() ?? decisionTime.getTime()) - matchedPosition.entryTime.getTime()) /
                Math.max(1, timeframeToMs(strategy.decisionTimeframe))
              )
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

    // Update latest known prices for mark-to-market
    for (const strategy of config.strategies) {
      const set = decisionSets[strategy.decisionTimeframe];
      const lookup = decisionLookups[strategy.decisionTimeframe];
      const index = lookup?.get(decisionTime.toISOString());
      if (set && index !== undefined) {
        for (const [market, candles] of Object.entries(set.candlesByMarket)) {
          const close = candles?.[index]?.closePrice;
          if (close !== undefined) {
            latestPriceByMarket.set(market, close);
          }
        }
      }
    }

    const equity =
      state.cash +
      state.positions.reduce((sum, position) => {
        const latestPrice = latestPriceByMarket.get(position.market) ?? position.entryPrice;
        return sum + latestPrice * position.quantity;
      }, 0);
    equityCurve.push(equity);
    equityTimeline.push(decisionTime);
  }

  const winningTrades = completedTrades.filter((trade) => trade.netPnl > 0).length;

  const finalEquity = equityCurve[equityCurve.length - 1] ?? config.initialCapital;
  const grossReturn = config.initialCapital === 0 ? 0 : (finalEquity + feePaid + slippagePaid - config.initialCapital) / config.initialCapital;
  const netReturn = config.initialCapital === 0 ? 0 : (finalEquity - config.initialCapital) / config.initialCapital;
  const universeCoverage = summarizeUniverseCoverage({
    universeSnapshotsByTf,
    decisionSets,
    usedTimeframes: usedDecisionTimeframes,
    captureUniverseSnapshots
  });

  const result: MultiStrategyBacktestResult = {
    completedTrades,
    decisions,
    fills,
    events: captureTraceArtifacts ? eventStore.list() : [],
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
      signalCount,
      blockedSignalCount,
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
    decisionCoverageSummary: {
      observationCount: decisionObservationCount,
      rawBuySignals,
      rawSellSignals,
      rawHoldSignals,
      avgConsideredBuys:
        decisionObservationCount === 0 ? 0 : consideredBuysTotal / decisionObservationCount,
      avgEligibleBuys:
        decisionObservationCount === 0 ? 0 : eligibleBuysTotal / decisionObservationCount
    },
    universeCoverageSummary: universeCoverage.summary,
    finalAccount: {
      equity: finalEquity,
      cash: state.cash,
      capitalInUse: state.positions.reduce((sum, position) => sum + position.entryPrice * position.quantity, 0)
    },
    finalPositions: state.positions,
    equityCurve: equityCurve.slice(),
    equityTimeline: equityTimeline.slice(),
    rawSignals: captureTraceArtifacts ? allSignals : [],
    universeSnapshots: universeCoverage.snapshots,
    orderIntents
  };

  validateBacktestResult({
    result,
    captureTraceArtifacts
  });

  return result;
}
