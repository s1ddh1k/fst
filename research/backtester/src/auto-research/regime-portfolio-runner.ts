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
import { withCryptoRegimeGate, resetCryptoRegimeCache } from "./crypto-regime-gate.js";
import {
  createRelativeStrengthRotationStrategy,
  createBollingerMeanReversionMultiStrategy,
  createRelativeMomentumPullbackMultiStrategy,
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

  // Multi-market strategies designed for universe-wide trading,
  // gated by our crypto regime detection (BTC benchmark).

  // trend_up: relative strength rotation — buys the strongest coins, rotates
  const trendUpStrategy = withCryptoRegimeGate({
    strategy: createRelativeStrengthRotationStrategy({
      strategyId: "regime-rotation-1h",
      rebalanceBars: 5,
      entryFloor: 0.80,
      reEntryCooldownBars: 3,
      exitFloor: 0.56,
      switchGap: 0.12,
      minAboveTrendRatio: 0.50,  // lowered — our regime gate handles macro filtering
      minLiquidityScore: 0.04,
      minCompositeTrend: -0.10   // lowered — regime gate already filters
    }),
    allowedRegimes: ["trend_up"],
    exitOnDisallow: true,
    benchmarkCandles: btcCandles
  });

  // trend_down: BB mean reversion — proven strategy, +3.88% in previous tests
  const trendDownStrategy = withCryptoRegimeGate({
    strategy: createBollingerMeanReversionMultiStrategy({
      strategyId: "regime-bb-reversion-1h",
      bbWindow: 24,
      bbMultiplier: 2.1,
      rsiPeriod: 14,
      entryRsiThreshold: 30,
      requireRsiConfirmation: false,
      requireReclaimConfirmation: true,
      reclaimLookbackBars: 4,
      reclaimPercentBThreshold: 0.18,
      reclaimMinCloseBouncePct: 0.004,
      reclaimBandWidthFactor: 0.12,
      deepTouchEntryPercentB: -0.05,
      deepTouchRsiThreshold: 18,
      exitRsi: 40,
      stopLossPct: 0.09,
      maxHoldBars: 24,
      entryPercentB: -0.02,
      minBandWidth: 0.015
    }),
    allowedRegimes: ["trend_down", "range"],  // works in both bear and sideways
    exitOnDisallow: true,
    benchmarkCandles: btcCandles
  });

  // range: momentum pullback — buys dips in strong coins during sideways
  const rangeStrategy = withCryptoRegimeGate({
    strategy: createRelativeMomentumPullbackMultiStrategy({
      strategyId: "regime-pullback-1h",
      minStrengthPct: 0.75,
      minRiskOn: 0.05,
      pullbackZ: 0.9,
      trailAtrMult: 2.2
    }),
    allowedRegimes: ["range"],
    exitOnDisallow: true,
    benchmarkCandles: btcCandles
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
