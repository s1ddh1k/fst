export type CandidateSignal = {
  market: string;
  timestamp: Date;
  signal: "BUY" | "SELL" | "HOLD";
  conviction: number;
  lastPrice: number;
  metadata?: {
    estimatedSpreadBps?: number;
    liquidityScore?: number;
    avgDailyNotional?: number;
    isSyntheticBar?: boolean;
    exitReason?: OrderIntent["reason"];
  };
};

export type OpenPosition = {
  market: string;
  entryTimestamp: Date;
  entryPrice: number;
  quantity: number;
  entryBarIndex: number;
};

export type PortfolioState = {
  cash: number;
  position?: OpenPosition;
  cooldownUntilByMarket: Record<string, number>;
  lastExitReasonByMarket: Record<string, string | undefined>;
  lastExitBarIndexByMarket: Record<string, number | undefined>;
  lastEntryBarIndexByMarket: Record<string, number | undefined>;
  tradesToday: number;
  currentTradeDay?: string;
  lastTradeTimestamp?: Date;
};

export type CoordinatorConfig = {
  minBuyConviction: number;
  cooldownBarsAfterLoss: number;
  minBarsBetweenReentry: number;
  maxTradesPerDay?: number;
  allowSwitching?: boolean;
  ignoreSyntheticBarsForEntry?: boolean;
};

export type OrderIntent = {
  side: "BUY" | "SELL";
  market: string;
  timestamp: Date;
  orderStyle: "market" | "best_ioc" | "limit";
  reason:
    | "entry"
    | "signal_exit"
    | "stop_exit"
    | "trail_exit"
    | "risk_off_exit"
    | "rebalance_exit";
  conviction: number;
  targetNotional?: number;
  targetQuantity?: number;
  limitPrice?: number;
  metadata?: Record<string, unknown>;
};

export type CoordinationDiagnostics = {
  cooldownSkips: number;
  consideredBuys: number;
  eligibleBuys: number;
};

export type CoordinationResult = {
  intent: OrderIntent | null;
  diagnostics: CoordinationDiagnostics;
};
