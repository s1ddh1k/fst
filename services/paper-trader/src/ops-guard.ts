export type PaperRuntimeOpsGuard = {
  name: string;
  acceptsTicker(params: {
    marketCode: string;
    timestamp: number;
  }): boolean;
  shouldEvaluateSignal(params: {
    openedNewBucket: boolean;
    candleCount: number;
  }): boolean;
};

export function createPaperRuntimeOpsGuard(params?: {
  minSignalCandles?: number;
  tickSampleIntervalMs?: number;
}): PaperRuntimeOpsGuard {
  const lastSeenTimestampByMarket = new Map<string, number>();
  const lastAcceptedRealTimeByMarket = new Map<string, number>();
  const minSignalCandles = params?.minSignalCandles ?? 2;
  const tickSampleIntervalMs = params?.tickSampleIntervalMs ?? 5_000;

  return {
    name: "sequential-ticker-guard",
    acceptsTicker({ marketCode, timestamp }) {
      const lastTimestamp = lastSeenTimestampByMarket.get(marketCode);

      if (lastTimestamp !== undefined && timestamp <= lastTimestamp) {
        return false;
      }

      lastSeenTimestampByMarket.set(marketCode, timestamp);

      const now = Date.now();
      const lastAccepted = lastAcceptedRealTimeByMarket.get(marketCode);
      if (lastAccepted !== undefined && now - lastAccepted < tickSampleIntervalMs) {
        return false;
      }
      lastAcceptedRealTimeByMarket.set(marketCode, now);

      return true;
    },
    shouldEvaluateSignal({ openedNewBucket, candleCount }) {
      return openedNewBucket && candleCount >= minSignalCandles;
    }
  };
}
