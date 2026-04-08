import type { Candle } from "../types.js";
import { runRegimePortfolioV2 } from "./regime-portfolio-v2.js";

type CandleMap = Record<string, Candle[]>;

export type RegimePortfolioConfig = {
  candlesByTimeframeAndMarket: Record<string, CandleMap>;
  initialCapital: number;
  marketCodes: string[];
  maxOpenPositions?: number;
};

export function runRegimePortfolioBacktest(config: RegimePortfolioConfig) {
  return runRegimePortfolioV2(config);
}
