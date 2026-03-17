import type {
  CandidateSignal,
  CoordinationResult,
  CoordinatorConfig,
  OrderIntent,
  PortfolioState
} from "./portfolioTypes.js";
import { toDayKey } from "../universe/timeframe.js";

function incrementReason(
  reasonCounts: Record<string, number>,
  reason: string,
  amount = 1
): void {
  reasonCounts[reason] = (reasonCounts[reason] ?? 0) + amount;
}

function normalize01(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  if (value <= low) {
    return 0;
  }

  if (value >= high) {
    return 1;
  }

  return (value - low) / (high - low);
}

function compareCandidates(left: CandidateSignal, right: CandidateSignal): number {
  if (right.conviction !== left.conviction) {
    return right.conviction - left.conviction;
  }

  const leftLiquidity = left.metadata?.liquidityScore ?? 0;
  const rightLiquidity = right.metadata?.liquidityScore ?? 0;

  if (rightLiquidity !== leftLiquidity) {
    return rightLiquidity - leftLiquidity;
  }

  const leftSpread = left.metadata?.estimatedSpreadBps ?? Number.POSITIVE_INFINITY;
  const rightSpread = right.metadata?.estimatedSpreadBps ?? Number.POSITIVE_INFINITY;

  if (leftSpread !== rightSpread) {
    return leftSpread - rightSpread;
  }

  return left.market.localeCompare(right.market);
}

function selectionScore(candidate: CandidateSignal): number {
  const conviction = candidate.conviction;
  const liquidityBonus = normalize01(candidate.metadata?.liquidityScore ?? 0, 0, 1);
  const costPenalty = normalize01(candidate.metadata?.estimatedSpreadBps ?? 0, 5, 40);

  return 0.75 * conviction + 0.15 * liquidityBonus - 0.1 * costPenalty;
}

export function createDefaultCoordinatorConfig(): CoordinatorConfig {
  return {
    minBuyConviction: 0.55,
    cooldownBarsAfterLoss: 12,
    minBarsBetweenReentry: 6,
    maxTradesPerDay: 4,
    allowSwitching: false,
    ignoreSyntheticBarsForEntry: true
  };
}

export function createInitialPortfolioState(initialCash: number): PortfolioState {
  return {
    cash: initialCash,
    cooldownUntilByMarket: {},
    lastExitReasonByMarket: {},
    lastExitBarIndexByMarket: {},
    lastEntryBarIndexByMarket: {},
    tradesToday: 0
  };
}

function resetDailyTradeCounterIfNeeded(state: PortfolioState, timestamp: Date): void {
  const dayKey = toDayKey(timestamp);

  if (state.currentTradeDay !== dayKey) {
    state.currentTradeDay = dayKey;
    state.tradesToday = 0;
  }
}

