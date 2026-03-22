import path from "node:path";
import { readFile } from "node:fs/promises";
import {
  getStrategyFamilies,
  normalizeCandidateProposal
} from "./catalog.js";
import { compareCandidateEvaluations } from "./ranking.js";
import { MULTI_TF_REGIME_SWITCH_PORTFOLIO } from "./portfolio-runtime.js";
import type {
  AutoResearchRunConfig,
  CandidateBacktestEvaluation,
  CandidateProposal,
  CodeMutationTask,
  ExperimentPlan,
  NormalizedCandidateProposal,
  ProposalBatch,
  ProposedStrategyFamily,
  ResearchHypothesis,
  ResearchIterationRecord,
  ResearchPreparationAction,
  StrategyFamilyDefinition
} from "./types.js";

export const DEFAULT_EXPERIMENT_CANDIDATE_DIVERSIFICATION_MIN_DISTANCE = 0.08;

export const SCREEN_FAMILY_TO_CONFIRM_FAMILY = new Map<string, string>([
  ["multi-tf-regime-switch-screen", "multi-tf-regime-switch"],
  ["multi-tf-trend-burst", "multi-tf-regime-switch"],
  ["multi-tf-defensive-reclaim", "multi-tf-regime-switch"]
]);

export const REGIME_SWITCH_CONFIRM_DEFAULT_PARAMETERS: Record<string, number> = {
  microLookbackBars: 10,
  microExtensionThreshold: 0.003,
  microHoldingBarsMax: 8,
  microStopAtrMult: 1.05,
  microMinVolumeSpike: 0.95,
  microMinRiskOnScore: 0.01,
  microMinLiquidityScore: 0.03,
  microProfitTarget: 0.004,
  microMinRiskOnGate: 0.01,
  microMinLiquidityGate: 0.03,
  microMinVolatilityGate: 0.008
};

export type ArtifactSeedSnapshot = {
  candidateId?: string;
  familyId: string;
  parameters: Record<string, number>;
  netReturn?: number;
  maxDrawdown?: number;
  tradeCount?: number;
  positiveWindowRatio?: number;
  score?: number;
  sourcePath: string;
};

export type ExperimentCandidateHint = {
  candidateId?: string;
  familyId: string;
  thesis?: string;
  parameters?: Record<string, number>;
  invalidationSignals?: string[];
  parentCandidateIds?: string[];
  origin?: CandidateProposal["origin"];
};

export type ExperimentHintBatch = {
  researchSummary?: string;
  preparation?: ResearchPreparationAction[];
  proposedFamilies?: ProposedStrategyFamily[];
  codeTasks?: CodeMutationTask[];
  hints: ExperimentCandidateHint[];
};

export type CompiledExperimentPlan = {
  sourceProposal: ProposalBatch;
  augmentedProposal: ProposalBatch;
  engineCandidates: CandidateProposal[];
  artifactSeedCandidates: CandidateProposal[];
  baseCandidates: NormalizedCandidateProposal[];
  novelCandidates: NormalizedCandidateProposal[];
  compiledCandidates: NormalizedCandidateProposal[];
  evaluationCandidates: NormalizedCandidateProposal[];
  stats: {
    sourceCandidateCount: number;
    artifactSeedCount: number;
    engineMutationCount: number;
    engineSeedCount: number;
    baseCandidateCount: number;
    novelCandidateCount: number;
    compiledCandidateCount: number;
    evaluationCandidateCount: number;
  };
};

type ExperimentCompilationSource = ProposalBatch | ExperimentHintBatch | ExperimentCandidateHint[];

