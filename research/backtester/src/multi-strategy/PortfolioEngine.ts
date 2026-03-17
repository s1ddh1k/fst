import type {
  AccountView,
  PositionIntent,
  PositionView,
  PortfolioDecision,
  StrategySignal,
  SleeveId
} from "../../../../packages/shared/src/index.js";
import { allocateSleeves } from "./SleeveAllocator.js";
import { resolveSignalConflicts } from "./ConflictResolver.js";
import { checkRisk, estimateIntentNotional } from "./RiskEngine.js";
import type { PortfolioEngineConfig, PortfolioEngineState } from "./types.js";

export function createDefaultPortfolioEngineConfig() {
  return {
    maxOpenPositions: 5,
    maxCapitalUsagePct: 0.95,
    cooldownBarsAfterLoss: 12,
    minBarsBetweenEntries: 1
  };
}

export function createInitialPortfolioEngineState(initialCapital: number): PortfolioEngineState {
  return {
    cash: initialCapital,
    positions: [],
    cooldownUntilByMarket: {},
    lastEntryBarByMarket: {}
  };
}

export function createPortfolioEngine(config: PortfolioEngineConfig) {
  function getEntryExecutionStyle(signal: StrategySignal): PositionIntent["executionStyle"] {
    if (signal.family === "micro") {
      return "limit_aggressive";
    }

    if (signal.family === "breakout") {
      return "limit_aggressive";
    }

    return "best_ioc";
  }

  return {
    decide(params: {
      signals: StrategySignal[];
      state: PortfolioEngineState;
      currentBarIndex: number;
      account: AccountView;
    }): PortfolioDecision {
      const allocations = allocateSleeves({
        equity: params.account.equity,
        sleeves: config.sleeves,
        positions: params.state.positions
      });
      const intents: PositionIntent[] = [];
      const blockedSignals: PortfolioDecision["blockedSignals"] = [];

      for (const signal of params.signals.filter((item) => item.signal === "SELL")) {
        const held = params.state.positions.find(
          (position) => position.market === signal.market && position.strategyId === signal.strategyId
        );

        if (!held) {
          continue;
        }

        intents.push({
          strategyId: signal.strategyId,
          sleeveId: signal.sleeveId as SleeveId,
          market: signal.market,
          action: "CLOSE",
          side: "SELL",
          targetNotional: held.quantity * held.entryPrice,
          targetQuantity: held.quantity,
          conviction: signal.conviction,
          reason: signal.reason,
          executionStyle: "best_ioc"
        });
      }

      const buySignals = params.signals.filter((item) => item.signal === "BUY");
      const riskAccepted: StrategySignal[] = [];
      for (const signal of buySignals) {
        const risk = checkRisk({
          signal,
          state: params.state,
          config,
          currentBarIndex: params.currentBarIndex,
          equity: params.account.equity
        });
        if (!risk.accepted) {
          blockedSignals.push({
            strategyId: signal.strategyId,
            market: signal.market,
            reason: risk.reason ?? "risk_reject"
          });
          continue;
        }

        riskAccepted.push(signal);
      }

      const resolved = resolveSignalConflicts({
        signals: riskAccepted,
        sleeveAllocations: allocations,
        heldMarkets: new Set(params.state.positions.map((position) => position.market)),
        maxOpenPositionsLeft: Math.max(0, config.maxOpenPositions - params.state.positions.length)
      });
      blockedSignals.push(...resolved.blocked);

      for (const signal of resolved.accepted) {
        const sleeve = allocations[signal.sleeveId];
        const notional = estimateIntentNotional({
          equity: params.account.equity,
          config,
          sleeveBudgetNotional: sleeve.remainingNotional,
          maxSinglePositionNotional: sleeve.maxSinglePositionNotional,
          signal
        });

        intents.push({
          strategyId: signal.strategyId,
          sleeveId: signal.sleeveId as SleeveId,
          market: signal.market,
          action: "OPEN",
          side: "BUY",
          targetNotional: Math.min(notional, params.state.cash),
          conviction: signal.conviction,
          reason: signal.reason,
          executionStyle: getEntryExecutionStyle(signal)
        });
      }

      return {
        ts: Date.now(),
        intents,
        blockedSignals
      };
    },

    applyFill(params: {
      fill: {
        market: string;
        side: "BUY" | "SELL";
        fillPrice?: number;
        filledQuantity?: number;
      };
      strategyId: string;
      sleeveId: string;
      fillTime: Date;
      state: PortfolioEngineState;
    }): void {
      if (
        params.fill.side === "BUY" &&
        params.fill.fillPrice !== undefined &&
        params.fill.filledQuantity !== undefined
      ) {
        params.state.positions.push({
          market: params.fill.market,
          quantity: params.fill.filledQuantity,
          entryPrice: params.fill.fillPrice,
          entryTime: params.fillTime,
          sleeveId: params.sleeveId,
          strategyId: params.strategyId,
          lastUpdateTime: params.fillTime
        });
        return;
      }

      if (params.fill.side === "SELL") {
        params.state.positions = params.state.positions.filter(
          (position) =>
            !(position.market === params.fill.market && position.strategyId === params.strategyId)
        );
      }
    }
  };
}
