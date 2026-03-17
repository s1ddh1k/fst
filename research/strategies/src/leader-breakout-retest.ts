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

  for (let candleIndex = start; candleIndex < endIndex; candleIndex += 1) {
    highest = Math.max(highest, candles[candleIndex]?.highPrice ?? Number.NEGATIVE_INFINITY);
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

function closePositionInBar(candle: StrategyContext["candles"][number] | undefined): number {
  if (!candle) {
    return 0;
  }

  const range = candle.highPrice - candle.lowPrice;
  if (range <= 0) {
    return 0.5;
  }

  return clamp01((candle.closePrice - candle.lowPrice) / range);
}

export function createLeaderBreakoutRetestStrategy(params?: {
  strengthFloor?: number;
  breakoutLookback?: number;
  retestAtrBuffer?: number;
  trailAtrMult?: number;
}): ScoredStrategy {
  const strengthFloor = params?.strengthFloor ?? 0.7;
  const breakoutLookback = Math.max(8, Math.round(params?.breakoutLookback ?? 18));
  const retestAtrBuffer = params?.retestAtrBuffer ?? 0.45;
  const trailAtrMult = params?.trailAtrMult ?? 2.2;

  const parameters: Record<string, number> = {
    strengthFloor,
    breakoutLookback,
    retestAtrBuffer,
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
    name: "leader-breakout-retest",
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
      const rsi14 = getRsi(candles, index, 14);
      const volumeSpikeRatio = getVolumeSpikeRatio(candles, index, 20);
      const breakoutLevel = highestHigh(candles, index, breakoutLookback);
      const breadth = marketState?.breadth;
      const relativeStrength = marketState?.relativeStrength;
      const composite = marketState?.composite;

      if (
        close === undefined ||
        ema20 === null ||
        ema50 === null ||
        atr14 === null ||
        rsi14 === null ||
        volumeSpikeRatio === null ||
        breakoutLevel === null ||
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
        breadth.riskOnScore < -0.05;

      if (hasPosition && currentPosition) {
        const highestClose = highestCloseSinceEntry(candles, index, currentPosition.barsHeld);
        const trailingStop =
          highestClose === null ? Number.NEGATIVE_INFINITY : highestClose - atr14 * trailAtrMult;
        const breakoutFailed = close < breakoutLevel && close < ema20;

        if (riskOff) {
          return sell(0.95, "market_regime_deteriorated", "risk_off_exit");
        }

        if (breakoutFailed) {
          return sell(0.85, "breakout_retest_failed", "signal_exit");
        }

        if (close <= trailingStop) {
          return sell(0.9, "atr_trailing_stop_hit", "trail_exit");
        }

        return hold("breakout_retest_position_still_valid");
      }

      const extensionAtr = atr14 <= 0 ? Number.POSITIVE_INFINITY : (close - breakoutLevel) / atr14;
      const retestHeld =
        candle.lowPrice <= breakoutLevel + atr14 * retestAtrBuffer &&
        close >= breakoutLevel &&
        close > ema20;
      const trendAligned = close > ema20 && ema20 > ema50;
      const leader =
        (relativeStrength.momentumPercentile ?? 0) >= strengthFloor &&
        (relativeStrength.returnPercentile ?? 0) >= 0.55 &&
        (relativeStrength.compositeMomentumSpread ?? Number.NEGATIVE_INFINITY) > 0;
      const regimeGood =
        composite.regime !== "trend_down" &&
        composite.regime !== "volatile" &&
        composite.trendScore > 0 &&
        breadth.riskOnScore >= 0 &&
        breadth.aboveTrendRatio >= 0.55;
      const trigger =
        retestHeld &&
        closePositionInBar(candle) >= 0.55 &&
        rsi14 >= 52 &&
        extensionAtr >= -0.2 &&
        extensionAtr <= 1.2;
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
      if (!retestHeld) {
        rejectTags.push("breakout_retest_not_held");
      }
      if (!trigger) {
        rejectTags.push("retest_trigger_missing");
      }
      if (volumeSpikeRatio < 0.9) {
        rejectTags.push("volume_confirmation_missing");
      }

      if (rejectTags.length > 0) {
        return hold(rejectTags[0], {
          tags: rejectTags,
          metrics: {
            breakoutLevel,
            extensionAtr,
            rsi14,
            volumeSpikeRatio,
            momentumPercentile: relativeStrength.momentumPercentile ?? null,
            riskOnScore: breadth.riskOnScore,
            trendScore: composite.trendScore
          }
        });
      }

      const conviction = clamp01(
        average([
          normalizeWindow(relativeStrength.momentumPercentile ?? 0, strengthFloor, 1),
          normalizeWindow(relativeStrength.returnPercentile ?? 0, 0.55, 1),
          normalizeWindow(breadth.riskOnScore, 0, 0.75),
          normalizeWindow(composite.trendScore, 0, 0.6),
          normalizeWindow(rsi14, 52, 70),
          normalizeWindow(volumeSpikeRatio, 0.9, 1.8),
          1 - normalizeWindow(extensionAtr, 0.5, 1.2)
        ])
      );

      if (conviction <= 0) {
        return hold("conviction_collapsed_to_zero");
      }

      return buy(Math.max(0.55, conviction), "leader_breakout_retest_entry", {
        tags: ["leader", "breakout", "retest"],
        metrics: {
          breakoutLevel,
          extensionAtr,
          rsi14,
          volumeSpikeRatio,
          momentumPercentile: relativeStrength.momentumPercentile ?? null,
          riskOnScore: breadth.riskOnScore,
          trendScore: composite.trendScore
        }
      });
    }
  };
}
