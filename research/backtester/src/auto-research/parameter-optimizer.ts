/**
 * Numeric parameter optimizer for strategy families.
 *
 * Replaces LLM-driven parameter tuning with a systematic search:
 * - Phase 1 (exploration): Latin Hypercube Sampling across the full parameter space
 * - Phase 2 (exploitation): Gaussian perturbation around best-known candidates
 * - History-aware: uses previous evaluation results to guide the search
 * - Respects min/max bounds from parameterSpecs
 * - Enforces minimum distance between candidates for diversity
 */

import type {
  CandidateBacktestEvaluation,
  CandidateProposal,
  ResearchParameterSpec,
  StrategyFamilyDefinition
} from "./types.js";
import { calculateCandidateRiskAdjustedScore } from "./ranking.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OptimizerConfig = {
  /** Total candidates to generate per family */
  candidatesPerFamily: number;
  /** Fraction of budget spent on exploration vs exploitation (0–1) */
  explorationRatio: number;
  /** Minimum normalized Euclidean distance between any two candidates */
  minDistance: number;
  /** RNG seed for reproducibility (optional) */
  seed?: number;
};

const DEFAULT_CONFIG: OptimizerConfig = {
  candidatesPerFamily: 6,
  explorationRatio: 0.5,
  minDistance: 0.12,
  seed: undefined
};

// ---------------------------------------------------------------------------
// Simple seeded PRNG (xorshift32) for reproducible results
// ---------------------------------------------------------------------------

function createRng(seed?: number): () => number {
  let state = seed ?? (Date.now() ^ 0xdeadbeef);
  state = state === 0 ? 1 : state;
  return () => {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

// ---------------------------------------------------------------------------
// Latin Hypercube Sampling — generates well-distributed points
// ---------------------------------------------------------------------------

function latinHypercubeSample(
  specs: ResearchParameterSpec[],
  count: number,
  rng: () => number
): Record<string, number>[] {
  if (specs.length === 0 || count === 0) return [];

  const dim = specs.length;
  // Create shuffled intervals for each dimension
  const intervals: number[][] = [];
  for (let d = 0; d < dim; d++) {
    const perm = Array.from({ length: count }, (_, i) => i);
    // Fisher-Yates shuffle
    for (let i = perm.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [perm[i], perm[j]] = [perm[j], perm[i]];
    }
    intervals.push(perm);
  }

  const results: Record<string, number>[] = [];
  for (let i = 0; i < count; i++) {
    const params: Record<string, number> = {};
    for (let d = 0; d < dim; d++) {
      const spec = specs[d];
      const interval = intervals[d][i];
      // Random point within the interval
      const u = (interval + rng()) / count;
      params[spec.name] = spec.min + u * (spec.max - spec.min);
    }
    results.push(params);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Gaussian perturbation around a base candidate
// ---------------------------------------------------------------------------

function perturbCandidate(
  base: Record<string, number>,
  specs: ResearchParameterSpec[],
  scale: number,
  rng: () => number,
  sensitivity?: ParameterSensitivity[]
): Record<string, number> {
  const params: Record<string, number> = {};
  const importanceMap = new Map(sensitivity?.map((s) => [s.name, s.importance]) ?? []);

  for (const spec of specs) {
    const current = base[spec.name] ?? (spec.min + spec.max) / 2;
    const width = spec.max - spec.min;

    // Scale perturbation by parameter importance:
    // Important params get larger perturbations (focused search)
    // Unimportant params get smaller perturbations (less wasted variation)
    const importance = importanceMap.get(spec.name) ?? (1 / specs.length);
    const paramScale = scale * (0.5 + importance * specs.length * 0.5);

    // Box-Muller for Gaussian noise
    const u1 = Math.max(1e-10, rng());
    const u2 = rng();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);

    const noise = z * width * paramScale;
    params[spec.name] = Math.max(spec.min, Math.min(spec.max, current + noise));
  }

  return params;
}

// ---------------------------------------------------------------------------
// Normalize parameters to [0,1] for distance computation
// ---------------------------------------------------------------------------

function normalizeParams(
  params: Record<string, number>,
  specs: ResearchParameterSpec[]
): number[] {
  return specs.map((spec) => {
    const width = spec.max - spec.min;
    if (width <= 0) return 0.5;
    const val = params[spec.name] ?? (spec.min + spec.max) / 2;
    return (val - spec.min) / width;
  });
}

function euclideanDistance(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum / Math.max(a.length, 1));
}

// ---------------------------------------------------------------------------
// Parameter sensitivity analysis — identifies which params matter most
// ---------------------------------------------------------------------------

export type ParameterSensitivity = {
  name: string;
  correlation: number;
  importance: number;
};

/**
 * Compute Spearman-like rank correlation between each parameter and score.
 * Returns parameters sorted by absolute correlation (most important first).
 */
export function analyzeParameterSensitivity(
  evaluations: CandidateBacktestEvaluation[],
  familyId: string,
  specs: ResearchParameterSpec[]
): ParameterSensitivity[] {
  const familyEvals = evaluations.filter(
    (e) => e.candidate.familyId === familyId && e.status === "completed"
  );

  if (familyEvals.length < 4 || specs.length === 0) {
    return specs.map((s) => ({ name: s.name, correlation: 0, importance: 1 / specs.length }));
  }

  const scores = familyEvals.map((e) => calculateCandidateRiskAdjustedScore(e));
  const results: ParameterSensitivity[] = [];

  for (const spec of specs) {
    const values = familyEvals.map((e) => e.candidate.parameters[spec.name] ?? 0);
    const corr = rankCorrelation(values, scores);
    results.push({ name: spec.name, correlation: corr, importance: 0 });
  }

  // Normalize importance as relative absolute correlation
  const totalAbsCorr = results.reduce((s, r) => s + Math.abs(r.correlation), 0);
  if (totalAbsCorr > 0) {
    for (const r of results) {
      r.importance = Math.abs(r.correlation) / totalAbsCorr;
    }
  } else {
    for (const r of results) {
      r.importance = 1 / results.length;
    }
  }

  return results.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));
}

