import type { StrategyContext } from "../../../../packages/shared/src/index.js";
import type { Candle } from "../types.js";
import { getRsi } from "../../../strategies/src/factors/mean-reversion.js";
import { getSma } from "../../../strategies/src/factors/moving-averages.js";
import { getVolumeSpikeRatio } from "../../../strategies/src/factors/volume.js";

export type MacroRegime = "bull" | "bear" | "neutral";

export type MicroScore = {
  quality: number;
  direction: "long" | "short" | "neutral";
  signals: {
    relativeStrength: number;
    rsi: number;
    volumeSpike: number;
    smaDistance: number;
  };
};

export type MacroRegimeConfig = {
  bullThreshold?: number;
  bearThreshold?: number;
  cooldownBars?: number;
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}

function sma(candles: Array<{ closePrice: number }>, endIndex: number, period: number): number | null {
  if (endIndex < period - 1) {
    return null;
  }

  let sum = 0;
  for (let i = endIndex - period + 1; i <= endIndex; i += 1) {
    sum += candles[i].closePrice;
  }
  return sum / period;
}

export function detectMacroScore(candles: Candle[], index: number): number {
  if (index < 720) {
    return 0;
  }

  const close = candles[index]?.closePrice;
  if (!close) {
    return 0;
  }

  const sma50 = sma(candles, index, 50);
  const sma200 = sma(candles, index, 200);
  if (sma50 === null || sma200 === null) {
    return 0;
  }

  const goldenCross = sma50 > sma200;
  const lookback = 336;
  let obvNow = 0;
  let obvHalf = 0;
  for (let j = index - lookback + 1; j <= index; j += 1) {
    const dir = candles[j].closePrice > (candles[j - 1]?.closePrice ?? candles[j].closePrice) ? 1 : -1;
    if (j <= index - 168) {
      obvHalf += dir * candles[j].volume;
    }
    obvNow += dir * candles[j].volume;
  }

  const priceSlope = close - (candles[index - lookback]?.closePrice ?? close);
  const bearishDiv = priceSlope > 0 && (obvNow - obvHalf) < 0;
  const bullishDiv = priceSlope < 0 && (obvNow - obvHalf) > 0;

  const weekAgo = candles[index - 168]?.closePrice ?? close;
  const monthAgo = candles[index - 720]?.closePrice ?? close;
  const weekReturn = weekAgo > 0 ? (close - weekAgo) / weekAgo : 0;
  const monthReturn = monthAgo > 0 ? (close - monthAgo) / monthAgo : 0;

  let atr24h = 0;
  for (let j = index - 23; j <= index; j += 1) {
    atr24h += candles[j].highPrice - candles[j].lowPrice;
  }
  atr24h /= 24;

  let atr7d = 0;
  for (let j = index - 167; j <= index; j += 1) {
    atr7d += candles[j].highPrice - candles[j].lowPrice;
  }
  atr7d /= 168;
  const volAccel = atr7d > 0 ? atr24h / atr7d : 1;

  let upperW = 0;
  let lowerW = 0;
  let bodyS = 0;
  for (let j = index - 47; j <= index; j += 1) {
    bodyS += Math.abs(candles[j].closePrice - candles[j].openPrice);
    upperW += candles[j].highPrice - Math.max(candles[j].openPrice, candles[j].closePrice);
    lowerW += Math.min(candles[j].openPrice, candles[j].closePrice) - candles[j].lowPrice;
  }

  let score = 0;
  if (close > sma200 && goldenCross) score += 2;
  else if (close < sma200 && !goldenCross) score -= 2;
  if (bullishDiv) score += 3;
  if (bearishDiv) score -= 3;
  if (weekReturn > 0.03 && monthReturn > 0.05) score += 2;
  else if (weekReturn < -0.03 && monthReturn < -0.05) score -= 2;
  if (bodyS > 0 && lowerW > upperW * 1.5) score += 1;
  if (bodyS > 0 && upperW > lowerW * 1.5) score -= 1;
  if (volAccel > 2.0 && weekReturn < -0.02) score -= 2;
  if (volAccel > 2.0 && weekReturn > 0.02) score += 1;
  return score;
}

