import {
  getAtr,
  getEma,
  getRsi,
  getVolumeSpikeRatio
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

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function highestCloseSinceEntry(
  candles: StrategyContext["candles"],
  index: number,
  barsHeld: number
): number | null {
  const start = Math.max(0, index - barsHeld);
  let highest = Number.NEGATIVE_INFINITY;

  for (let candleIndex = start; candleIndex <= index; candleIndex += 1) {
    highest = Math.max(highest, candles[candleIndex]?.closePrice ?? Number.NEGATIVE_INFINITY);
  }

  return Number.isFinite(highest) ? highest : null;
}

export function createLeaderTrendContinuationStrategy(params?: {
  strengthFloor?: number;
  minRiskOn?: number;
  maxExtensionAtr?: number;
  trailAtrMult?: number;
}): ScoredStrategy {
  const strengthFloor = params?.strengthFloor ?? 0.7;
  const minRiskOn = params?.minRiskOn ?? 0.05;
  const maxExtensionAtr = params?.maxExtensionAtr ?? 1.1;
  const trailAtrMult = params?.trailAtrMult ?? 2.2;

  const parameters: Record<string, number> = {
    strengthFloor,
    minRiskOn,
    maxExtensionAtr,
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
    name: "leader-trend-continuation",
    parameters,
    parameterCount: 4,
    contextConfig,

    generateSignal(context: StrategyContext): SignalResult {
      const { candles, index, hasPosition, currentPosition, marketState } = context;
      const candle = candles[index];
      const close = candle?.closePrice;
      const previousClose = candles[index - 1]?.closePrice;
      const ema20 = getEma(candles, index, 20);
      const ema20Prev = getEma(candles, index - 1, 20);
      const ema50 = getEma(candles, index, 50);
      const atr14 = getAtr(candles, index, 14);
      const rsi14 = getRsi(candles, index, 14);
      const volumeSpikeRatio = getVolumeSpikeRatio(candles, index, 20);
      const breadth = marketState?.breadth;
      const relativeStrength = marketState?.relativeStrength;
      const composite = marketState?.composite;

      if (
        close === undefined ||
        previousClose === undefined ||
        ema20 === null ||
        ema20Prev === null ||
        ema50 === null ||
        atr14 === null ||
        rsi14 === null ||
        volumeSpikeRatio === null ||
        !breadth ||
        !relativeStrength ||
        !composite
      ) {
        return hold("insufficient_context");
      }

      const riskOff =
        composite.regime === "trend_down" ||
        composite.regime === "volatile" ||
        composite.trendScore < -0.1 ||
        breadth.riskOnScore < minRiskOn - 0.1;

      if (hasPosition && currentPosition) {
        const highestClose = highestCloseSinceEntry(candles, index, currentPosition.barsHeld);
        const trailingStop =
          highestClose === null ? Number.NEGATIVE_INFINITY : highestClose - atr14 * trailAtrMult;
        const leadershipBroken =
          close < ema20 &&
          (relativeStrength.momentumPercentile ?? 0) < 0.5 &&
          (relativeStrength.compositeMomentumSpread ?? 0) < 0;

        if (riskOff) {
          return sell(0.95, "market_regime_deteriorated", "risk_off_exit");
        }

        if (leadershipBroken) {
          return sell(0.82, "leadership_rank_decay", "signal_exit");
        }

        if (close <= trailingStop) {
          return sell(0.9, "atr_trailing_stop_hit", "trail_exit");
        }

        return hold("leader_continuation_position_still_valid");
      }

      const extensionAtr = atr14 <= 0 ? Number.POSITIVE_INFINITY : (close - ema20) / atr14;
      const regimeGood =
        composite.regime !== "trend_down" &&
        composite.regime !== "volatile" &&
        composite.trendScore > 0 &&
        breadth.riskOnScore >= minRiskOn &&
        breadth.aboveTrendRatio >= 0.55;
      const leader =
        (relativeStrength.momentumPercentile ?? 0) >= strengthFloor &&
        (relativeStrength.returnPercentile ?? 0) >= 0.55 &&
        (relativeStrength.compositeMomentumSpread ?? Number.NEGATIVE_INFINITY) > 0;
      const trendAligned = close > ema20 && ema20 > ema50 && ema20 > ema20Prev;
      const continuationWindow =
        close > previousClose &&
        rsi14 >= 54 &&
        rsi14 <= 72 &&
        extensionAtr >= 0 &&
        extensionAtr <= maxExtensionAtr;
      const rejectTags: string[] = [];

      if (!regimeGood) {
        rejectTags.push("trend_regime_not_aligned");
      }
      if (!leader) {
        rejectTags.push("leader_strength_below_floor");
      }
      if (!trendAligned) {
        rejectTags.push("ema_trend_not_aligned");
      }
      if (!continuationWindow) {
        rejectTags.push("continuation_window_missing");
      }
      if (volumeSpikeRatio < 0.8) {
        rejectTags.push("volume_confirmation_missing");
      }

      if (rejectTags.length > 0) {
        return hold(rejectTags[0], {
          tags: rejectTags,
          metrics: {
            momentumPercentile: relativeStrength.momentumPercentile ?? null,
            returnPercentile: relativeStrength.returnPercentile ?? null,
            riskOnScore: breadth.riskOnScore,
            trendScore: composite.trendScore,
            rsi14,
            extensionAtr,
            volumeSpikeRatio
          }
        });
      }

      const conviction = clamp01(
        average([
          normalizeWindow(relativeStrength.momentumPercentile ?? 0, strengthFloor, 1),
          normalizeWindow(relativeStrength.returnPercentile ?? 0, 0.55, 1),
          normalizeWindow(breadth.riskOnScore, minRiskOn, 0.75),
          normalizeWindow(composite.trendScore, 0, 0.6),
          normalizeWindow(rsi14, 54, 72),
          normalizeWindow(volumeSpikeRatio, 0.8, 1.6),
          1 - normalizeWindow(extensionAtr, maxExtensionAtr * 0.65, maxExtensionAtr)
        ])
      );

      if (conviction <= 0) {
        return hold("conviction_collapsed_to_zero");
      }

      return buy(Math.max(0.55, conviction), "leader_trend_continuation_entry", {
        tags: ["leader", "continuation", "trend"],
        metrics: {
          momentumPercentile: relativeStrength.momentumPercentile ?? null,
          returnPercentile: relativeStrength.returnPercentile ?? null,
          riskOnScore: breadth.riskOnScore,
          trendScore: composite.trendScore,
          rsi14,
          extensionAtr,
          volumeSpikeRatio
        }
      });
    }
  };
}