function rankCorrelation(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 3) return 0;

  const rankX = toRanks(x);
  const rankY = toRanks(y);

  let sumD2 = 0;
  for (let i = 0; i < n; i++) {
    const d = rankX[i] - rankY[i];
    sumD2 += d * d;
  }

  return 1 - (6 * sumD2) / (n * (n * n - 1));
}

function toRanks(values: number[]): number[] {
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(values.length);
  for (let i = 0; i < indexed.length; i++) {
    ranks[indexed[i].i] = i + 1;
  }
  return ranks;
}

// ---------------------------------------------------------------------------
// Select top-K evaluations as exploitation centers
// ---------------------------------------------------------------------------

function selectExploitationCenters(
  evaluations: CandidateBacktestEvaluation[],
  familyId: string,
  topK: number
): Record<string, number>[] {
  const familyEvals = evaluations
    .filter((e) => e.candidate.familyId === familyId && e.status === "completed")
    .map((e) => ({
      params: e.candidate.parameters,
      score: calculateCandidateRiskAdjustedScore(e)
    }))
    .sort((a, b) => b.score - a.score);

  return familyEvals.slice(0, topK).map((e) => e.params);
}

// ---------------------------------------------------------------------------
// Deduplicate against history — don't re-explore tested regions
// ---------------------------------------------------------------------------