export function detectMacroRegime(
  candles: Candle[],
  index: number,
  config?: MacroRegimeConfig
): MacroRegime {
  const score = detectMacroScore(candles, index);

  const bullThreshold = config?.bullThreshold ?? 4;
  const bearThreshold = config?.bearThreshold ?? -2;

  if (score >= bullThreshold) {
    return "bull";
  }
  if (score <= bearThreshold) {
    return "bear";
  }
  return "neutral";
}

export function buildMacroRegimeSeries(candles: Candle[], config?: MacroRegimeConfig): MacroRegime[] {
  const raw = candles.map((_, index) => detectMacroRegime(candles, index, config));
  const stable: MacroRegime[] = new Array(raw.length).fill("neutral");
  let current: MacroRegime = raw[0] ?? "neutral";
  let lastChangeIndex = 0;
  const cooldownBars = config?.cooldownBars ?? 72;

  for (let index = 0; index < raw.length; index += 1) {
    const next = raw[index] ?? current;
    if (index === 0) {
      current = next;
      stable[index] = current;
      continue;
    }

    if (next !== current && index - lastChangeIndex >= cooldownBars) {
      current = next;
      lastChangeIndex = index;
    }

    stable[index] = current;
  }

  return stable;
}

export function resolveMacroRegimeAtTime(params: {
  benchmarkCandles: Candle[];
  stableRegimes: MacroRegime[];
  decisionTime: Date;
}): MacroRegime {
  const targetMs = params.decisionTime.getTime();
  for (let index = params.benchmarkCandles.length - 1; index >= 0; index -= 1) {
    if (params.benchmarkCandles[index].candleTimeUtc.getTime() <= targetMs) {
      return params.stableRegimes[index] ?? "neutral";
    }
  }
  return "neutral";
}

export function resolveMacroScoreAtTime(params: {
  benchmarkCandles: Candle[];
  decisionTime: Date;
}): number {
  const targetMs = params.decisionTime.getTime();
  for (let index = params.benchmarkCandles.length - 1; index >= 0; index -= 1) {
    if (params.benchmarkCandles[index].candleTimeUtc.getTime() <= targetMs) {
      return detectMacroScore(params.benchmarkCandles, index);
    }
  }
  return 0;
}

export function scoreCoin(context: StrategyContext): MicroScore {
  const candles = context.featureView.candles;
  const index = context.featureView.decisionIndex;
  const close = candles[index]?.closePrice ?? 0;
  const rsi = getRsi(candles as any, index, 14);
  const volumeSpike = getVolumeSpikeRatio(candles as any, index, 20);
  const sma50 = getSma(candles as any, index, 50);
  const state = (context.marketState as {
    relativeStrength?: {
      momentumPercentile?: number;
      returnPercentile?: number;
    };
  } | undefined) ?? {};

  const relativeStrength = clamp01(
    (
      Number(state.relativeStrength?.momentumPercentile ?? 0) +
      Number(state.relativeStrength?.returnPercentile ?? 0)
    ) / 2
  );
  const rsiValue = Number(rsi ?? 50);
  const rsiQuality = clamp01(1 - Math.abs(rsiValue - 58) / 42);
  const volumeQuality = clamp01(Number(volumeSpike ?? 1) / 2.5);
  const smaDistanceRaw = sma50 && sma50 > 0 ? (close - sma50) / sma50 : 0;
  const smaDistance = Math.max(-0.2, Math.min(0.2, smaDistanceRaw));
  const smaQuality = clamp01((smaDistance + 0.03) / 0.12);
  const quality = clamp01(
    0.5 * relativeStrength +
    0.2 * rsiQuality +
    0.15 * volumeQuality +
    0.15 * smaQuality
  );

  let direction: MicroScore["direction"] = "neutral";
  if (relativeStrength >= 0.55 || smaDistance > 0.01) {
    direction = "long";
  } else if (relativeStrength <= 0.3 && smaDistance < -0.03) {
    direction = "short";
  }

  return {
    quality,
    direction,
    signals: {
      relativeStrength,
      rsi: clamp01(rsiValue / 100),
      volumeSpike: volumeQuality,
      smaDistance
    }
  };
}
