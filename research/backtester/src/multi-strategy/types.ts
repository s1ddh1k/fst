import type {
  AccountView,
  Candle,
  OrderIntent,
  PositionIntent,
  PositionView,
  Strategy,
  StrategySignal,
  StrategySleeveConfig,
  StrategyTimeframe,
  UniverseSnapshot
} from "../../../../packages/shared/src/index.js";
import type { ExchangeAdapter } from "../execution/executionTypes.js";

export type MarketTimeframeSeries = Record<string, Candle[]>;
export type TimeframeCandleMap = Partial<Record<StrategyTimeframe, MarketTimeframeSeries>>;

export type FullGridCandleSet = {
  timeframe: StrategyTimeframe;
  timeline: Date[];
  candlesByMarket: MarketTimeframeSeries;
};

export type UniverseSnapshotBuilderConfig = {
  topN: number;
  minTopN: number;
  lookbackBars: number;
  refreshEveryBars: number;
  minHistoryBars: number;
  targetQuoteVolumeShare: number;
};

export type SleeveAllocation = {
  sleeveId: string;
  budgetNotional: number;
  remainingNotional: number;
  maxOpenPositions: number;
  maxSinglePositionNotional: number;
  priority: number;
};

export type PortfolioEngineConfig = {
  maxOpenPositions: number;
  maxCapitalUsagePct: number;
  cooldownBarsAfterLoss: number;
  minBarsBetweenEntries: number;
  sleeves: StrategySleeveConfig[];
};

export type PortfolioEngineState = {
  cash: number;
  positions: PositionView[];
  cooldownUntilByMarket: Record<string, number>;
  lastEntryBarByMarket: Record<string, number>;
};

export type RiskCheck = {
  accepted: boolean;
  reason?: string;
};

export type SimulationFill = {
  orderId: string;
  market: string;
  side: "BUY" | "SELL";
  status: "FILLED" | "REJECTED";
  fillTime?: Date;
  fillPrice?: number;
  filledQuantity?: number;
  filledNotional?: number;
  feePaid: number;
  slippagePaid: number;
  reason?: string;
};

export type MultiStrategyBacktestConfig = {
  universeName: string;
  initialCapital: number;
  exchangeAdapter?: ExchangeAdapter;
  strategies: Strategy[];
  sleeves: StrategySleeveConfig[];
  decisionCandles: TimeframeCandleMap;
  executionCandles: TimeframeCandleMap;
  /** Market state config passed to buildMarketStateContexts (e.g. useAdaptiveRegime) */
  marketStateConfig?: Record<string, unknown>;
  preNormalizedDecisionSets?: Partial<Record<StrategyTimeframe, FullGridCandleSet>>;
  preNormalizedExecutionSets?: Partial<Record<StrategyTimeframe, FullGridCandleSet>>;
  precomputedUniverseSnapshotsByTf?: Partial<Record<StrategyTimeframe, Map<string, UniverseSnapshot>>>;
  captureTraceArtifacts?: boolean;
  captureUniverseSnapshots?: boolean;
  universeConfig?: Partial<UniverseSnapshotBuilderConfig>;
  maxOpenPositions?: number;
  maxCapitalUsagePct?: number;
  cooldownBarsAfterLoss?: number;
  minBarsBetweenEntries?: number;
};

export type MarketStateResolver = (params: {
  strategy: Strategy;
  market: string;
  decisionIndex: number;
  decisionTime: Date;
  decisionCandlesByMarket: MarketTimeframeSeries;
  universeSnapshot?: UniverseSnapshot;
}) => Record<string, unknown> | undefined;

export type MultiStrategyBacktestResult = {
  completedTrades: Array<{
    strategyId: string;
    sleeveId: string;
    market: string;
    entryTime: Date;
    exitTime: Date;
    entryPrice: number;
    exitPrice: number;
    quantity: number;
    grossPnl: number;
    feePaid: number;
    slippagePaid: number;
    netPnl: number;
    returnPct: number;
  }>;
  decisions: Array<{
    time: Date;
    intents: PositionIntent[];
    blockedSignals: Array<{ strategyId: string; market: string; reason: string }>;
  }>;
  fills: SimulationFill[];
  events: import("../../../../packages/shared/src/index.js").EngineEvent[];
  metrics: {
    grossReturn: number;
    netReturn: number;
    turnover: number;
    winRate: number;
    avgHoldBars: number;
    maxDrawdown: number;
    feePaid: number;
    slippagePaid: number;
    rejectedOrdersCount: number;
    cooldownSkipsCount: number;
    signalCount: number;
    blockedSignalCount: number;
    openPositionCount: number;
  };
  strategyMetrics: Record<
    string,
    {
      rawSignals: number;
      buySignals: number;
      sellSignals: number;
      blockedSignals: number;
      filledOrders: number;
      rejectedOrders: number;
    }
  >;
  sleeveMetrics: Record<
    string,
    {
      intents: number;
      fills: number;
      blockedSignals: number;
    }
  >;
  funnel: Record<string, Record<string, number>>;
  ghostSummary: Record<string, { count: number; avgForwardReturn: number }>;
  decisionCoverageSummary: {
    observationCount: number;
    rawBuySignals: number;
    rawSellSignals: number;
    rawHoldSignals: number;
    avgConsideredBuys: number;
    avgEligibleBuys: number;
  };
  universeCoverageSummary: {
    avg: number;
    min: number;
    max: number;
    observationCount: number;
  };
  finalAccount: AccountView;
  finalPositions: PositionView[];
  equityCurve: number[];
  equityTimeline: Date[];
  rawSignals: StrategySignal[];
  universeSnapshots: UniverseSnapshot[];
  orderIntents: OrderIntent[];
};
