export type Candle = {
  marketCode: string;
  timeframe: string;
  candleTimeUtc: Date;
  openPrice: number;
  highPrice: number;
  lowPrice: number;
  closePrice: number;
  volume: number;
  quoteVolume?: number;
  isSynthetic?: boolean;
};

export type Signal = "BUY" | "SELL" | "HOLD";

export type PositionContext = {
  entryPrice: number;
  quantity: number;
  barsHeld: number;
};

export type MarketBreadthContext = {
  sampleSize: number;
  advancingRatio: number;
  aboveTrendRatio: number;
  positiveMomentumRatio: number;
  averageMomentum: number | null;
  averageZScore: number | null;
  averageVolumeSpike: number | null;
  averageHistoricalVolatility: number | null;
  dispersionScore: number;
  liquidityScore: number;
  compositeTrendScore: number;
  riskOnScore: number;
};

export type RelativeStrengthContext = {
  momentumSpread: number | null;
  zScoreSpread: number | null;
  volumeSpikeSpread: number | null;
  benchmarkMomentumSpread: number | null;
  momentumPercentile: number | null;
  cohortMomentumSpread: number | null;
  cohortZScoreSpread: number | null;
  cohortVolumeSpikeSpread: number | null;
  compositeMomentumSpread: number | null;
  compositeChangeSpread: number | null;
  liquiditySpread: number | null;
  returnPercentile: number | null;
};

export type CompositeBenchmarkContext = {
  source: "universe_composite";
  marketCode: string;
  averageChange: number | null;
  momentum: number | null;
  aboveTrend: boolean | null;
  aboveTrendRatio: number;
  historicalVolatility: number | null;
  trendScore: number;
  liquidityScore: number;
  dispersionScore: number;
  regime: "trend_up" | "trend_down" | "range" | "volatile" | "unknown";
};

export type BenchmarkMarketContext = CompositeBenchmarkContext;

export type MarketStateContext = {
  universeName?: string;
  benchmarkMarketCode?: string;
  referenceTime: Date;
  sampleSize: number;
  breadth: MarketBreadthContext;
  relativeStrength?: RelativeStrengthContext;
  composite?: CompositeBenchmarkContext;
  benchmark?: BenchmarkMarketContext;
};

export type MarketStateConfig = {
  trendWindow?: number;
  momentumLookback?: number;
  volumeWindow?: number;
  zScoreWindow?: number;
  volatilityWindow?: number;
  benchmarkMarketCode?: string;
};

export type StrategyContext = {
  candles: Candle[];
  index: number;
  hasPosition: boolean;
  currentPosition?: PositionContext;
  marketState?: MarketStateContext;
};

export type Strategy = {
  name: string;
  parameters: Record<string, number>;
  contextConfig?: MarketStateConfig;
  generateSignal(context: StrategyContext): Signal;
};

export type Trade = {
  marketCode?: string;
  side: "BUY" | "SELL";
  time: Date;
  price: number;
  quantity: number;
  fee: number;
  slippage?: number;
  reason?: string;
};

export type BacktestMetrics = {
  initialCapital: number;
  finalCapital: number;
  totalReturn: number;
  grossReturn: number;
  netReturn: number;
  maxDrawdown: number;
  tradeCount: number;
  winRate: number;
  turnover: number;
  avgHoldBars: number;
  feePaid: number;
  slippagePaid: number;
  rejectedOrdersCount: number;
  cooldownSkipsCount: number;
};

export type BacktestReasonCounts = {
  strategy: Record<string, number>;
  strategyTags: Record<string, number>;
  coordinator: Record<string, number>;
  execution: Record<string, number>;
  risk: Record<string, number>;
};

export type BacktestCoverageSummary = {
  rawBuySignals: number;
  rawSellSignals: number;
  rawHoldSignals: number;
  avgUniverseSize: number;
  minUniverseSize: number;
  maxUniverseSize: number;
  avgConsideredBuys: number;
  avgEligibleBuys: number;
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

export type UniverseAlphaCandidate = {
  marketCode: string;
  score: number;
  factors: Record<string, number | null>;
};

export type UniverseBacktestTrade = {
  marketCode: string;
  side: "BUY" | "SELL";
  time: Date;
  price: number;
  quantity: number;
  fee: number;
  score: number | null;
  weight: number | null;
};

export type UniverseBacktestMetrics = BacktestMetrics & {
  rebalanceCount: number;
  averagePositions: number;
  turnover: number;
};

export type UniverseBacktestResult = {
  strategyName: string;
  universeName: string;
  timeframe: string;
  marketCount: number;
  trades: UniverseBacktestTrade[];
  equityCurve: number[];
  metrics: UniverseBacktestMetrics;
  selectedHistory: Array<{
    time: Date;
    marketCodes: string[];
  }>;
};

// --- scored types ---

export type BootstrapResult = {
  observedReturn: number;
  meanReturn: number;
  confidence95Lower: number;
  confidence95Upper: number;
  pValue: number;
  isSignificant: boolean;
  tradeToParameterRatio: number;
  passesMinRatio: boolean;
};

export type RandomBenchmarkResult = {
  strategyReturn: number;
  randomMeanReturn: number;
  randomMedianReturn: number;
  percentileVsRandom: number;
  beatsRandomPct: number;
};

export type GhostTradeHorizonSummary = {
  horizonBars: number;
  sampleSize: number;
  medianMfe: number;
  medianMae: number;
  medianGrossReturn: number;
  medianNetReturn: number;
  positiveNetRate: number;
};

export type GhostTradeStudySummary = {
  entryReference: "next_bar_open";
  horizonSummaries: GhostTradeHorizonSummary[];
};

export type ScoredBacktestResult = BacktestResult & {
  positionSizing: string;
  riskManagement: string;
  bootstrap?: BootstrapResult;
  randomBenchmark?: RandomBenchmarkResult;
  averagePositionWeight: number;
  maxPositionWeight: number;
  circuitBreakerTriggered: number;
  signalCount: number;
  ghostSignalCount: number;
  decisionCounts: {
    rawBuySignals: number;
    rawSellSignals: number;
    rawHoldSignals: number;
  };
  reasonCounts: BacktestReasonCounts;
  coverageSummary: BacktestCoverageSummary;
  ghostStudy: GhostTradeStudySummary;
  universeName?: string;
  marketCount?: number;
};
