import type { StrategyTimeframe } from "../../../../packages/shared/src/index.js";

export function timeframeToMs(timeframe: StrategyTimeframe | string): number {
  switch (timeframe) {
    case "1m":
      return 60_000;
    case "5m":
      return 5 * 60_000;
    case "15m":
      return 15 * 60_000;
    case "1h":
      return 60 * 60_000;
    default:
      throw new Error(`Unsupported timeframe: ${timeframe}`);
  }
}

export function floorTimeToTimeframe(time: Date, timeframe: StrategyTimeframe | string): Date {
  const step = timeframeToMs(timeframe);
  return new Date(Math.floor(time.getTime() / step) * step);
}
