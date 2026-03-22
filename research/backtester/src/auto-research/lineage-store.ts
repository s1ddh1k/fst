import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  calculateLineageMetrics,
  toResearchDriftMetrics,
  type AutoResearchLineageMetrics
} from "./lineage-metrics.js";
import type {
  AutoResearchRunConfig,
  CandidateBacktestEvaluation,
  ResearchLineage,
  ResearchLineageEvent,
  ResearchIterationRecord
} from "./types.js";

export const LINEAGE_EVENTS_FILE = "lineage-events.jsonl";
export const LINEAGE_SNAPSHOT_FILE = "lineage-snapshot.json";
export const RESEARCH_LINEAGE_FILE = "research-lineage.json";
export const RESEARCH_LINEAGE_EVENTS_FILE = "research-lineage-events.jsonl";
const LINEAGE_SNAPSHOT_VERSION = 1;

export type LineageEvent =
  | {
      kind: "candidate_evaluated";
      at: string;
      iteration: number;
      candidateId: string;
      familyId: string;
      strategyName: string;
      origin: string;
      parentCandidateIds: string[];
      fingerprint: string;
      thesis: string;
      parameters: Record<string, number>;
      status: CandidateBacktestEvaluation["status"];
      netReturn: number;
      tradeCount: number;
      maxDrawdown: number;
    }
  | {
      kind: "review_completed";
      at: string;
      iteration: number;
      verdict: ResearchIterationRecord["review"]["verdict"];
      promotedCandidateId?: string;
      retireCandidateIds: string[];
      nextCandidateIds: string[];
      observationCount: number;
    }
  | {
      kind: "candidate_promoted";
      at: string;
      iteration: number;
      candidateId: string;
      familyId?: string;
      reason: string;
    }
  | {
      kind: "candidate_retired";
      at: string;
      iteration: number;
      candidateId: string;
      reason: string;
    }
  | {
      kind: "snapshot_saved";
      at: string;
      latestIteration: number;
      eventCount: number;
      candidateCount: number;
      familyCount: number;
      version: number;
    };

export type LineageCandidateSnapshot = {
  candidateId: string;
  familyId: string;
  strategyName: string;
  origin: string;
  parentCandidateIds: string[];
  fingerprint: string;
  thesis: string;
  parameters: Record<string, number>;
  firstIteration: number;
  lastIteration: number;
  evaluationCount: number;
  bestNetReturn: number;
  latestNetReturn: number;
  bestTradeCount: number;
  latestTradeCount: number;
  promoted: boolean;
  promotedAtIteration?: number;
};

export type LineageFamilySnapshot = {
  familyId: string;
  candidateCount: number;
  evaluationCount: number;
  tradefulEvaluations: number;
  promotedCandidateIds: string[];
  latestIteration: number;
  bestCandidateId?: string;
  bestNetReturn: number;
  avgNetReturn: number;
  origins: Record<string, number>;
};

export type AutoResearchLineageSnapshot = {
  version: number;
  savedAt: string;
  latestIteration: number;
  eventCount: number;
  run?: Pick<
    AutoResearchRunConfig,
    "universeName" | "timeframe" | "mode" | "marketLimit" | "limit" | "holdoutDays" | "trainingDays" | "stepDays" | "iterations"
  >;
  summary: {
    candidateCount: number;
    familyCount: number;
    promotedCandidateCount: number;
  };
  metrics: AutoResearchLineageMetrics;
  candidates: LineageCandidateSnapshot[];
  families: LineageFamilySnapshot[];
};

type CandidateAccumulator = LineageCandidateSnapshot;
type FamilyAccumulator = {
  familyId: string;
  candidateIds: Set<string>;
  evaluationCount: number;
  tradefulEvaluations: number;
  promotedCandidateIds: Set<string>;
  latestIteration: number;
  bestCandidateId?: string;
  bestNetReturn: number;
  totalNetReturn: number;
  origins: Map<string, number>;
};

function roundMetric(value: number): number {
  return Number(value.toFixed(6));
}

function stableParametersKey(parameters: Record<string, number>): string {
  return JSON.stringify(
    Object.keys(parameters)
      .sort((left, right) => left.localeCompare(right))
      .reduce<Record<string, number>>((result, key) => {
        result[key] = parameters[key] ?? 0;
        return result;
      }, {})
  );
}

function candidateFingerprint(candidate: Pick<LineageCandidateSnapshot, "familyId" | "parameters">): string {
  return `${candidate.familyId}:${stableParametersKey(candidate.parameters)}`;
}

function asIsoString(value: Date | string | undefined): string {
  if (!value) {
    return new Date().toISOString();
  }

  return typeof value === "string" ? value : value.toISOString();
}

