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

  // Same proven strategy as BTC single-market, applied to each coin:
  //   trend_up:   donchian breakout (trend following on each coin)
  //   trend_down: volume-exhaustion (catch capitulation bounces on each coin)
  //   range:      cash (no trading)

  // trend_up: relative strength rotation
  // 유니버스에서 아직 덜 오른(상대적 약세) 종목 매수 → 충분히 오르면 매도 → 다른 종목으로 교체
  const trendUpStrategy = withCryptoRegimeGate({
    strategy: createRelativeStrengthRotationStrategy({
      strategyId: "regime-rotation",
      rebalanceBars: 5,
      entryFloor: 0.70,         // 상대강도 70% 이상이면 진입
      reEntryCooldownBars: 3,
      exitFloor: 0.50,          // 상대강도 50% 이하면 교체
      switchGap: 0.10,          // 현재 vs 대체 종목 gap
      minAboveTrendRatio: 0.0,  // 완전 비활성 — crypto regime gate만 사용
      minLiquidityScore: 0.0,
      minCompositeTrend: -1.0   // 완전 비활성
    }),
    allowedRegimes: ["trend_up"],
    exitOnDisallow: true,
    benchmarkCandles: btcCandles,
    cooldownBars: 72
  });

  // trend_down: volume-exhaustion — catches capitulation bounces on individual coins
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
