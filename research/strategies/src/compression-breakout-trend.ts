import {
  getAtr,
  getEma,
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

function recentHighLowRange(
  candles: StrategyContext["candles"],
  endIndex: number,
  window: number
): { highestHigh: number; lowestLow: number } | null {
  const start = endIndex - window;
  if (start < 0) {
    return null;
  }

  let highestHigh = Number.NEGATIVE_INFINITY;
  let lowestLow = Number.POSITIVE_INFINITY;

  for (let candleIndex = start; candleIndex < endIndex; candleIndex += 1) {
    highestHigh = Math.max(highestHigh, candles[candleIndex]?.highPrice ?? Number.NEGATIVE_INFINITY);
    lowestLow = Math.min(lowestLow, candles[candleIndex]?.lowPrice ?? Number.POSITIVE_INFINITY);
  }

  if (!Number.isFinite(highestHigh) || !Number.isFinite(lowestLow)) {
    return null;
  }

  return { highestHigh, lowestLow };
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

export function createCompressionBreakoutTrendStrategy(params?: {
  strengthFloor?: number;
  compressionWindow?: number;
  compressionAtr?: number;
  trailAtrMult?: number;
}): ScoredStrategy {
  const strengthFloor = params?.strengthFloor ?? 0.65;
  const compressionWindow = Math.max(6, Math.round(params?.compressionWindow ?? 8));
  const compressionAtr = params?.compressionAtr ?? 2.5;
  const trailAtrMult = params?.trailAtrMult ?? 2.2;

  const parameters: Record<string, number> = {
    strengthFloor,
    compressionWindow,
    compressionAtr,
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
    name: "compression-breakout-trend",
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
      const volumeSpikeRatio = getVolumeSpikeRatio(candles, index, 20);
      const compressionRange = recentHighLowRange(candles, index, compressionWindow);
      const breadth = marketState?.breadth;
      const relativeStrength = marketState?.relativeStrength;
      const composite = marketState?.composite;

      if (
        close === undefined ||
        ema20 === null ||
        ema50 === null ||
        atr14 === null ||
        volumeSpikeRatio === null ||
        compressionRange === null ||
        !breadth ||
        !relativeStrength ||
        !composite
      ) {
        return hold("insufficient_context");
      }

      const compressionRangeAtr =
        atr14 <= 0 ? Number.POSITIVE_INFINITY : (compressionRange.highestHigh - compressionRange.lowestLow) / atr14;
      const riskOff =
        composite.regime === "trend_down" ||
        composite.regime === "volatile" ||
        composite.trendScore < -0.1 ||
        breadth.riskOnScore < -0.05;

      if (hasPosition && currentPosition) {
        const highestClose = highestCloseSinceEntry(candles, index, currentPosition.barsHeld);
        const trailingStop =
          highestClose === null ? Number.NEGATIVE_INFINITY : highestClose - atr14 * trailAtrMult;
        const breakoutFailure = close < ema20 && close < compressionRange.highestHigh;

        if (riskOff) {
          return sell(0.95, "market_regime_deteriorated", "risk_off_exit");
        }

        if (breakoutFailure) {
          return sell(0.84, "compression_breakout_failed", "signal_exit");
        }

        if (close <= trailingStop) {
          return sell(0.9, "atr_trailing_stop_hit", "trail_exit");
        }

        return hold("compression_breakout_position_still_valid");
      }

      const breakout = close > compressionRange.highestHigh;
      const regimeGood =
        composite.regime !== "trend_down" &&
        composite.regime !== "volatile" &&
        composite.trendScore > 0 &&
        breadth.riskOnScore >= 0 &&
        breadth.aboveTrendRatio >= 0.55;
      const leader =
        (relativeStrength.momentumPercentile ?? 0) >= strengthFloor &&
        (relativeStrength.compositeMomentumSpread ?? Number.NEGATIVE_INFINITY) > 0;
      const trendAligned = close > ema20 && ema20 > ema50;
      const compressed = compressionRangeAtr <= compressionAtr;
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
      if (!compressed) {
        rejectTags.push("range_not_compressed");
      }
      if (!breakout) {
        rejectTags.push("breakout_level_not_cleared");
      }
      if (volumeSpikeRatio < 1) {
        rejectTags.push("volume_confirmation_missing");
      }

      if (rejectTags.length > 0) {
        return hold(rejectTags[0], {
          tags: rejectTags,
          metrics: {
            compressionRangeAtr,
            breakoutLevel: compressionRange.highestHigh,
            momentumPercentile: relativeStrength.momentumPercentile ?? null,
            riskOnScore: breadth.riskOnScore,
            trendScore: composite.trendScore,
            volumeSpikeRatio
          }
        });
      }

      const conviction = clamp01(
        average([
          normalizeWindow(relativeStrength.momentumPercentile ?? 0, strengthFloor, 1),
          normalizeWindow(relativeStrength.returnPercentile ?? 0, 0.5, 1),
          normalizeWindow(breadth.riskOnScore, 0, 0.75),
          normalizeWindow(composite.trendScore, 0, 0.6),
          1 - normalizeWindow(compressionRangeAtr, compressionAtr * 0.6, compressionAtr),
          normalizeWindow(volumeSpikeRatio, 1, 2)
        ])
      );

      if (conviction <= 0) {
        return hold("conviction_collapsed_to_zero");
      }

      return buy(Math.max(0.55, conviction), "compression_breakout_entry", {
        tags: ["leader", "compression", "breakout"],
        metrics: {
          compressionRangeAtr,
          breakoutLevel: compressionRange.highestHigh,
          momentumPercentile: relativeStrength.momentumPercentile ?? null,
          riskOnScore: breadth.riskOnScore,
          trendScore: composite.trendScore,
          volumeSpikeRatio
        }
      });
    }
  };
}