export function createPortfolioCoordinator(config?: Partial<CoordinatorConfig>) {
  const resolvedConfig = {
    ...createDefaultCoordinatorConfig(),
    ...config
  };

  return {
    config: resolvedConfig,

    coordinate(params: {
      state: PortfolioState;
      signals: CandidateSignal[];
      timestamp: Date;
      barIndex: number;
    }): CoordinationResult {
      resetDailyTradeCounterIfNeeded(params.state, params.timestamp);
      const reasonCounts: Record<string, number> = {};

      if (params.state.position) {
        const heldSignal = params.signals.find(
          (signal) => signal.market === params.state.position?.market
        );
        const blockedBuys = params.signals.filter(
          (signal) => signal.signal === "BUY" && signal.market !== params.state.position?.market
        ).length;

        if (blockedBuys > 0) {
          incrementReason(reasonCounts, "entry_blocked_by_open_position", blockedBuys);
        }

        if (!heldSignal || heldSignal.signal !== "SELL") {
          return {
            intent: null,
            diagnostics: {
              cooldownSkips: 0,
              consideredBuys: 0,
              eligibleBuys: 0,
              reasonCounts
            }
          };
        }

        return {
          intent: {
            side: "SELL",
            market: heldSignal.market,
            timestamp: params.timestamp,
            orderStyle: "best_ioc",
            reason: heldSignal.metadata?.exitReason ?? "signal_exit",
            conviction: Math.max(heldSignal.conviction, 0.5),
            targetQuantity: params.state.position.quantity
          },
          diagnostics: {
            cooldownSkips: 0,
            consideredBuys: 0,
            eligibleBuys: 0,
            reasonCounts
          }
        };
      }

      if (
        resolvedConfig.maxTradesPerDay !== undefined &&
        params.state.tradesToday >= resolvedConfig.maxTradesPerDay
      ) {
        const blockedEntries = params.signals.filter((signal) => signal.signal === "BUY").length;
        if (blockedEntries > 0) {
          incrementReason(reasonCounts, "max_trades_per_day", blockedEntries);
        }
        return {
          intent: null,
          diagnostics: {
            cooldownSkips: 0,
            consideredBuys: 0,
            eligibleBuys: 0,
            reasonCounts
          }
        };
      }

      const candidates = params.signals.filter((signal) => signal.signal === "BUY");
      let cooldownSkips = 0;
      const eligible = candidates.filter((signal) => {
        if (signal.conviction < resolvedConfig.minBuyConviction) {
          incrementReason(reasonCounts, "below_min_conviction");
          return false;
        }

        if (resolvedConfig.ignoreSyntheticBarsForEntry && signal.metadata?.isSyntheticBar) {
          incrementReason(reasonCounts, "synthetic_bar_blocked");
          return false;
        }

        const cooldownUntil = params.state.cooldownUntilByMarket[signal.market] ?? Number.NEGATIVE_INFINITY;

        if (params.barIndex < cooldownUntil) {
          cooldownSkips += 1;
          incrementReason(reasonCounts, "cooldown_active");
          return false;
        }

        const lastExitBar = params.state.lastExitBarIndexByMarket[signal.market];

        if (
          lastExitBar !== undefined &&
          params.barIndex - lastExitBar < resolvedConfig.minBarsBetweenReentry
        ) {
          incrementReason(reasonCounts, "min_reentry_gap");
          return false;
        }

        return true;
      });

      if (eligible.length === 0) {
        return {
          intent: null,
          diagnostics: {
            cooldownSkips,
            consideredBuys: candidates.length,
            eligibleBuys: 0,
            reasonCounts
          }
        };
      }

      const ranked = eligible
        .slice()
        .sort((left, right) => {
          const scoreDelta = selectionScore(right) - selectionScore(left);

          if (scoreDelta !== 0) {
            return scoreDelta;
          }

          return compareCandidates(left, right);
        });
      const best = ranked[0];

      if (ranked.length > 1) {
        incrementReason(reasonCounts, "ranked_out_by_single_position", ranked.length - 1);
      }

      return {
        intent: {
          side: "BUY",
          market: best.market,
          timestamp: params.timestamp,
          orderStyle: "best_ioc",
          reason: "entry",
          conviction: best.conviction,
          metadata: {
            avgDailyNotional: best.metadata?.avgDailyNotional,
            estimatedSpreadBps: best.metadata?.estimatedSpreadBps
          }
        },
        diagnostics: {
          cooldownSkips,
          consideredBuys: candidates.length,
          eligibleBuys: eligible.length,
          reasonCounts
        }
      };
    },

    onBuyFilled(params: {
      state: PortfolioState;
      market: string;
      entryPrice: number;
      quantity: number;
      barIndex: number;
      timestamp: Date;
    }): void {
      resetDailyTradeCounterIfNeeded(params.state, params.timestamp);
      params.state.position = {
        market: params.market,
        entryTimestamp: params.timestamp,
        entryPrice: params.entryPrice,
        quantity: params.quantity,
        entryBarIndex: params.barIndex
      };
      params.state.lastEntryBarIndexByMarket[params.market] = params.barIndex;
      params.state.tradesToday += 1;
      params.state.lastTradeTimestamp = params.timestamp;
    },

    onSellFilled(params: {
      state: PortfolioState;
      market: string;
      barIndex: number;
      timestamp: Date;
      reason: OrderIntent["reason"];
      pnlRatio: number;
    }): void {
      resetDailyTradeCounterIfNeeded(params.state, params.timestamp);
      params.state.position = undefined;
      params.state.lastExitReasonByMarket[params.market] = params.reason;
      params.state.lastExitBarIndexByMarket[params.market] = params.barIndex;
      params.state.tradesToday += 1;
      params.state.lastTradeTimestamp = params.timestamp;

      if (params.pnlRatio < 0) {
        params.state.cooldownUntilByMarket[params.market] =
          params.barIndex + resolvedConfig.cooldownBarsAfterLoss;
      }
    }
  };
}
