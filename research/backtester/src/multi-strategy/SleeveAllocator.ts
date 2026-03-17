import type { StrategySleeveConfig } from "../../../../packages/shared/src/index.js";
import type { PositionView } from "../../../../packages/shared/src/index.js";
import type { SleeveAllocation } from "./types.js";

export function allocateSleeves(params: {
  equity: number;
  sleeves: StrategySleeveConfig[];
  positions: PositionView[];
}): Record<string, SleeveAllocation> {
  const allocations: Record<string, SleeveAllocation> = {};

  for (const sleeve of params.sleeves) {
    const budgetNotional = params.equity * sleeve.capitalBudgetPct;
    const inUse = params.positions
      .filter((position) => position.sleeveId === sleeve.sleeveId)
      .reduce((sum, position) => sum + position.quantity * position.entryPrice, 0);

    allocations[sleeve.sleeveId] = {
      sleeveId: sleeve.sleeveId,
      budgetNotional,
      remainingNotional: Math.max(0, budgetNotional - inUse),
      maxOpenPositions: sleeve.maxOpenPositions,
      maxSinglePositionNotional: budgetNotional * sleeve.maxSinglePositionPct,
      priority: sleeve.priority
    };
  }

  return allocations;
}
