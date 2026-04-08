import { readFile } from "node:fs/promises";
import path from "node:path";
import { replaceStrategyRegimes } from "../db.js";
import {
  calculateCandidateRiskAdjustedScore,
  compareCandidateEvaluations,
  passesPromotionGate,
  summarizeEvaluationRanking
} from "./ranking.js";
import type {
  AutoResearchRunConfig,
  CandidateBacktestEvaluation,
  ResearchIterationRecord
} from "./types.js";
import type { AutoResearchRunState } from "./run-manager.js";

export type AutoPromoteResult = {
  promoted: boolean;
  reason: string;
  candidateCount: number;
  publishedCount: number;
  regimeName: string;
  candidates: Array<{
    candidateId: string;
    familyId: string;
    strategyName: string;
    netReturn: number;
    maxDrawdown: number;
    tradeCount: number;
    riskAdjustedScore: number;
    rank: number;
  }>;
};

function selectPromotableCandidates(
  iterations: ResearchIterationRecord[],
  config?: {
    maxCandidates?: number;
    minNetReturn?: number;
    maxDrawdown?: number;
    minPositiveWindowRatio?: number;
    minWorstWindowNetReturn?: number;
  }
): CandidateBacktestEvaluation[] {
  const allEvaluations = new Map<string, CandidateBacktestEvaluation>();

  for (const iteration of iterations) {
    for (const evaluation of iteration.evaluations) {
      if (evaluation.status !== "completed") continue;
      const existing = allEvaluations.get(evaluation.candidate.candidateId);
      if (!existing || compareCandidateEvaluations(existing, evaluation) > 0) {
        allEvaluations.set(evaluation.candidate.candidateId, evaluation);
      }
    }
  }

  const promotable = Array.from(allEvaluations.values())
    .filter((evaluation) =>
      passesPromotionGate(evaluation, {
        minNetReturn: config?.minNetReturn,
        maxDrawdown: config?.maxDrawdown,
        minPositiveWindowRatio: config?.minPositiveWindowRatio,
        minWorstWindowNetReturn: config?.minWorstWindowNetReturn
      })
    )
    .sort(compareCandidateEvaluations);

  const maxCandidates = config?.maxCandidates ?? 5;
  return promotable.slice(0, maxCandidates);
}

function buildRegimeName(config: AutoResearchRunConfig): string {
  const stage = config.researchStage ?? "auto";
  return `auto-research-${stage}-recommendation`;
}

export async function autoPromoteFromRunState(params: {
  outputDir: string;
  maxCandidates?: number;
  minNetReturn?: number;
  maxDrawdown?: number;
  minPositiveWindowRatio?: number;
  minWorstWindowNetReturn?: number;
  dryRun?: boolean;
}): Promise<AutoPromoteResult> {
  const runStatePath = path.join(params.outputDir, "run-state.json");
  const raw = await readFile(runStatePath, "utf8");
  const state = JSON.parse(raw) as AutoResearchRunState;

  if (state.outcome !== "completed") {
    return {
      promoted: false,
      reason: `Run outcome is '${state.outcome}', not completed`,
      candidateCount: 0,
      publishedCount: 0,
      regimeName: buildRegimeName(state.config),
      candidates: []
    };
  }

  const candidates = selectPromotableCandidates(state.iterations, {
    maxCandidates: params.maxCandidates,
    minNetReturn: params.minNetReturn,
    maxDrawdown: params.maxDrawdown,
    minPositiveWindowRatio: params.minPositiveWindowRatio,
    minWorstWindowNetReturn: params.minWorstWindowNetReturn
  });

  if (candidates.length === 0) {
    return {
      promoted: false,
      reason: "No candidates pass promotion gate",
      candidateCount: 0,
      publishedCount: 0,
      regimeName: buildRegimeName(state.config),
      candidates: []
    };
  }

  const regimeName = buildRegimeName(state.config);
  const candidateRows = candidates.map((evaluation, index) => ({
    strategyType: evaluation.candidate.familyId,
    strategyNames: [evaluation.candidate.strategyName],
    parameters: evaluation.candidate.parameters,
    weights: null,
    marketCount: state.marketCodes.length,
    avgTrainReturn: evaluation.summary.netReturn,
    avgTestReturn: evaluation.summary.netReturn,
    avgTestDrawdown: evaluation.summary.maxDrawdown,
    rank: index + 1
  }));

  const resultCandidates = candidates.map((evaluation, index) => ({
    candidateId: evaluation.candidate.candidateId,
    familyId: evaluation.candidate.familyId,
    strategyName: evaluation.candidate.strategyName,
    netReturn: evaluation.summary.netReturn,
    maxDrawdown: evaluation.summary.maxDrawdown,
    tradeCount: evaluation.summary.tradeCount,
    riskAdjustedScore: calculateCandidateRiskAdjustedScore(evaluation),
    rank: index + 1
  }));

  if (params.dryRun) {
    return {
      promoted: false,
      reason: "Dry run — would promote but skipped",
      candidateCount: candidates.length,
      publishedCount: 0,
      regimeName,
      candidates: resultCandidates
    };
  }

  await replaceStrategyRegimes({
    regimeName,
    universeName: state.config.universeName,
    timeframe: state.config.timeframe,
    holdoutDays: state.config.holdoutDays,
    verification: {
      kind: "auto_research",
      outputDir: params.outputDir
    },
    metadata: {
      sourceLabel: `auto-research-${state.config.researchStage ?? "auto"}`,
      trainingDays: state.config.trainingDays,
      stepDays: state.config.stepDays,
      candidatePoolSize: candidates.length
    },
    rows: candidateRows
  });

  return {
    promoted: true,
    reason: `Published ${candidates.length} candidates to '${regimeName}'`,
    candidateCount: candidates.length,
    publishedCount: candidates.length,
    regimeName,
    candidates: resultCandidates
  };
}

export async function autoPromoteAndLog(params: {
  outputDir: string;
  maxCandidates?: number;
  dryRun?: boolean;
  log?: (message: string) => void;
}): Promise<AutoPromoteResult> {
  const log = params.log ?? console.error;

  try {
    const result = await autoPromoteFromRunState(params);

    if (result.promoted) {
      log(`[auto-promote] published ${result.publishedCount} candidates to '${result.regimeName}'`);
      for (const candidate of result.candidates) {
        log(
          `[auto-promote]   #${candidate.rank} ${candidate.candidateId} ` +
          `net=${candidate.netReturn.toFixed(4)} dd=${candidate.maxDrawdown.toFixed(4)} ` +
          `trades=${candidate.tradeCount} score=${candidate.riskAdjustedScore.toFixed(4)}`
        );
      }
    } else {
      log(`[auto-promote] skipped: ${result.reason}`);
    }

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`[auto-promote] failed: ${message}`);
    return {
      promoted: false,
      reason: `Error: ${message}`,
      candidateCount: 0,
      publishedCount: 0,
      regimeName: "unknown",
      candidates: []
    };
  }
}
