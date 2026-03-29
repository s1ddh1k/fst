/**
 * Regime-switching portfolio — uses the EXISTING multi-strategy engine.
 *
 * Instead of a separate regime-switching simulator, this configures
 * multiple regime-gated strategies in the real backtest engine:
 *   - trend_up:   relative strength rotation (uses adaptive regime from market-state.ts)
 *   - trend_down: vol-exhaustion (crypto regime gate)
 *   - range:      cash (no trading)
 *
 * The rotation strategy uses adaptive regime detection built into market-state.ts
 * (SMA200, momentum72, no volatile override) instead of the external crypto-regime-gate.
 * This keeps regime logic centralized and testable.
 */

import type { Candle } from "../types.js";
import type { Strategy, StrategyTimeframe } from "../../../../packages/shared/src/index.js";
import {
  runMultiStrategyBacktest,
  adaptScoredStrategy
} from "../multi-strategy/index.js";
import { withCryptoRegimeGate, resetCryptoRegimeCache } from "./crypto-regime-gate.js";
import {
  createVolumeExhaustionBounceStrategy
} from "../../../strategies/src/simple-strategies.js";
import {
  createRelativeStrengthRotationStrategy
} from "../multi-strategy/index.js";

type CandleMap = Record<string, Candle[]>;

export type RegimePortfolioConfig = {
  candlesByTimeframeAndMarket: Record<string, CandleMap>;
  initialCapital: number;
  marketCodes: string[];
  maxOpenPositions?: number;
};

export function runRegimePortfolioBacktest(config: RegimePortfolioConfig) {
  const { candlesByTimeframeAndMarket, initialCapital, marketCodes } = config;
  resetCryptoRegimeCache();

  // Use BTC as regime benchmark for all markets
  const btcCandles = candlesByTimeframeAndMarket["1h"]?.["KRW-BTC"] ?? [];

  // trend_up: relative strength rotation
  // Uses adaptive regime from market-state.ts directly (useAdaptiveRegime: true)
  // instead of external crypto-regime-gate wrapping.
  // The strategy's own minAboveTrendRatio and minCompositeTrend handle regime gating internally.
  const trendUpStrategy = createRelativeStrengthRotationStrategy({
    strategyId: "regime-rotation",
    rebalanceBars: 5,
    entryFloor: 0.70,
    reEntryCooldownBars: 3,
    exitFloor: 0.50,
    switchGap: 0.10,
    minAboveTrendRatio: 0.55,   // Re-enabled — adaptive regime gives meaningful trend signals
    minLiquidityScore: 0.05,
    minCompositeTrend: 0         // Re-enabled — adaptive regime gives meaningful trend signals
  });

  // trend_down: volume-exhaustion — catches capitulation bounces on individual coins
  // Still uses crypto regime gate since it needs 1h BTC candles for separate regime detection
  const trendDownStrategy = withCryptoRegimeGate({
    strategy: adaptScoredStrategy({
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
    }),
    allowedRegimes: ["trend_down"],
    exitOnDisallow: true,
    benchmarkCandles: btcCandles,
    cooldownBars: 72
  });

  // range: no strategy (cash)
  const rangeStrategy = null;

  return runMultiStrategyBacktest({
    universeName: "krw-top",
    initialCapital,
    strategies: [trendUpStrategy, trendDownStrategy].filter(Boolean),
    sleeves: [
      { sleeveId: "trend", capitalBudgetPct: 0.45, maxOpenPositions: 3, maxSinglePositionPct: 0.25, priority: 10 },
      { sleeveId: "micro", capitalBudgetPct: 0.45, maxOpenPositions: 3, maxSinglePositionPct: 0.25, priority: 9 },
    ],
    decisionCandles: candlesByTimeframeAndMarket as any,
    executionCandles: candlesByTimeframeAndMarket as any,
    // Use adaptive regime detection for market state contexts
    marketStateConfig: { useAdaptiveRegime: true },
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
