import type { OrderSide } from "./domain.js";

export type OrderIntent = {
  orderId: string;
  strategyId: string;
  sleeveId: string;
  market: string;
  side: OrderSide;
  style: "market" | "best_ioc" | "limit_passive" | "limit_aggressive";
  notional?: number;
  quantity?: number;
  maxSlipBps: number;
  ttlSec?: number;
  reason: string;
  createdAt: Date;
  metadata?: Record<string, unknown>;
};

export type ChildOrderPlan = {
  childOrderId: string;
  intentId: string;
  orderType: "market" | "best" | "limit";
  timeInForce?: "ioc" | "fok" | "post_only";
  price?: number;
  quantity?: number;
  notional?: number;
};

export type OrderPlan = {
  intent: OrderIntent;
  childOrders: ChildOrderPlan[];
};

export type OrderStatus =
  | "CREATED"
  | "PLANNED"
  | "SUBMITTED"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCEL_REQUESTED"
  | "CANCELLED"
  | "REJECTED"
  | "EXPIRED";

export type OrderStateRecord = {
  orderId: string;
  market: string;
  side: OrderSide;
  status: OrderStatus;
  createdAt: Date;
  updatedAt: Date;
  filledQuantity: number;
  filledNotional: number;
  averageFillPrice?: number;
  lastReason?: string;
};

export type OrderStateEvent =
  | { type: "ORDER_CREATED"; at: Date; orderId: string; market: string; side: OrderSide }
  | { type: "ORDER_PLANNED"; at: Date; orderId: string }
  | { type: "ORDER_SUBMITTED"; at: Date; orderId: string }
  | { type: "ORDER_PARTIALLY_FILLED"; at: Date; orderId: string; filledQuantity: number; filledNotional: number }
  | { type: "ORDER_FILLED"; at: Date; orderId: string; filledQuantity: number; filledNotional: number }
  | { type: "ORDER_CANCEL_REQUESTED"; at: Date; orderId: string; reason?: string }
  | { type: "ORDER_CANCELLED"; at: Date; orderId: string; reason?: string }
  | { type: "ORDER_REJECTED"; at: Date; orderId: string; reason: string }
  | { type: "ORDER_EXPIRED"; at: Date; orderId: string; reason?: string };

export function applyOrderStateEvent(
  current: OrderStateRecord | undefined,
  event: OrderStateEvent
): OrderStateRecord {
  if (!current) {
    if (event.type !== "ORDER_CREATED") {
      throw new Error(`Order ${event.orderId} must start with ORDER_CREATED`);
    }

    return {
      orderId: event.orderId,
      market: event.market,
      side: event.side,
      status: "CREATED",
      createdAt: event.at,
      updatedAt: event.at,
      filledQuantity: 0,
      filledNotional: 0
    };
  }

  switch (event.type) {
    case "ORDER_CREATED":
      throw new Error(`Order ${event.orderId} already exists`);
    case "ORDER_PLANNED":
      return { ...current, status: "PLANNED", updatedAt: event.at };
    case "ORDER_SUBMITTED":
      return { ...current, status: "SUBMITTED", updatedAt: event.at };
    case "ORDER_PARTIALLY_FILLED":
      return {
        ...current,
        status: "PARTIALLY_FILLED",
        updatedAt: event.at,
        filledQuantity: event.filledQuantity,
        filledNotional: event.filledNotional,
        averageFillPrice:
          event.filledQuantity > 0 ? event.filledNotional / event.filledQuantity : current.averageFillPrice
      };
    case "ORDER_FILLED":
      return {
        ...current,
        status: "FILLED",
        updatedAt: event.at,
        filledQuantity: event.filledQuantity,
        filledNotional: event.filledNotional,
        averageFillPrice:
          event.filledQuantity > 0 ? event.filledNotional / event.filledQuantity : current.averageFillPrice
      };
    case "ORDER_CANCEL_REQUESTED":
      return { ...current, status: "CANCEL_REQUESTED", updatedAt: event.at, lastReason: event.reason };
    case "ORDER_CANCELLED":
      return { ...current, status: "CANCELLED", updatedAt: event.at, lastReason: event.reason };
    case "ORDER_REJECTED":
      return { ...current, status: "REJECTED", updatedAt: event.at, lastReason: event.reason };
    case "ORDER_EXPIRED":
      return { ...current, status: "EXPIRED", updatedAt: event.at, lastReason: event.reason };
  }
}

export class OrderStateMachine {
  private readonly orders = new Map<string, OrderStateRecord>();

  apply(event: OrderStateEvent): OrderStateRecord {
    const next = applyOrderStateEvent(this.orders.get(event.orderId), event);
    this.orders.set(event.orderId, next);
    return next;
  }

  get(orderId: string): OrderStateRecord | undefined {
    return this.orders.get(orderId);
  }

  snapshot(): OrderStateRecord[] {
    return Array.from(this.orders.values()).sort((left, right) =>
      left.createdAt.getTime() - right.createdAt.getTime()
    );
  }
}
