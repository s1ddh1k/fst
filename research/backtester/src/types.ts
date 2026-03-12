export type Candle = {
  marketCode: string;
  timeframe: string;
  candleTimeUtc: Date;
  openPrice: number;
  highPrice: number;
  lowPrice: number;
  closePrice: number;
  volume: number;
};

export type Signal = "BUY" | "SELL" | "HOLD";

export type PositionContext = {
  entryPrice: number;
  quantity: number;
  barsHeld: number;
};

export type StrategyContext = {
  candles: Candle[];
  index: number;
  hasPosition: boolean;
  currentPosition?: PositionContext;
};

export type Strategy = {
  name: string;
  parameters: Record<string, number>;
  generateSignal(context: StrategyContext): Signal;
};

export type Trade = {
  side: "BUY" | "SELL";
  time: Date;
  price: number;
  quantity: number;
  fee: number;
};

export type BacktestMetrics = {
  initialCapital: number;
  finalCapital: number;
  totalReturn: number;
  maxDrawdown: number;
  tradeCount: number;
  winRate: number;
};

export type BacktestResult = {
  strategyName: string;
  marketCode: string;
  timeframe: string;
  candleCount: number;
  trades: Trade[];
  equityCurve: number[];
  metrics: BacktestMetrics;
};

export type PeriodRange = {
  start: Date;
  end: Date;
};

export type HoldoutBacktestSummary = {
  backtestRunId: number;
  strategyName: string;
  marketCode: string;
  timeframe: string;
  holdoutDays: number;
  trainRange: { start: Date; end: Date };
  testRange: { start: Date; end: Date };
  train: BacktestMetrics;
  test: BacktestMetrics;
  parameters: Record<string, number>;
};

export type PortfolioBacktestSummary = {
  marketCode: string;
  timeframe: string;
  holdoutDays: number;
  strategies: Array<{
    strategyName: string;
    parameters: Record<string, number>;
    weight: number;
  }>;
  train: BacktestMetrics;
  test: BacktestMetrics;
};

export type WalkForwardWindowSummary = {
  trainRange: { start: Date; end: Date };
  testRange: { start: Date; end: Date };
  train: BacktestMetrics;
  test: BacktestMetrics;
};

export type WalkForwardBacktestSummary = {
  strategyName: string;
  marketCode: string;
  timeframe: string;
  trainingDays: number;
  holdoutDays: number;
  windowCount: number;
  windows: WalkForwardWindowSummary[];
  averageTrainReturn: number;
  averageTestReturn: number;
  averageTestDrawdown: number;
  averageTestTradeCount: number;
  parameters: Record<string, number>;
};
