import { calculateCandidateRiskAdjustedScore, compareCandidateEvaluations } from "./ranking.js";
import type {
  CandidateBacktestEvaluation,
  ResearchDriftMetrics,
  ResearchIterationRecord
} from "./types.js";

const STAGNATION_EPSILON = 1e-9;

export type LineageIterationSummary = {
  iteration: number;
  candidateCount: number;
  completedCount: number;
  failedCount: number;
  tradefulCount: number;
  familyIds: string[];
  bestCandidateId?: string;
  bestFamilyId?: string;
  bestNetReturn: number;
  avgNetReturn: number;
  avgRiskAdjustedScore: number;
  familyTurnoverFromPrevious?: number;
  bestParameterDriftFromPrevious?: number;
  stagnationStreak: number;
};

export type AutoResearchLineageMetrics = {
  iterationCount: number;
  evaluatedCandidateCount: number;
  completedEvaluationCount: number;
  failedEvaluationCount: number;
  uniqueCandidateCount: number;
  uniqueFamilyCount: number;
  tradefulIterationCount: number;
  noTradeIterationCount: number;
  stagnantIterationCount: number;
  currentStagnationStreak: number;
  longestStagnationStreak: number;
  bestNetReturn: number;
  bestNetReturnDrift: number;
  averageNetReturnDrift: number;
  latestFamilyTurnover: number;
  averageFamilyTurnover: number;
  latestBestParameterDrift: number;
  averageBestParameterDrift: number;
  iterationSummaries: LineageIterationSummary[];
};

type CandidateShape = Pick<CandidateBacktestEvaluation["candidate"], "familyId" | "parameters">;

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function roundMetric(value: number): number {
  return Number(value.toFixed(6));
}

function selectBestEvaluation(
  evaluations: CandidateBacktestEvaluation[]
): CandidateBacktestEvaluation | undefined {
  const ranked = evaluations.slice().sort(compareCandidateEvaluations);
  return ranked[0];
}

export function calculateFamilyTurnover(previousFamilies: string[], nextFamilies: string[]): number {
  const previous = new Set(previousFamilies);
  const next = new Set(nextFamilies);
  const union = new Set([...previous, ...next]);

  if (union.size === 0) {
    return 0;
  }

  let overlap = 0;
  for (const familyId of previous) {
    if (next.has(familyId)) {
      overlap += 1;
    }
  }

  return roundMetric(1 - overlap / union.size);
}

export function calculateCandidateParameterDrift(
  previous: CandidateShape | undefined,
  next: CandidateShape | undefined
): number {
  if (!previous && !next) {
    return 0;
  }

  if (!previous || !next) {
    return 1;
  }

  if (previous.familyId !== next.familyId) {
    return 1;
  }

  const keys = new Set([
    ...Object.keys(previous.parameters ?? {}),
    ...Object.keys(next.parameters ?? {})
  ]);

  if (keys.size === 0) {
    return 0;
  }

  let total = 0;
  for (const key of keys) {
    const previousValue = previous.parameters[key] ?? 0;
    const nextValue = next.parameters[key] ?? 0;
    total += Math.abs(nextValue - previousValue) / Math.max(Math.abs(previousValue), 1);
  }

  return roundMetric(total / keys.size);
}

