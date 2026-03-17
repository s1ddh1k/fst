import {
  getAtr,
  getEma,
  getRsi,
  getVolumeSpikeRatio,
  getZScore
} from "./factors/index.js";
import type {
  MarketStateConfig,
  ScoredStrategy,
  SignalResult,
  StrategyContext
} from "./types.js";
import { buy, hold, sell } from "./scored-signal.js";

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function normalizeWindow(value: number, low: number, high: number): number {
  if (!Number.isFinite(value) || high <= low) {
    return 0;
  }

  if (value <= low) {
    return 0;
  }

  if (value >= high) {
    return 1;
  }

  return (value - low) / (high - low);
}

function recentMinimumZ(candles: StrategyContext["candles"], index: number, window: number): number | null {
  let minValue = Number.POSITIVE_INFINITY;
  let found = false;

  for (let offset = Math.max(0, index - window + 1); offset <= index; offset += 1) {
    const zScore = getZScore(candles, offset, 20);

    if (zScore === null) {
      continue;
    }

    minValue = Math.min(minValue, zScore);
    found = true;
  }

  return found ? minValue : null;
}

function highestCloseSinceEntry(candles: StrategyContext["candles"], index: number, barsHeld: number): number {
  const start = Math.max(0, index - barsHeld);
  let highest = Number.NEGATIVE_INFINITY;

  for (let candleIndex = start; candleIndex <= index; candleIndex += 1) {
    highest = Math.max(highest, candles[candleIndex]?.closePrice ?? Number.NEGATIVE_INFINITY);
  }

  return highest;
}

function hasRecentCloseBelowEma(
  candles: StrategyContext["candles"],
  index: number,
  period: number,
  lookbackBars: number
): boolean {
  const start = Math.max(0, index - lookbackBars);

  for (let candleIndex = start; candleIndex < index; candleIndex += 1) {
    const close = candles[candleIndex]?.closePrice;
    const ema = getEma(candles, candleIndex, period);

    if (close !== undefined && ema !== null && close <= ema) {
      return true;
    }
  }

  return false;
}

function closesBelowEma(
  candles: StrategyContext["candles"],
  index: number,
  period: number,
  consecutiveBars: number
): boolean {
  if (consecutiveBars <= 0) {
    return false;
  }

  const start = index - consecutiveBars + 1;

  if (start < 0) {
    return false;
  }

  for (let candleIndex = start; candleIndex <= index; candleIndex += 1) {
    const close = candles[candleIndex]?.closePrice;
    const ema = getEma(candles, candleIndex, period);

    if (close === undefined || ema === null || close >= ema) {
      return false;
    }
  }

  return true;
}

function recentPeakClose(
  candles: StrategyContext["candles"],
  index: number,
  lookbackBars: number
): { peakClose: number; peakIndex: number } | null {
  const end = index - 1;
  const start = Math.max(0, end - lookbackBars + 1);
  let peakClose = Number.NEGATIVE_INFINITY;
  let peakIndex = -1;

  for (let candleIndex = start; candleIndex <= end; candleIndex += 1) {
    const close = candles[candleIndex]?.closePrice;
    if (close === undefined || close <= peakClose) {
      continue;
    }

    peakClose = close;
    peakIndex = candleIndex;
  }

  return peakIndex >= 0 ? { peakClose, peakIndex } : null;
}

function lowestCloseInRange(
  candles: StrategyContext["candles"],
  startIndex: number,
  endIndex: number
): { lowClose: number; lowIndex: number } | null {
  if (endIndex < startIndex) {
    return null;
  }

  let lowClose = Number.POSITIVE_INFINITY;
  let lowIndex = -1;

  for (let candleIndex = startIndex; candleIndex <= endIndex; candleIndex += 1) {
    const close = candles[candleIndex]?.closePrice;
    if (close === undefined || close >= lowClose) {
      continue;
    }

    lowClose = close;
    lowIndex = candleIndex;
  }

  return lowIndex >= 0 ? { lowClose, lowIndex } : null;
}

