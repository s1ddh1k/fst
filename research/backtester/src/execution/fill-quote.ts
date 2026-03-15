import type { Candle } from "../types.js";
import type { ExchangeAdapter, ExecutionPolicy, SlippageModelInput } from "./executionTypes.js";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function computeSlippageBps(
  input: SlippageModelInput,
  policy: ExecutionPolicy
): number {
  const baseSpreadHalfBps = (input.estimatedSpreadBps ?? 10) * 0.5;
  const participation =
    input.avgDailyNotional && input.avgDailyNotional > 0
      ? input.notional / input.avgDailyNotional
      : 0;
  const impactBps = Math.min(25, Math.sqrt(Math.max(0, participation)) * 100);
  const urgencyBps = input.conviction && input.conviction > 0.85 ? 1.5 : 0;

  return clamp(
    baseSpreadHalfBps + impactBps + urgencyBps,
    0,
    policy.maxSlippageBps ?? 50
  );
}

export function estimateFillQuote(params: {
  side: "BUY" | "SELL";
  candle: Candle;
  conviction: number;
  estimatedNotional: number;
  avgDailyNotional?: number;
  estimatedSpreadBps?: number;
  exchangeAdapter: ExchangeAdapter;
  policy: ExecutionPolicy;
}): {
  referenceOpen: number;
  fillPrice: number;
  slippageBps: number;
} {
  const referenceOpen = params.exchangeAdapter.rules.roundPrice(
    params.candle.openPrice,
    params.side
  );
  const slippageBps = computeSlippageBps(
    {
      side: params.side,
      notional: params.estimatedNotional,
      barOpen: params.candle.openPrice,
      barHigh: params.candle.highPrice,
      barLow: params.candle.lowPrice,
      barClose: params.candle.closePrice,
      barVolume: params.candle.volume,
      avgDailyNotional: params.avgDailyNotional,
      estimatedSpreadBps: params.estimatedSpreadBps,
      conviction: params.conviction
    },
    params.policy
  );
  const rawFillPrice =
    params.side === "BUY"
      ? params.candle.openPrice * (1 + slippageBps / 10_000)
      : params.candle.openPrice * (1 - slippageBps / 10_000);

  return {
    referenceOpen,
    fillPrice: params.exchangeAdapter.rules.roundPrice(rawFillPrice, params.side),
    slippageBps
  };
}
