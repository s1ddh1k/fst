export function timeframeToMilliseconds(timeframe: string): number {
  switch (timeframe) {
    case "1m":
      return 60_000;
    case "5m":
      return 5 * 60_000;
    case "1h":
    case "60m":
      return 60 * 60_000;
    case "1d":
      return 24 * 60 * 60_000;
    default:
      throw new Error(`Unsupported timeframe: ${timeframe}`);
  }
}

export function buildTimeGrid(params: {
  startTime: Date;
  endTime: Date;
  timeframe: string;
}): Date[] {
  const stepMs = timeframeToMilliseconds(params.timeframe);
  const grid: Date[] = [];

  for (
    let timestamp = params.startTime.getTime();
    timestamp <= params.endTime.getTime();
    timestamp += stepMs
  ) {
    grid.push(new Date(timestamp));
  }

  return grid;
}

export function toDayKey(time: Date): string {
  return time.toISOString().slice(0, 10);
}
