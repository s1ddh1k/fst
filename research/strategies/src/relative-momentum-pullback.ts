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
        !breadth ||
        !relativeStrength ||
        !composite
      ) {
        return { signal: "HOLD", conviction: 0 };
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
          return { signal: "SELL", conviction: 1 };
        }

        if (close <= trailingStop) {
          return { signal: "SELL", conviction: 0.95 };
        }

        if (breadth.riskOnScore < minRiskOn - 0.1 || composite.trendScore < -0.1) {
          return { signal: "SELL", conviction: 0.9 };
        }

        if (
          currentPosition.barsHeld <= earlyFailureExitBars &&
          close < currentPosition.entryPrice &&
          close < ema20 &&
          highestClose < followThroughThreshold
        ) {
          return { signal: "SELL", conviction: 0.88 };
        }

        if (
          currentPosition.barsHeld >= minimumHoldBarsBeforeSoftExit &&
          closesBelowEma(candles, index, 20, softExitConfirmationBars) &&
          (relativeStrength.compositeMomentumSpread ?? 0) < 0 &&
          (relativeStrength.momentumPercentile ?? 0) < 0.55
        ) {
          return { signal: "SELL", conviction: 0.8 };
        }

        if (currentPosition.barsHeld >= 72 && drawdownFromHigh >= staleRetreatThreshold) {
          return { signal: "SELL", conviction: 0.75 };
        }

        if (entryIndex === index) {
          return { signal: "HOLD", conviction: 0 };
        }

        return { signal: "HOLD", conviction: 0 };
      }

      if (composite.regime === "trend_down" || composite.regime === "volatile") {
        return { signal: "HOLD", conviction: 0 };
      }

      if (
        composite.trendScore <= 0 ||
        breadth.riskOnScore < minRiskOn ||
        breadth.aboveTrendRatio < 0.55
      ) {
        return { signal: "HOLD", conviction: 0 };
      }

      if (
        (relativeStrength.momentumPercentile ?? 0) < minStrengthPct ||
        (relativeStrength.returnPercentile ?? 0) < 0.55 ||
        (relativeStrength.compositeMomentumSpread ?? Number.NEGATIVE_INFINITY) <= 0 ||
        (relativeStrength.liquiditySpread ?? Number.NEGATIVE_INFINITY) < 0
      ) {
        return { signal: "HOLD", conviction: 0 };
      }

      if (close <= ema50 || ema20 <= ema50) {
        return { signal: "HOLD", conviction: 0 };
      }

      if (
        recentPullbackMin > -pullbackZ ||
        !(close > ema20 && hasRecentCloseBelowEma(candles, index, 20, reclaimLookbackBars)) ||
        rsi14 < 50 ||
        z20 >= 1.0
      ) {
        return { signal: "HOLD", conviction: 0 };
      }

      if (volumeSpikeRatio < 0.9) {
        return { signal: "HOLD", conviction: 0 };
      }

      const conviction = clamp01(
        average([
          normalizeWindow(relativeStrength.momentumPercentile ?? 0, minStrengthPct, 1),
          normalizeWindow(relativeStrength.returnPercentile ?? 0, 0.55, 1),
          normalizeWindow(breadth.riskOnScore, minRiskOn, 0.75),
          normalizeWindow(composite.trendScore, 0, 0.6),
          normalizeWindow(Math.abs(recentPullbackMin), pullbackZ, pullbackZ + 1.5),
          normalizeWindow((close - ema20) / ema20, 0, 0.04),
          normalizeWindow(rsi14, 50, 70)
        ])
      );

      if (conviction <= 0) {
        return { signal: "HOLD", conviction: 0 };
      }

      return {
        signal: "BUY",
        conviction: Math.max(0.55, conviction)
      };
    }
  };
}
