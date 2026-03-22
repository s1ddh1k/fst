import type { OrderSide } from "./domain.js";

export type SleeveId = "trend" | "breakout" | "micro";

export type StrategySleeveConfig = {
  sleeveId: SleeveId;
  capitalBudgetPct: number;
  maxOpenPositions: number;
  maxSinglePositionPct: number;
  priority: number;
};

export type PositionIntentAction = "OPEN" | "CLOSE" | "REDUCE" | "KEEP";

export type PositionIntent = {
  strategyId: string;
  sleeveId: SleeveId;
  market: string;
  action: PositionIntentAction;
  side: OrderSide;
  targetNotional: number;
  targetQuantity?: number;
  conviction: number;
  reason: string;
  executionStyle: "market" | "best_ioc" | "limit_passive" | "limit_aggressive";
  metadata?: Record<string, unknown>;
};

export type BlockedSignal = {
  strategyId: string;
  market: string;
  reason: string;
};

export type PortfolioDecision = {
  ts: number;
  intents: PositionIntent[];
  blockedSignals: BlockedSignal[];
  diagnostics: {
    consideredBuys: number;
    eligibleBuys: number;
  };
};