function createLineageId(): string {
  return `lineage-${Date.now()}-${process.pid}`;
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, content);
  await rename(tempPath, filePath);
}

export function buildLineageEventsFromIteration(
  iteration: ResearchIterationRecord,
  recordedAt?: string | Date
): LineageEvent[] {
  const at = asIsoString(recordedAt);
  const events: LineageEvent[] = [];
  const familyByCandidateId = new Map<string, string>();

  for (const evaluation of iteration.evaluations) {
    familyByCandidateId.set(evaluation.candidate.candidateId, evaluation.candidate.familyId);
    events.push({
      kind: "candidate_evaluated",
      at,
      iteration: iteration.iteration,
      candidateId: evaluation.candidate.candidateId,
      familyId: evaluation.candidate.familyId,
      strategyName: evaluation.candidate.strategyName,
      origin: evaluation.candidate.origin ?? "llm",
      parentCandidateIds: evaluation.candidate.parentCandidateIds ?? [],
      fingerprint: candidateFingerprint(evaluation.candidate),
      thesis: evaluation.candidate.thesis,
      parameters: evaluation.candidate.parameters,
      status: evaluation.status,
      netReturn: evaluation.summary.netReturn,
      tradeCount: evaluation.summary.tradeCount,
      maxDrawdown: evaluation.summary.maxDrawdown
    });
  }

  events.push({
    kind: "review_completed",
    at,
    iteration: iteration.iteration,
    verdict: iteration.review.verdict,
    promotedCandidateId: iteration.review.promotedCandidateId,
    retireCandidateIds: iteration.review.retireCandidateIds,
    nextCandidateIds: iteration.review.nextCandidates
      .map((candidate) => candidate.candidateId)
      .filter((candidateId): candidateId is string => Boolean(candidateId)),
    observationCount: iteration.review.observations.length
  });

  if (iteration.review.promotedCandidateId) {
    events.push({
      kind: "candidate_promoted",
      at,
      iteration: iteration.iteration,
      candidateId: iteration.review.promotedCandidateId,
      familyId: familyByCandidateId.get(iteration.review.promotedCandidateId),
      reason: "review_promoted_candidate"
    });
  }

  for (const candidateId of iteration.review.retireCandidateIds) {
    events.push({
      kind: "candidate_retired",
      at,
      iteration: iteration.iteration,
      candidateId,
      reason: "review_retired_candidate"
    });
  }

  return events;
}

export async function appendLineageEvents(
  outputDir: string,
  events: LineageEvent[],
  fileName = LINEAGE_EVENTS_FILE
): Promise<void> {
  if (events.length === 0) {
    return;
  }

  await mkdir(outputDir, { recursive: true });
  const serialized = events.map((event) => JSON.stringify(event)).join("\n");
  await appendFile(path.join(outputDir, fileName), `${serialized}\n`);
}