function quantize(value: number): number {
  return Number(value.toFixed(4));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function compareEvaluations(
  left: CandidateBacktestEvaluation,
  right: CandidateBacktestEvaluation
): number {
  return compareCandidateEvaluations(left, right);
}

export function stableParametersKey(parameters: Record<string, number>): string {
  return JSON.stringify(
    Object.keys(parameters)
      .sort((left, right) => left.localeCompare(right))
      .reduce<Record<string, number>>((result, key) => {
        result[key] = quantize(parameters[key] ?? 0);
        return result;
      }, {})
  );
}

export function candidateFingerprint(candidate: Pick<NormalizedCandidateProposal | CandidateProposal, "familyId" | "parameters">): string {
  return `${candidate.familyId}:${stableParametersKey(candidate.parameters)}`;
}

export function midpointParameters(family: StrategyFamilyDefinition): Record<string, number> {
  return family.parameterSpecs.reduce<Record<string, number>>((result, spec) => {
    result[spec.name] = quantize((spec.min + spec.max) / 2);
    return result;
  }, {});
}

function getStepFraction(iteration?: number): number {
  if (iteration === undefined || iteration <= 3) {
    return 0.10;
  }
  if (iteration <= 6) {
    return 0.15;
  }
  return 0.25;
}

function isPortfolioFamilyDefinition(family: StrategyFamilyDefinition | undefined): boolean {
  return family?.strategyName.startsWith("portfolio:") ?? false;
}

function dedupeNormalizedCandidates(candidates: NormalizedCandidateProposal[]): NormalizedCandidateProposal[] {
  const seen = new Set<string>();

  return candidates.filter((candidate) => {
    const key = `${candidate.strategyName}:${JSON.stringify(candidate.parameters)}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function shouldStageConfirmCandidate(evaluation: CandidateBacktestEvaluation): boolean {
  if (evaluation.status !== "completed") {
    return false;
  }

  if (evaluation.summary.tradeCount <= 0 || evaluation.summary.netReturn <= 0) {
    return false;
  }

  const positiveWindowRatio = evaluation.diagnostics.windows.positiveWindowRatio;
  if (typeof positiveWindowRatio === "number" && positiveWindowRatio <= 0) {
    return false;
  }

  return true;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asNumericParameters(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => typeof entry === "number" && Number.isFinite(entry))
    .map(([key, entry]) => [key, entry as number] as const);

  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(entries);
}

function snapshotFromArtifactNode(
  node: unknown,
  sourcePath: string
): ArtifactSeedSnapshot | undefined {
  if (!node || typeof node !== "object") {
    return undefined;
  }

  const record = node as Record<string, unknown>;
  const directFamilyId = typeof record.familyId === "string" ? record.familyId : undefined;
  const directParameters = asNumericParameters(record.parameters);

  if (directFamilyId && directParameters) {
    return {
      candidateId: typeof record.candidateId === "string" ? record.candidateId : undefined,
      familyId: directFamilyId,
      parameters: directParameters,
      netReturn: asFiniteNumber(record.netReturn),
      maxDrawdown: asFiniteNumber(record.maxDrawdown),
      tradeCount: asFiniteNumber(record.tradeCount),
      positiveWindowRatio: asFiniteNumber(record.positiveWindowRatio),
      score: asFiniteNumber(record.score),
      sourcePath
    };
  }

  const nestedCandidate = record.candidate;
  if (!nestedCandidate || typeof nestedCandidate !== "object") {
    return undefined;
  }

  const candidateRecord = nestedCandidate as Record<string, unknown>;
  const familyId = typeof candidateRecord.familyId === "string" ? candidateRecord.familyId : undefined;
  const parameters = asNumericParameters(candidateRecord.parameters);

  if (!familyId || !parameters) {
    return undefined;
  }

  const summary = record.summary && typeof record.summary === "object"
    ? (record.summary as Record<string, unknown>)
    : undefined;
  const diagnostics = record.diagnostics && typeof record.diagnostics === "object"
    ? (record.diagnostics as Record<string, unknown>)
    : undefined;
  const windows = diagnostics?.windows && typeof diagnostics.windows === "object"
    ? (diagnostics.windows as Record<string, unknown>)
    : undefined;

  return {
    candidateId: typeof candidateRecord.candidateId === "string" ? candidateRecord.candidateId : undefined,
    familyId,
    parameters,
    netReturn: asFiniteNumber(summary?.netReturn),
    maxDrawdown: asFiniteNumber(summary?.maxDrawdown),
    tradeCount: asFiniteNumber(summary?.tradeCount),
    positiveWindowRatio: asFiniteNumber(windows?.positiveWindowRatio),
    score: asFiniteNumber(summary?.netReturn),
    sourcePath
  };
}

function collectArtifactSeedSnapshots(
  node: unknown,
  sourcePath: string,
  snapshots: ArtifactSeedSnapshot[]
): void {
  const snapshot = snapshotFromArtifactNode(node, sourcePath);
  if (snapshot) {
    snapshots.push(snapshot);
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      collectArtifactSeedSnapshots(item, sourcePath, snapshots);
    }
    return;
  }

  if (!node || typeof node !== "object") {
    return;
  }

  for (const value of Object.values(node as Record<string, unknown>)) {
    collectArtifactSeedSnapshots(value, sourcePath, snapshots);
  }
}

function scoreArtifactSeed(snapshot: ArtifactSeedSnapshot): number {
  const baseScore = Number.isFinite(snapshot.score)
    ? snapshot.score!
    : (snapshot.netReturn ?? Number.NEGATIVE_INFINITY) - (snapshot.maxDrawdown ?? 0) * 0.7;
  const tradeBoost = Math.min(snapshot.tradeCount ?? 0, 100) * 0.0002;
  const windowBoost = Math.max(0, snapshot.positiveWindowRatio ?? 0) * 0.01;
  return baseScore + tradeBoost + windowBoost;
}

function calculateCandidateParameterDistance(
  left: Pick<NormalizedCandidateProposal, "familyId" | "parameters">,
  right: Pick<NormalizedCandidateProposal, "familyId" | "parameters">,
  familyMap: Map<string, StrategyFamilyDefinition>
): number {
  if (left.familyId !== right.familyId) {
    return 1;
  }

  const family = familyMap.get(left.familyId);
  if (!family || family.parameterSpecs.length === 0) {
    return 0;
  }

  let totalDistance = 0;
  let contributingSpecs = 0;

  for (const spec of family.parameterSpecs) {
    const range = spec.max - spec.min;
    if (range <= 0) {
      continue;
    }

    const leftValue = left.parameters[spec.name];
    const rightValue = right.parameters[spec.name];
    if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) {
      continue;
    }

    totalDistance += Math.abs(leftValue - rightValue) / range;
    contributingSpecs += 1;
  }

  if (contributingSpecs === 0) {
    return 0;
  }

  return totalDistance / contributingSpecs;
}

function mutateCandidateToNovelVariant(params: {
  candidate: NormalizedCandidateProposal;
  family: StrategyFamilyDefinition | undefined;
  usedFingerprints: Set<string>;
  seed: number;
  suffix: string;
  iteration?: number;
}): NormalizedCandidateProposal | undefined {
  if (!params.family || params.family.parameterSpecs.length === 0) {
    return undefined;
  }

  const portfolioFamily = isPortfolioFamilyDefinition(params.family);
  const directions = portfolioFamily ? [1, -1, 2, -2, 3, -3] : [1, -1, 2, -2];

  for (let offset = 0; offset < params.family.parameterSpecs.length; offset += 1) {
    const spec = params.family.parameterSpecs[
      (params.seed + offset) % params.family.parameterSpecs.length
    ]!;
    const width = spec.max - spec.min;
    const current = params.candidate.parameters[spec.name];

    if (!Number.isFinite(current) || width <= 0) {
      continue;
    }

    const stepFraction = portfolioFamily ? 0.1 : getStepFraction(params.iteration);
    const step = Math.max(width * stepFraction, width / (portfolioFamily ? 10 : 20));

    for (const direction of directions) {
      const next = clamp(current + step * direction, spec.min, spec.max);
      if (Math.abs(next - current) < 1e-9) {
        continue;
      }

      const candidate: NormalizedCandidateProposal = {
        ...params.candidate,
        candidateId: `${params.candidate.familyId}-${params.suffix}-${String(
          params.seed + offset + Math.abs(direction)
        ).padStart(2, "0")}`,
        thesis: `${params.candidate.thesis} Novelized from historical duplicate.`,
        origin: "novelized",
        parentCandidateIds: [
          ...(params.candidate.parentCandidateIds ?? []),
          params.candidate.candidateId
        ].slice(-8),
        parameters: {
          ...params.candidate.parameters,
          [spec.name]: quantize(next)
        }
      };
      const fingerprint = candidateFingerprint(candidate);

      if (!params.usedFingerprints.has(fingerprint)) {
        return candidate;
      }
    }
  }

  if (!portfolioFamily || params.family.parameterSpecs.length < 2) {
    return undefined;
  }

  const pairedDirections: Array<[number, number]> = [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
    [2, 1],
    [1, 2]
  ];

  for (let offset = 0; offset < params.family.parameterSpecs.length; offset += 1) {
    const firstSpec = params.family.parameterSpecs[
      (params.seed + offset) % params.family.parameterSpecs.length
    ]!;
    const secondSpec = params.family.parameterSpecs[
      (params.seed + offset + 1) % params.family.parameterSpecs.length
    ]!;
    const firstCurrent = params.candidate.parameters[firstSpec.name];
    const secondCurrent = params.candidate.parameters[secondSpec.name];
    const firstWidth = firstSpec.max - firstSpec.min;
    const secondWidth = secondSpec.max - secondSpec.min;

    if (
      !Number.isFinite(firstCurrent) ||
      !Number.isFinite(secondCurrent) ||
      firstWidth <= 0 ||
      secondWidth <= 0
    ) {
      continue;
    }

    const firstStep = Math.max(firstWidth * 0.08, firstWidth / 12);
    const secondStep = Math.max(secondWidth * 0.08, secondWidth / 12);

    for (const [firstDirection, secondDirection] of pairedDirections) {
      const nextFirst = clamp(
        firstCurrent + firstStep * firstDirection,
        firstSpec.min,
        firstSpec.max
      );
      const nextSecond = clamp(
        secondCurrent + secondStep * secondDirection,
        secondSpec.min,
        secondSpec.max
      );

      if (
        Math.abs(nextFirst - firstCurrent) < 1e-9 &&
        Math.abs(nextSecond - secondCurrent) < 1e-9
      ) {
        continue;
      }

      const candidate: NormalizedCandidateProposal = {
        ...params.candidate,
        candidateId: `${params.candidate.familyId}-${params.suffix}-${String(
          params.seed + offset + Math.abs(firstDirection) + Math.abs(secondDirection)
        ).padStart(2, "0")}`,
        thesis: `${params.candidate.thesis} Novelized with a paired portfolio mutation.`,
        origin: "novelized",
        parentCandidateIds: [
          ...(params.candidate.parentCandidateIds ?? []),
          params.candidate.candidateId
        ].slice(-8),
        parameters: {
          ...params.candidate.parameters,
          [firstSpec.name]: quantize(nextFirst),
          [secondSpec.name]: quantize(nextSecond)
        }
      };
      const fingerprint = candidateFingerprint(candidate);

      if (!params.usedFingerprints.has(fingerprint)) {
        return candidate;
      }
    }
  }

  return undefined;
}

function ensureNovelCandidates(params: {
  candidates: NormalizedCandidateProposal[];
  families: StrategyFamilyDefinition[];
  iterations: ResearchIterationRecord[];
  iteration: number;
}): NormalizedCandidateProposal[] {
  const historicalFingerprints = new Set<string>(
    params.iterations.flatMap((iteration) =>
      iteration.evaluations.map((evaluation) => candidateFingerprint(evaluation.candidate))
    )
  );
  const usedFingerprints = new Set<string>();
  const result: NormalizedCandidateProposal[] = [];

  for (const [index, candidate] of params.candidates.entries()) {
    const fingerprint = candidateFingerprint(candidate);
    if (!historicalFingerprints.has(fingerprint) && !usedFingerprints.has(fingerprint)) {
      result.push(candidate);
      usedFingerprints.add(fingerprint);
      continue;
    }

    const family = params.families.find((item) => item.familyId === candidate.familyId);
    const mutated = mutateCandidateToNovelVariant({
      candidate,
      family,
      usedFingerprints: new Set([...historicalFingerprints, ...usedFingerprints]),
      seed: index + params.iteration,
      suffix: `novel-${String(params.iteration).padStart(2, "0")}`
    });

    if (mutated) {
      result.push(mutated);
      usedFingerprints.add(candidateFingerprint(mutated));
    }
  }

  return result;
}

function topUpCandidatesForEvaluation(params: {
  candidates: NormalizedCandidateProposal[];
  families: StrategyFamilyDefinition[];
  iterations: ResearchIterationRecord[];
  iteration: number;
  limit: number;
}): NormalizedCandidateProposal[] {
  if (params.candidates.length >= params.limit) {
    return params.candidates;
  }

  const historicalFingerprints = new Set<string>(
    params.iterations.flatMap((iteration) =>
      iteration.evaluations.map((evaluation) => candidateFingerprint(evaluation.candidate))
    )
  );
  const result = [...params.candidates];
  const usedFingerprints = new Set<string>([
    ...historicalFingerprints,
    ...result.map((candidate) => candidateFingerprint(candidate))
  ]);
  let attempts = 0;
  const maxAttempts = Math.max(params.limit * Math.max(1, params.candidates.length) * 4, 8);

  while (result.length < params.limit && attempts < maxAttempts) {
    const baseCandidate = params.candidates[attempts % Math.max(params.candidates.length, 1)];
    if (!baseCandidate) {
      break;
    }

    const family = params.families.find((item) => item.familyId === baseCandidate.familyId);
    const mutated = mutateCandidateToNovelVariant({
      candidate: baseCandidate,
      family,
      usedFingerprints,
      seed: params.iteration + attempts + result.length,
      suffix: `proposal-topup-${String(params.iteration).padStart(2, "0")}`
    });

    attempts += 1;

    if (!mutated) {
      continue;
    }

    usedFingerprints.add(candidateFingerprint(mutated));
    result.push(mutated);
  }

  return result;
}

export function selectDiversifiedExperimentCandidates(
  candidates: NormalizedCandidateProposal[],
  families: StrategyFamilyDefinition[],
  limit: number,
  minDistance = DEFAULT_EXPERIMENT_CANDIDATE_DIVERSIFICATION_MIN_DISTANCE
): NormalizedCandidateProposal[] {
  const byFamily = new Map<string, NormalizedCandidateProposal[]>();
  const familyMap = new Map(families.map((family) => [family.familyId, family]));

  for (const candidate of candidates) {
    const bucket = byFamily.get(candidate.familyId) ?? [];
    bucket.push(candidate);
    byFamily.set(candidate.familyId, bucket);
  }

  const selected: NormalizedCandidateProposal[] = [];
  for (const bucket of byFamily.values()) {
    if (bucket[0]) {
      selected.push(bucket[0]);
    }
  }

  const remaining = candidates.filter((candidate) => !selected.includes(candidate));

  while (selected.length < limit && remaining.length > 0) {
    const sameFamilyPool = remaining.filter((candidate) =>
      selected.some((picked) => picked.familyId === candidate.familyId)
    );
    const candidatePool = sameFamilyPool.length > 0 ? sameFamilyPool : remaining;
    const distantPool = candidatePool.filter((candidate) => {
      const sameFamilySelected = selected.filter((picked) => picked.familyId === candidate.familyId);
      if (sameFamilySelected.length === 0) {
        return true;
      }

      const closestDistance = Math.min(
        ...sameFamilySelected.map((picked) =>
          calculateCandidateParameterDistance(candidate, picked, familyMap)
        )
      );
      return closestDistance >= minDistance;
    });
    const pool = distantPool.length > 0 ? distantPool : candidatePool;
    let bestIndex = -1;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const candidate of pool) {
      const position = remaining.indexOf(candidate);
      const sameFamilySelected = selected.filter((picked) => picked.familyId === candidate.familyId);
      const closestSameFamilyDistance = sameFamilySelected.length > 0
        ? Math.min(
          ...sameFamilySelected.map((picked) =>
            calculateCandidateParameterDistance(candidate, picked, familyMap)
          )
        )
        : 1;
      const familyNoveltyBonus = sameFamilySelected.length === 0 ? 1 : 0;
      const score = familyNoveltyBonus * 10 + closestSameFamilyDistance - position * 1e-4;

      if (score > bestScore) {
        bestScore = score;
        bestIndex = position;
      }
    }

    if (bestIndex < 0) {
      break;
    }

    selected.push(remaining[bestIndex]!);
    remaining.splice(bestIndex, 1);
  }

  return selected.slice(0, limit);
}

export function compileCandidateBatch(params: {
  proposal: ProposalBatch;
  families: StrategyFamilyDefinition[];
  history: ResearchIterationRecord[];
  iteration: number;
  limit: number;
  minDistance?: number;
  hiddenFamilyIds?: Iterable<string>;
}): NormalizedCandidateProposal[] {
  const hiddenFamilyIds = new Set(params.hiddenFamilyIds ?? []);
  const baseCandidates = params.proposal.candidates.length > 0
    ? dedupeNormalizedCandidates(
        params.proposal.candidates.map((proposal, index) =>
          normalizeCandidateProposal(proposal, params.families, index)
        )
      )
    : params.families
        .filter((family) => !hiddenFamilyIds.has(family.familyId))
        .map((family, index) =>
          normalizeCandidateProposal(
            {
              candidateId: `${family.familyId}-compiler-seed-${String(params.iteration).padStart(2, "0")}-${String(index + 1).padStart(2, "0")}`,
              familyId: family.familyId,
              thesis: `Compiler seed for ${family.familyId}.`,
              parameters: midpointParameters(family),
              origin: "engine_seed",
              invalidationSignals: [
                "compiler seed does not produce acceptable risk-adjusted performance"
              ]
            },
            params.families,
            index
          )
        );
  const novelCandidates = ensureNovelCandidates({
    candidates: baseCandidates,
    families: params.families,
    iterations: params.history,
    iteration: params.iteration
  });
  const compiledCandidates = topUpCandidatesForEvaluation({
    candidates: novelCandidates.length > 0 ? novelCandidates : baseCandidates,
    families: params.families,
    iterations: params.history,
    iteration: params.iteration,
    limit: params.limit
  });

  return selectDiversifiedExperimentCandidates(
    compiledCandidates.filter((candidate) => !hiddenFamilyIds.has(candidate.familyId)),
    params.families,
    params.limit,
    params.minDistance ?? DEFAULT_EXPERIMENT_CANDIDATE_DIVERSIFICATION_MIN_DISTANCE
  );
}

function buildStagedConfirmCandidate(params: {
  evaluation: CandidateBacktestEvaluation;
  family: StrategyFamilyDefinition | undefined;
  iteration: number;
  seed: number;
  usedFingerprints: Set<string>;
}): CandidateProposal | undefined {
  const confirmFamilyId = SCREEN_FAMILY_TO_CONFIRM_FAMILY.get(params.evaluation.candidate.familyId);

  if (
    !confirmFamilyId ||
    !params.family ||
    params.family.familyId !== confirmFamilyId ||
    params.family.strategyName !== MULTI_TF_REGIME_SWITCH_PORTFOLIO ||
    !shouldStageConfirmCandidate(params.evaluation)
  ) {
    return undefined;
  }

  const sharedParameters = Object.fromEntries(
    params.family.parameterSpecs
      .map((spec) => {
        const existing = params.evaluation.candidate.parameters[spec.name];
        if (!Number.isFinite(existing)) {
          return undefined;
        }

        return [spec.name, quantize(existing)] as const;
      })
      .filter((entry): entry is readonly [string, number] => Boolean(entry))
  );
  const parameters = {
    ...midpointParameters(params.family),
    ...REGIME_SWITCH_CONFIRM_DEFAULT_PARAMETERS,
    ...sharedParameters
  };
  const invalidationSignals = [
    "full confirm loses edge once 1m sleeve is enabled",
    "micro sleeve dominates turnover without lifting net return",
    "drawdown expands beyond the screen-stage parent"
  ];
  const proposal: CandidateProposal = {
    candidateId: `${params.family.familyId}-engine-confirm-${String(params.iteration).padStart(2, "0")}-${String(params.seed).padStart(2, "0")}`,
    familyId: params.family.familyId,
    thesis: `Confirm full regime-switch candidate from ${params.evaluation.candidate.familyId} survivor ${params.evaluation.candidate.candidateId}.`,
    parameters,
    origin: "engine_seed",
    parentCandidateIds: [
      ...(params.evaluation.candidate.parentCandidateIds ?? []),
      params.evaluation.candidate.candidateId
    ].slice(-8),
    invalidationSignals
  };
  const fingerprint = candidateFingerprint(proposal);

  if (!params.usedFingerprints.has(fingerprint)) {
    params.usedFingerprints.add(fingerprint);
    return proposal;
  }

  const normalized = normalizeCandidateProposal(proposal, [params.family], 0);
  const mutated = mutateCandidateToNovelVariant({
    candidate: normalized,
    family: params.family,
    usedFingerprints: params.usedFingerprints,
    seed: params.seed,
    suffix: `engine-confirm-${String(params.iteration).padStart(2, "0")}`
  });

  if (!mutated) {
    return undefined;
  }

  params.usedFingerprints.add(candidateFingerprint(mutated));
  return {
    candidateId: mutated.candidateId,
    familyId: mutated.familyId,
    thesis: mutated.thesis,
    parameters: mutated.parameters,
    origin: "engine_mutation",
    parentCandidateIds: mutated.parentCandidateIds,
    invalidationSignals
  };
}

export function compileHintBatchToProposalBatch(params: {
  hints: ExperimentHintBatch | ExperimentCandidateHint[];
  families: StrategyFamilyDefinition[];
  iteration: number;
  defaultResearchSummary?: string;
}): ProposalBatch {
  const hintBatch = Array.isArray(params.hints)
    ? { hints: params.hints }
    : params.hints;
  const familyMap = new Map(params.families.map((family) => [family.familyId, family]));

  return {
    researchSummary:
      hintBatch.researchSummary?.trim() ||
      params.defaultResearchSummary ||
      "Deterministic experiment hints compiled into executable candidates.",
    preparation: hintBatch.preparation ?? [],
    proposedFamilies: hintBatch.proposedFamilies ?? [],
    codeTasks: hintBatch.codeTasks ?? [],
    candidates: hintBatch.hints.map((hint, index) => {
      const family = familyMap.get(hint.familyId);
      if (!family) {
        throw new Error(`Unknown strategy family for experiment hint: ${hint.familyId}`);
      }

      return {
        candidateId:
          hint.candidateId ??
          `${hint.familyId}-hint-${String(params.iteration).padStart(2, "0")}-${String(index + 1).padStart(2, "0")}`,
        familyId: hint.familyId,
        thesis: hint.thesis?.trim() || `Deterministic experiment hint for ${hint.familyId}.`,
        parameters: {
          ...midpointParameters(family),
          ...(hint.parameters ?? {})
        },
        invalidationSignals:
          hint.invalidationSignals?.filter(Boolean) ?? [
            "compiled experiment hint does not reproduce edge",
            "trade count remains inadequate",
            "drawdown exceeds acceptable bounds"
          ],
        parentCandidateIds: hint.parentCandidateIds?.filter(Boolean),
        origin: hint.origin ?? "llm"
      };
    })
  };
}

function toProposalBatch(
  source: ExperimentCompilationSource,
  families: StrategyFamilyDefinition[],
  iteration: number
): ProposalBatch {
  if (Array.isArray(source)) {
    return compileHintBatchToProposalBatch({
      hints: source,
      families,
      iteration
    });
  }

  if ("hints" in source) {
    return compileHintBatchToProposalBatch({
      hints: source,
      families,
      iteration
    });
  }

  return source;
}

export async function buildArtifactSeedCandidates(params: {
  config: AutoResearchRunConfig;
  families: StrategyFamilyDefinition[];
  hiddenFamilyIds?: Iterable<string>;
  usedFingerprints: Set<string>;
  iteration: number;
}): Promise<CandidateProposal[]> {
  const seedPaths = (params.config.seedArtifactPaths ?? []).filter(Boolean);
  if (seedPaths.length === 0) {
    return [];
  }

  const seedBudget = Math.min(
    params.config.candidatesPerIteration,
    Math.max(
      1,
      params.config.seedCandidatesPerIteration ??
        Math.ceil(params.config.candidatesPerIteration / 2)
    )
  );
  if (seedBudget <= 0) {
    return [];
  }

  const hiddenFamilyIds = new Set(params.hiddenFamilyIds ?? []);
  const eligibleFamilies = params.families.filter((family) => !hiddenFamilyIds.has(family.familyId));
  const eligibleFamilyIds = new Set(eligibleFamilies.map((family) => family.familyId));
  if (eligibleFamilyIds.size === 0) {
    return [];
  }

  const rankedByFingerprint = new Map<string, {
    candidate: NormalizedCandidateProposal;
    score: number;
    sourcePath: string;
  }>();

  for (const seedPath of seedPaths) {
    let parsed: unknown;

    try {
      parsed = JSON.parse(await readFile(seedPath, "utf8"));
    } catch {
      continue;
    }

    const snapshots: ArtifactSeedSnapshot[] = [];
    collectArtifactSeedSnapshots(parsed, seedPath, snapshots);

    for (const [index, snapshot] of snapshots.entries()) {
      if (!eligibleFamilyIds.has(snapshot.familyId)) {
        continue;
      }

      const family = eligibleFamilies.find((item) => item.familyId === snapshot.familyId);
      if (!family) {
        continue;
      }

      const artifactSlug =
        path.basename(snapshot.sourcePath)
          .replace(/[^a-zA-Z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 24) || "seed";
      const proposal: CandidateProposal = {
        candidateId: `${snapshot.familyId}-${artifactSlug}-artifact-seed-${String(params.iteration).padStart(2, "0")}-${String(index + 1).padStart(2, "0")}`,
        familyId: snapshot.familyId,
        thesis: `Artifact seed from ${path.basename(snapshot.sourcePath)} with prior measured edge.`,
        parameters: {
          ...midpointParameters(family),
          ...snapshot.parameters
        },
        origin: "artifact_seed",
        parentCandidateIds: snapshot.candidateId ? [snapshot.candidateId] : [],
        invalidationSignals: [
          "prior measured edge does not reproduce under the current walk-forward split",
          "edge collapses once candidate is evaluated on the current market set",
          "trade adequacy or drawdown degrades versus the source artifact"
        ]
      };

      let normalized: NormalizedCandidateProposal;
      try {
        normalized = normalizeCandidateProposal(proposal, eligibleFamilies, index);
      } catch {
        continue;
      }

      const fingerprint = candidateFingerprint(normalized);
      if (params.usedFingerprints.has(fingerprint)) {
        continue;
      }

      const score = scoreArtifactSeed(snapshot);
      const existing = rankedByFingerprint.get(fingerprint);
      if (!existing || score > existing.score) {
        rankedByFingerprint.set(fingerprint, {
          candidate: normalized,
          score,
          sourcePath: snapshot.sourcePath
        });
      }
    }
  }

  const rankedCandidates = [...rankedByFingerprint.values()]
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return left.sourcePath.localeCompare(right.sourcePath);
    })
    .map((item) => item.candidate);
  const diversified = selectDiversifiedExperimentCandidates(
    rankedCandidates,
    eligibleFamilies,
    seedBudget,
    params.config.candidateDiversificationMinDistance ??
      DEFAULT_EXPERIMENT_CANDIDATE_DIVERSIFICATION_MIN_DISTANCE
  );

  for (const candidate of diversified) {
    params.usedFingerprints.add(candidateFingerprint(candidate));
  }

  return diversified.map((candidate) => ({
    candidateId: candidate.candidateId,
    familyId: candidate.familyId,
    thesis: candidate.thesis,
    parameters: candidate.parameters,
    origin: "artifact_seed",
    parentCandidateIds: candidate.parentCandidateIds,
    invalidationSignals: candidate.invalidationSignals
  }));
}

export async function buildEngineAugmentedCandidateProposals(params: {
  proposal: ProposalBatch;
  config: AutoResearchRunConfig;
  families: StrategyFamilyDefinition[];
  history: ResearchIterationRecord[];
  iteration: number;
  hiddenFamilyIds?: Iterable<string>;
}): Promise<CandidateProposal[]> {
  const representedFamilies = new Set(
    params.proposal.candidates.map((candidate) => candidate.familyId)
  );
  const historicalEvaluations = params.history
    .flatMap((iteration) => iteration.evaluations)
    .filter((evaluation) => evaluation.status === "completed")
    .sort(compareEvaluations);
  const usedFingerprints = new Set<string>([
    ...params.proposal.candidates.map((candidate) => candidateFingerprint(candidate)),
    ...historicalEvaluations.map((evaluation) => candidateFingerprint(evaluation.candidate))
  ]);
  const artifactSeedCandidates = await buildArtifactSeedCandidates({
    config: params.config,
    families: params.families,
    hiddenFamilyIds: params.hiddenFamilyIds,
    usedFingerprints,
    iteration: params.iteration
  });
  const engineCandidates: CandidateProposal[] = [...artifactSeedCandidates];

  for (const candidate of artifactSeedCandidates) {
    representedFamilies.add(candidate.familyId);
  }

  if (params.history.length === 0) {
    return engineCandidates;
  }

  const diversityTarget = Math.min(
    params.config.candidatesPerIteration,
    params.families.length
  );
  const shouldAugment =
    engineCandidates.length < params.config.candidatesPerIteration &&
    (
      params.proposal.candidates.length < params.config.candidatesPerIteration ||
      representedFamilies.size < diversityTarget
    );

  if (!shouldAugment) {
    return engineCandidates;
  }

  const hiddenFamilyIds = new Set(params.hiddenFamilyIds ?? []);
  const stagedConfirmFamilies = new Set<string>();
  const addMutationCandidate = (evaluation: CandidateBacktestEvaluation, seed: number) => {
    if (engineCandidates.length >= params.config.candidatesPerIteration) {
      return;
    }

    const family = params.families.find((item) => item.familyId === evaluation.candidate.familyId);
    const mutated = mutateCandidateToNovelVariant({
      candidate: evaluation.candidate,
      family,
      usedFingerprints,
      seed,
      suffix: `engine-mutation-${String(params.iteration).padStart(2, "0")}`
    });

    if (!mutated) {
      return;
    }

    usedFingerprints.add(candidateFingerprint(mutated));
    representedFamilies.add(mutated.familyId);
    engineCandidates.push({
      candidateId: mutated.candidateId,
      familyId: mutated.familyId,
      thesis: `Engine mutation from ${evaluation.candidate.candidateId} after measured edge.`,
      parameters: mutated.parameters,
      origin: "engine_mutation",
      parentCandidateIds: [
        ...(evaluation.candidate.parentCandidateIds ?? []),
        evaluation.candidate.candidateId
      ].slice(-8),
      invalidationSignals: [
        "measured edge does not persist after local mutation",
        "trade count collapses",
        "drawdown expands beyond prior parent candidate"
      ]
    });
  };

  let mutationSeed = params.iteration + params.history.length;

  for (const evaluation of historicalEvaluations) {
    if (engineCandidates.length >= params.config.candidatesPerIteration) {
      break;
    }

    const confirmFamilyId = SCREEN_FAMILY_TO_CONFIRM_FAMILY.get(evaluation.candidate.familyId);
    if (
      !confirmFamilyId ||
      representedFamilies.has(confirmFamilyId) ||
      stagedConfirmFamilies.has(confirmFamilyId)
    ) {
      continue;
    }

    const confirmFamily = params.families.find((item) => item.familyId === confirmFamilyId);
    const confirmCandidate = buildStagedConfirmCandidate({
      evaluation,
      family: confirmFamily,
      iteration: params.iteration,
      seed: mutationSeed,
      usedFingerprints
    });
    mutationSeed += 1;

    if (!confirmCandidate) {
      continue;
    }

    stagedConfirmFamilies.add(confirmFamilyId);
    representedFamilies.add(confirmFamilyId);
    engineCandidates.push(confirmCandidate);
  }

  for (const evaluation of historicalEvaluations) {
    if (representedFamilies.has(evaluation.candidate.familyId)) {
      continue;
    }

    addMutationCandidate(evaluation, mutationSeed);
    mutationSeed += 1;
  }

  for (const family of params.families) {
    if (engineCandidates.length >= params.config.candidatesPerIteration) {
      break;
    }

    if (hiddenFamilyIds.has(family.familyId)) {
      continue;
    }

    if (representedFamilies.has(family.familyId)) {
      continue;
    }

    const seedCandidate: CandidateProposal = {
      candidateId: `${family.familyId}-engine-seed-${String(params.iteration).padStart(2, "0")}-${String(engineCandidates.length + 1).padStart(2, "0")}`,
      familyId: family.familyId,
      thesis: `Engine seed for underexplored family ${family.familyId}.`,
      parameters: midpointParameters(family),
      origin: "engine_seed",
      invalidationSignals: [
        "still produces weak or zero-trade behavior",
        "single market dominates pnl",
        "worst window turns sharply negative"
      ]
    };
    const fingerprint = candidateFingerprint(seedCandidate);
    if (usedFingerprints.has(fingerprint)) {
      continue;
    }

    usedFingerprints.add(fingerprint);
    representedFamilies.add(family.familyId);
    engineCandidates.push(seedCandidate);
  }

  for (const evaluation of historicalEvaluations) {
    if (engineCandidates.length >= params.config.candidatesPerIteration) {
      break;
    }

    addMutationCandidate(evaluation, mutationSeed);
    mutationSeed += 1;
  }

  return engineCandidates;
}

function mergeProposalWithEngineCandidates(
  proposal: ProposalBatch,
  engineCandidates: CandidateProposal[]
): ProposalBatch {
  if (engineCandidates.length === 0) {
    return proposal;
  }

  const artifactSeedCount = engineCandidates.filter(
    (candidate) => candidate.origin === "artifact_seed"
  ).length;
  const mutationCount = engineCandidates.filter(
    (candidate) => candidate.origin === "engine_mutation"
  ).length;
  const seedCount = engineCandidates.filter(
    (candidate) => candidate.origin === "engine_seed"
  ).length;
  const artifactSeeds = engineCandidates.filter(
    (candidate) => candidate.origin === "artifact_seed"
  );
  const runtimeSeeds = engineCandidates.filter(
    (candidate) => candidate.origin !== "artifact_seed"
  );

  return {
    ...proposal,
    researchSummary: `${proposal.researchSummary} Engine augmentation added ${engineCandidates.length} candidates (${artifactSeedCount} artifact seeds, ${mutationCount} mutations, ${seedCount} seeds).`,
    candidates: [...artifactSeeds, ...proposal.candidates, ...runtimeSeeds]
  };
}

export async function augmentProposalBatchWithEngineCandidates(params: {
  proposal: ProposalBatch;
  config: AutoResearchRunConfig;
  families: StrategyFamilyDefinition[];
  history: ResearchIterationRecord[];
  iteration: number;
  hiddenFamilyIds?: Iterable<string>;
}): Promise<ProposalBatch> {
  const engineCandidates = await buildEngineAugmentedCandidateProposals(params);
  return mergeProposalWithEngineCandidates(params.proposal, engineCandidates);
}

export async function compileExperimentPlan(params: {
  source: ExperimentCompilationSource;
  config: AutoResearchRunConfig;
  families?: StrategyFamilyDefinition[];
  history: ResearchIterationRecord[];
  iteration: number;
  hiddenFamilyIds?: Iterable<string>;
}): Promise<CompiledExperimentPlan> {
  const families =
    params.families ??
    getStrategyFamilies(params.config.strategyFamilyIds);
  const sourceProposal = toProposalBatch(params.source, families, params.iteration);
  const engineCandidates = await buildEngineAugmentedCandidateProposals({
    proposal: sourceProposal,
    config: params.config,
    families,
    history: params.history,
    iteration: params.iteration,
    hiddenFamilyIds: params.hiddenFamilyIds
  });
  const augmentedProposal = mergeProposalWithEngineCandidates(sourceProposal, engineCandidates);
  const baseCandidates = dedupeNormalizedCandidates(
    augmentedProposal.candidates.map((proposal, index) =>
      normalizeCandidateProposal(proposal, families, index)
    )
  );
  const novelCandidates = ensureNovelCandidates({
    candidates: baseCandidates,
    families,
    iterations: params.history,
    iteration: params.iteration
  });
  const compiledCandidates = topUpCandidatesForEvaluation({
    candidates: novelCandidates.length > 0 ? novelCandidates : baseCandidates,
    families,
    iterations: params.history,
    iteration: params.iteration,
    limit: params.config.candidatesPerIteration
  });
  const evaluationCandidates = selectDiversifiedExperimentCandidates(
    compiledCandidates,
    families,
    params.config.candidatesPerIteration,
    params.config.candidateDiversificationMinDistance ??
      DEFAULT_EXPERIMENT_CANDIDATE_DIVERSIFICATION_MIN_DISTANCE
  );

  return {
    sourceProposal,
    augmentedProposal,
    engineCandidates,
    artifactSeedCandidates: engineCandidates.filter(
      (candidate) => candidate.origin === "artifact_seed"
    ),
    baseCandidates,
    novelCandidates,
    compiledCandidates,
    evaluationCandidates,
    stats: {
      sourceCandidateCount: sourceProposal.candidates.length,
      artifactSeedCount: engineCandidates.filter(
        (candidate) => candidate.origin === "artifact_seed"
      ).length,
      engineMutationCount: engineCandidates.filter(
        (candidate) => candidate.origin === "engine_mutation"
      ).length,
      engineSeedCount: engineCandidates.filter(
        (candidate) => candidate.origin === "engine_seed"
      ).length,
      baseCandidateCount: baseCandidates.length,
      novelCandidateCount: novelCandidates.length,
      compiledCandidateCount: compiledCandidates.length,
      evaluationCandidateCount: evaluationCandidates.length
    }
  };
}

export function buildHypothesesFromProposal(params: {
  proposal: ProposalBatch;
  iteration: number;
}): ResearchHypothesis[] {
  const seen = new Set<string>();
  const hypotheses: ResearchHypothesis[] = [];

  for (const [index, candidate] of params.proposal.candidates.entries()) {
    const key = `${candidate.familyId}:${stableParametersKey(candidate.parameters)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    hypotheses.push({
      hypothesisId: `hyp-${String(params.iteration).padStart(2, "0")}-${String(index + 1).padStart(2, "0")}`,
      stage: "parametric",
      title: `${candidate.familyId} parameter search`,
      thesis: candidate.thesis,
      targetFamilyIds: [candidate.familyId],
      parentHypothesisIds: [],
      evidence: candidate.invalidationSignals,
      proposedSpecChanges: params.proposal.proposedFamilies.filter((family) => family.familyId === candidate.familyId),
      proposedCodeTasks: params.proposal.codeTasks.filter((task) => task.familyId === candidate.familyId),
      expectedMechanism: `Improve ${candidate.familyId} through parameter search and local mutations.`,
      riskNotes: candidate.invalidationSignals,
      origin: candidate.origin === "artifact_seed" ? "artifact_seed" : "llm"
    });
  }

  if (hypotheses.length === 0) {
    for (const [index, family] of params.proposal.proposedFamilies.entries()) {
      hypotheses.push({
        hypothesisId: `hyp-family-${String(params.iteration).padStart(2, "0")}-${String(index + 1).padStart(2, "0")}`,
        stage: "family",
        title: family.title,
        thesis: family.thesis,
        targetFamilyIds: [family.familyId],
        parentHypothesisIds: [],
        evidence: family.implementationNotes,
        proposedSpecChanges: [family],
        proposedCodeTasks: params.proposal.codeTasks.filter((task) => task.familyId === family.familyId),
        expectedMechanism: `Validate a new family branch for ${family.familyId}.`,
        riskNotes: family.implementationNotes,
        origin: "llm"
      });
    }
  }

  return hypotheses;
}

export function buildExperimentPlan(params: {
  config: AutoResearchRunConfig;
  proposal: ProposalBatch;
  families: StrategyFamilyDefinition[];
  history: ResearchIterationRecord[];
  iteration: number;
  hiddenFamilyIds?: Iterable<string>;
  hypotheses?: ResearchHypothesis[];
}): ExperimentPlan {
  const compiledCandidates = selectDiversifiedExperimentCandidates(
    topUpCandidatesForEvaluation({
      candidates: ensureNovelCandidates({
        candidates: params.proposal.candidates.map((proposal, index) =>
          normalizeCandidateProposal(proposal, params.families, index)
        ),
        families: params.families,
        iterations: params.history,
        iteration: params.iteration
      }),
      families: params.families,
      iterations: params.history,
      iteration: params.iteration,
      limit: params.config.candidatesPerIteration
    }),
    params.families,
    params.config.candidatesPerIteration,
    params.config.candidateDiversificationMinDistance ??
      DEFAULT_EXPERIMENT_CANDIDATE_DIVERSIFICATION_MIN_DISTANCE
  ).filter((candidate) => !(params.hiddenFamilyIds ? new Set(params.hiddenFamilyIds).has(candidate.familyId) : false));

  return {
    planId: `plan-${String(params.iteration).padStart(2, "0")}`,
    hypothesisId: params.hypotheses?.[0]?.hypothesisId ?? `legacy-${String(params.iteration).padStart(2, "0")}`,
    mode: "candidate_batch",
    candidates: compiledCandidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      familyId: candidate.familyId,
      thesis: candidate.thesis,
      parameters: candidate.parameters,
      parentCandidateIds: candidate.parentCandidateIds,
      origin: candidate.origin,
      invalidationSignals: candidate.invalidationSignals
    })),
    preparation: params.proposal.preparation,
    validationCommands: [],
    budget: {
      candidateLimit: params.config.candidatesPerIteration,
      marketLimit: params.config.marketLimit,
      timeoutMs: params.config.llmTimeoutMs
    }
  };
}

