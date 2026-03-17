import { createUpbitKrwExchangeAdapter } from "../../../research/backtester/src/execution/exchangeAdapter.js";

export type MarketPolicy = {
  marketCode: string;
  minOrderNotional: number;
  tickSize: number;
  makerFeeRate: number;
  takerFeeRate: number;
};

export function createMarketPolicyCache(params?: {
  minOrderNotional?: number;
  makerFeeRate?: number;
  takerFeeRate?: number;
}) {
  const adapter = createUpbitKrwExchangeAdapter(params);
  const cache = new Map<string, MarketPolicy>();

  return {
    get(marketCode: string, referencePrice: number): MarketPolicy {
      const cached = cache.get(marketCode);
      const tickSize = adapter.rules.getTickSize(referencePrice);

      if (
        cached &&
        cached.tickSize === tickSize
      ) {
        return cached;
      }

      const policy: MarketPolicy = {
        marketCode,
        minOrderNotional: adapter.rules.minOrderNotional,
        tickSize,
        makerFeeRate: adapter.rules.makerFeeRate,
        takerFeeRate: adapter.rules.takerFeeRate
      };
      cache.set(marketCode, policy);
      return policy;
    },
    roundPrice(price: number, side: "BUY" | "SELL"): number {
      return adapter.rules.roundPrice(price, side);
    }
  };
}
