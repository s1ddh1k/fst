import type {
  AccountView,
  Candle,
  PositionView,
  Signal,
  StrategyTimeframe,
  UniverseSnapshot
} from "./domain.js";

export type StrategyFeatureView = {
  candles: Candle[];
  decisionIndex: number;
  executionIndex: number;
  trailingCandles: Candle[];
};

export type StrategySignalStage =
  | "universe_eligible"
  | "regime_pass"
  | "setup_pass"
  | "trigger_pass"
  | "portfolio_accepted"
  | "execution_fill"
  | "completed_trade";

export type StrategySignal = {
  strategyId: string;
  sleeveId: string;
  family: "trend" | "breakout" | "micro" | "meanreversion";
  market: string;
  signal: Signal;
  conviction: number;
  decisionTime: Date;
  decisionTimeframe: StrategyTimeframe;
  executionTimeframe: StrategyTimeframe;
  reason: string;
  stages: Partial<Record<StrategySignalStage, boolean>>;
  metadata?: Record<string, number | string | boolean | null | undefined>;
};

export type StrategyContext = {
  strategyId: string;
  market: string;
  decisionTime: Date;
  decisionTimeframe: StrategyTimeframe;
  executionTimeframe: StrategyTimeframe;
  universeSnapshot?: UniverseSnapshot;
  existingPosition?: PositionView;
  accountState?: AccountView;
  featureView: StrategyFeatureView;
  marketState?: Record<string, unknown>;
};

export type Strategy = {
  readonly id: string;
  readonly sleeveId: string;
  readonly family: "trend" | "breakout" | "micro" | "meanreversion";
  readonly decisionTimeframe: StrategyTimeframe;
  readonly executionTimeframe: StrategyTimeframe;
  readonly parameters: Record<string, number>;
  generateSignal(context: StrategyContext): StrategySignal;
};
