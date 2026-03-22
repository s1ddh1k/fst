import type { StrategySleeveConfig } from "../../../../packages/shared/src/index.js";
import type { PositionView } from "../../../../packages/shared/src/index.js";
import type { SleeveAllocation } from "./types.js";

export function allocateSleeves(params: {
  equity: number;
  sleeves: StrategySleeveConfig[];
  positions: PositionView[];
}): Record<string, SleeveAllocation> {
  const allocations: Record<string, SleeveAllocation> = {};
  const inUseBySleeve: Record<string, number> = {};

  for (const position of params.positions) {
    inUseBySleeve[position.sleeveId] =
      (inUseBySleeve[position.sleeveId] ?? 0) + position.quantity * position.entryPrice;
  }

  for (const sleeve of params.sleeves) {
    const budgetNotional = params.equity * sleeve.capitalBudgetPct;
    const inUse = inUseBySleeve[sleeve.sleeveId] ?? 0;

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
