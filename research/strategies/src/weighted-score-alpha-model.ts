import type {
  AlphaModel,
  AlphaSnapshot,
  StrategyContext
} from "./types.js";

export type WeightedScoreFactor = {
  name: string;
  weight: number;
  evaluate: (context: StrategyContext) => number | null;
};

type CompositeScore = {
  score: number;
  matchedFactors: number;
  activeFactors: string[];
};

function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(-1, Math.min(1, value));
}

function evaluateCompositeScore(
  factors: WeightedScoreFactor[],
  context: StrategyContext
): CompositeScore | null {
  let weightedTotal = 0;
  let totalWeight = 0;
  let matchedFactors = 0;
  const activeFactors: string[] = [];

  for (const factor of factors) {
    const rawValue = factor.evaluate(context);

    if (rawValue === null || !Number.isFinite(rawValue) || factor.weight <= 0) {
      continue;
    }

    weightedTotal += clampScore(rawValue) * factor.weight;
    totalWeight += factor.weight;
    matchedFactors += 1;
    activeFactors.push(factor.name);
  }

  if (totalWeight === 0 || matchedFactors === 0) {
    return null;
  }

  return {
    score: weightedTotal / totalWeight,
    matchedFactors,
    activeFactors
  };
}

function toAlphaSnapshot(params: {
  entryScore: CompositeScore | null;
  exitScore: CompositeScore | null;
}): AlphaSnapshot {
  return {
    entryScore: params.entryScore?.score ?? null,
    exitScore: params.exitScore?.score ?? null,
    entryMatchedFactors: params.entryScore?.matchedFactors ?? 0,
    exitMatchedFactors: params.exitScore?.matchedFactors ?? 0,
    diagnostics: {
      entryFactors: params.entryScore?.activeFactors ?? [],
      exitFactors: params.exitScore?.activeFactors ?? []
    }
  };
}

export function createWeightedScoreAlphaModel(params: {
  name: string;
  entryFactors: WeightedScoreFactor[];
  exitFactors: WeightedScoreFactor[];
}): AlphaModel {
  return {
    name: params.name,
    evaluate(context) {
      return toAlphaSnapshot({
        entryScore: evaluateCompositeScore(params.entryFactors, context),
        exitScore: evaluateCompositeScore(params.exitFactors, context)
      });
    }
  };
}
