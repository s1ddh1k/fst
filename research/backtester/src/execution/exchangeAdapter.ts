import type { ExchangeAdapter } from "./executionTypes.js";
import { DEFAULT_FEE_RATE } from "../config.js";

function getKrwTickSize(price: number): number {
  if (price >= 2_000_000) return 1_000;
  if (price >= 1_000_000) return 500;
  if (price >= 500_000) return 100;
  if (price >= 100_000) return 50;
  if (price >= 50_000) return 10;
  if (price >= 10_000) return 1;
  if (price >= 5_000) return 5;
  if (price >= 1_000) return 1;
  if (price >= 100) return 0.1;
  if (price >= 10) return 0.01;
  if (price >= 1) return 0.001;
  if (price >= 0.1) return 0.0001;
  if (price >= 0.01) return 0.00001;
  if (price >= 0.001) return 0.000001;
  if (price >= 0.0001) return 0.0000001;
  return 0.00000001;
}

function roundToTick(value: number, tick: number): number {
  const decimals = tick >= 1 ? 0 : Math.ceil(Math.abs(Math.log10(tick)));
  return Number(value.toFixed(decimals));
}

export function createUpbitKrwExchangeAdapter(params?: {
  minOrderNotional?: number;
  makerFeeRate?: number;
  takerFeeRate?: number;
}): ExchangeAdapter {
  const makerFeeRate = params?.makerFeeRate ?? DEFAULT_FEE_RATE;
  const takerFeeRate = params?.takerFeeRate ?? DEFAULT_FEE_RATE;

  return {
    name: "upbit-krw-spot",
    rules: {
      minOrderNotional: params?.minOrderNotional ?? 5_000,
      getTickSize: getKrwTickSize,
      roundPrice(price, side) {
        const tick = getKrwTickSize(price);
        const scaled = price / tick;
        return roundToTick(
          side === "BUY"
            ? Math.ceil(scaled) * tick
            : Math.floor(scaled) * tick,
          tick
        );
      },
      makerFeeRate,
      takerFeeRate
    }
  };
}