export async function loadLineageEvents(
  outputDir: string,
  fileName = LINEAGE_EVENTS_FILE
): Promise<LineageEvent[]> {
  try {
    const raw = await readFile(path.join(outputDir, fileName), "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as LineageEvent);
  } catch {
    return [];
  }
}

export async function appendLineageEvent(params: {
  outputDir: string;
  event: ResearchLineageEvent;
  fileName?: string;
}): Promise<void> {
  await mkdir(params.outputDir, { recursive: true });
  await appendFile(
    path.join(params.outputDir, params.fileName ?? RESEARCH_LINEAGE_EVENTS_FILE),
    `${JSON.stringify(params.event)}\n`
  );
}

export function buildLineageSnapshot(params: {
  iterations: ResearchIterationRecord[];
  config?: AutoResearchRunConfig;
  savedAt?: string | Date;
  eventCount?: number;
}): AutoResearchLineageSnapshot {
  const orderedIterations = params.iterations
    .slice()
    .sort((left, right) => left.iteration - right.iteration);
  const promotedCandidates = new Map<string, number>();
  const candidateMap = new Map<string, CandidateAccumulator>();
  const familyMap = new Map<string, FamilyAccumulator>();

  for (const iteration of orderedIterations) {
    if (iteration.review.promotedCandidateId) {
      promotedCandidates.set(iteration.review.promotedCandidateId, iteration.iteration);
    }

    for (const evaluation of iteration.evaluations) {
      const candidateId = evaluation.candidate.candidateId;
      const existingCandidate = candidateMap.get(candidateId);
      const promotedAtIteration = promotedCandidates.get(candidateId);

      if (!existingCandidate) {
        candidateMap.set(candidateId, {
          candidateId,
          familyId: evaluation.candidate.familyId,
          strategyName: evaluation.candidate.strategyName,
          origin: evaluation.candidate.origin ?? "llm",
          parentCandidateIds: evaluation.candidate.parentCandidateIds ?? [],
          fingerprint: candidateFingerprint(evaluation.candidate),
          thesis: evaluation.candidate.thesis,
          parameters: evaluation.candidate.parameters,
          firstIteration: iteration.iteration,
          lastIteration: iteration.iteration,
          evaluationCount: 1,
          bestNetReturn: evaluation.summary.netReturn,
          latestNetReturn: evaluation.summary.netReturn,
          bestTradeCount: evaluation.summary.tradeCount,
          latestTradeCount: evaluation.summary.tradeCount,
          promoted: promotedAtIteration !== undefined,
          promotedAtIteration
        });
      } else {
        existingCandidate.lastIteration = iteration.iteration;
        existingCandidate.evaluationCount += 1;
        existingCandidate.bestNetReturn = Math.max(
          existingCandidate.bestNetReturn,
          evaluation.summary.netReturn
        );
        existingCandidate.latestNetReturn = evaluation.summary.netReturn;
        existingCandidate.bestTradeCount = Math.max(
          existingCandidate.bestTradeCount,
          evaluation.summary.tradeCount
        );
        existingCandidate.latestTradeCount = evaluation.summary.tradeCount;
        if (promotedAtIteration !== undefined) {
          existingCandidate.promoted = true;
          existingCandidate.promotedAtIteration = promotedAtIteration;
        }
      }

      const existingFamily = familyMap.get(evaluation.candidate.familyId) ?? {
        familyId: evaluation.candidate.familyId,
        candidateIds: new Set<string>(),
        evaluationCount: 0,
        tradefulEvaluations: 0,
        promotedCandidateIds: new Set<string>(),
        latestIteration: 0,
        bestCandidateId: undefined,
        bestNetReturn: Number.NEGATIVE_INFINITY,
        totalNetReturn: 0,
        origins: new Map<string, number>()
      };

      existingFamily.candidateIds.add(candidateId);
      existingFamily.evaluationCount += 1;
      existingFamily.tradefulEvaluations += evaluation.summary.tradeCount > 0 ? 1 : 0;
      existingFamily.latestIteration = Math.max(existingFamily.latestIteration, iteration.iteration);
      existingFamily.totalNetReturn += evaluation.summary.netReturn;
      existingFamily.origins.set(
        evaluation.candidate.origin ?? "llm",
        (existingFamily.origins.get(evaluation.candidate.origin ?? "llm") ?? 0) + 1
      );

      if (evaluation.summary.netReturn >= existingFamily.bestNetReturn) {
        existingFamily.bestNetReturn = evaluation.summary.netReturn;
        existingFamily.bestCandidateId = candidateId;
      }

      if (promotedAtIteration !== undefined) {
        existingFamily.promotedCandidateIds.add(candidateId);
      }

      familyMap.set(evaluation.candidate.familyId, existingFamily);
    }
  }

  const candidates = Array.from(candidateMap.values()).sort((left, right) => {
    if (left.firstIteration !== right.firstIteration) {
      return left.firstIteration - right.firstIteration;
    }

    return left.candidateId.localeCompare(right.candidateId);
  });
  const families = Array.from(familyMap.values())
    .map<LineageFamilySnapshot>((family) => ({
      familyId: family.familyId,
      candidateCount: family.candidateIds.size,
      evaluationCount: family.evaluationCount,
      tradefulEvaluations: family.tradefulEvaluations,
      promotedCandidateIds: Array.from(family.promotedCandidateIds).sort((left, right) => left.localeCompare(right)),
      latestIteration: family.latestIteration,
      bestCandidateId: family.bestCandidateId,
      bestNetReturn: family.bestNetReturn === Number.NEGATIVE_INFINITY ? 0 : roundMetric(family.bestNetReturn),
      avgNetReturn: family.evaluationCount === 0 ? 0 : roundMetric(family.totalNetReturn / family.evaluationCount),
      origins: Object.fromEntries(
        Array.from(family.origins.entries()).sort(([left], [right]) => left.localeCompare(right))
      )
    }))
    .sort((left, right) => {
      if (right.bestNetReturn !== left.bestNetReturn) {
        return right.bestNetReturn - left.bestNetReturn;
      }

      return left.familyId.localeCompare(right.familyId);
    });

  const metrics = calculateLineageMetrics(orderedIterations);

  return {
    version: LINEAGE_SNAPSHOT_VERSION,
    savedAt: asIsoString(params.savedAt),
    latestIteration: orderedIterations[orderedIterations.length - 1]?.iteration ?? 0,
    eventCount: params.eventCount ?? 0,
    run: params.config
      ? {
          universeName: params.config.universeName,
          timeframe: params.config.timeframe,
          mode: params.config.mode,
          marketLimit: params.config.marketLimit,
          limit: params.config.limit,
          holdoutDays: params.config.holdoutDays,
          trainingDays: params.config.trainingDays,
          stepDays: params.config.stepDays,
          iterations: params.config.iterations
        }
      : undefined,
    summary: {
      candidateCount: candidates.length,
      familyCount: families.length,
      promotedCandidateCount: candidates.filter((candidate) => candidate.promoted).length
    },
    metrics,
    candidates,
    families
  };
}

async function saveResearchLineage(
  outputDir: string,
  lineage: ResearchLineage,
  fileName = RESEARCH_LINEAGE_FILE
): Promise<void> {
  await writeFileAtomic(path.join(outputDir, fileName), `${JSON.stringify(lineage, null, 2)}\n`);
}

async function loadResearchLineage(
  outputDir: string,
  fileName = RESEARCH_LINEAGE_FILE
): Promise<ResearchLineage | undefined> {
  try {
    const raw = await readFile(path.join(outputDir, fileName), "utf8");
    return JSON.parse(raw) as ResearchLineage;
  } catch {
    return undefined;
  }
}

export async function loadOrCreateResearchLineage(params: {
  outputDir: string;
  stage: ResearchLineage["stage"];
  objective: string;
  lineageId?: string;
}): Promise<ResearchLineage> {
  const existing = await loadResearchLineage(params.outputDir);
  if (existing) {
    return existing;
  }

  const now = new Date().toISOString();
  const lineage: ResearchLineage = {
    lineageId: params.lineageId ?? createLineageId(),
    stage: params.stage,
    objective: params.objective,
    startedAt: now,
    updatedAt: now,
    activeHypothesisIds: [],
    convergedFamilyIds: [],
    retiredHypothesisIds: [],
    drift: {
      performanceDrift: 0,
      noveltyDrift: 0,
      structureDrift: 0,
      reproducibilityDrift: 0,
      stagnationScore: 0
    }
  };
  await saveResearchLineage(params.outputDir, lineage);
  return lineage;
}

export async function updateResearchLineageFromIterations(params: {
  outputDir?: string;
  lineage: ResearchLineage;
  iterations: ResearchIterationRecord[];
  updatedAt?: string | Date;
}): Promise<ResearchLineage> {
  const orderedIterations = params.iterations
    .slice()
    .sort((left, right) => left.iteration - right.iteration);
  const latestIteration = orderedIterations[orderedIterations.length - 1];
  const promotedCandidateIds = new Set(
    orderedIterations
      .map((iteration) => iteration.review.promotedCandidateId)
      .filter((candidateId): candidateId is string => Boolean(candidateId))
  );
  const promotedFamilyIds = new Set<string>();
  const retiredHypothesisIds = new Set<string>();

  for (const iteration of orderedIterations) {
    for (const candidateId of iteration.review.retireCandidateIds) {
      retiredHypothesisIds.add(candidateId);
    }
    for (const evaluation of iteration.evaluations) {
      if (promotedCandidateIds.has(evaluation.candidate.candidateId)) {
        promotedFamilyIds.add(evaluation.candidate.familyId);
      }
    }
  }

  const metrics = calculateLineageMetrics(orderedIterations);
  const lineage: ResearchLineage = {
    ...params.lineage,
    updatedAt: asIsoString(params.updatedAt),
    activeHypothesisIds: latestIteration
      ? latestIteration.evaluations.map((evaluation) => evaluation.candidate.candidateId)
      : [],
    convergedFamilyIds: Array.from(promotedFamilyIds).sort((left, right) => left.localeCompare(right)),
    retiredHypothesisIds: Array.from(retiredHypothesisIds).sort((left, right) => left.localeCompare(right)),
    drift: toResearchDriftMetrics(metrics)
  };

  if (params.outputDir) {
    await saveResearchLineage(params.outputDir, lineage);
  }

  return lineage;
}

export async function saveLineageSnapshot(
  outputDir: string,
  snapshot: AutoResearchLineageSnapshot,
  fileName = LINEAGE_SNAPSHOT_FILE
): Promise<void> {
  await writeFileAtomic(path.join(outputDir, fileName), `${JSON.stringify(snapshot, null, 2)}\n`);
}

export async function loadLineageSnapshot(
  outputDir: string,
  fileName = LINEAGE_SNAPSHOT_FILE
): Promise<AutoResearchLineageSnapshot | undefined> {
  try {
    const raw = await readFile(path.join(outputDir, fileName), "utf8");
    return JSON.parse(raw) as AutoResearchLineageSnapshot;
  } catch {
    return undefined;
  }
}
