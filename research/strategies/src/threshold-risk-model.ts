import type {
  RiskModel,
  StrategyContext
} from "./types.js";

export type StrategyGate = {
  name: string;
  test: (context: StrategyContext) => boolean;
};

function passesAll(gates: StrategyGate[], context: StrategyContext): boolean {
  return gates.every((gate) => gate.test(context));
}

function hitsAny(gates: StrategyGate[], context: StrategyContext): boolean {
  return gates.some((gate) => gate.test(context));
}

export function createThresholdRiskModel(params: {
  name: string;
  filterRules?: StrategyGate[];
  riskExitRules?: StrategyGate[];
  entryThreshold: number;
  exitThreshold: number;
  entryMinFactors?: number;
  exitMinFactors?: number;
  stopLossPct?: number;
  maxHoldBars?: number;
}): RiskModel {
  const filterRules = params.filterRules ?? [];
  const riskExitRules = params.riskExitRules ?? [];
  const entryMinFactors = params.entryMinFactors ?? 1;
  const exitMinFactors = params.exitMinFactors ?? 1;

  return {
    name: params.name,
    decide({ context, alpha }) {
      if (!context.hasPosition) {
        if (!passesAll(filterRules, context)) {
          return {
            signal: "HOLD",
            reason: "entry_filter_blocked"
          };
        }

        if (
          alpha.entryScore !== null &&
          alpha.entryMatchedFactors >= entryMinFactors &&
          alpha.entryScore >= params.entryThreshold
        ) {
          return {
            signal: "BUY",
            reason: "alpha_entry_threshold"
          };
        }

        return {
          signal: "HOLD",
          reason: "entry_threshold_not_met"
        };
      }

      const currentPrice = context.candles[context.index]?.closePrice ?? 0;

      if (context.currentPosition && params.stopLossPct !== undefined) {
        const stopPrice = context.currentPosition.entryPrice * (1 - params.stopLossPct);

        if (currentPrice <= stopPrice) {
          return {
            signal: "SELL",
            reason: "stop_loss"
          };
        }
      }

      if (
        context.currentPosition &&
        params.maxHoldBars !== undefined &&
        context.currentPosition.barsHeld >= params.maxHoldBars
      ) {
        return {
          signal: "SELL",
          reason: "max_hold_bars"
        };
      }

      if (hitsAny(riskExitRules, context)) {
        return {
          signal: "SELL",
          reason: "risk_exit_rule"
        };
      }

      if (
        alpha.exitScore !== null &&
        alpha.exitMatchedFactors >= exitMinFactors &&
        alpha.exitScore >= params.exitThreshold
      ) {
        return {
          signal: "SELL",
          reason: "alpha_exit_threshold"
        };
      }

      return {
        signal: "HOLD",
        reason: "hold"
      };
    }
  };
}
