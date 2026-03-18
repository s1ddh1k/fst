import type { AutoResearchRunConfig } from "./types.js";

type SupportedTimeframe = "1m" | "5m" | "15m" | "1h" | "1d";

function candlesPerDay(timeframe: SupportedTimeframe): number {
  switch (timeframe) {
    case "1m":
      return 24 * 60;
    case "5m":
      return 24 * 12;
    case "15m":
      return 24 * 4;
    case "1h":
      return 24;
    case "1d":
      return 1;
    default:
      return 1;
  }
}

export function calculateAutoResearchMinimumLimit(
  config: Pick<AutoResearchRunConfig, "holdoutDays" | "trainingDays" | "stepDays" | "mode"> & {
    timeframe: SupportedTimeframe;
  }
): number {
  const perDay = candlesPerDay(config.timeframe);
  const baseDays =
    config.mode === "walk-forward"
      ? (config.trainingDays ?? config.holdoutDays * 2) + config.holdoutDays + (config.stepDays ?? config.holdoutDays)
      : config.holdoutDays * 2;

  return Math.ceil(baseDays * perDay * 1.1);
}

export function repairAutoResearchLimit(config: AutoResearchRunConfig): {
  config: AutoResearchRunConfig;
  repaired: boolean;
  minimumLimit: number;
  previousLimit: number;
} {
  const minimumLimit = calculateAutoResearchMinimumLimit(config);

  if (config.limit >= minimumLimit) {
    return {
      config,
      repaired: false,
      minimumLimit,
      previousLimit: config.limit
    };
  }

  return {
    config: {
      ...config,
      limit: minimumLimit
    },
    repaired: true,
    minimumLimit,
    previousLimit: config.limit
  };
}
