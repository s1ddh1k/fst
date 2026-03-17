import type {
  ExecutionPolicy,
  ExecutionRequest,
  FillResult
} from "./executionTypes.js";
import type { ExchangeAdapter } from "./executionTypes.js";
import { createUpbitKrwExchangeAdapter } from "./exchangeAdapter.js";
import { estimateFillQuote } from "./fill-quote.js";

export function createDefaultExecutionPolicy(): ExecutionPolicy {
  return {
    entryOrderStyle: "best_ioc",
    exitOrderStyle: "best_ioc",
    defaultFeeSide: "taker",
    decisionToExecutionLagBars: 1,
    rejectIfNextBarMissing: true,
    maxSlippageBps: 35,
    allowPartialFills: false
  };
}

export function createExecutionSimulator(params?: {
  exchangeAdapter?: ExchangeAdapter;
  policy?: Partial<ExecutionPolicy>;
}) {
  const exchangeAdapter = params?.exchangeAdapter ?? createUpbitKrwExchangeAdapter();
  const policy = {
    ...createDefaultExecutionPolicy(),
    ...params?.policy
  };

  return {
    exchangeAdapter,
    policy,

    simulate(request: ExecutionRequest): FillResult {
      if (
        request.nextBar &&
        request.nextBar.candleTimeUtc.getTime() <= request.orderIntent.timestamp.getTime()
      ) {
        return {
          status: "REJECTED",
          side: request.orderIntent.side,
          market: request.orderIntent.market,
          orderTimestamp: request.orderIntent.timestamp,
          reason: "same_bar_fill_forbidden"
        };
      }

      if (!request.nextBar) {
        return {
          status: policy.rejectIfNextBarMissing ? "REJECTED" : "UNFILLED",
          side: request.orderIntent.side,
          market: request.orderIntent.market,
          orderTimestamp: request.orderIntent.timestamp,
          reason: "missing_next_bar"
        };
      }

      const feeRate =
        policy.defaultFeeSide === "maker"
          ? exchangeAdapter.rules.makerFeeRate
          : exchangeAdapter.rules.takerFeeRate;
      const estimatedNotional =
        request.orderIntent.side === "BUY"
          ? request.orderIntent.targetNotional ?? 0
          : (request.orderIntent.targetQuantity ?? request.positionQuantity) *
            exchangeAdapter.rules.roundPrice(request.nextBar.openPrice, request.orderIntent.side);
      const {
        referenceOpen,
        slippageBps,
        fillPrice
      } = estimateFillQuote({
        side: request.orderIntent.side,
        candle: request.nextBar,
        conviction: request.orderIntent.conviction,
        estimatedNotional,
        avgDailyNotional:
          request.avgDailyNotional ??
          (typeof request.orderIntent.metadata?.avgDailyNotional === "number"
            ? request.orderIntent.metadata.avgDailyNotional
            : undefined),
        estimatedSpreadBps:
          request.estimatedSpreadBps ??
          (typeof request.orderIntent.metadata?.estimatedSpreadBps === "number"
            ? request.orderIntent.metadata.estimatedSpreadBps
            : undefined),
        exchangeAdapter,
        policy
      });

      if (!Number.isFinite(fillPrice) || fillPrice <= 0) {
        return {
          status: "REJECTED",
          side: request.orderIntent.side,
          market: request.orderIntent.market,
          orderTimestamp: request.orderIntent.timestamp,
          reason: "invalid_fill_price"
        };
      }

      if (request.orderIntent.side === "BUY") {
        const availableBudget = Math.min(
          request.cashAvailable,
          request.orderIntent.targetNotional ?? request.cashAvailable
        );

        if (availableBudget <= 0) {
          return {
            status: "REJECTED",
            side: "BUY",
            market: request.orderIntent.market,
            orderTimestamp: request.orderIntent.timestamp,
            reason: "insufficient_cash"
          };
        }

        const quantity = availableBudget / (fillPrice * (1 + feeRate));
        const grossNotional = quantity * fillPrice;

        if (!Number.isFinite(quantity) || quantity <= 0) {
          return {
            status: "REJECTED",
            side: "BUY",
            market: request.orderIntent.market,
            orderTimestamp: request.orderIntent.timestamp,
            reason: "invalid_quantity"
          };
        }

        if (grossNotional < exchangeAdapter.rules.minOrderNotional) {
          return {
            status: "REJECTED",
            side: "BUY",
            market: request.orderIntent.market,
            orderTimestamp: request.orderIntent.timestamp,
            requestedNotional: availableBudget,
            reason: "below_min_order_notional"
          };
        }

        const feePaid = grossNotional * feeRate;

        return {
          status: "FILLED",
          side: "BUY",
          market: request.orderIntent.market,
          orderTimestamp: request.orderIntent.timestamp,
          fillTimestamp: request.nextBar.candleTimeUtc,
          requestedNotional: availableBudget,
          filledQuantity: quantity,
          filledNotional: grossNotional,
          fillPrice,
          feePaid,
          slippageBps,
          slippagePaid: Math.max(0, (fillPrice - referenceOpen) * quantity),
          metadata: {
            referenceOpen
          }
        };
      }

      const quantity = request.orderIntent.targetQuantity ?? request.positionQuantity;

      if (!Number.isFinite(quantity) || quantity <= 0) {
        return {
          status: "REJECTED",
          side: "SELL",
          market: request.orderIntent.market,
          orderTimestamp: request.orderIntent.timestamp,
          reason: "invalid_quantity"
        };
      }

      if (quantity > request.positionQuantity + 1e-12) {
        return {
          status: "REJECTED",
          side: "SELL",
          market: request.orderIntent.market,
          orderTimestamp: request.orderIntent.timestamp,
          requestedQuantity: quantity,
          reason: "insufficient_position"
        };
      }

      const grossNotional = quantity * fillPrice;

      if (grossNotional < exchangeAdapter.rules.minOrderNotional) {
        return {
          status: "REJECTED",
          side: "SELL",
          market: request.orderIntent.market,
          orderTimestamp: request.orderIntent.timestamp,
          requestedQuantity: quantity,
          requestedNotional: grossNotional,
          reason: "below_min_order_notional"
        };
      }

      const feePaid = grossNotional * feeRate;

      return {
        status: "FILLED",
        side: "SELL",
        market: request.orderIntent.market,
        orderTimestamp: request.orderIntent.timestamp,
        fillTimestamp: request.nextBar.candleTimeUtc,
        requestedQuantity: quantity,
        filledQuantity: quantity,
        requestedNotional: grossNotional,
        filledNotional: grossNotional,
        fillPrice,
        feePaid,
        slippageBps,
        slippagePaid: Math.max(0, (referenceOpen - fillPrice) * quantity),
        metadata: {
          referenceOpen
        }
      };
    }
  };
}
