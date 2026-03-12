import type { Timeframe } from "./types.js";

export function getTimeframeMinutes(timeframe: Timeframe): number {
  switch (timeframe) {
    case "1m":
      return 1;
    case "5m":
      return 5;
    case "1h":
      return 60;
    case "1d":
      return 60 * 24;
  }
}

export function shiftBackward(time: Date, timeframe: Timeframe, steps = 1): Date {
  const minutes = getTimeframeMinutes(timeframe) * steps;
  return new Date(time.getTime() - minutes * 60_000);
}
