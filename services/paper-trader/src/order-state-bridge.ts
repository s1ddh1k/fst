import { OrderStateMachine } from "../../../packages/shared/src/execution.js";
import { insertPaperOrder } from "./db.js";
import type { MarketPolicy } from "./market-policy-cache.js";

type FilledOrderRequest = {
  sessionId: number;
  marketCode: string;
  side: "BUY" | "SELL";
  orderType: "market" | "best_ioc" | "limit";
  requestedPrice: number;
  executedPrice: number;
  quantity: number;
  fee: number;
  slippage: number;
  marketPolicy: MarketPolicy;
  reason?: string;
};

let orderSequence = 0;

function nextOrderId(sessionId: number, marketCode: string, side: "BUY" | "SELL"): string {
  orderSequence += 1;
  return `paper-${sessionId}-${marketCode}-${side}-${orderSequence}`;
}

export function createPaperOrderStateBridge() {
  const machine = new OrderStateMachine();

  return {
    machine,
    async recordFilledOrder(request: FilledOrderRequest): Promise<{ orderId: string; status: "FILLED" | "REJECTED" }> {
      const orderId = nextOrderId(request.sessionId, request.marketCode, request.side);
      const createdAt = new Date();
      const roundedRequestedPrice = request.requestedPrice <= 0
        ? request.requestedPrice
        : request.side === "BUY"
          ? Math.ceil(request.requestedPrice / request.marketPolicy.tickSize) * request.marketPolicy.tickSize
          : Math.floor(request.requestedPrice / request.marketPolicy.tickSize) * request.marketPolicy.tickSize;
      const notional = request.executedPrice * request.quantity;

      machine.apply({
        type: "ORDER_CREATED",
        at: createdAt,
        orderId,
        market: request.marketCode,
        side: request.side
      });
      machine.apply({
        type: "ORDER_SUBMITTED",
        at: createdAt,
        orderId
      });

      if (notional < request.marketPolicy.minOrderNotional) {
        machine.apply({
          type: "ORDER_REJECTED",
          at: createdAt,
          orderId,
          reason: request.reason ?? "below_min_order_notional"
        });
        return {
          orderId,
          status: "REJECTED"
        };
      }

      await insertPaperOrder({
        sessionId: request.sessionId,
        marketCode: request.marketCode,
        side: request.side,
        orderType: request.orderType,
        requestedPrice: roundedRequestedPrice,
        executedPrice: request.executedPrice,
        quantity: request.quantity,
        fee: request.fee,
        slippage: request.slippage
      });

      machine.apply({
        type: "ORDER_FILLED",
        at: createdAt,
        orderId,
        filledQuantity: request.quantity,
        filledNotional: notional
      });

      return {
        orderId,
        status: "FILLED"
      };
    }
  };
}