function isNovelCandidate(
  params: Record<string, number>,
  existingParams: Record<string, number>[],
  specs: ResearchParameterSpec[],
  minDistance: number
): boolean {
  const normalized = normalizeParams(params, specs);
  for (const existing of existingParams) {
    const existingNormalized = normalizeParams(existing, specs);
    if (euclideanDistance(normalized, existingNormalized) < minDistance) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Main optimizer entry point
// ---------------------------------------------------------------------------

export function generateOptimizedCandidates(params: {
  family: StrategyFamilyDefinition;
  previousEvaluations: CandidateBacktestEvaluation[];
  iteration: number;
  config?: Partial<OptimizerConfig>;
}): CandidateProposal[] {
  const { family, previousEvaluations, iteration } = params;
  const config = { ...DEFAULT_CONFIG, ...params.config };
  const rng = createRng(config.seed !== undefined ? config.seed + iteration : undefined);
  const specs = family.parameterSpecs;

  if (specs.length === 0) return [];

  const totalBudget = config.candidatesPerFamily;
  const familyHistory = previousEvaluations.filter(
    (e) => e.candidate.familyId === family.familyId
  );
  const historicalParams = familyHistory.map((e) => e.candidate.parameters);

  // Adaptive exploration ratio: explore more early, exploit more as history accumulates
  const historyWeight = Math.min(familyHistory.length / 20, 1);
  const effectiveExplorationRatio = config.explorationRatio * (1 - historyWeight * 0.6);
  const explorationCount = Math.max(1, Math.round(totalBudget * effectiveExplorationRatio));
  const exploitationCount = totalBudget - explorationCount;

  const candidates: CandidateProposal[] = [];
  const usedParams: Record<string, number>[] = [...historicalParams];

  // Phase 1: Exploration via Latin Hypercube Sampling
  const lhsSamples = latinHypercubeSample(specs, explorationCount * 3, rng);
  let explorationAdded = 0;

  for (const sample of lhsSamples) {
    if (explorationAdded >= explorationCount) break;
    if (!isNovelCandidate(sample, usedParams, specs, config.minDistance)) continue;

    candidates.push({
      familyId: family.familyId,
      thesis: `Systematic exploration — LHS sample ${explorationAdded + 1}/${explorationCount}`,
      parameters: roundParameters(sample, specs),
      invalidationSignals: [],
      origin: "engine_seed" as const
    });
    usedParams.push(sample);
    explorationAdded++;
  }

  // Phase 2: Exploitation — perturb around best known candidates
  // Use sensitivity analysis to focus perturbation on parameters that matter
  const sensitivity = familyHistory.length >= 4
    ? analyzeParameterSensitivity(previousEvaluations, family.familyId, specs)
    : undefined;

  if (exploitationCount > 0 && familyHistory.length > 0) {
    const centers = selectExploitationCenters(previousEvaluations, family.familyId, 3);

    if (centers.length > 0) {
      // Adaptive scale: shrink as iterations progress
      const scale = Math.max(0.03, 0.15 * Math.pow(0.92, iteration));
      const attemptsPerCenter = Math.ceil((exploitationCount * 4) / centers.length);
      let exploitationAdded = 0;

      for (const center of centers) {
        if (exploitationAdded >= exploitationCount) break;

        for (let attempt = 0; attempt < attemptsPerCenter; attempt++) {
          if (exploitationAdded >= exploitationCount) break;

          const perturbed = perturbCandidate(center, specs, scale, rng, sensitivity);
          if (!isNovelCandidate(perturbed, usedParams, specs, config.minDistance)) continue;

          candidates.push({
            familyId: family.familyId,
            thesis: `Exploitation — perturbation around top candidate (scale=${scale.toFixed(3)})`,
            parameters: roundParameters(perturbed, specs),
            invalidationSignals: [],
            origin: "engine_mutation" as const,
            parentCandidateIds: familyHistory
              .filter((e) => e.candidate.parameters === center)
              .map((e) => e.candidate.candidateId)
              .slice(0, 1)
          });
          usedParams.push(perturbed);
          exploitationAdded++;
        }
      }

      // Fill remaining with wider perturbations if exploitation didn't fill
      const remaining = exploitationCount - exploitationAdded;
      if (remaining > 0) {
        const wideSamples = latinHypercubeSample(specs, remaining * 3, rng);
        let fillAdded = 0;
        for (const sample of wideSamples) {
          if (fillAdded >= remaining) break;
          if (!isNovelCandidate(sample, usedParams, specs, config.minDistance)) continue;
          candidates.push({
            familyId: family.familyId,
            thesis: `Exploration fill — covering unexplored regions`,
            parameters: roundParameters(sample, specs),
            invalidationSignals: [],
            origin: "engine_seed" as const
          });
          usedParams.push(sample);
          fillAdded++;
        }
      }
    }
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Round parameters to sensible precision based on their range
// ---------------------------------------------------------------------------

function roundParameters(
  params: Record<string, number>,
  specs: ResearchParameterSpec[]
): Record<string, number> {
  const result: Record<string, number> = {};

  for (const spec of specs) {
    const value = params[spec.name];
    if (value === undefined) continue;

    const width = spec.max - spec.min;
    // Use integer rounding for params where min/max are integers and range >= 4
    if (Number.isInteger(spec.min) && Number.isInteger(spec.max) && width >= 4) {
      result[spec.name] = Math.round(Math.max(spec.min, Math.min(spec.max, value)));
    } else {
      // Round to 4 significant digits within the range
      const precision = Math.max(1, Math.ceil(-Math.log10(width)) + 3);
      const factor = Math.pow(10, precision);
      result[spec.name] = Math.max(
        spec.min,
        Math.min(spec.max, Math.round(value * factor) / factor)
      );
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Convenience: generate candidates for multiple families at once
// ---------------------------------------------------------------------------

export function generateOptimizedCandidatesForFamilies(params: {
  families: StrategyFamilyDefinition[];
  previousEvaluations: CandidateBacktestEvaluation[];
  iteration: number;
  totalBudget: number;
  config?: Partial<OptimizerConfig>;
}): CandidateProposal[] {
  const { families, previousEvaluations, iteration, totalBudget } = params;

  if (families.length === 0) return [];

  // Distribute budget across families, giving more to promising ones
  const familyScores = families.map((family) => {
    const evals = previousEvaluations.filter(
      (e) => e.candidate.familyId === family.familyId && e.status === "completed"
    );
    if (evals.length === 0) return { family, score: 0, budget: 0 };

    const bestScore = Math.max(
      ...evals.map((e) => calculateCandidateRiskAdjustedScore(e))
    );
    return { family, score: bestScore, budget: 0 };
  });

  // Sort: unevaluated families first (explore), then by score (exploit best)
  familyScores.sort((a, b) => {
    const aEvaluated = previousEvaluations.some((e) => e.candidate.familyId === a.family.familyId);
    const bEvaluated = previousEvaluations.some((e) => e.candidate.familyId === b.family.familyId);
    if (!aEvaluated && bEvaluated) return -1;
    if (aEvaluated && !bEvaluated) return 1;
    return b.score - a.score;
  });

  // Allocate budget: at least 1 per family, rest proportional to rank
  const perFamily = Math.max(1, Math.floor(totalBudget / families.length));
  const remaining = totalBudget - perFamily * families.length;

  for (let i = 0; i < familyScores.length; i++) {
    familyScores[i].budget = perFamily + (i < remaining ? 1 : 0);
  }

  const allCandidates: CandidateProposal[] = [];
  for (const { family, budget } of familyScores) {
    if (budget <= 0) continue;
    const candidates = generateOptimizedCandidates({
      family,
      previousEvaluations,
      iteration,
      config: { ...params.config, candidatesPerFamily: budget }
    });
    allCandidates.push(...candidates);
  }

  return allCandidates;
}
