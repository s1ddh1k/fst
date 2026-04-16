import type { PositionView, StrategySignal } from "../../../../packages/shared/src/index.js";
import type { PortfolioEngineConfig, PortfolioEngineState, RiskCheck } from "./types.js";

export function checkRisk(params: {
  signal: StrategySignal;
  state: PortfolioEngineState;
  config: PortfolioEngineConfig;
  currentBarIndex: number;
  equity: number;
}): RiskCheck {
  if (params.signal.signal !== "BUY") {
    return { accepted: true };
  }

  const cooldownUntil = params.state.cooldownUntilByMarket[params.signal.market] ?? Number.NEGATIVE_INFINITY;
  if (params.currentBarIndex < cooldownUntil) {
    return { accepted: false, reason: "cooldown" };
  }

  const lastEntryBar = params.state.lastEntryBarByMarket[params.signal.market];
  if (
    lastEntryBar !== undefined &&
    params.currentBarIndex - lastEntryBar < params.config.minBarsBetweenEntries
  ) {
    return { accepted: false, reason: "reentry_guard" };
  }

  const inUse = params.equity - params.state.cash;
  if (params.equity > 0 && inUse / params.equity >= params.config.maxCapitalUsagePct) {
    return { accepted: false, reason: "capital_usage_limit" };
  }

  return { accepted: true };
}

export function applyExitRiskState(params: {
  state: PortfolioEngineState;
  position: PositionView;
  currentBarIndex: number;
  pnlRatio: number;
  config: PortfolioEngineConfig;
}): void {
  if (params.pnlRatio < 0) {
    params.state.cooldownUntilByMarket[params.position.market] =
      params.currentBarIndex + params.config.cooldownBarsAfterLoss;
  }
}

export function estimateIntentNotional(params: {
  equity: number;
  config: PortfolioEngineConfig;
  sleeveBudgetNotional: number;
  maxSinglePositionNotional: number;
  signal: StrategySignal;
}): number {
  const convictionWeight = 0.25 + params.signal.conviction * 0.75;
  // Size each position as equity / maxOpenPositions, scaled by conviction.
  // This ensures capital is utilized when few positions are open.
  const positionBudget = params.equity * params.config.maxCapitalUsagePct / Math.max(1, params.config.maxOpenPositions);
  return Math.max(
    0,
    Math.min(
      params.maxSinglePositionNotional,
      params.sleeveBudgetNotional,
      positionBudget * convictionWeight
    )
  );
}
