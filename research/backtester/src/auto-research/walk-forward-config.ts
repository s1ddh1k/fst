import type { Candle } from "../types.js";
import { buildWalkForwardRanges } from "../validation.js";
import type { AutoResearchConfigRepair, AutoResearchRunConfig } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export type ReferenceCandleSpan = {
  startAt?: Date;
  endAt?: Date;
  availableDays: number;
};

export type WalkForwardConfigResolution = {
  config: AutoResearchRunConfig;
  windowCount: number;
  span: ReferenceCandleSpan;
  repair?: AutoResearchConfigRepair;
  invalidReason?: string;
};

function quantizeDays(value: number): number {
  return Math.max(7, Math.round(value));
}

export function summarizeReferenceCandleSpan(referenceCandles: Candle[]): ReferenceCandleSpan {
  const startAt = referenceCandles[0]?.candleTimeUtc;
  const endAt = referenceCandles[referenceCandles.length - 1]?.candleTimeUtc;
  if (!startAt || !endAt) {
    return {
      availableDays: 0
    };
  }

  return {
    startAt,
    endAt,
    availableDays: Math.max(0, (endAt.getTime() - startAt.getTime()) / DAY_MS)
  };
}

export function getResolvedWalkForwardConfig(config: AutoResearchRunConfig): {
  holdoutDays: number;
  trainingDays: number;
  stepDays: number;
  requiredDays: number;
} {
  const holdoutDays = config.holdoutDays;
  const trainingDays = config.trainingDays ?? config.holdoutDays * 2;
  const stepDays = config.stepDays ?? config.holdoutDays;
  return {
    holdoutDays,
    trainingDays,
    stepDays,
    requiredDays: trainingDays + holdoutDays
  };
}

function tryCountWindows(referenceCandles: Candle[], config: AutoResearchRunConfig): number {
  if (config.mode !== "walk-forward") {
    return 0;
  }

  const resolved = getResolvedWalkForwardConfig(config);
  try {
    return buildWalkForwardRanges({
      candles: referenceCandles,
      trainingDays: resolved.trainingDays,
      holdoutDays: resolved.holdoutDays,
      stepDays: resolved.stepDays
    }).length;
  } catch {
    return 0;
  }
}

export function repairWalkForwardConfig(params: {
  config: AutoResearchRunConfig;
  referenceCandles: Candle[];
}): WalkForwardConfigResolution {
  const span = summarizeReferenceCandleSpan(params.referenceCandles);

  if (params.config.mode !== "walk-forward") {
    return {
      config: params.config,
      windowCount: 0,
      span
    };
  }

  const resolvedCurrent = getResolvedWalkForwardConfig(params.config);
  const currentWindowCount = tryCountWindows(params.referenceCandles, params.config);
  if (currentWindowCount > 0) {
    return {
      config: {
        ...params.config,
        trainingDays: resolvedCurrent.trainingDays,
        stepDays: resolvedCurrent.stepDays
      },
      windowCount: currentWindowCount,
      span
    };
  }

  const currentTrainingRatio = Math.max(1, resolvedCurrent.trainingDays / Math.max(resolvedCurrent.holdoutDays, 1));
  const currentStepRatio = Math.max(0.25, resolvedCurrent.stepDays / Math.max(resolvedCurrent.holdoutDays, 1));
  const candidateHoldouts = Array.from(
    new Set(
      [
        params.config.holdoutDays,
        180,
        120,
        90,
        75,
        60,
        45,
        30,
        21,
        14,
        7,
        Math.floor(span.availableDays / 5),
        Math.floor(span.availableDays / 4),
        Math.floor(span.availableDays / 3)
      ]
        .filter((value) => Number.isFinite(value) && value >= 7)
        .map((value) => quantizeDays(value))
    )
  ).sort((left, right) => right - left);

  let best:
    | {
        holdoutDays: number;
        trainingDays: number;
        stepDays: number;
        windowCount: number;
        score: number;
      }
    | undefined;

  for (const holdoutDays of candidateHoldouts) {
    for (const trainingRatio of [currentTrainingRatio, 2, 1.5, 1]) {
      for (const stepRatio of [currentStepRatio, 1, 0.5]) {
        const trainingDays = quantizeDays(holdoutDays * trainingRatio);
        const stepDays = quantizeDays(Math.max(7, holdoutDays * stepRatio));
        const candidateConfig: AutoResearchRunConfig = {
          ...params.config,
          holdoutDays,
          trainingDays,
          stepDays
        };
        const windowCount = tryCountWindows(params.referenceCandles, candidateConfig);
        if (windowCount <= 0) {
          continue;
        }

        const score =
          (windowCount >= 2 ? 100_000 : 0) +
          windowCount * 10_000 +
          holdoutDays * 100 +
          trainingDays -
          Math.abs(trainingRatio - currentTrainingRatio) * 100 -
          Math.abs(stepRatio - currentStepRatio) * 50;

        if (!best || score > best.score) {
          best = {
            holdoutDays,
            trainingDays,
            stepDays,
            windowCount,
            score
          };
        }
      }
    }
  }

  if (!best) {
    return {
      config: {
        ...params.config,
        trainingDays: resolvedCurrent.trainingDays,
        stepDays: resolvedCurrent.stepDays
      },
      windowCount: 0,
      span,
      invalidReason:
        "No valid walk-forward window could be constructed from the available candle span."
    };
  }

  return {
    config: {
      ...params.config,
      holdoutDays: best.holdoutDays,
      trainingDays: best.trainingDays,
      stepDays: best.stepDays
    },
    windowCount: best.windowCount,
    span,
    repair: {
      appliedAt: new Date().toISOString(),
      reason: "Adjusted walk-forward config to fit available candle span and produce valid windows.",
      previous: resolvedCurrent,
      next: {
        holdoutDays: best.holdoutDays,
        trainingDays: best.trainingDays,
        stepDays: best.stepDays,
        requiredDays: best.trainingDays + best.holdoutDays,
        expectedWindowCount: best.windowCount
      },
      available: {
        startAt: span.startAt?.toISOString(),
        endAt: span.endAt?.toISOString(),
        availableDays: span.availableDays
      }
    }
  };
}
