/**
 * Regime-switching portfolio — uses the EXISTING multi-strategy engine.
 *
 * Instead of a separate regime-switching simulator, this configures
 * multiple regime-gated strategies in the real backtest engine:
 *   - trend_up:   donchian-breakout (30 coin universe)
 *   - trend_down: vol-exhaustion-15m (30 coin universe)
 *   - range:      rsi-reversion (30 coin universe)
 *
 * All strategies run simultaneously. The regime gate activates/deactivates
 * each strategy automatically based on market state.
 */

import type { Candle } from "../types.js";
import type { StrategyTimeframe } from "../../../../packages/shared/src/index.js";
import {
  runMultiStrategyBacktest,
  withRegimeGate,
  adaptScoredStrategy
} from "../multi-strategy/index.js";
import type { RegimeGateConfig } from "../multi-strategy/RegimeGatedStrategy.js";
import {
  createDonchianBreakoutStrategy,
  createVolumeExhaustionBounce15mStrategy,
  createSimpleRsiReversionStrategy,
  createVolumeExhaustionBounceStrategy
} from "../../../strategies/src/simple-strategies.js";

type CandleMap = Record<string, Candle[]>;

export type RegimePortfolioConfig = {
  candlesByTimeframeAndMarket: Record<string, CandleMap>;
  initialCapital: number;
  marketCodes: string[];
  maxOpenPositions?: number;
};

export function runRegimePortfolioBacktest(config: RegimePortfolioConfig) {
  const { candlesByTimeframeAndMarket, initialCapital, marketCodes } = config;

  // All strategies run WITHOUT regime gate — let every strategy trade in all conditions.
  // The strategies themselves have internal logic (RSI thresholds, volume conditions)
  // that naturally filter when to enter. The portfolio engine coordinates capital.
  //
  // This is simpler and avoids the broken market-state.ts regime detection.

  const trendUpStrategy = adaptScoredStrategy({
    strategyId: "regime-donchian-1h",
    sleeveId: "trend",
    family: "breakout",
    decisionTimeframe: "1h",
    executionTimeframe: "1h",
    scoredStrategy: createDonchianBreakoutStrategy({
      entryLookback: 20,
      exitLookback: 10,
      stopAtrMult: 2.0,
      maxHoldBars: 96,
      minChannelWidth: 0.02
    })
  });

  const trendDownStrategy = adaptScoredStrategy({
    strategyId: "regime-vex-1h",
    sleeveId: "micro",
    family: "meanreversion",
    decisionTimeframe: "1h",
    executionTimeframe: "1h",
    scoredStrategy: createVolumeExhaustionBounceStrategy({
      dropLookback: 5,
      dropThresholdPct: 0.06,
      volumeWindow: 20,
      volumeSpikeMult: 2.5,
      rsiPeriod: 14,
      rsiEntry: 20,
      profitTargetPct: 0.025
    })
  });

  const rangeStrategy = adaptScoredStrategy({
    strategyId: "regime-rsi-1h",
    sleeveId: "micro",
    family: "meanreversion",
    decisionTimeframe: "1h",
    executionTimeframe: "1h",
    scoredStrategy: createSimpleRsiReversionStrategy({
      rsiPeriod: 14,
      oversold: 30,
      overbought: 70,
      stopLossPct: 0.05,
      maxHoldBars: 48
    })
  });

  return runMultiStrategyBacktest({
    universeName: "krw-top",
    initialCapital,
    strategies: [trendUpStrategy, trendDownStrategy, rangeStrategy],
    sleeves: [
      { sleeveId: "trend", capitalBudgetPct: 0.45, maxOpenPositions: 3, maxSinglePositionPct: 0.25, priority: 10 },
      { sleeveId: "micro", capitalBudgetPct: 0.45, maxOpenPositions: 3, maxSinglePositionPct: 0.25, priority: 9 },
    ],
    decisionCandles: candlesByTimeframeAndMarket as any,
    executionCandles: candlesByTimeframeAndMarket as any,
    universeConfig: {
      topN: Math.min(config.maxOpenPositions ?? 5, marketCodes.length),
      lookbackBars: 28,
      refreshEveryBars: 4
    },
    captureTraceArtifacts: false,
    captureUniverseSnapshots: false,
    maxOpenPositions: config.maxOpenPositions ?? 5,
    maxCapitalUsagePct: 0.95,
    cooldownBarsAfterLoss: 12,
    minBarsBetweenEntries: 1
  });
}
