import type { ChildOrderPlan, OrderIntent, PositionIntent } from "../../../../packages/shared/src/index.js";

let orderSeq = 0;

function nextId(prefix: string): string {
  orderSeq += 1;
  return `${prefix}-${orderSeq}`;
}

export function planOrderFromIntent(intent: PositionIntent, at: Date): {
  orderIntent: OrderIntent;
  childOrders: ChildOrderPlan[];
} {
  const orderId = nextId("ord");
  const orderIntent: OrderIntent = {
    orderId,
    strategyId: intent.strategyId,
    sleeveId: intent.sleeveId,
    market: intent.market,
    side: intent.side,
    style: intent.executionStyle,
    notional: intent.targetNotional > 0 ? intent.targetNotional : undefined,
    quantity: intent.targetQuantity,
    maxSlipBps: 35,
    ttlSec: 60,
    reason: intent.reason,
    createdAt: at,
    metadata: intent.metadata
  };

  const childOrders: ChildOrderPlan[] = [
    {
      childOrderId: nextId("child"),
      intentId: orderId,
      orderType:
        intent.executionStyle === "market"
          ? "market"
          : intent.executionStyle === "best_ioc"
            ? "best"
            : "limit",
      timeInForce:
        intent.executionStyle === "best_ioc"
          ? "ioc"
          : intent.executionStyle === "limit_passive"
            ? "post_only"
            : undefined,
      notional: orderIntent.notional,
      quantity: orderIntent.quantity
    }
  ];

  return { orderIntent, childOrders };
}
