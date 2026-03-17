import type { Signal, SignalMetadata, SignalResult } from "./types.js";

type SignalOptions = Omit<SignalMetadata, "reason">;

function createSignalResult(
  signal: Signal,
  conviction: number,
  reason: string,
  options?: SignalOptions
): SignalResult {
  return {
    signal,
    conviction,
    metadata: {
      reason,
      tags: options?.tags,
      orderReason: options?.orderReason,
      metrics: options?.metrics
    }
  };
}

export function hold(reason: string, options?: SignalOptions): SignalResult {
  return createSignalResult("HOLD", 0, reason, options);
}

export function buy(conviction: number, reason: string, options?: SignalOptions): SignalResult {
  return createSignalResult("BUY", conviction, reason, options);
}

export function sell(
  conviction: number,
  reason: string,
  orderReason = "signal_exit",
  options?: SignalOptions
): SignalResult {
  return createSignalResult("SELL", conviction, reason, {
    ...options,
    orderReason
  });
}