export function createRelativeMomentumPullbackStrategy(params?: {
  minStrengthPct?: number;
  minRiskOn?: number;
  pullbackZ?: number;
  trailAtrMult?: number;
}): ScoredStrategy {
  const minStrengthPct = params?.minStrengthPct ?? 0.75;
  const minRiskOn = params?.minRiskOn ?? 0.10;
  const pullbackZ = params?.pullbackZ ?? 0.90;
  const trailAtrMult = params?.trailAtrMult ?? 2.2;
  const reclaimLookbackBars = 3;
  const earlyFailureExitBars = 4;
  const earlyFailureFollowThroughAtr = 0.75;
  const adaptiveTrailArmAtr = 1.25;
  const adaptiveTrailFloorAtr = 1.0;
  const softExitConfirmationBars = 2;
  const minimumHoldBarsBeforeSoftExit = 3;
  const peakLookbackBars = 12;
  const maxBarsSincePeak = 8;
  const minRecoveryRatio = 0.22;

  const parameters: Record<string, number> = {
    minStrengthPct,
    minRiskOn,
    pullbackZ,
    trailAtrMult
  };

  const contextConfig: MarketStateConfig = {
    trendWindow: 50,
    momentumLookback: 20,
    volumeWindow: 20,
    zScoreWindow: 20,
    volatilityWindow: 20
  };

  return {
    name: "relative-momentum-pullback",
    parameters,
    parameterCount: 4,
    contextConfig,

    generateSignal(context: StrategyContext): SignalResult {
      const { candles, index, hasPosition, currentPosition, marketState } = context;
      const candle = candles[index];
      const previousCandle = candles[index - 1];
      const close = candle?.closePrice;
      const previousClose = previousCandle?.closePrice;
      const ema20 = getEma(candles, index, 20);
      const ema50 = getEma(candles, index, 50);
      const rsi14 = getRsi(candles, index, 14);
      const atr14 = getAtr(candles, index, 14);
      const z20 = getZScore(candles, index, 20);
      const recentPullbackMin = recentMinimumZ(candles, index, 6);
      const volumeSpikeRatio = getVolumeSpikeRatio(candles, index, 20);
      const peak = recentPeakClose(candles, index, peakLookbackBars);
      const breadth = marketState?.breadth;
      const relativeStrength = marketState?.relativeStrength;
      const composite = marketState?.composite;

      if (
        close === undefined ||
        previousClose === undefined ||
        ema20 === null ||
        ema50 === null ||
        rsi14 === null ||
        atr14 === null ||
        z20 === null ||
        recentPullbackMin === null ||
        volumeSpikeRatio === null ||
        peak === null ||
        !breadth ||
        !relativeStrength ||
        !composite
      ) {
        return hold("insufficient_context");
      }

      if (hasPosition && currentPosition) {
        const entryIndex = Math.max(0, index - currentPosition.barsHeld);
        const highestClose = highestCloseSinceEntry(candles, index, currentPosition.barsHeld);
        const followThroughThreshold =
          currentPosition.entryPrice + atr14 * earlyFailureFollowThroughAtr;
        const runnerArmed = highestClose >= currentPosition.entryPrice + atr14 * adaptiveTrailArmAtr;
        const trailDistanceAtr = runnerArmed
          ? Math.max(adaptiveTrailFloorAtr, trailAtrMult - 0.8)
          : trailAtrMult;
        const trailingStop = highestClose - atr14 * trailDistanceAtr;
        const hardStop = currentPosition.entryPrice * (1 - Math.max(0.035, (atr14 / close) * 1.25));
        const drawdownFromHigh =
          highestClose <= 0 ? 0 : (highestClose - close) / highestClose;
        const staleRetreatThreshold = Math.max(0.03, (atr14 / close) * 1.5);

        if (close <= hardStop) {
          return sell(1, "hard_stop_hit", "stop_exit");
        }

        if (close <= trailingStop) {
          return sell(0.95, "atr_trailing_stop_hit", "trail_exit");
        }

        if (breadth.riskOnScore < minRiskOn - 0.1 || composite.trendScore < -0.1) {
          return sell(0.9, "market_regime_deteriorated", "risk_off_exit");
        }

        if (
          currentPosition.barsHeld <= earlyFailureExitBars &&
          close < currentPosition.entryPrice &&
          close < ema20 &&
          highestClose < followThroughThreshold
        ) {
          return sell(0.88, "failed_reclaim_early", "signal_exit");
        }

        if (
          currentPosition.barsHeld >= minimumHoldBarsBeforeSoftExit &&
          closesBelowEma(candles, index, 20, softExitConfirmationBars) &&
          (relativeStrength.compositeMomentumSpread ?? 0) < 0 &&
          (relativeStrength.momentumPercentile ?? 0) < 0.55
        ) {
          return sell(0.8, "relative_strength_broken", "signal_exit");
        }

        if (currentPosition.barsHeld >= 72 && drawdownFromHigh >= staleRetreatThreshold) {
          return sell(0.75, "stale_runner_retraced", "signal_exit");
        }

        if (entryIndex === index) {
          return hold("entry_bar_hold");
        }

        return hold("trend_position_still_valid");
      }

      if (composite.regime === "trend_down" || composite.regime === "volatile") {
        return hold("market_regime_blocked", {
          tags: [`regime:${composite.regime}`]
        });
      }

      const rejectTags: string[] = [];

      if (composite.trendScore <= 0) {
        rejectTags.push("composite_trend_non_positive");
      }
      if (breadth.riskOnScore < minRiskOn) {
        rejectTags.push("risk_on_below_floor");
      }
      if (breadth.aboveTrendRatio < 0.55) {
        rejectTags.push("breadth_above_trend_too_low");
      }

      if ((relativeStrength.momentumPercentile ?? 0) < minStrengthPct) {
        rejectTags.push("strength_percentile_below_floor");
      }
      if ((relativeStrength.returnPercentile ?? 0) < 0.55) {
        rejectTags.push("return_percentile_below_floor");
      }
      if ((relativeStrength.compositeMomentumSpread ?? Number.NEGATIVE_INFINITY) <= 0) {
        rejectTags.push("composite_momentum_spread_negative");
      }
      if ((relativeStrength.liquiditySpread ?? Number.NEGATIVE_INFINITY) < 0) {
        rejectTags.push("liquidity_spread_negative");
      }

      if (close <= ema50) {
        rejectTags.push("close_below_ema50");
      }
      if (ema20 <= ema50) {
        rejectTags.push("ema20_below_ema50");
      }

      const pullbackLow = lowestCloseInRange(candles, peak.peakIndex, index - 1);
      const barsSincePeak = index - peak.peakIndex;
      const pullbackDepth =
        peak.peakClose <= 0 || pullbackLow === null ? 0 : (peak.peakClose - pullbackLow.lowClose) / peak.peakClose;
      const minimumPullbackDepth = Math.max((atr14 / close) * 0.8, 0.012);
      const maximumPullbackDepth = Math.max((atr14 / close) * 6.5, 0.18);
      const recoveryRatio =
        pullbackLow === null || peak.peakClose <= pullbackLow.lowClose
          ? 0
          : (close - pullbackLow.lowClose) / (peak.peakClose - pullbackLow.lowClose);
      const reclaimedPreviousBar =
        previousClose > 0 &&
        close > previousClose &&
        close >= (previousCandle?.highPrice ?? previousClose);
      const reclaimedPullbackMid =
        pullbackLow !== null &&
        close >= pullbackLow.lowClose + (peak.peakClose - pullbackLow.lowClose) * 0.5;
      const pullbackStructureValid =
        pullbackLow !== null &&
        barsSincePeak >= 2 &&
        barsSincePeak <= maxBarsSincePeak &&
        pullbackDepth >= minimumPullbackDepth &&
        pullbackDepth <= maximumPullbackDepth &&
        recoveryRatio >= minRecoveryRatio &&
        close < peak.peakClose &&
        (reclaimedPreviousBar || reclaimedPullbackMid);

      if (recentPullbackMin > -pullbackZ) {
        rejectTags.push("pullback_not_deep_enough");
      }
      if (!(close > ema20 && hasRecentCloseBelowEma(candles, index, 20, reclaimLookbackBars))) {
        rejectTags.push("ema20_reclaim_missing");
      }
      if (rsi14 < 50) {
        rejectTags.push("rsi_below_reclaim_floor");
      }
      if (z20 >= 1.0) {
        rejectTags.push("too_extended_after_reclaim");
      }
      if (!pullbackStructureValid) {
        rejectTags.push("swing_pullback_structure_invalid");
      }

      if (volumeSpikeRatio < 0.8) {
        rejectTags.push("volume_confirmation_missing");
      }

      if (rejectTags.length > 0) {
        return hold(rejectTags[0], {
          tags: rejectTags,
          metrics: {
            trendScore: composite.trendScore,
            riskOnScore: breadth.riskOnScore,
            momentumPercentile: relativeStrength.momentumPercentile ?? null,
            returnPercentile: relativeStrength.returnPercentile ?? null,
            pullbackDepth,
            recoveryRatio,
            recentPullbackMin,
            volumeSpikeRatio
          }
        });
      }

      const conviction = clamp01(
        average([
          normalizeWindow(relativeStrength.momentumPercentile ?? 0, minStrengthPct, 1),
          normalizeWindow(relativeStrength.returnPercentile ?? 0, 0.55, 1),
          normalizeWindow(breadth.riskOnScore, minRiskOn, 0.75),
          normalizeWindow(composite.trendScore, 0, 0.6),
          normalizeWindow(Math.abs(recentPullbackMin), pullbackZ, pullbackZ + 1.5),
          normalizeWindow(pullbackDepth, minimumPullbackDepth, Math.max(minimumPullbackDepth + 0.03, 0.05)),
          normalizeWindow(recoveryRatio, minRecoveryRatio, 0.85),
          normalizeWindow((close - ema20) / ema20, 0, 0.04),
          normalizeWindow(rsi14, 50, 70)
        ])
      );

      if (conviction <= 0) {
        return hold("conviction_collapsed_to_zero", {
          metrics: {
            pullbackDepth,
            recoveryRatio,
            recentPullbackMin
          }
        });
      }

      return buy(Math.max(0.55, conviction), "trend_pullback_reclaim", {
        tags: ["regime_ok", "strong_leader", "pullback_reclaim"],
        metrics: {
          trendScore: composite.trendScore,
          riskOnScore: breadth.riskOnScore,
          momentumPercentile: relativeStrength.momentumPercentile ?? null,
          pullbackDepth,
          recoveryRatio,
          recentPullbackMin,
          volumeSpikeRatio
        }
      });
    }
  };
}
