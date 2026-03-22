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

export type CompositeBenchmarkRegime =
  | "trend_up"
  | "trend_down"
  | "range"
  | "volatile"
  | "unknown";

export type CompositeBenchmarkAnchorContext = {
  timeframe: "intraday" | "1d" | "1w";
  sampleSize: number;
  averageChange: number | null;
  momentum: number | null;
  aboveTrend: boolean | null;
  aboveTrendRatio: number;
  historicalVolatility: number | null;
  trendScore: number;
  liquidityScore: number;
  dispersionScore: number;
  regime: CompositeBenchmarkRegime;
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
  regime: CompositeBenchmarkRegime;
  anchors?: {
    intraday: CompositeBenchmarkAnchorContext;
    daily?: CompositeBenchmarkAnchorContext;
    weekly?: CompositeBenchmarkAnchorContext;
  };
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

export type AlphaDiagnostics = {
  entryFactors: string[];
  exitFactors: string[];
};

export type AlphaSnapshot = {
  entryScore: number | null;
  exitScore: number | null;
  entryMatchedFactors: number;
  exitMatchedFactors: number;
  diagnostics?: AlphaDiagnostics;
};

export type AlphaModel = {
  name: string;
  evaluate(context: StrategyContext): AlphaSnapshot;
};

export type RiskDecision = {
  signal: Signal;
  reason: string;
};

export type RiskModel = {
  name: string;
  decide(params: {
    context: StrategyContext;
    alpha: AlphaSnapshot;
  }): RiskDecision;
};

export type Strategy = {
  name: string;
  parameters: Record<string, number>;
  contextConfig?: MarketStateConfig;
  generateSignal(context: StrategyContext): Signal;
};

// --- v2 types ---

export type SignalMetadata = {
  reason?: string;
  tags?: string[];
  orderReason?: string;
  metrics?: Record<string, number | null>;
};

export type SignalResult = {
  signal: Signal;
  conviction: number;
  metadata?: SignalMetadata;
};

export type ScoredStrategy = {
  name: string;
  parameters: Record<string, number>;
  parameterCount: number;
  contextConfig?: MarketStateConfig;
  generateSignal(context: StrategyContext): SignalResult;
};

export type PositionSizeRequest = {
  conviction: number;
  currentPrice: number;
  atr: number;
  portfolioEquity: number;
  currentPositionValue: number;
};

export type PositionSizeResult = {
  targetWeight: number;
  reason: string;
};

export type PositionSizer = {
  name: string;
  calculate(request: PositionSizeRequest): PositionSizeResult;
};

export type PortfolioRiskCheck = {
  canOpenNew: boolean;
  mustLiquidateAll: boolean;
  maxExposure: number;
  reason: string;
};

export type PortfolioRiskManager = {
  name: string;
  check(params: {
    currentEquity: number;
    peakEquity: number;
    currentExposure: number;
  }): PortfolioRiskCheck;
  onBarClose(equity: number): void;
};
