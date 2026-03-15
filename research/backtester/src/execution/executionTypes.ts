import type { Candle } from "../types.js";
import type { OrderIntent } from "../portfolio/portfolioTypes.js";

export type ExchangeRules = {
  minOrderNotional: number;
  getTickSize(price: number): number;
  roundPrice(price: number, side: "BUY" | "SELL"): number;
  makerFeeRate: number;
  takerFeeRate: number;
};

export type ExchangeAdapter = {
  name: string;
  rules: ExchangeRules;
};

export type SlippageModelInput = {
  side: "BUY" | "SELL";
  notional: number;
  barOpen: number;
  barHigh: number;
  barLow: number;
  barClose: number;
  barVolume?: number;
  avgDailyNotional?: number;
  estimatedSpreadBps?: number;
  conviction?: number;
};

export type ExecutionPolicy = {
  entryOrderStyle: "market" | "best_ioc" | "limit";
  exitOrderStyle: "market" | "best_ioc" | "limit";
  defaultFeeSide: "taker" | "maker";
  decisionToExecutionLagBars: number;
  rejectIfNextBarMissing: boolean;
  maxSlippageBps?: number;
  allowPartialFills?: boolean;
};

export type FillResult = {
  status: "FILLED" | "REJECTED" | "UNFILLED" | "PARTIAL";
  side: "BUY" | "SELL";
  market: string;
  orderTimestamp: Date;
  fillTimestamp?: Date;
  requestedQuantity?: number;
  filledQuantity?: number;
  requestedNotional?: number;
  filledNotional?: number;
  fillPrice?: number;
  feePaid?: number;
  slippageBps?: number;
  slippagePaid?: number;
  reason?: string;
  metadata?: Record<string, unknown>;
};

export type ExecutionRequest = {
  orderIntent: OrderIntent;
  decisionBarIndex: number;
  executionBarIndex: number;
  nextBar?: Candle;
  cashAvailable: number;
  positionQuantity: number;
  avgDailyNotional?: number;
  estimatedSpreadBps?: number;
};
