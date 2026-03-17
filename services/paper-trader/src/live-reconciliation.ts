import type { OrderStateRecord } from "../../../packages/shared/src/index.js";

export type LiveReconciliationResult = {
  missingLocalOrders: string[];
  staleOpenOrders: string[];
};

export function reconcileOrderStates(params: {
  localOrders: OrderStateRecord[];
  exchangeOpenOrderIds: string[];
}): LiveReconciliationResult {
  const localOpen = params.localOrders
    .filter((order) => ["CREATED", "PLANNED", "SUBMITTED", "PARTIALLY_FILLED", "CANCEL_REQUESTED"].includes(order.status))
    .map((order) => order.orderId);
  const exchangeOpen = new Set(params.exchangeOpenOrderIds);

  return {
    missingLocalOrders: params.exchangeOpenOrderIds.filter((orderId) => !localOpen.includes(orderId)),
    staleOpenOrders: localOpen.filter((orderId) => !exchangeOpen.has(orderId))
  };
}
