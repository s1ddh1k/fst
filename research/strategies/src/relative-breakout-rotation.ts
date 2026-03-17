import {
  getAtr,
  getEma
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

function highestHigh(
  candles: StrategyContext["candles"],
  endIndex: number,
  lookback: number
): number | null {
  const start = endIndex - lookback;

  if (start < 0) {
    return null;
  }

  let highest = Number.NEGATIVE_INFINITY;

  for (let index = start; index < endIndex; index += 1) {
    highest = Math.max(highest, candles[index]?.highPrice ?? Number.NEGATIVE_INFINITY);
  }

  return Number.isFinite(highest) ? highest : null;
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

export function createRelativeBreakoutRotationStrategy(params?: {
  breakoutLookback?: number;
  strengthFloor?: number;
  maxExtensionAtr?: number;
  trailAtrMult?: number;
}): ScoredStrategy {
  const breakoutLookback = params?.breakoutLookback ?? 20;
  const strengthFloor = params?.strengthFloor ?? 0.7;
  const maxExtensionAtr = params?.maxExtensionAtr ?? 1.2;
  const trailAtrMult = params?.trailAtrMult ?? 2.2;

  const parameters: Record<string, number> = {
    breakoutLookback,
    strengthFloor,
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
    name: "relative-breakout-rotation",
    parameters,
    parameterCount: 4,
    contextConfig,

    generateSignal(context: StrategyContext): SignalResult {
      const { candles, index, hasPosition, currentPosition, marketState } = context;
      const candle = candles[index];
      const close = candle?.closePrice;
      const ema20 = getEma(candles, index, 20);
      const ema50 = getEma(candles, index, 50);
      const atr14 = getAtr(candles, index, 14);
      const breadth = marketState?.breadth;
      const relativeStrength = marketState?.relativeStrength;
      const composite = marketState?.composite;

      if (
        close === undefined ||
        ema20 === null ||
        ema50 === null ||
        atr14 === null ||
        !breadth ||
        !relativeStrength ||
        !composite
      ) {
        return hold("insufficient_context");
      }

      const riskOff =
        composite.trendScore < -0.1 ||
        breadth.riskOnScore < -0.05 ||
        composite.regime === "trend_down";

      if (hasPosition && currentPosition) {
        const highestClose = highestCloseSinceEntry(candles, index, currentPosition.barsHeld);
        const trailStop =
          highestClose === null
            ? Number.NEGATIVE_INFINITY
            : highestClose - trailAtrMult * atr14;
        const trendBreak =
          close < ema20 &&
          (relativeStrength.momentumPercentile ?? 0) < 0.5;

        if (riskOff) {
          return sell(0.95, "market_regime_deteriorated", "risk_off_exit");
        }

        if (trendBreak) {
          return sell(0.82, "trend_break_after_breakout", "signal_exit");
        }

        if (close <= trailStop) {
          return sell(0.9, "atr_trailing_stop_hit", "trail_exit");
        }

        return hold("breakout_position_still_valid");
      }

      if (composite.regime === "volatile" || composite.regime === "trend_down") {
        return hold("market_regime_blocked", {
          tags: [`regime:${composite.regime}`]
        });
      }

      const regimeGood =
        composite.trendScore > 0 &&
        breadth.aboveTrendRatio >= 0.55;
      const leader =
        (relativeStrength.momentumPercentile ?? 0) >= strengthFloor &&
        (relativeStrength.compositeMomentumSpread ?? Number.NEGATIVE_INFINITY) > 0;
      const breakoutLevel = highestHigh(candles, index, breakoutLookback);
      const breakout = breakoutLevel !== null && close > breakoutLevel;
      const trendAligned = close > ema20 && ema20 > ema50;
      const extensionAtr = atr14 <= 0 ? Number.POSITIVE_INFINITY : (close - ema20) / atr14;
      const notTooExtended = extensionAtr <= maxExtensionAtr;

      const rejectTags: string[] = [];

      if (!regimeGood) {
        rejectTags.push("trend_regime_not_aligned");
      }
      if (!leader) {
        rejectTags.push("leader_strength_below_floor");
      }
      if (!breakout) {
        rejectTags.push("breakout_level_not_cleared");
      }
      if (!trendAligned) {
        rejectTags.push("ema_trend_not_aligned");
      }
      if (!notTooExtended) {
        rejectTags.push("extension_too_large");
      }

      if (rejectTags.length > 0) {
        return hold(rejectTags[0], {
          tags: rejectTags,
          metrics: {
            momentumPercentile: relativeStrength.momentumPercentile ?? null,
            returnPercentile: relativeStrength.returnPercentile ?? null,
            riskOnScore: breadth.riskOnScore,
            trendScore: composite.trendScore,
            breakoutLevel,
            extensionAtr
          }
        });
      }

      const conviction = clamp01(
        average([
          normalizeWindow(relativeStrength.momentumPercentile ?? 0, strengthFloor, 1),
          normalizeWindow(relativeStrength.returnPercentile ?? 0, 0.5, 1),
          normalizeWindow(breadth.riskOnScore, 0, 0.75),
          normalizeWindow(composite.trendScore, 0, 0.6),
          normalizeWindow(extensionAtr, -0.2, maxExtensionAtr)
        ])
      );

      if (conviction <= 0) {
        return hold("conviction_collapsed_to_zero");
      }

      return buy(Math.max(0.55, conviction), "leader_breakout_continuation", {
        tags: ["leader", "breakout", "trend_aligned"],
        metrics: {
          momentumPercentile: relativeStrength.momentumPercentile ?? null,
          returnPercentile: relativeStrength.returnPercentile ?? null,
          riskOnScore: breadth.riskOnScore,
          trendScore: composite.trendScore,
          breakoutLevel,
          extensionAtr
        }
      });
    }
  };
}
