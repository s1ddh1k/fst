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
}): PaperRuntimeOpsGuard {
  const lastSeenTimestampByMarket = new Map<string, number>();
  const minSignalCandles = params?.minSignalCandles ?? 2;

  return {
    name: "sequential-ticker-guard",
    acceptsTicker({ marketCode, timestamp }) {
      const lastTimestamp = lastSeenTimestampByMarket.get(marketCode);

      if (lastTimestamp !== undefined && timestamp <= lastTimestamp) {
        return false;
      }

      lastSeenTimestampByMarket.set(marketCode, timestamp);
      return true;
    },
    shouldEvaluateSignal({ openedNewBucket, candleCount }) {
      return openedNewBucket && candleCount >= minSignalCandles;
    }
  };
}
