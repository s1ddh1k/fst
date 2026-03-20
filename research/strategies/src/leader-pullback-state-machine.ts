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

function recentWindowMinima(
  candles: StrategyContext["candles"],
  index: number,
  setupExpiryBars: number
): {
  minDistanceToEma20Atr: number | null;
  minCloseVsEma50: number | null;
} {
  const start = Math.max(0, index - setupExpiryBars + 1);
  let minDistanceToEma20Atr = Number.POSITIVE_INFINITY;
  let minCloseVsEma50 = Number.POSITIVE_INFINITY;
  let found = false;

  for (let candleIndex = start; candleIndex <= index; candleIndex += 1) {
    const candle = candles[candleIndex];
    const close = candle?.closePrice;
    const ema20 = getEma(candles, candleIndex, 20);
    const ema50 = getEma(candles, candleIndex, 50);
    const atr = getAtr(candles, candleIndex, 14);

    if (close === undefined || ema20 === null || ema50 === null || atr === null || atr <= 0) {
      continue;
    }

    minDistanceToEma20Atr = Math.min(minDistanceToEma20Atr, (close - ema20) / atr);
    minCloseVsEma50 = Math.min(minCloseVsEma50, (close - ema50) / ema50);
    found = true;
  }

  return {
    minDistanceToEma20Atr: found ? minDistanceToEma20Atr : null,
    minCloseVsEma50: found ? minCloseVsEma50 : null
  };
}

