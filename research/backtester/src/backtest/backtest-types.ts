import type { PositionSizer, PortfolioRiskManager, ScoredStrategy } from "../../../strategies/src/types.js";
import type { Candle } from "../types.js";
import type { ExchangeAdapter, ExecutionPolicy } from "../execution/executionTypes.js";
import type { CoordinatorConfig } from "../portfolio/portfolioTypes.js";
import type { PointInTimeUniverseConfig } from "../universe/universe-selector.js";

export type UniverseScoredBacktestParams = {
  universeName: string;
  timeframe: string;
  candidateCandlesByMarket: Record<string, Candle[]>;
  evaluationRange?: {
    start: Date;
    end: Date;
  };
  strategy: ScoredStrategy;
  positionSizer: PositionSizer;
  riskManager: PortfolioRiskManager;
  exchangeAdapter?: ExchangeAdapter;
  executionPolicy?: Partial<ExecutionPolicy>;
  coordinatorConfig?: Partial<CoordinatorConfig>;
  universeConfig?: Partial<PointInTimeUniverseConfig>;
  initialCapital?: number;
  feeRate?: number;
  runBootstrap?: boolean;
  runRandomBenchmarkFlag?: boolean;
};
