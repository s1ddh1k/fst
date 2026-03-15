export const SCORED_DECISION_TIMEFRAME = "1h";

export function isSupportedScoredDecisionTimeframe(timeframe: string): boolean {
  return timeframe === "1h" || timeframe === "60m";
}

export function assertSupportedScoredDecisionTimeframe(timeframe: string): void {
  if (isSupportedScoredDecisionTimeframe(timeframe)) {
    return;
  }

  throw new Error(
    `Scored strategies must run on ${SCORED_DECISION_TIMEFRAME} decision candles; received ${timeframe}`
  );
}
