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

export function createMomentumReaccelerationStrategy(params?: {
  strengthFloor?: number;
  minRiskOn?: number;
  resetRsiFloor?: number;
  trailAtrMult?: number;
}): ScoredStrategy {
  const strengthFloor = params?.strengthFloor ?? 0.7;
  const minRiskOn = params?.minRiskOn ?? 0.05;
  const resetRsiFloor = params?.resetRsiFloor ?? 50;
  const trailAtrMult = params?.trailAtrMult ?? 2.2;

  const parameters: Record<string, number> = {
    strengthFloor,
    minRiskOn,
    resetRsiFloor,
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
    name: "momentum-reacceleration",
    parameters,
    parameterCount: 4,
    contextConfig,

    generateSignal(context: StrategyContext): SignalResult {
      const { candles, index, hasPosition, currentPosition, marketState } = context;
      const candle = candles[index];
      const previous = candles[index - 1];
      const close = candle?.closePrice;
      const previousClose = previous?.closePrice;
      const ema20 = getEma(candles, index, 20);
      const ema20Prev = getEma(candles, index - 1, 20);
      const ema50 = getEma(candles, index, 50);
      const atr14 = getAtr(candles, index, 14);
      const rsi14 = getRsi(candles, index, 14);
      const z20 = getZScore(candles, index, 20);
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
        z20 === null ||
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

        if (close <= trailingStop) {
          return sell(0.9, "atr_trailing_stop_hit", "trail_exit");
        }

        if (leadershipBroken) {
          return sell(0.82, "leadership_lost_after_entry", "signal_exit");
        }

        return hold("continuation_position_still_valid");
      }

      const rejectTags: string[] = [];
      const extensionAtr = atr14 <= 0 ? Number.POSITIVE_INFINITY : (close - ema20) / atr14;
      const regimeGood =
        composite.regime !== "trend_down" &&
        composite.regime !== "volatile" &&
        composite.trendScore > 0 &&
        breadth.riskOnScore >= minRiskOn &&
        breadth.aboveTrendRatio >= 0.52;
      const leader =
        (relativeStrength.momentumPercentile ?? 0) >= strengthFloor &&
        (relativeStrength.returnPercentile ?? 0) >= 0.55 &&
        (relativeStrength.compositeMomentumSpread ?? Number.NEGATIVE_INFINITY) > 0 &&
        (relativeStrength.liquiditySpread ?? Number.NEGATIVE_INFINITY) >= -0.05;
      const trendAligned = close > ema50 && ema20 > ema50 && ema20 > ema20Prev;
      const resetAndReclaim =
        previousClose <= ema20 * 1.01 &&
        close > ema20 &&
        close > previousClose &&
        rsi14 >= resetRsiFloor &&
        rsi14 <= 68 &&
        z20 <= 0.35;
      const notTooExtended = extensionAtr >= -0.2 && extensionAtr <= 1.2;

      if (!regimeGood) {
        rejectTags.push("trend_regime_not_aligned");
      }
      if (!leader) {
        rejectTags.push("leader_strength_below_floor");
      }
      if (!trendAligned) {
        rejectTags.push("ema_trend_not_aligned");
      }
      if (!resetAndReclaim) {
        rejectTags.push("reset_reclaim_missing");
      }
      if (!notTooExtended) {
        rejectTags.push("extension_out_of_range");
      }
      if (volumeSpikeRatio < 0.85) {
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
            z20,
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
          normalizeWindow(rsi14, resetRsiFloor, 68),
          normalizeWindow(volumeSpikeRatio, 0.85, 1.8),
          1 - normalizeWindow(extensionAtr, 0.5, 1.2)
        ])
      );

      if (conviction <= 0) {
        return hold("conviction_collapsed_to_zero");
      }

      return buy(Math.max(0.55, conviction), "momentum_reacceleration_entry", {
        tags: ["leader", "reset", "reclaim"],
        metrics: {
          momentumPercentile: relativeStrength.momentumPercentile ?? null,
          returnPercentile: relativeStrength.returnPercentile ?? null,
          riskOnScore: breadth.riskOnScore,
          trendScore: composite.trendScore,
          rsi14,
          z20,
          extensionAtr,
          volumeSpikeRatio
        }
      });
    }
  };
}
