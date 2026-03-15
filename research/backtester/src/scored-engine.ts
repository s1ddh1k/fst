import type { MarketStateContext } from "../../strategies/src/index.js";
import type {
  PortfolioRiskManager,
  PositionSizer,
  ScoredStrategy
} from "../../strategies/src/types.js";
import type { Candle, ScoredBacktestResult } from "./types.js";
import { runUniverseScoredBacktest } from "./backtest/BacktestEngine.js";

export function runScoredBacktest(params: {
  marketCode: string;
  timeframe: string;
  candles: Candle[];
  strategy: ScoredStrategy;
  positionSizer: PositionSizer;
  riskManager: PortfolioRiskManager;
  universeName?: string;
  benchmarkMarketCode?: string;
  universeCandlesByMarket?: Record<string, Candle[]>;
  precomputedMarketStateByTime?: Record<string, MarketStateContext>;
  initialCapital?: number;
  feeRate?: number;
  slippageRate?: number;
  runBootstrap?: boolean;
  runRandomBenchmarkFlag?: boolean;
}): ScoredBacktestResult {
  const candidateCandlesByMarket = params.universeCandlesByMarket ?? {
    [params.marketCode]: params.candles
  };

  return runUniverseScoredBacktest({
    universeName: params.universeName ?? params.marketCode,
    timeframe: params.timeframe,
    candidateCandlesByMarket,
    strategy: params.strategy,
    positionSizer: params.positionSizer,
    riskManager: params.riskManager,
    initialCapital: params.initialCapital,
    feeRate: params.feeRate,
    runBootstrap: params.runBootstrap,
    runRandomBenchmarkFlag: params.runRandomBenchmarkFlag
  });
}