export function createLeaderPullbackStateMachineStrategy(params?: {
  strengthFloor?: number;
  pullbackAtr?: number;
  setupExpiryBars?: number;
  trailAtrMult?: number;
}): ScoredStrategy {
  const strengthFloor = params?.strengthFloor ?? 0.7;
  const pullbackAtr = params?.pullbackAtr ?? 0.9;
  const setupExpiryBars = Math.max(2, Math.round(params?.setupExpiryBars ?? 4));
  const trailAtrMult = params?.trailAtrMult ?? 2.2;

  const parameters: Record<string, number> = {
    strengthFloor,
    pullbackAtr,
    setupExpiryBars,
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
    name: "leader-pullback-state-machine",
    parameters,
    parameterCount: 4,
    contextConfig,

    generateSignal(context: StrategyContext): SignalResult {
      const { candles, index, hasPosition, currentPosition, marketState } = context;
      const candle = candles[index];
      const previous = candles[index - 1];
      const previous2 = candles[index - 2];
      const close = candle?.closePrice;
      const ema20 = getEma(candles, index, 20);
      const ema20Prev = getEma(candles, index - 1, 20);
      const ema50 = getEma(candles, index, 50);
      const atr14 = getAtr(candles, index, 14);
      const breadth = marketState?.breadth;
      const relativeStrength = marketState?.relativeStrength;
      const composite = marketState?.composite;

      if (
        close === undefined ||
        ema20 === null ||
        ema20Prev === null ||
        ema50 === null ||
        atr14 === null ||
        !breadth ||
        !relativeStrength ||
        !composite
      ) {
        return hold("insufficient_context");
      }

      const riskOff = composite.trendScore < -0.1 || breadth.riskOnScore < -0.05;

      if (hasPosition && currentPosition) {
        const highestClose = highestCloseSinceEntry(candles, index, currentPosition.barsHeld);

        // Hard stop: regime fully deteriorated
        if (riskOff) {
          return sell(0.95, "market_regime_deteriorated", "risk_off_exit");
        }

        // Hard stop: price breaks well below entry early on
        const earlyFailure =
          currentPosition.barsHeld <= 3 &&
          close < currentPosition.entryPrice - 0.8 * atr14;
        if (earlyFailure) {
          return sell(0.9, "early_stop_loss", "stop_exit");
        }

        // Trailing stop: primary exit mechanism — let winners run
        const trailStop =
          highestClose !== null &&
          close <= highestClose - trailAtrMult * atr14;
        if (trailStop) {
          return sell(0.88, "atr_trailing_stop_hit", "trail_exit");
        }

        // Rank decay: only exit after sustained weakness (6+ bars held, confirmed breakdown)
        const rankDecay =
          currentPosition.barsHeld >= 6 &&
          close < ema20 &&
          close < ema50 &&
          (relativeStrength.momentumPercentile ?? 0) < 0.35 &&
          (relativeStrength.compositeMomentumSpread ?? 0) < -0.01;
        if (rankDecay) {
          return sell(0.8, "leadership_rank_decay", "signal_exit");
        }

        return hold("setup_still_valid");
      }

      // Regime filtering is handled by withRegimeGate() — no internal regime check needed.
      // Only check leadership strength and entry trigger.

      const leader =
        (relativeStrength.momentumPercentile ?? 0) >= strengthFloor &&
        (relativeStrength.returnPercentile ?? 0) >= 0.5 &&
        (relativeStrength.compositeMomentumSpread ?? Number.NEGATIVE_INFINITY) > 0;
      const setupWindow = recentWindowMinima(candles, index, setupExpiryBars);
      const armed =
        (setupWindow.minDistanceToEma20Atr ?? Number.POSITIVE_INFINITY) <= -pullbackAtr &&
        (setupWindow.minCloseVsEma50 ?? Number.NEGATIVE_INFINITY) > -0.01;
      const trigger =
        close > ema20 &&
        close > Math.max(previous?.highPrice ?? Number.NEGATIVE_INFINITY, previous2?.highPrice ?? Number.NEGATIVE_INFINITY) &&
        closePositionInBar(candle) >= 0.45 &&
        close - ema20 <= 1.2 * atr14;

      const rejectTags: string[] = [];

      if (!leader) {
        rejectTags.push("leader_strength_below_floor");
      }
      // armed is optional — leader + trigger is sufficient for entry
      if (!trigger) {
        rejectTags.push("reclaim_trigger_missing");
      }

      if (rejectTags.length > 0) {
        return hold(rejectTags[0], {
          tags: rejectTags,
          metrics: {
            momentumPercentile: relativeStrength.momentumPercentile ?? null,
            returnPercentile: relativeStrength.returnPercentile ?? null,
            riskOnScore: breadth.riskOnScore,
            trendScore: composite.trendScore,
            minDistanceToEma20Atr: setupWindow.minDistanceToEma20Atr,
            minCloseVsEma50: setupWindow.minCloseVsEma50
          }
        });
      }

      const convictionComponents = [
        normalizeWindow(relativeStrength.momentumPercentile ?? 0, strengthFloor, 1),
        normalizeWindow(relativeStrength.returnPercentile ?? 0, 0.5, 1),
        normalizeWindow(breadth.riskOnScore, 0, 0.75),
        normalizeWindow(composite.trendScore, 0, 0.6),
        normalizeWindow(closePositionInBar(candle), 0.6, 1)
      ];
      // armed pullback gives conviction bonus but is not required
      if (armed) {
        convictionComponents.push(
          normalizeWindow(Math.abs(setupWindow.minDistanceToEma20Atr ?? 0), pullbackAtr, pullbackAtr + 1)
        );
      }
      const conviction = clamp01(average(convictionComponents));

      if (conviction <= 0) {
        return hold("conviction_collapsed_to_zero");
      }

      return buy(Math.max(0.55, conviction), "leader_pullback_reclaim", {
        tags: armed ? ["leader", "armed_pullback", "reacceleration"] : ["leader", "reacceleration"],
        metrics: {
          momentumPercentile: relativeStrength.momentumPercentile ?? null,
          returnPercentile: relativeStrength.returnPercentile ?? null,
          riskOnScore: breadth.riskOnScore,
          trendScore: composite.trendScore,
          minDistanceToEma20Atr: setupWindow.minDistanceToEma20Atr
        }
      });
    }
  };
}
