import {
  OrderStateMachine,
  type ChildOrderPlan,
  type OrderIntent,
  type PositionView
} from "../../../../packages/shared/src/index.js";
import type { Candle } from "../../../../packages/shared/src/index.js";
import type { ExchangeAdapter } from "../execution/executionTypes.js";
import { createExecutionSimulator } from "../execution/ExecutionSimulator.js";
import { createUpbitKrwExchangeAdapter } from "../execution/exchangeAdapter.js";
import type { SimulationFill } from "./types.js";

export function createExecutionRouter(params?: { exchangeAdapter?: ExchangeAdapter }) {
  const exchangeAdapter = params?.exchangeAdapter ?? createUpbitKrwExchangeAdapter();
  const orderStateMachine = new OrderStateMachine();
  const simulatorByStyle = new Map<OrderIntent["style"], ReturnType<typeof createExecutionSimulator>>();

  function getSimulator(style: OrderIntent["style"]) {
    const cached = simulatorByStyle.get(style);

    if (cached) {
      return cached;
    }

    const simulator = createExecutionSimulator({
      exchangeAdapter,
      policy:
        style === "limit_passive"
          ? {
              defaultFeeSide: "maker",
              maxSlippageBps: 3
            }
          : style === "limit_aggressive"
            ? {
                defaultFeeSide: "taker",
                maxSlippageBps: 8
              }
            : {
                maxSlippageBps: 35
              }
    });
    simulatorByStyle.set(style, simulator);
    return simulator;
  }

  return {
    orderStateMachine,
    route(params: {
      orderIntent: OrderIntent;
      childOrders: ChildOrderPlan[];
      decisionBarIndex: number;
      executionBarIndex: number;
      nextExecutionBar?: Candle;
      cashAvailable: number;
      currentPosition?: PositionView;
    }): SimulationFill {
      orderStateMachine.apply({
        type: "ORDER_CREATED",
        at: params.orderIntent.createdAt,
        orderId: params.orderIntent.orderId,
        market: params.orderIntent.market,
        side: params.orderIntent.side
      });
      orderStateMachine.apply({
        type: "ORDER_PLANNED",
        at: params.orderIntent.createdAt,
        orderId: params.orderIntent.orderId
      });
      orderStateMachine.apply({
        type: "ORDER_SUBMITTED",
        at: params.orderIntent.createdAt,
        orderId: params.orderIntent.orderId
      });

      const simulator = getSimulator(params.orderIntent.style);

      const fill = simulator.simulate({
        orderIntent: {
          side: params.orderIntent.side,
          market: params.orderIntent.market,
          timestamp: params.orderIntent.createdAt,
          orderStyle:
            params.orderIntent.style === "limit_passive" || params.orderIntent.style === "limit_aggressive"
              ? "limit"
              : params.orderIntent.style,
          reason:
            params.orderIntent.side === "BUY"
              ? "entry"
              : ["stop_exit", "trail_exit", "risk_off_exit", "rebalance_exit"].includes(params.orderIntent.reason)
                ? (params.orderIntent.reason as "stop_exit" | "trail_exit" | "risk_off_exit" | "rebalance_exit")
                : "signal_exit",
          conviction: 0.5,
          targetNotional: params.orderIntent.notional,
          targetQuantity: params.orderIntent.quantity,
          metadata: params.orderIntent.metadata as Record<string, unknown> | undefined
        },
        decisionBarIndex: params.decisionBarIndex,
        executionBarIndex: params.executionBarIndex,
        nextBar: params.nextExecutionBar,
        cashAvailable: params.cashAvailable,
        positionQuantity: params.currentPosition?.quantity ?? 0
      });

      if (fill.status === "FILLED") {
        orderStateMachine.apply({
          type: "ORDER_FILLED",
          at: fill.fillTimestamp ?? params.orderIntent.createdAt,
          orderId: params.orderIntent.orderId,
          filledQuantity: fill.filledQuantity ?? 0,
          filledNotional: fill.filledNotional ?? 0
        });
      } else {
        orderStateMachine.apply({
          type: "ORDER_REJECTED",
          at: params.orderIntent.createdAt,
          orderId: params.orderIntent.orderId,
          reason: fill.reason ?? "rejected"
        });
      }

      return {
        orderId: params.orderIntent.orderId,
        market: params.orderIntent.market,
        side: params.orderIntent.side,
        status: fill.status === "FILLED" ? "FILLED" : "REJECTED",
        fillTime: fill.fillTimestamp,
        fillPrice: fill.fillPrice,
        filledQuantity: fill.filledQuantity,
        filledNotional: fill.filledNotional,
        feePaid: fill.feePaid ?? 0,
        slippagePaid: fill.slippagePaid ?? 0,
        reason: fill.reason
      };
    }
  };
}
