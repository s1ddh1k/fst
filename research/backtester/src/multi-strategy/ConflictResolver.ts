import type { BlockedSignal, StrategySignal } from "../../../../packages/shared/src/index.js";
import type { SleeveAllocation } from "./types.js";

function scoreSignal(signal: StrategySignal, sleeve: SleeveAllocation): number {
  const liquidity = Number(signal.metadata?.liquidityScore ?? 0);
  const costPenalty = Number(signal.metadata?.costPenalty ?? 0);
  const priorityScore = Math.max(0, Math.min(1, sleeve.priority / 10));

  return 0.6 * signal.conviction + 0.15 * priorityScore + 0.15 * liquidity - 0.1 * costPenalty;
}

export function resolveSignalConflicts(params: {
  signals: StrategySignal[];
  sleeveAllocations: Record<string, SleeveAllocation>;
  heldMarkets: Set<string>;
  maxOpenPositionsLeft: number;
}): { accepted: StrategySignal[]; blocked: BlockedSignal[] } {
  const blocked: BlockedSignal[] = [];
  const candidates = params.signals
    .filter((signal) => signal.signal === "BUY")
    .slice()
    .sort((left, right) => {
      const leftSleeve = params.sleeveAllocations[left.sleeveId];
      const rightSleeve = params.sleeveAllocations[right.sleeveId];
      return scoreSignal(right, rightSleeve) - scoreSignal(left, leftSleeve);
    });

  const accepted: StrategySignal[] = [];
  const occupiedMarkets = new Set(params.heldMarkets);

  for (const signal of candidates) {
    const sleeve = params.sleeveAllocations[signal.sleeveId];
    if (!sleeve) {
      blocked.push({ strategyId: signal.strategyId, market: signal.market, reason: "unknown_sleeve" });
      continue;
    }

    if (accepted.length >= params.maxOpenPositionsLeft) {
      blocked.push({ strategyId: signal.strategyId, market: signal.market, reason: "max_open_positions" });
      continue;
    }

    if (occupiedMarkets.has(signal.market)) {
      blocked.push({ strategyId: signal.strategyId, market: signal.market, reason: "duplicate_market" });
      continue;
    }

    const acceptedInSleeve = accepted.filter((item) => item.sleeveId === signal.sleeveId).length;
    if (acceptedInSleeve >= sleeve.maxOpenPositions) {
      blocked.push({ strategyId: signal.strategyId, market: signal.market, reason: "sleeve_capacity" });
      continue;
    }

    if (sleeve.remainingNotional <= 0) {
      blocked.push({ strategyId: signal.strategyId, market: signal.market, reason: "sleeve_budget" });
      continue;
    }

    accepted.push(signal);
    occupiedMarkets.add(signal.market);
  }

  return { accepted, blocked };
}