export function calculateLineageMetrics(
  iterations: ResearchIterationRecord[]
): AutoResearchLineageMetrics {
  const orderedIterations = iterations
    .slice()
    .sort((left, right) => left.iteration - right.iteration);
  const uniqueCandidateIds = new Set<string>();
  const uniqueFamilies = new Set<string>();
  const bestNetReturns: number[] = [];
  const avgNetReturns: number[] = [];
  const familyTurnovers: number[] = [];
  const parameterDrifts: number[] = [];
  const iterationSummaries: LineageIterationSummary[] = [];

  let evaluatedCandidateCount = 0;
  let completedEvaluationCount = 0;
  let failedEvaluationCount = 0;
  let tradefulIterationCount = 0;
  let noTradeIterationCount = 0;
  let stagnantIterationCount = 0;
  let currentStagnationStreak = 0;
  let longestStagnationStreak = 0;
  let runningBestNetReturn = Number.NEGATIVE_INFINITY;
  let previousFamilyIds: string[] | undefined;
  let previousBestEvaluation: CandidateBacktestEvaluation | undefined;

  for (const iteration of orderedIterations) {
    evaluatedCandidateCount += iteration.evaluations.length;
    const completed = iteration.evaluations.filter((evaluation) => evaluation.status === "completed");
    const tradefulCount = completed.filter((evaluation) => evaluation.summary.tradeCount > 0).length;
    const familyIds = Array.from(
      new Set(iteration.evaluations.map((evaluation) => evaluation.candidate.familyId))
    ).sort((left, right) => left.localeCompare(right));
    const bestEvaluation = selectBestEvaluation(iteration.evaluations);
    const bestNetReturn = bestEvaluation?.summary.netReturn ?? 0;
    const avgNetReturn = completed.length === 0
      ? 0
      : completed.reduce((sum, evaluation) => sum + evaluation.summary.netReturn, 0) / completed.length;
    const avgRiskAdjustedScore = completed.length === 0
      ? 0
      : average(completed.map((evaluation) => calculateCandidateRiskAdjustedScore(evaluation)));

    for (const evaluation of iteration.evaluations) {
      uniqueCandidateIds.add(evaluation.candidate.candidateId);
      uniqueFamilies.add(evaluation.candidate.familyId);
      if (evaluation.status === "completed") {
        completedEvaluationCount += 1;
      } else {
        failedEvaluationCount += 1;
      }
    }

    if (tradefulCount > 0) {
      tradefulIterationCount += 1;
    } else {
      noTradeIterationCount += 1;
    }

    let stagnationStreak = 0;
    if (iterationSummaries.length > 0 && bestNetReturn <= runningBestNetReturn + STAGNATION_EPSILON) {
      stagnantIterationCount += 1;
      currentStagnationStreak += 1;
      longestStagnationStreak = Math.max(longestStagnationStreak, currentStagnationStreak);
      stagnationStreak = currentStagnationStreak;
    } else {
      currentStagnationStreak = 0;
      runningBestNetReturn = Math.max(runningBestNetReturn, bestNetReturn);
    }

    const familyTurnoverFromPrevious = previousFamilyIds
      ? calculateFamilyTurnover(previousFamilyIds, familyIds)
      : undefined;
    if (familyTurnoverFromPrevious !== undefined) {
      familyTurnovers.push(familyTurnoverFromPrevious);
    }

    const bestParameterDriftFromPrevious = previousBestEvaluation
      ? calculateCandidateParameterDrift(previousBestEvaluation.candidate, bestEvaluation?.candidate)
      : undefined;
    if (bestParameterDriftFromPrevious !== undefined) {
      parameterDrifts.push(bestParameterDriftFromPrevious);
    }

    iterationSummaries.push({
      iteration: iteration.iteration,
      candidateCount: iteration.evaluations.length,
      completedCount: completed.length,
      failedCount: iteration.evaluations.length - completed.length,
      tradefulCount,
      familyIds,
      bestCandidateId: bestEvaluation?.candidate.candidateId,
      bestFamilyId: bestEvaluation?.candidate.familyId,
      bestNetReturn: roundMetric(bestNetReturn),
      avgNetReturn: roundMetric(avgNetReturn),
      avgRiskAdjustedScore: roundMetric(avgRiskAdjustedScore),
      familyTurnoverFromPrevious,
      bestParameterDriftFromPrevious,
      stagnationStreak
    });

    bestNetReturns.push(bestNetReturn);
    avgNetReturns.push(avgNetReturn);
    previousFamilyIds = familyIds;
    previousBestEvaluation = bestEvaluation;
  }

  const firstBestNetReturn = iterationSummaries[0]?.bestNetReturn ?? 0;
  const latestBestNetReturn = iterationSummaries[iterationSummaries.length - 1]?.bestNetReturn ?? 0;
  const firstAvgNetReturn = iterationSummaries[0]?.avgNetReturn ?? 0;
  const latestAvgNetReturn = iterationSummaries[iterationSummaries.length - 1]?.avgNetReturn ?? 0;

  return {
    iterationCount: orderedIterations.length,
    evaluatedCandidateCount,
    completedEvaluationCount,
    failedEvaluationCount,
    uniqueCandidateCount: uniqueCandidateIds.size,
    uniqueFamilyCount: uniqueFamilies.size,
    tradefulIterationCount,
    noTradeIterationCount,
    stagnantIterationCount,
    currentStagnationStreak,
    longestStagnationStreak,
    bestNetReturn: roundMetric(bestNetReturns.length === 0 ? 0 : Math.max(...bestNetReturns)),
    bestNetReturnDrift: roundMetric(latestBestNetReturn - firstBestNetReturn),
    averageNetReturnDrift: roundMetric(latestAvgNetReturn - firstAvgNetReturn),
    latestFamilyTurnover: familyTurnovers[familyTurnovers.length - 1] ?? 0,
    averageFamilyTurnover: roundMetric(average(familyTurnovers)),
    latestBestParameterDrift: parameterDrifts[parameterDrifts.length - 1] ?? 0,
    averageBestParameterDrift: roundMetric(average(parameterDrifts)),
    iterationSummaries
  };
}

export function toResearchDriftMetrics(
  metrics: AutoResearchLineageMetrics
): ResearchDriftMetrics {
  return {
    performanceDrift: roundMetric(metrics.bestNetReturnDrift),
    noveltyDrift: roundMetric(metrics.averageFamilyTurnover),
    structureDrift: roundMetric(metrics.averageBestParameterDrift),
    reproducibilityDrift: roundMetric(metrics.averageNetReturnDrift),
    stagnationScore: roundMetric(
      metrics.iterationCount <= 1
        ? 0
        : metrics.currentStagnationStreak / Math.max(metrics.iterationCount - 1, 1)
    )
  };
}

/**
 * Detect overall research convergence from drift metrics.
 * Returns true when the research is no longer making meaningful progress:
 * - High stagnation (70%+ of iterations show no improvement)
 * - Low novelty (families barely changing)
 * - Performance drift near zero or negative
 */
export function isResearchConverged(drift: ResearchDriftMetrics): boolean {
  return (
    drift.stagnationScore > 0.7 &&
    drift.noveltyDrift < 0.1 &&
    Math.abs(drift.performanceDrift) < 0.01
  );
}