export function buildDeterministicContinuationProposal(params: {
  evaluations: CandidateBacktestEvaluation[];
  families: StrategyFamilyDefinition[];
  history: ResearchIterationRecord[];
  iteration: number;
  candidateLimit: number;
  nextPreparation?: ResearchPreparationAction[];
  summary?: string;
}): ProposalBatch {
  const topEvaluations = [...params.evaluations]
    .filter((evaluation) => evaluation.status === "completed")
    .sort(compareEvaluations)
    .slice(0, Math.max(1, params.candidateLimit));

  const hintBatch: ExperimentHintBatch = {
    researchSummary:
      params.summary ?? "Objective continuation generated by the experiment compiler.",
    preparation: params.nextPreparation ?? [],
    hints: topEvaluations.map((evaluation) => ({
      candidateId: `${evaluation.candidate.familyId}-objective-seed-${String(params.iteration + 1).padStart(2, "0")}-${evaluation.candidate.candidateId}`,
      familyId: evaluation.candidate.familyId,
      thesis: `Objective continuation from ${evaluation.candidate.candidateId}.`,
      parameters: evaluation.candidate.parameters,
      parentCandidateIds: [
        ...(evaluation.candidate.parentCandidateIds ?? []),
        evaluation.candidate.candidateId
      ].slice(-8),
      origin: "engine_mutation",
      invalidationSignals: [
        "objective continuation fails to improve the best measured branch",
        "drawdown rises without compensating return",
        "trade adequacy degrades"
      ]
    }))
  };

  const compiled = compileHintBatchToProposalBatch({
    hints: hintBatch,
    families: params.families,
    iteration: params.iteration + 1,
    defaultResearchSummary: hintBatch.researchSummary
  });
  const planCandidates = selectDiversifiedExperimentCandidates(
    topUpCandidatesForEvaluation({
      candidates: ensureNovelCandidates({
        candidates: compiled.candidates.map((candidate, index) =>
          normalizeCandidateProposal(candidate, params.families, index)
        ),
        families: params.families,
        iterations: params.history,
        iteration: params.iteration + 1
      }),
      families: params.families,
      iterations: params.history,
      iteration: params.iteration + 1,
      limit: params.candidateLimit
    }),
    params.families,
    params.candidateLimit
  );

  return {
    researchSummary: hintBatch.researchSummary!,
    preparation: hintBatch.preparation ?? [],
    proposedFamilies: [],
    codeTasks: [],
    candidates: planCandidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      familyId: candidate.familyId,
      thesis: candidate.thesis,
      parameters: candidate.parameters,
      parentCandidateIds: candidate.parentCandidateIds,
      origin: candidate.origin,
      invalidationSignals: candidate.invalidationSignals
    }))
  };
}
