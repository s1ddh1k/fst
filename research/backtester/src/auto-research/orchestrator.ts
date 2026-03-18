import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  getCandidateMarketsWithMinimumCandles
} from "../db.js";
import { preloadMarketData } from "../scored-runner.js";
import type { Candle } from "../types.js";
import { getStrategyFamilies, normalizeCandidateProposal } from "./catalog.js";
import { CliCodeMutationAgent, type CodeAgent } from "./code-agent.js";
import {
  applyCodeMutationResultsToCatalog,
  buildRuntimeFamilies,
  createInitialCatalog,
  markCatalogFamilyState,
  mergeProposedFamilies,
  refreshCatalogImplementations,
  saveCatalogArtifact
} from "./proposed-catalog.js";
import type {
  AutoResearchConfigRepair,
  AutoResearchRunConfig,
  AutoResearchRunOutcome,
  AutoResearchRunReport,
  CandidateBacktestEvaluation,
  CodeMutationExecutionResult,
  CatalogEntryRecord,
  CandidateProposal,
  NormalizedCandidateProposal,
  PreparationExecutionResult,
  ProposalBatch,
  ResearchIterationRecord,
  ReviewDecision,
  StrategyFamilyDefinition,
  ValidationCommandResult
} from "./types.js";
import type { ResearchLlmClient } from "./llm-adapter.js";
import { executePreparationActions } from "./preparation.js";
import { acquireRunLock, appendRunLog, loadRunState, reconcilePartialRunStatus, releaseRunLock, saveLeaderboard, saveRunState, saveRunStatus, toReport, type AutoResearchStatus } from "./run-manager.js";
import { renderAutoResearchHtmlWithOptions } from "./report-html.js";
import { runPostMutationValidation } from "./validation.js";
import { discoverRuntimeScoredStrategyNames } from "./runtime-discovery.js";
import { repairWalkForwardConfig } from "./walk-forward-config.js";
import { repairAutoResearchLimit } from "./limit-resolution.js";
import {
  calculateCandidateRiskAdjustedScore,
  compareCandidateEvaluations,
  passesPromotionGate,
  summarizeEvaluationRanking
} from "./ranking.js";
import {
  MULTI_TF_REGIME_SWITCH_PORTFOLIO
} from "./portfolio-runtime.js";

const SCREEN_FAMILY_TO_CONFIRM_FAMILY = new Map<string, string>([
  ["multi-tf-regime-switch-screen", "multi-tf-regime-switch"],
  ["multi-tf-trend-burst", "multi-tf-regime-switch"],
  ["multi-tf-defensive-reclaim", "multi-tf-regime-switch"]
]);

const REGIME_SWITCH_CONFIRM_DEFAULT_PARAMETERS: Record<string, number> = {
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

function summarizeWindows(
  windows: CandidateBacktestEvaluation["diagnostics"]["windows"] | undefined
): string[] {
  if (!windows) {
    return [];
  }

  const lines = [
    `mode: ${windows.mode}`,
    `holdoutDays: ${windows.holdoutDays}`
  ];

  if (typeof windows.trainingDays === "number") {
    lines.push(`trainingDays: ${windows.trainingDays}`);
  }

  if (typeof windows.stepDays === "number") {
    lines.push(`stepDays: ${windows.stepDays}`);
  }

  if (typeof windows.windowCount === "number") {
    lines.push(`windowCount: ${windows.windowCount}`);
  }

  if (typeof windows.positiveWindowRatio === "number") {
    lines.push(`positiveWindowRatio: ${windows.positiveWindowRatio}`);
  }

  if (typeof windows.totalClosedTrades === "number") {
    lines.push(`totalClosedTrades: ${windows.totalClosedTrades}`);
  }

  if (typeof windows.availableDays === "number") {
    lines.push(`availableDays: ${windows.availableDays}`);
  }

  if (typeof windows.requiredDays === "number") {
    lines.push(`requiredDays: ${windows.requiredDays}`);
  }

  return lines;
}

function summarizeMarkdown(report: AutoResearchRunReport): string {
  const lines = [
    "# Auto Research Report",
    "",
    `generatedAt: ${report.generatedAt}`,
    `outcome: ${report.outcome}`,
    `mode: ${report.config.mode}`,
    `universe: ${report.config.universeName}`,
    `marketLimit: ${report.config.marketLimit}`,
    `limit: ${report.config.limit}`,
    ""
  ];

  if (report.outcomeReason) {
    lines.push(`outcomeReason: ${report.outcomeReason}`);
    lines.push("");
  }

  if (report.configRepairs.length > 0) {
    lines.push("## Config Repairs");
    for (const repair of report.configRepairs) {
      lines.push(`- appliedAt: ${repair.appliedAt}`);
      lines.push(`- reason: ${repair.reason}`);
      lines.push(
        `- previous: holdout=${repair.previous.holdoutDays}, training=${repair.previous.trainingDays}, step=${repair.previous.stepDays}, required=${repair.previous.requiredDays}`
      );
      lines.push(
        `- next: holdout=${repair.next.holdoutDays}, training=${repair.next.trainingDays}, step=${repair.next.stepDays}, required=${repair.next.requiredDays}, windows=${repair.next.expectedWindowCount}`
      );
      lines.push(
        `- available: start=${repair.available.startAt ?? "-"}, end=${repair.available.endAt ?? "-"}, days=${repair.available.availableDays}`
      );
      lines.push("");
    }
  }

  if (report.bestCandidate) {
    lines.push("## Best Candidate");
    lines.push(`- id: ${report.bestCandidate.candidate.candidateId}`);
    lines.push(`- family: ${report.bestCandidate.candidate.familyId}`);
    lines.push(`- params: \`${JSON.stringify(report.bestCandidate.candidate.parameters)}\``);
    lines.push(`- netReturn: ${report.bestCandidate.summary.netReturn}`);
    lines.push(`- maxDrawdown: ${report.bestCandidate.summary.maxDrawdown}`);
    lines.push(`- tradeCount: ${report.bestCandidate.summary.tradeCount}`);
    for (const line of summarizeWindows(report.bestCandidate.diagnostics.windows)) {
      lines.push(`- ${line}`);
    }
    lines.push("");
  }

  if (report.bestTradeCandidate) {
    lines.push("## Best Candidate With Trades");
    lines.push(`- id: ${report.bestTradeCandidate.candidate.candidateId}`);
    lines.push(`- family: ${report.bestTradeCandidate.candidate.familyId}`);
    lines.push(`- params: \`${JSON.stringify(report.bestTradeCandidate.candidate.parameters)}\``);
    lines.push(`- netReturn: ${report.bestTradeCandidate.summary.netReturn}`);
    lines.push(`- maxDrawdown: ${report.bestTradeCandidate.summary.maxDrawdown}`);
    lines.push(`- tradeCount: ${report.bestTradeCandidate.summary.tradeCount}`);
    for (const line of summarizeWindows(report.bestTradeCandidate.diagnostics.windows)) {
      lines.push(`- ${line}`);
    }
    lines.push("");
  }

  lines.push("## Iterations");
  for (const iteration of report.iterations) {
    lines.push(`### Iteration ${iteration.iteration}`);
    lines.push(`- proposal: ${iteration.proposal.researchSummary}`);
    lines.push(`- review: ${iteration.review.summary}`);
    for (const evaluation of iteration.evaluations) {
      lines.push(
        `- ${evaluation.candidate.candidateId} ${evaluation.candidate.familyId} net=${evaluation.summary.netReturn} dd=${evaluation.summary.maxDrawdown} trades=${evaluation.summary.tradeCount}`
      );
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function compareEvaluations(left: CandidateBacktestEvaluation, right: CandidateBacktestEvaluation): number {
  return compareCandidateEvaluations(left, right);
}

function promotionGateConfig(config: AutoResearchRunConfig) {
  return {
    minTrades: config.minTradesForPromotion,
    minNetReturn: config.minNetReturnForPromotion,
    maxDrawdown: config.maxDrawdownForPromotion,
    minPositiveWindowRatio: config.minPositiveWindowRatioForPromotion,
    minRandomPercentile: config.minRandomPercentileForPromotion,
    requireBootstrapSignificance: config.requireBootstrapSignificanceForPromotion
  };
}

function mergeStrategyFamilies(...groups: StrategyFamilyDefinition[][]): StrategyFamilyDefinition[] {
  const byId = new Map<string, StrategyFamilyDefinition>();

  for (const group of groups) {
    for (const family of group) {
      byId.set(family.familyId, family);
    }
  }

  return Array.from(byId.values());
}

function expandResearchFamilies(families: StrategyFamilyDefinition[]): {
  runtimeFamilies: StrategyFamilyDefinition[];
  hiddenFamilyIds: Set<string>;
} {
  const hiddenFamilyIds = new Set<string>();
  const selectedIds = new Set(families.map((family) => family.familyId));
  const runtimeFamilies = [...families];

  for (const [screenFamilyId, confirmFamilyId] of SCREEN_FAMILY_TO_CONFIRM_FAMILY.entries()) {
    if (!selectedIds.has(screenFamilyId) || selectedIds.has(confirmFamilyId)) {
      continue;
    }

    const confirmFamily = getStrategyFamilies([confirmFamilyId])[0];
    if (!confirmFamily) {
      continue;
    }

    runtimeFamilies.push(confirmFamily);
    hiddenFamilyIds.add(confirmFamilyId);
  }

  return {
    runtimeFamilies: mergeStrategyFamilies(runtimeFamilies),
    hiddenFamilyIds
  };
}

function resolveCandidateMarketTarget(params: {
  families: StrategyFamilyDefinition[];
  marketLimit: number;
}): number {
  const safeMarketLimit = Math.max(1, params.marketLimit);
  const includesMicroExecution = params.families.some((family) => (family.requiredData ?? []).includes("1m"));
  const portfolioOnly = params.families.every((family) => family.strategyName.startsWith("portfolio:"));

  if (includesMicroExecution) {
    return Math.max(safeMarketLimit * 2, safeMarketLimit + 2);
  }

  if (portfolioOnly) {
    return Math.max(safeMarketLimit * 2, safeMarketLimit + 3);
  }

  return Math.max(safeMarketLimit * 3, safeMarketLimit + 5);
}

function findTopPromotableEvaluation(
  evaluations: CandidateBacktestEvaluation[],
  config: AutoResearchRunConfig
): CandidateBacktestEvaluation | undefined {
  const gateConfig = promotionGateConfig(config);

  return evaluations.find((evaluation) => passesPromotionGate(evaluation, gateConfig));
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

function appendReviewObservation(review: ReviewDecision, observation: string): ReviewDecision {
  return {
    ...review,
    observations: [...review.observations, observation]
  };
}

function governReviewDecision(params: {
  review: ReviewDecision;
  evaluations: CandidateBacktestEvaluation[];
  config: AutoResearchRunConfig;
  iteration: number;
  usedFallbackReview: boolean;
}): ReviewDecision {
  const { review, evaluations, config, iteration, usedFallbackReview } = params;
  const isFinalIteration = iteration >= config.iterations;
  const topPromotable = findTopPromotableEvaluation(evaluations, config);
  const requestedPromoted = review.promotedCandidateId
    ? evaluations.find((item) => item.candidate.candidateId === review.promotedCandidateId)
    : undefined;
  const requestedPromotedPassesGate = requestedPromoted
    ? passesPromotionGate(requestedPromoted, promotionGateConfig(config))
    : false;

  if (review.verdict === "promote_candidate" && topPromotable) {
    if (
      review.promotedCandidateId === topPromotable.candidate.candidateId &&
      requestedPromotedPassesGate
    ) {
      return review;
    }

    const observation =
      review.promotedCandidateId && requestedPromoted
        ? `Review promoted ${review.promotedCandidateId}, but objective governance selected ${topPromotable.candidate.candidateId}.`
        : `Review promotion was incomplete; objective governance selected ${topPromotable.candidate.candidateId}.`;

    return appendReviewObservation(
      {
        ...review,
        verdict: "promote_candidate",
        promotedCandidateId: topPromotable.candidate.candidateId,
        summary: `${review.summary} Objective governance promoted ${topPromotable.candidate.candidateId}.`.trim()
      },
      observation
    );
  }

  if (
    topPromotable &&
    (
      usedFallbackReview ||
      review.verdict === "stop_no_edge" ||
      (review.verdict === "keep_searching" && isFinalIteration)
    )
  ) {
    const reason = usedFallbackReview
      ? `LLM review fallback activated; objective governance promoted ${topPromotable.candidate.candidateId}.`
      : review.verdict === "stop_no_edge"
        ? `Review returned stop_no_edge, but objective governance promoted ${topPromotable.candidate.candidateId}.`
        : `Final iteration kept searching, but objective governance promoted ${topPromotable.candidate.candidateId}.`;

    return appendReviewObservation(
      {
        ...review,
        verdict: "promote_candidate",
        promotedCandidateId: topPromotable.candidate.candidateId,
        summary: `${review.summary} ${reason}`.trim()
      },
      reason
    );
  }

  if (review.verdict === "promote_candidate" && !requestedPromotedPassesGate) {
    const nextVerdict = isFinalIteration ? "stop_no_edge" : "keep_searching";
    const reason = review.promotedCandidateId
      ? `Promotion gate blocked ${review.promotedCandidateId}; switching verdict to ${nextVerdict}.`
      : `Review did not provide a valid promoted candidate; switching verdict to ${nextVerdict}.`;

    return appendReviewObservation(
      {
        ...review,
        verdict: nextVerdict,
        promotedCandidateId: undefined,
        summary: `${review.summary} ${reason}`.trim()
      },
      reason
    );
  }

  return review;
}

function ensureNextCandidatesForKeepSearching(params: {
  review: ReviewDecision;
  evaluations: CandidateBacktestEvaluation[];
  families: StrategyFamilyDefinition[];
  limit: number;
  iteration: number;
  history: ResearchIterationRecord[];
}): ReviewDecision {
  if (params.review.verdict !== "keep_searching") {
    return params.review;
  }

  const uniqueReviewCandidates = dedupeCandidateProposals(params.review.nextCandidates).slice(0, params.limit);
  const usedFingerprints = new Set(
    params.history.flatMap((record) =>
      record.evaluations.map((evaluation) => candidateFingerprint(evaluation.candidate))
    )
  );

  for (const candidate of uniqueReviewCandidates) {
    usedFingerprints.add(candidateFingerprint(candidate));
  }

  const fallbackCandidates = buildFallbackNextCandidates({
    evaluations: params.evaluations,
    families: params.families,
    limit: params.limit,
    iteration: params.iteration,
    seenFingerprints: usedFingerprints
  });
  const nextCandidates = [...uniqueReviewCandidates];

  for (const candidate of fallbackCandidates) {
    if (nextCandidates.length >= params.limit) {
      break;
    }

    const fingerprint = candidateFingerprint(candidate);
    if (usedFingerprints.has(fingerprint)) {
      continue;
    }

    nextCandidates.push(candidate);
    usedFingerprints.add(fingerprint);
  }

  const candidateListsMatch =
    nextCandidates.length === params.review.nextCandidates.length &&
    nextCandidates.every(
      (candidate, index) =>
        candidateFingerprint(candidate) === candidateFingerprint(params.review.nextCandidates[index]!)
    );

  if (candidateListsMatch) {
    return params.review;
  }

  let nextReview: ReviewDecision = {
    ...params.review,
    nextCandidates
  };

  if (uniqueReviewCandidates.length < params.review.nextCandidates.length) {
    nextReview = appendReviewObservation(
      nextReview,
      `Review keep_searching candidates were deduped from ${params.review.nextCandidates.length} to ${uniqueReviewCandidates.length}.`
    );
  }

  if (nextCandidates.length > uniqueReviewCandidates.length) {
    nextReview = appendReviewObservation(
      nextReview,
      `Review keep_searching candidates were topped up with ${nextCandidates.length - uniqueReviewCandidates.length} diversified fallback candidates.`
    );
  }

  if (nextCandidates.length < params.review.nextCandidates.length) {
    nextReview = appendReviewObservation(
      nextReview,
      `Review keep_searching candidates were trimmed to the configured candidate limit of ${params.limit}.`
    );
  }

  return nextReview;
}

function normalizeCandidates(
  proposals: CandidateProposal[],
  familyIds: ReturnType<typeof getStrategyFamilies>
): NormalizedCandidateProposal[] {
  return proposals.map((proposal, index) => normalizeCandidateProposal(proposal, familyIds, index));
}

function dedupeCandidates(candidates: NormalizedCandidateProposal[]): NormalizedCandidateProposal[] {
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

function dedupeCandidateProposals(candidates: CandidateProposal[]): CandidateProposal[] {
  const seen = new Set<string>();

  return candidates.filter((candidate) => {
    const key = candidateFingerprint(candidate);
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

async function runWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await worker(items[current], current);
    }
  });

  await Promise.all(runners);
  return results;
}

async function saveJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined, label: string): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) {
    return promise;
  }

  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

type LiveLeaderboardEntry = {
  iteration: number;
  candidateId: string;
  familyId: string;
  riskAdjustedScore: number;
  netReturn: number;
  maxDrawdown: number;
  tradeCount: number;
  parameters: Record<string, number>;
};

type CandidateLedgerEntry = {
  fingerprint: string;
  familyId: string;
  parameters: Record<string, number>;
  firstCandidateId: string;
  lastCandidateId: string;
  firstIteration: number;
  lastIteration: number;
  appearances: number;
  bestNetReturn: number;
  bestTradeCount: number;
  positiveAppearances: number;
  tradefulAppearances: number;
};

type FamilySummaryEntry = {
  familyId: string;
  evaluations: number;
  uniqueCandidates: number;
  positiveEvaluations: number;
  tradefulEvaluations: number;
  bestNetReturn: number;
  bestTradeNetReturn?: number;
  bestTradeCount: number;
  totalTrades: number;
  lastIteration: number;
};

type CandidateGenealogyEntry = {
  iteration: number;
  candidateId: string;
  familyId: string;
  origin: string;
  parentCandidateIds: string[];
  netReturn: number;
  tradeCount: number;
};

function stableParametersKey(parameters: Record<string, number>): string {
  return JSON.stringify(
    Object.keys(parameters)
      .sort((left, right) => left.localeCompare(right))
      .reduce<Record<string, number>>((result, key) => {
        result[key] = quantize(parameters[key] ?? 0);
        return result;
      }, {})
  );
}

function candidateFingerprint(candidate: Pick<NormalizedCandidateProposal, "familyId" | "parameters">): string {
  return `${candidate.familyId}:${stableParametersKey(candidate.parameters)}`;
}

function buildLeaderboard(
  iterations: ResearchIterationRecord[],
  liveEvaluations: CandidateBacktestEvaluation[] = []
): LiveLeaderboardEntry[] {
  return [
    ...iterations.flatMap((iteration) =>
      iteration.evaluations.map((evaluation) => ({
        iteration: iteration.iteration,
        candidateId: evaluation.candidate.candidateId,
        familyId: evaluation.candidate.familyId,
        riskAdjustedScore: calculateCandidateRiskAdjustedScore(evaluation),
        netReturn: evaluation.summary.netReturn,
        maxDrawdown: evaluation.summary.maxDrawdown,
        tradeCount: evaluation.summary.tradeCount,
        parameters: evaluation.candidate.parameters
      }))
    ),
    ...liveEvaluations.map((evaluation) => ({
      iteration: iterations.length + 1,
      candidateId: evaluation.candidate.candidateId,
      familyId: evaluation.candidate.familyId,
      riskAdjustedScore: calculateCandidateRiskAdjustedScore(evaluation),
      netReturn: evaluation.summary.netReturn,
      maxDrawdown: evaluation.summary.maxDrawdown,
      tradeCount: evaluation.summary.tradeCount,
      parameters: evaluation.candidate.parameters
    }))
  ].sort((left, right) => {
    if (right.riskAdjustedScore !== left.riskAdjustedScore) {
      return right.riskAdjustedScore - left.riskAdjustedScore;
    }

    if (right.netReturn !== left.netReturn) {
      return right.netReturn - left.netReturn;
    }

    if (left.maxDrawdown !== right.maxDrawdown) {
      return left.maxDrawdown - right.maxDrawdown;
    }

    return right.tradeCount - left.tradeCount;
  });
}

function buildUniqueLeaderboard(entries: LiveLeaderboardEntry[]): LiveLeaderboardEntry[] {
  const bestByKey = new Map<string, LiveLeaderboardEntry>();

  for (const entry of entries) {
    const key = candidateFingerprint(entry);
    if (!bestByKey.has(key)) {
      bestByKey.set(key, entry);
    }
  }

  return [...bestByKey.values()];
}

function buildCandidateLedger(
  iterations: ResearchIterationRecord[],
  liveEvaluations: CandidateBacktestEvaluation[] = []
): CandidateLedgerEntry[] {
  const ledger = new Map<string, CandidateLedgerEntry>();

  const register = (iteration: number, evaluation: CandidateBacktestEvaluation) => {
    const fingerprint = candidateFingerprint(evaluation.candidate);
    const existing = ledger.get(fingerprint);

    if (!existing) {
      ledger.set(fingerprint, {
        fingerprint,
        familyId: evaluation.candidate.familyId,
        parameters: evaluation.candidate.parameters,
        firstCandidateId: evaluation.candidate.candidateId,
        lastCandidateId: evaluation.candidate.candidateId,
        firstIteration: iteration,
        lastIteration: iteration,
        appearances: 1,
        bestNetReturn: evaluation.summary.netReturn,
        bestTradeCount: evaluation.summary.tradeCount,
        positiveAppearances: evaluation.summary.netReturn > 0 ? 1 : 0,
        tradefulAppearances: evaluation.summary.tradeCount > 0 ? 1 : 0
      });
      return;
    }

    existing.lastCandidateId = evaluation.candidate.candidateId;
    existing.lastIteration = iteration;
    existing.appearances += 1;
    existing.bestNetReturn = Math.max(existing.bestNetReturn, evaluation.summary.netReturn);
    existing.bestTradeCount = Math.max(existing.bestTradeCount, evaluation.summary.tradeCount);
    existing.positiveAppearances += evaluation.summary.netReturn > 0 ? 1 : 0;
    existing.tradefulAppearances += evaluation.summary.tradeCount > 0 ? 1 : 0;
  };

  for (const iteration of iterations) {
    for (const evaluation of iteration.evaluations) {
      register(iteration.iteration, evaluation);
    }
  }

  for (const evaluation of liveEvaluations) {
    register(iterations.length + 1, evaluation);
  }

  return [...ledger.values()].sort((left, right) => {
    if (right.bestNetReturn !== left.bestNetReturn) {
      return right.bestNetReturn - left.bestNetReturn;
    }

    if (right.bestTradeCount !== left.bestTradeCount) {
      return right.bestTradeCount - left.bestTradeCount;
    }

    return right.appearances - left.appearances;
  });
}

function buildFamilySummary(ledger: CandidateLedgerEntry[]): FamilySummaryEntry[] {
  const byFamily = new Map<string, FamilySummaryEntry>();

  for (const entry of ledger) {
    const current = byFamily.get(entry.familyId) ?? {
      familyId: entry.familyId,
      evaluations: 0,
      uniqueCandidates: 0,
      positiveEvaluations: 0,
      tradefulEvaluations: 0,
      bestNetReturn: Number.NEGATIVE_INFINITY,
      bestTradeNetReturn: undefined,
      bestTradeCount: 0,
      totalTrades: 0,
      lastIteration: 0
    };

    current.evaluations += entry.appearances;
    current.uniqueCandidates += 1;
    current.positiveEvaluations += entry.positiveAppearances;
    current.tradefulEvaluations += entry.tradefulAppearances;
    current.bestNetReturn = Math.max(current.bestNetReturn, entry.bestNetReturn);
    if (entry.bestTradeCount > 0) {
      current.bestTradeCount = Math.max(current.bestTradeCount, entry.bestTradeCount);
      current.bestTradeNetReturn =
        typeof current.bestTradeNetReturn === "number"
          ? Math.max(current.bestTradeNetReturn, entry.bestNetReturn)
          : entry.bestNetReturn;
    }
    current.totalTrades += entry.bestTradeCount;
    current.lastIteration = Math.max(current.lastIteration, entry.lastIteration);
    byFamily.set(entry.familyId, current);
  }

  return [...byFamily.values()].sort((left, right) => {
    if (right.bestNetReturn !== left.bestNetReturn) {
      return right.bestNetReturn - left.bestNetReturn;
    }

    if (right.tradefulEvaluations !== left.tradefulEvaluations) {
      return right.tradefulEvaluations - left.tradefulEvaluations;
    }

    return right.evaluations - left.evaluations;
  });
}

function midpointParameters(family: StrategyFamilyDefinition): Record<string, number> {
  return family.parameterSpecs.reduce<Record<string, number>>((result, spec) => {
    result[spec.name] = quantize((spec.min + spec.max) / 2);
    return result;
  }, {});
}

function buildCandidateGenealogy(
  iterations: ResearchIterationRecord[],
  liveEvaluations: CandidateBacktestEvaluation[] = []
): CandidateGenealogyEntry[] {
  const rows: CandidateGenealogyEntry[] = [];

  for (const iteration of iterations) {
    for (const evaluation of iteration.evaluations) {
      rows.push({
        iteration: iteration.iteration,
        candidateId: evaluation.candidate.candidateId,
        familyId: evaluation.candidate.familyId,
        origin: evaluation.candidate.origin ?? "llm",
        parentCandidateIds: evaluation.candidate.parentCandidateIds ?? [],
        netReturn: evaluation.summary.netReturn,
        tradeCount: evaluation.summary.tradeCount
      });
    }
  }

  for (const evaluation of liveEvaluations) {
    rows.push({
      iteration: iterations.length + 1,
      candidateId: evaluation.candidate.candidateId,
      familyId: evaluation.candidate.familyId,
      origin: evaluation.candidate.origin ?? "llm",
      parentCandidateIds: evaluation.candidate.parentCandidateIds ?? [],
      netReturn: evaluation.summary.netReturn,
      tradeCount: evaluation.summary.tradeCount
    });
  }

  return rows.sort((left, right) => {
    if (right.iteration !== left.iteration) {
      return right.iteration - left.iteration;
    }

    return right.netReturn - left.netReturn;
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function quantize(value: number): number {
  return Number(value.toFixed(4));
}

function isPortfolioFamilyDefinition(family: StrategyFamilyDefinition | undefined): boolean {
  return family?.strategyName.startsWith("portfolio:") ?? false;
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

        return [spec.name, quantize(existing)];
      })
      .filter((entry): entry is [string, number] => Boolean(entry))
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

function mutateCandidateToNovelVariant(params: {
  candidate: NormalizedCandidateProposal;
  family: StrategyFamilyDefinition | undefined;
  usedFingerprints: Set<string>;
  seed: number;
  suffix: string;
}): NormalizedCandidateProposal | undefined {
  if (!params.family || params.family.parameterSpecs.length === 0) {
    return undefined;
  }

  const portfolioFamily = isPortfolioFamilyDefinition(params.family);
  const directions = portfolioFamily ? [1, -1, 2, -2, 3, -3] : [1, -1, 2, -2];

  for (let offset = 0; offset < params.family.parameterSpecs.length; offset += 1) {
    const spec = params.family.parameterSpecs[(params.seed + offset) % params.family.parameterSpecs.length];
    const width = spec.max - spec.min;
    const current = params.candidate.parameters[spec.name];

    if (!Number.isFinite(current) || width <= 0) {
      continue;
    }

    const step = portfolioFamily
      ? Math.max(width * 0.1, width / 10)
      : Math.max(width * 0.05, width / 20);

    for (const direction of directions) {
      const next = clamp(current + step * direction, spec.min, spec.max);
      if (Math.abs(next - current) < 1e-9) {
        continue;
      }

      const candidate: NormalizedCandidateProposal = {
        ...params.candidate,
        candidateId: `${params.candidate.familyId}-${params.suffix}-${String(params.seed + offset + Math.abs(direction)).padStart(2, "0")}`,
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
    const firstSpec = params.family.parameterSpecs[(params.seed + offset) % params.family.parameterSpecs.length];
    const secondSpec = params.family.parameterSpecs[(params.seed + offset + 1) % params.family.parameterSpecs.length];
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
      const nextFirst = clamp(firstCurrent + firstStep * firstDirection, firstSpec.min, firstSpec.max);
      const nextSecond = clamp(secondCurrent + secondStep * secondDirection, secondSpec.min, secondSpec.max);

      if (
        Math.abs(nextFirst - firstCurrent) < 1e-9 &&
        Math.abs(nextSecond - secondCurrent) < 1e-9
      ) {
        continue;
      }

      const candidate: NormalizedCandidateProposal = {
        ...params.candidate,
        candidateId: `${params.candidate.familyId}-${params.suffix}-${String(params.seed + offset + Math.abs(firstDirection) + Math.abs(secondDirection)).padStart(2, "0")}`,
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
    const baseCandidate = params.candidates[attempts % params.candidates.length];
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

function selectDiversifiedCandidates(
  candidates: NormalizedCandidateProposal[],
  limit: number
): NormalizedCandidateProposal[] {
  const byFamily = new Map<string, NormalizedCandidateProposal[]>();

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

  for (const candidate of candidates) {
    if (selected.length >= limit) {
      break;
    }

    if (!selected.includes(candidate)) {
      selected.push(candidate);
    }
  }

  return selected.slice(0, limit);
}

function buildFallbackNextCandidates(params: {
  evaluations: CandidateBacktestEvaluation[];
  families: StrategyFamilyDefinition[];
  limit: number;
  iteration: number;
  seenFingerprints?: Set<string>;
}): CandidateProposal[] {
  const ranked = params.evaluations
    .slice()
    .sort((left, right) => {
      const leftHasTrades = left.summary.tradeCount > 0 ? 1 : 0;
      const rightHasTrades = right.summary.tradeCount > 0 ? 1 : 0;

      if (rightHasTrades !== leftHasTrades) {
        return rightHasTrades - leftHasTrades;
      }

      return compareEvaluations(left, right);
    });
  const byFamily = new Map<string, CandidateBacktestEvaluation[]>();

  for (const evaluation of ranked) {
    const bucket = byFamily.get(evaluation.candidate.familyId) ?? [];
    bucket.push(evaluation);
    byFamily.set(evaluation.candidate.familyId, bucket);
  }

  const selected: CandidateBacktestEvaluation[] = [];
  for (const bucket of byFamily.values()) {
    if (bucket[0]) {
      selected.push(bucket[0]);
    }
  }

  for (const evaluation of ranked) {
    if (selected.length >= params.limit) {
      break;
    }

    if (!selected.includes(evaluation)) {
      selected.push(evaluation);
    }
  }

  const usedFingerprints = new Set(params.seenFingerprints ?? []);

  return selected.slice(0, params.limit).flatMap((evaluation, candidateIndex) => {
    const family = params.families.find((item) => item.familyId === evaluation.candidate.familyId);
    const parameters = { ...evaluation.candidate.parameters };

    if (family && family.parameterSpecs.length > 0) {
      const spec = family.parameterSpecs[candidateIndex % family.parameterSpecs.length];
      const width = spec.max - spec.min;
      const current = parameters[spec.name];

      if (typeof current === "number" && Number.isFinite(current) && width > 0) {
        const step = Math.max(width * 0.05, width / 20);
        const direction = candidateIndex % 2 === 0 ? 1 : -1;
        let nextValue = clamp(current + step * direction, spec.min, spec.max);

        if (Math.abs(nextValue - current) < 1e-9) {
          nextValue = clamp(current - step * direction, spec.min, spec.max);
        }

        parameters[spec.name] = quantize(nextValue);
      }
    }

    const proposal = {
      candidateId: `${evaluation.candidate.familyId}-fallback-${String(params.iteration).padStart(2, "0")}-${String(candidateIndex + 1).padStart(2, "0")}`,
      familyId: evaluation.candidate.familyId,
      thesis: `Fallback diversified from ${evaluation.candidate.candidateId} after review failure.`,
      parameters,
      origin: "review_fallback" as const,
      parentCandidateIds: [
        ...(evaluation.candidate.parentCandidateIds ?? []),
        evaluation.candidate.candidateId
      ].slice(-8),
      invalidationSignals: [
        "repeat candidate without new edge",
        "trade count collapses",
        "net return falls below prior fallback source"
      ]
    };
    let fingerprint = candidateFingerprint(proposal);

    if (usedFingerprints.has(fingerprint)) {
      const familyDefinition = params.families.find((item) => item.familyId === proposal.familyId);
      const mutated = mutateCandidateToNovelVariant({
        candidate: {
          ...evaluation.candidate,
          candidateId: proposal.candidateId,
          parameters: proposal.parameters,
          thesis: proposal.thesis
        },
        family: familyDefinition,
        usedFingerprints,
        seed: params.iteration + candidateIndex,
        suffix: `fallback-novel-${String(params.iteration).padStart(2, "0")}`
      });

      if (mutated) {
        fingerprint = candidateFingerprint(mutated);
        usedFingerprints.add(fingerprint);
        return [{
          candidateId: mutated.candidateId,
          familyId: mutated.familyId,
          thesis: mutated.thesis,
          parameters: mutated.parameters,
          invalidationSignals: proposal.invalidationSignals
        }];
      }
    }

    usedFingerprints.add(fingerprint);
    return [proposal];
  });
}

function buildFallbackProposalBatch(params: {
  config: AutoResearchRunConfig;
  families: StrategyFamilyDefinition[];
  history: ResearchIterationRecord[];
}): ProposalBatch {
  const historicalEvaluations = params.history
    .flatMap((iteration) => iteration.evaluations)
    .filter((evaluation) => evaluation.status === "completed")
    .sort(compareEvaluations);

  const seenFamilies = new Set<string>();
  const seenFingerprints = new Set<string>();
  const candidates: CandidateProposal[] = [];

  for (const evaluation of historicalEvaluations) {
    if (candidates.length >= params.config.candidatesPerIteration) {
      break;
    }

    const family = params.families.find((item) => item.familyId === evaluation.candidate.familyId);
    if (!family || seenFamilies.has(family.familyId)) {
      continue;
    }

    const mutated = mutateCandidateToNovelVariant({
      candidate: evaluation.candidate,
      family,
      usedFingerprints: seenFingerprints,
      seed: candidates.length + params.history.length + 1,
      suffix: `proposal-fallback`
    });

    const baseCandidate = mutated ?? {
      ...evaluation.candidate,
      candidateId: `${family.familyId}-proposal-fallback-${String(candidates.length + 1).padStart(2, "0")}`,
      thesis: `Fallback continuation from ${evaluation.candidate.candidateId}.`,
      origin: "proposal_fallback" as const,
      parentCandidateIds: [
        ...(evaluation.candidate.parentCandidateIds ?? []),
        evaluation.candidate.candidateId
      ].slice(-8)
    };

    seenFamilies.add(family.familyId);
    seenFingerprints.add(candidateFingerprint(baseCandidate));
    candidates.push({
      candidateId: baseCandidate.candidateId,
      familyId: baseCandidate.familyId,
      thesis: baseCandidate.thesis,
      parameters: baseCandidate.parameters,
      origin: "proposal_fallback",
      parentCandidateIds: baseCandidate.parentCandidateIds,
      invalidationSignals: [
        "fallback candidate still produces zero trades",
        "window robustness degrades",
        "worst window turns sharply negative"
      ]
    });
  }

  for (const family of params.families) {
    if (candidates.length >= params.config.candidatesPerIteration) {
      break;
    }

    if (seenFamilies.has(family.familyId)) {
      continue;
    }

    candidates.push({
      candidateId: `${family.familyId}-proposal-fallback-${String(candidates.length + 1).padStart(2, "0")}`,
      familyId: family.familyId,
      thesis: `Bootstrap fallback candidate for ${family.familyId} using midpoint parameters.`,
      parameters: midpointParameters(family),
      origin: "proposal_fallback",
      invalidationSignals: [
        "still no trades after bootstrap fallback",
        "window robustness remains weak"
      ]
    });
  }

  return {
    researchSummary: "Proposal fallback built from historical best candidates and diversified family midpoints.",
    preparation: [],
    proposedFamilies: [],
    codeTasks: [],
    candidates
  };
}

function buildEngineAugmentedCandidates(params: {
  proposal: ProposalBatch;
  config: AutoResearchRunConfig;
  families: StrategyFamilyDefinition[];
  history: ResearchIterationRecord[];
  iteration: number;
  hiddenFamilyIds: Set<string>;
}): CandidateProposal[] {
  if (params.history.length === 0) {
    return [];
  }

  const representedFamilies = new Set(params.proposal.candidates.map((candidate) => candidate.familyId));
  const diversityTarget = Math.min(params.config.candidatesPerIteration, params.families.length);
  const shouldAugment =
    params.proposal.candidates.length < params.config.candidatesPerIteration ||
    representedFamilies.size < diversityTarget;

  if (!shouldAugment) {
    return [];
  }

  const historicalEvaluations = params.history
    .flatMap((iteration) => iteration.evaluations)
    .filter((evaluation) => evaluation.status === "completed")
    .sort(compareEvaluations);
  const usedFingerprints = new Set<string>([
    ...params.proposal.candidates.map((candidate) => candidateFingerprint(candidate)),
    ...historicalEvaluations.map((evaluation) => candidateFingerprint(evaluation.candidate))
  ]);
  const engineCandidates: CandidateProposal[] = [];
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
    if (!confirmFamilyId || representedFamilies.has(confirmFamilyId) || stagedConfirmFamilies.has(confirmFamilyId)) {
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

    if (params.hiddenFamilyIds.has(family.familyId)) {
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

function augmentProposalBatchWithEngineCandidates(params: {
  proposal: ProposalBatch;
  config: AutoResearchRunConfig;
  families: StrategyFamilyDefinition[];
  history: ResearchIterationRecord[];
  iteration: number;
  hiddenFamilyIds: Set<string>;
}): ProposalBatch {
  const engineCandidates = buildEngineAugmentedCandidates(params);

  if (engineCandidates.length === 0) {
    return params.proposal;
  }

  const mutationCount = engineCandidates.filter((candidate) => candidate.origin === "engine_mutation").length;
  const seedCount = engineCandidates.filter((candidate) => candidate.origin === "engine_seed").length;

  return {
    ...params.proposal,
    researchSummary: `${params.proposal.researchSummary} Engine augmentation added ${engineCandidates.length} candidates (${mutationCount} mutations, ${seedCount} seeds).`,
    candidates: [...params.proposal.candidates, ...engineCandidates]
  };
}

async function persistRunArtifacts(params: {
  outputDir: string;
  generatedAt: string;
  config: AutoResearchRunConfig;
  families: StrategyFamilyDefinition[];
  catalog: CatalogEntryRecord[];
  marketCodes: string[];
  iterations: ResearchIterationRecord[];
  outcome: AutoResearchRunOutcome;
  outcomeReason?: string;
  configRepairs: AutoResearchConfigRepair[];
  bestCandidate?: CandidateBacktestEvaluation;
  pendingProposal?: ProposalBatch;
  noTradeIterations: number;
  status?: AutoResearchStatus;
  liveEvaluations?: CandidateBacktestEvaluation[];
}): Promise<AutoResearchRunReport> {
  const state = {
    generatedAt: params.generatedAt,
    config: params.config,
    families: params.families,
    catalog: params.catalog,
    marketCodes: params.marketCodes,
    iterations: params.iterations,
    outcome: params.outcome,
    outcomeReason: params.outcomeReason,
    configRepairs: params.configRepairs,
    bestCandidate: params.bestCandidate,
    pendingProposal: params.pendingProposal,
    noTradeIterations: params.noTradeIterations
  };
  const report = toReport(state);
  const rawLeaderboard = buildLeaderboard(params.iterations, params.liveEvaluations);
  const leaderboard = buildUniqueLeaderboard(rawLeaderboard);
  const candidateLedger = buildCandidateLedger(params.iterations, params.liveEvaluations);
  const familySummary = buildFamilySummary(candidateLedger);
  const candidateGenealogy = buildCandidateGenealogy(params.iterations, params.liveEvaluations);

  await saveRunState(params.outputDir, state);
  await saveLeaderboard(params.outputDir, leaderboard);
  await saveLeaderboard(params.outputDir, rawLeaderboard, "leaderboard.raw.json");
  await saveJson(path.join(params.outputDir, "candidate-ledger.json"), candidateLedger);
  await saveJson(path.join(params.outputDir, "family-summary.json"), familySummary);
  await saveJson(path.join(params.outputDir, "candidate-genealogy.json"), candidateGenealogy);
  await saveJson(path.join(params.outputDir, "config-repairs.json"), params.configRepairs);
  await saveJson(path.join(params.outputDir, "report.json"), report);
  await writeFile(path.join(params.outputDir, "report.md"), summarizeMarkdown(report));
  await writeFile(
    path.join(params.outputDir, "report.html"),
    renderAutoResearchHtmlWithOptions(report, {
      status: params.status,
      leaderboard,
      rawLeaderboard,
      candidateLedger,
      familySummary,
      candidateGenealogy
    })
  );

  if (params.status) {
    await saveRunStatus(params.outputDir, params.status);
  }

  return report;
}

export function createAutoResearchOrchestrator(deps: {
  llmClient: ResearchLlmClient;
  evaluateCandidate?: (params: {
    config: AutoResearchRunConfig;
    candidate: NormalizedCandidateProposal;
    marketCodes: string[];
    outputDir: string;
  }) => Promise<CandidateBacktestEvaluation>;
  prepareActions?: (params: {
    outputDir: string;
    actions: ProposalBatch["preparation"];
    marketCodes: string[];
    universeName: string;
    defaultLimit: number;
    defaultMinCandles: number;
    allowDataCollection: boolean;
    allowFeatureCacheBuild: boolean;
  }) => Promise<PreparationExecutionResult[]>;
  codeAgent?: CodeAgent;
  discoverRuntimeScoredStrategies?: (cwd: string) => Promise<string[]>;
  resolveCandidateMarkets?: (params: {
    timeframe: AutoResearchRunConfig["timeframe"];
    minCandles: number;
    marketLimit: number;
  }) => Promise<string[]>;
  preloadReferenceCandles?: (params: {
    config: AutoResearchRunConfig;
    marketCodes: string[];
  }) => Promise<Candle[]>;
}) {
  const evaluateCandidate = deps.evaluateCandidate ?? (async ({ config, candidate, marketCodes, outputDir }) => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "fst-auto-research-worker-"));
    const payloadPath = path.join(tempDir, "payload.json");
    await writeFile(
      payloadPath,
      `${JSON.stringify({ config, candidate, marketCodes }, null, 2)}\n`
    );

    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        "pnpm",
        [
          "--filter",
          "@fst/backtester",
          "exec",
          "tsx",
          "src/auto-research/evaluate-worker.ts",
          "--payload",
          payloadPath
        ],
        {
          cwd: process.cwd(),
          stdio: ["ignore", "pipe", "pipe"]
        }
      );
      let out = "";
      let err = "";
      child.stdout.on("data", (chunk) => {
        out += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        err += String(chunk);
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) {
          resolve(out);
          return;
        }

        reject(new Error(err.trim() || out.trim() || `evaluate-worker failed with code ${code}`));
      });
    });

    const evaluation = JSON.parse(stdout) as CandidateBacktestEvaluation;
    await saveJson(path.join(outputDir, `${candidate.candidateId}.json`), evaluation);
    return evaluation;
  });
  const prepareActions = deps.prepareActions ?? executePreparationActions;
  const codeAgent = deps.codeAgent ?? new CliCodeMutationAgent();
  const discoverRuntimeStrategies = deps.discoverRuntimeScoredStrategies ?? discoverRuntimeScoredStrategyNames;
  const resolveCandidateMarkets =
    deps.resolveCandidateMarkets ??
    (async ({ timeframe, minCandles, marketLimit }) =>
      (
        await getCandidateMarketsWithMinimumCandles({
          timeframe,
          minCandles
        })
      )
        .map((item) => item.marketCode)
        .slice(0, Math.max(marketLimit * 3, marketLimit + 5)));
  const preloadReferenceCandles =
    deps.preloadReferenceCandles ??
    (async ({ config, marketCodes }) => {
      const preloaded = await preloadMarketData({
        timeframe: config.timeframe,
        limit: config.limit,
        holdoutDays: config.holdoutDays,
        universeName: config.universeName,
        universeMarketCodes: marketCodes
      });
      return preloaded.referenceCandles;
    });

  return {
    async run(inputConfig: AutoResearchRunConfig): Promise<AutoResearchRunReport> {
      const restored = inputConfig.resumeFrom ? await loadRunState(inputConfig.resumeFrom) : undefined;
      let config: AutoResearchRunConfig = restored?.config
        ? {
            ...restored.config,
            outputDir: inputConfig.outputDir,
            resumeFrom: inputConfig.resumeFrom,
            iterations: Math.max(restored.config.iterations, inputConfig.iterations),
            llmProvider: inputConfig.llmProvider ?? restored.config.llmProvider,
            llmModel: inputConfig.llmModel ?? restored.config.llmModel,
            llmTimeoutMs: inputConfig.llmTimeoutMs ?? restored.config.llmTimeoutMs,
            parallelism: inputConfig.parallelism ?? restored.config.parallelism,
            allowDataCollection: inputConfig.allowDataCollection || restored.config.allowDataCollection,
            allowFeatureCacheBuild: inputConfig.allowFeatureCacheBuild || restored.config.allowFeatureCacheBuild,
            allowCodeMutation: inputConfig.allowCodeMutation || restored.config.allowCodeMutation,
            minTradesForPromotion: inputConfig.minTradesForPromotion ?? restored.config.minTradesForPromotion,
            minNetReturnForPromotion:
              inputConfig.minNetReturnForPromotion ?? restored.config.minNetReturnForPromotion,
            maxDrawdownForPromotion:
              inputConfig.maxDrawdownForPromotion ?? restored.config.maxDrawdownForPromotion,
            minPositiveWindowRatioForPromotion:
              inputConfig.minPositiveWindowRatioForPromotion ??
              restored.config.minPositiveWindowRatioForPromotion,
            minRandomPercentileForPromotion:
              inputConfig.minRandomPercentileForPromotion ??
              restored.config.minRandomPercentileForPromotion,
            requireBootstrapSignificanceForPromotion:
              inputConfig.requireBootstrapSignificanceForPromotion ??
              restored.config.requireBootstrapSignificanceForPromotion,
            maxNoTradeIterations: inputConfig.maxNoTradeIterations ?? restored.config.maxNoTradeIterations
          }
        : inputConfig;
      const selectedFamilies = config.strategyFamilyIds
        ? getStrategyFamilies(config.strategyFamilyIds)
        : (restored?.families ?? getStrategyFamilies());
      const expandedFamilySelection = expandResearchFamilies(selectedFamilies);
      const hiddenFamilyIds = expandedFamilySelection.hiddenFamilyIds;
      const configuredFamilies = expandedFamilySelection.runtimeFamilies;
      let runtimeFamilies = mergeStrategyFamilies(
        restored?.catalog ? buildRuntimeFamilies(restored.catalog) : [],
        configuredFamilies
      );
      let abortRequested = false;
      let abortSignal: string | undefined;
      const handleAbort = (signal: NodeJS.Signals) => {
        abortRequested = true;
        abortSignal = signal;
      };

      if (runtimeFamilies.length === 0) {
        throw new Error("No strategy families selected for auto research");
      }

      await mkdir(config.outputDir, { recursive: true });
      await acquireRunLock(config.outputDir);

      try {
        await reconcilePartialRunStatus(config.outputDir);
        const limitResolution = repairAutoResearchLimit(config);
        config = limitResolution.config;
        const minCandles = Math.max(250, config.limit);
        const candidateMarketTarget = resolveCandidateMarketTarget({
          families: runtimeFamilies,
          marketLimit: config.marketLimit
        });
        const marketCodes = (await resolveCandidateMarkets({
          timeframe: config.timeframe,
          minCandles,
          marketLimit: config.marketLimit
        })).slice(0, candidateMarketTarget);

        if (marketCodes.length === 0) {
          throw new Error("No candidate markets available for auto research");
        }

        const iterations: ResearchIterationRecord[] = restored?.iterations ?? [];
        let outcome: AutoResearchRunOutcome = restored?.outcome ?? "completed";
        let outcomeReason = restored?.outcomeReason;
        const configRepairs: AutoResearchConfigRepair[] = restored?.configRepairs ?? [];
        let catalog: CatalogEntryRecord[] = refreshCatalogImplementations(
          restored?.catalog ?? createInitialCatalog(runtimeFamilies)
        );
        runtimeFamilies = mergeStrategyFamilies(buildRuntimeFamilies(catalog), configuredFamilies);
        let nextProposal: ProposalBatch | undefined = restored?.pendingProposal;
        let bestCandidate: CandidateBacktestEvaluation | undefined = restored?.bestCandidate;
        let noTradeIterations =
          restored?.noTradeIterations ??
          iterations.filter((iteration) => iteration.evaluations.every((evaluation) => evaluation.summary.tradeCount === 0)).length;

        const parallelism = Math.max(1, config.parallelism ?? config.candidatesPerIteration ?? 1);
        const log = async (message: string) => {
          console.error(message);
          await appendRunLog(config.outputDir, message);
        };
        process.once("SIGINT", handleAbort);
        process.once("SIGTERM", handleAbort);

        if (limitResolution.repaired) {
          await log(
            `[auto-research] limit-repair limit=${limitResolution.previousLimit}->${limitResolution.minimumLimit} timeframe=${config.timeframe} mode=${config.mode}`
          );
        }

        if (config.mode === "walk-forward") {
          const referenceCandles = await preloadReferenceCandles({
            config,
            marketCodes
          });
          const resolution = repairWalkForwardConfig({
            config,
            referenceCandles
          });

          if (resolution.repair) {
            config = resolution.config;
            configRepairs.push(resolution.repair);
            await log(
              `[auto-research] config-repair holdout=${resolution.repair.previous.holdoutDays}->${resolution.repair.next.holdoutDays} training=${resolution.repair.previous.trainingDays}->${resolution.repair.next.trainingDays} step=${resolution.repair.previous.stepDays}->${resolution.repair.next.stepDays} windows=${resolution.repair.next.expectedWindowCount}`
            );
          }

          if (resolution.invalidReason) {
            outcome = "invalid_config";
            outcomeReason = resolution.invalidReason;
            const invalidStatus: AutoResearchStatus = {
              updatedAt: new Date().toISOString(),
              phase: "invalid_config",
              iteration: iterations.length,
              totalIterations: config.iterations,
              message: resolution.invalidReason
            };
            const report = await persistRunArtifacts({
              outputDir: config.outputDir,
              generatedAt: new Date().toISOString(),
              config,
              families: runtimeFamilies,
              catalog,
              marketCodes,
              iterations,
              outcome,
              outcomeReason,
              configRepairs,
              bestCandidate,
              pendingProposal: nextProposal,
              noTradeIterations,
              status: invalidStatus
            });
            return report;
          }
        }

        await log(
          `[auto-research] start provider=${config.llmProvider ?? "codex"} model=${config.llmModel ?? "default"} iterations=${config.iterations} candidates=${config.candidatesPerIteration} parallelism=${parallelism}`
        );
        const startingStatus: AutoResearchStatus = {
          updatedAt: new Date().toISOString(),
          phase: "starting",
          iteration: iterations.length,
          totalIterations: config.iterations,
          message: "Auto research run started."
        };
        await persistRunArtifacts({
          outputDir: config.outputDir,
          generatedAt: new Date().toISOString(),
          config,
          families: runtimeFamilies,
          catalog,
          marketCodes,
          iterations,
          outcome,
          outcomeReason,
          configRepairs,
          bestCandidate,
          pendingProposal: nextProposal,
          noTradeIterations,
          status: startingStatus
        });

        const startIteration = iterations.length + 1;
        for (let iteration = startIteration; iteration <= config.iterations; iteration += 1) {
          if (abortRequested) {
            outcome = "aborted";
            outcomeReason = `Received ${abortSignal ?? "termination signal"}.`;
            break;
          }
          const proposalFamiliesForLlm = runtimeFamilies.filter((family) => !hiddenFamilyIds.has(family.familyId));
          await log(`[auto-research] iteration ${iteration}/${config.iterations} proposal`);
          const proposalStatus: AutoResearchStatus = {
            updatedAt: new Date().toISOString(),
            phase: "proposal",
            iteration,
            totalIterations: config.iterations,
            message: "Waiting for LLM proposal."
          };
          await saveRunStatus(config.outputDir, proposalStatus);
          let proposal: ProposalBatch;
          if (nextProposal) {
            proposal = nextProposal;
          } else {
            try {
              proposal = await withTimeout(
                deps.llmClient.proposeCandidates({
                  config,
                  families: proposalFamiliesForLlm,
                  marketCodes,
                  history: iterations
                }),
                config.llmTimeoutMs,
                "auto-research proposal"
              );
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              await log(`[auto-research] proposal-fallback ${message}`);
              proposal = buildFallbackProposalBatch({
                config,
                families: proposalFamiliesForLlm,
                history: iterations
              });
            }
          }
        catalog = mergeProposedFamilies(catalog, proposal.proposedFamilies);
        runtimeFamilies = mergeStrategyFamilies(buildRuntimeFamilies(catalog), configuredFamilies);
        await saveCatalogArtifact(config.outputDir, catalog);
        proposal = augmentProposalBatchWithEngineCandidates({
          proposal,
          config,
          families: runtimeFamilies,
          history: iterations,
          iteration,
          hiddenFamilyIds
        });
        const baseCandidates = dedupeCandidates(normalizeCandidates(proposal.candidates, runtimeFamilies));
        const novelCandidates = ensureNovelCandidates({
          candidates: baseCandidates,
          families: runtimeFamilies,
          iterations,
          iteration
        });
        const normalizedCandidates = topUpCandidatesForEvaluation({
          candidates: novelCandidates.length > 0 ? novelCandidates : baseCandidates,
          families: runtimeFamilies,
          iterations,
          iteration,
          limit: config.candidatesPerIteration
        });
        const diversifiedCandidates = selectDiversifiedCandidates(
          normalizedCandidates,
          config.candidatesPerIteration
        );
        await log(
          `[auto-research] iteration ${iteration}/${config.iterations} candidates=${diversifiedCandidates.length} families=${Array.from(new Set(diversifiedCandidates.map((candidate) => candidate.familyId))).join(",") || "none"}`
        );
        await log(
          `[auto-research] iteration ${iteration}/${config.iterations} preparation-actions=${
            proposal.preparation.length > 0
              ? proposal.preparation.map((action) => action.kind).join(",")
              : "none"
          }`
        );
        const preparationStatus: AutoResearchStatus = {
          updatedAt: new Date().toISOString(),
          phase: "preparation",
          iteration,
          totalIterations: config.iterations,
          message: `Preparation for ${diversifiedCandidates.length} candidates.`
        };
        await saveRunStatus(config.outputDir, preparationStatus);
        const preparationResults = await prepareActions({
          outputDir: path.join(config.outputDir, `iteration-${String(iteration).padStart(2, "0")}`),
          actions: proposal.preparation,
          marketCodes,
          universeName: config.universeName,
          defaultLimit: config.limit,
          defaultMinCandles: minCandles,
          allowDataCollection: config.allowDataCollection,
          allowFeatureCacheBuild: config.allowFeatureCacheBuild
        });
        await log(
          `[auto-research] iteration ${iteration}/${config.iterations} preparation-results executed=${
            preparationResults.filter((result) => result.status === "executed").length
          } skipped=${preparationResults.filter((result) => result.status === "skipped").length} failed=${
            preparationResults.filter((result) => result.status === "failed").length
          }`
        );
        const codeMutationResults = await codeAgent.execute({
          tasks: proposal.codeTasks,
          outputDir: path.join(
            config.outputDir,
            `iteration-${String(iteration).padStart(2, "0")}`,
            "code-agent"
          ),
          allowCodeMutation: config.allowCodeMutation,
          cwd: process.cwd(),
          provider: config.llmProvider,
          model: config.llmModel
        });
        const normalizedCodeMutationResults: CodeMutationExecutionResult[] = codeMutationResults.map((item) => ({
          taskId: item.task.taskId ?? item.task.title,
          familyId: item.task.familyId,
          strategyName: item.task.strategyName,
          title: item.task.title,
          status: item.status,
          detail: item.detail
        }));
        const validationResults: ValidationCommandResult[] = await runPostMutationValidation({
          outputDir: path.join(
            config.outputDir,
            `iteration-${String(iteration).padStart(2, "0")}`,
            "validation"
          ),
          cwd: process.cwd(),
          enabled: config.allowCodeMutation && codeMutationResults.some((item) => item.status === "executed")
        });
        const discoveredStrategyNames =
          config.allowCodeMutation && codeMutationResults.some((item) => item.status === "executed")
            ? await discoverRuntimeStrategies(process.cwd())
            : undefined;
        catalog = applyCodeMutationResultsToCatalog({
          catalog,
          codeMutationResults: normalizedCodeMutationResults,
          validationResults,
          discoveredStrategyNames
        });
        runtimeFamilies = mergeStrategyFamilies(buildRuntimeFamilies(catalog), configuredFamilies);
        await saveCatalogArtifact(config.outputDir, catalog);

        const evaluationStatusBase: AutoResearchStatus = {
          updatedAt: new Date().toISOString(),
          phase: "evaluation",
          iteration,
          totalIterations: config.iterations,
          message: `Evaluating ${diversifiedCandidates.length} candidates with parallelism ${parallelism}.`,
          completedCandidates: 0,
          candidateTotal: diversifiedCandidates.length,
          bestCandidateId: bestCandidate?.candidate.candidateId,
          bestNetReturn: bestCandidate?.summary.netReturn
        };
        await saveRunStatus(config.outputDir, evaluationStatusBase);
        const liveEvaluations: CandidateBacktestEvaluation[] = [];
        const evaluations = await runWithConcurrency(diversifiedCandidates, parallelism, async (candidate, index) => {
          await log(
            `[auto-research] iteration ${iteration}/${config.iterations} evaluate ${index + 1}/${diversifiedCandidates.length} ${candidate.candidateId}`
          );
          let evaluation: CandidateBacktestEvaluation;
          try {
            evaluation = await evaluateCandidate({
              config,
              candidate,
              marketCodes,
              outputDir: path.join(
                config.outputDir,
                `iteration-${String(iteration).padStart(2, "0")}`,
                "evaluations"
              )
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            evaluation = {
              candidate,
              mode: config.mode,
              status: "failed",
              failure: {
                stage: "worker",
                message
              },
              summary: {
                totalReturn: 0,
                grossReturn: 0,
                netReturn: 0,
                maxDrawdown: 0,
                turnover: 0,
                winRate: 0,
                avgHoldBars: 0,
                tradeCount: 0,
                feePaid: 0,
                slippagePaid: 0,
                rejectedOrdersCount: 0,
                cooldownSkipsCount: 0,
                signalCount: 0,
                ghostSignalCount: 0
              },
              diagnostics: {
                coverage: {
                  tradeCount: 0,
                  signalCount: 0,
                  ghostSignalCount: 0,
                  rejectedOrdersCount: 0,
                  cooldownSkipsCount: 0,
                  rawBuySignals: 0,
                  rawSellSignals: 0,
                  rawHoldSignals: 0,
                  avgUniverseSize: 0,
                  minUniverseSize: 0,
                  maxUniverseSize: 0,
                  avgConsideredBuys: 0,
                  avgEligibleBuys: 0
                },
                reasons: {
                  strategy: {},
                  strategyTags: {},
                  coordinator: {},
                  execution: {},
                  risk: {}
                },
                costs: {
                  feePaid: 0,
                  slippagePaid: 0,
                  totalCostsPaid: 0
                },
                robustness: {},
                crossChecks: [],
                windows: {
                  mode: config.mode,
                  holdoutDays: config.holdoutDays,
                  trainingDays: config.trainingDays,
                  stepDays: config.stepDays
                }
              }
            };
            await saveJson(
              path.join(
                config.outputDir,
                `iteration-${String(iteration).padStart(2, "0")}`,
                "evaluations",
                `${candidate.candidateId}.json`
              ),
              evaluation
            );
          }
          liveEvaluations.push(evaluation);
          liveEvaluations.sort(compareEvaluations);
          if (!bestCandidate || compareEvaluations(bestCandidate, liveEvaluations[0]) > 0) {
            bestCandidate = liveEvaluations[0];
          }
          const progressStatus: AutoResearchStatus = {
            updatedAt: new Date().toISOString(),
            phase: "evaluation",
            iteration,
            totalIterations: config.iterations,
            message: `Evaluated ${liveEvaluations.length}/${diversifiedCandidates.length} candidates.`,
            completedCandidates: liveEvaluations.length,
            candidateTotal: diversifiedCandidates.length,
            bestCandidateId: liveEvaluations[0]?.candidate.candidateId ?? bestCandidate?.candidate.candidateId,
            bestNetReturn: liveEvaluations[0]?.summary.netReturn ?? bestCandidate?.summary.netReturn
          };
          await persistRunArtifacts({
            outputDir: config.outputDir,
            generatedAt: new Date().toISOString(),
            config,
            families: runtimeFamilies,
            catalog,
            marketCodes,
            iterations,
            bestCandidate,
            pendingProposal: proposal,
            noTradeIterations,
            outcome,
            outcomeReason,
            configRepairs,
            status: progressStatus,
            liveEvaluations
          });
          await log(
            `[auto-research] iteration ${iteration}/${config.iterations} done ${candidate.candidateId} net=${evaluation.summary.netReturn} trades=${evaluation.summary.tradeCount}`
          );
          return evaluation;
        });
        evaluations.sort(compareEvaluations);
        if (!bestCandidate || (evaluations[0] && compareEvaluations(bestCandidate, evaluations[0]) > 0)) {
          bestCandidate = evaluations[0];
        }
        if (evaluations.every((evaluation) => evaluation.summary.tradeCount === 0)) {
          noTradeIterations += 1;
        } else {
          noTradeIterations = 0;
        }

        const reviewStatus: AutoResearchStatus = {
          updatedAt: new Date().toISOString(),
          phase: "review",
          iteration,
          totalIterations: config.iterations,
          message: "Waiting for LLM review."
        };
        await saveRunStatus(config.outputDir, reviewStatus);
        let review: ReviewDecision;
        let usedFallbackReview = false;
        const reviewFamiliesForLlm = runtimeFamilies.filter((family) => !hiddenFamilyIds.has(family.familyId));
        try {
          review = await withTimeout(
            deps.llmClient.reviewIteration({
              config,
              families: reviewFamiliesForLlm,
              history: iterations,
              latestProposal: proposal,
              preparationResults,
              codeMutationResults: normalizedCodeMutationResults,
              validationResults,
              evaluations
            }),
            config.llmTimeoutMs,
            "auto-research review"
          );
        } catch (error) {
          usedFallbackReview = true;
          const message = error instanceof Error ? error.message : String(error);
          await log(`[auto-research] review-fallback ${message}`);
          const fallbackCandidates = buildFallbackNextCandidates({
            evaluations,
            families: runtimeFamilies,
            limit: config.candidatesPerIteration,
            iteration,
            seenFingerprints: new Set(
              iterations.flatMap((record) =>
                record.evaluations.map((evaluation) => candidateFingerprint(evaluation.candidate))
              )
            )
          });
          review = {
            summary: `Fallback review after LLM failure: ${message}`,
            verdict: "keep_searching" as const,
            nextPreparation: [],
            proposedFamilies: proposal.proposedFamilies,
            codeTasks: [],
            nextCandidates:
              fallbackCandidates.length > 0
                ? fallbackCandidates
                : proposal.candidates.slice(0, config.candidatesPerIteration),
            retireCandidateIds: [],
            observations: [
              "LLM review unavailable; built diversified fallback candidates from current evaluations.",
              message
            ]
          };
        }
        review = governReviewDecision({
          review,
          evaluations,
          config,
          iteration,
          usedFallbackReview
        });
        review = ensureNextCandidatesForKeepSearching({
          review,
          evaluations,
          families: runtimeFamilies,
          limit: config.candidatesPerIteration,
          iteration,
          history: iterations
        });
        catalog = mergeProposedFamilies(catalog, review.proposedFamilies);
        catalog = refreshCatalogImplementations(catalog);
        runtimeFamilies = mergeStrategyFamilies(buildRuntimeFamilies(catalog), configuredFamilies);
        for (const retiredCandidateId of review.retireCandidateIds) {
          const retired = evaluations.find((item) => item.candidate.candidateId === retiredCandidateId);
          if (retired) {
            const catalogEntry = catalog.find((entry) => entry.familyId === retired.candidate.familyId);
            catalog = markCatalogFamilyState(
              catalog,
              retired.candidate.familyId,
              catalogEntry?.source === "llm" ? "discarded" : (catalogEntry?.state ?? "implemented"),
              `Candidate ${retiredCandidateId} retired by review.`
            );
          }
        }
        if (review.promotedCandidateId) {
          const promoted = evaluations.find((item) => item.candidate.candidateId === review.promotedCandidateId);
          if (promoted) {
            const canPromote = passesPromotionGate(promoted, promotionGateConfig(config));

            catalog = markCatalogFamilyState(
              catalog,
              promoted.candidate.familyId,
              canPromote ? "validated" : "implemented",
              canPromote
                ? `Candidate ${review.promotedCandidateId} promoted by review.`
                : `Candidate ${review.promotedCandidateId} blocked by promotion gate.`
            );
          }
        }
        await saveCatalogArtifact(config.outputDir, catalog);

        const record: ResearchIterationRecord = {
          iteration,
          proposal,
          preparationResults,
          codeMutationResults: normalizedCodeMutationResults,
          validationResults,
          evaluations,
          review: {
            ...review,
            observations: [
              ...review.observations,
              ...codeMutationResults.map((item) => `[code-agent:${item.status}] ${item.task.title}`)
            ]
          }
        };
        iterations.push(record);
        await saveJson(
          path.join(config.outputDir, `iteration-${String(iteration).padStart(2, "0")}.json`),
          record
        );
        await log(
          `[auto-research] iteration ${iteration}/${config.iterations} verdict=${review.verdict} best=${JSON.stringify(
            evaluations[0] ? summarizeEvaluationRanking(evaluations[0]) : {}
          )}`
        );
        const pendingProposal = review.verdict === "promote_candidate" || review.verdict === "stop_no_edge"
          ? undefined
          : {
              researchSummary: review.summary,
              preparation: review.nextPreparation,
              proposedFamilies: review.proposedFamilies,
              codeTasks: review.codeTasks,
              candidates: review.nextCandidates
            };
        await persistRunArtifacts({
          outputDir: config.outputDir,
          generatedAt: new Date().toISOString(),
          config,
          families: runtimeFamilies,
          catalog,
          marketCodes,
          iterations,
          outcome,
          outcomeReason,
          configRepairs,
          bestCandidate,
          pendingProposal,
          noTradeIterations,
          status: {
            updatedAt: new Date().toISOString(),
            phase: review.verdict === "promote_candidate" || review.verdict === "stop_no_edge" ? "completed" : "review",
            iteration,
            totalIterations: config.iterations,
            message:
              review.verdict === "promote_candidate" || review.verdict === "stop_no_edge"
                ? `Run stopped with verdict ${review.verdict}.`
                : `Iteration ${iteration} completed.`
          }
        });

        if (review.verdict === "promote_candidate" || review.verdict === "stop_no_edge") {
          outcome = "completed";
          outcomeReason = `Run stopped with verdict ${review.verdict}.`;
          if (review.promotedCandidateId) {
            bestCandidate = evaluations.find(
              (evaluation) => evaluation.candidate.candidateId === review.promotedCandidateId
            ) ?? bestCandidate;
          }
          break;
        }

        nextProposal = {
          researchSummary: review.summary,
          preparation: review.nextPreparation,
          proposedFamilies: review.proposedFamilies,
          codeTasks: review.codeTasks,
          candidates: review.nextCandidates
        };

        if (config.maxNoTradeIterations !== undefined && config.maxNoTradeIterations > 0 && noTradeIterations >= config.maxNoTradeIterations) {
          outcome = "completed";
          outcomeReason = `Run stopped after ${noTradeIterations} no-trade iterations.`;
          break;
        }
        }

        if (abortRequested && outcome !== "aborted") {
          outcome = "aborted";
          outcomeReason = `Received ${abortSignal ?? "termination signal"}.`;
        }

        if (
          outcome === "completed" &&
          iterations.length < config.iterations &&
          outcomeReason === undefined
        ) {
          outcome = "partial";
          outcomeReason = "Run ended before consuming all configured iterations.";
        }

        const report = toReport({
          generatedAt: new Date().toISOString(),
          config,
          families: runtimeFamilies,
          catalog,
          marketCodes,
          iterations,
          outcome,
          outcomeReason,
          configRepairs,
          bestCandidate,
          pendingProposal: undefined,
          noTradeIterations
        });

        await persistRunArtifacts({
          outputDir: config.outputDir,
          generatedAt: report.generatedAt,
          config,
          families: runtimeFamilies,
          catalog,
          marketCodes,
          iterations,
          outcome,
          outcomeReason,
          configRepairs,
          bestCandidate,
          pendingProposal: nextProposal,
          noTradeIterations,
          status: {
            updatedAt: new Date().toISOString(),
            phase: outcome,
            iteration: report.iterations.length,
            totalIterations: config.iterations,
            message: outcomeReason ?? "Auto research run completed."
          }
        });
        await saveRunStatus(config.outputDir, {
          updatedAt: new Date().toISOString(),
          phase: outcome,
          iteration: report.iterations.length,
          totalIterations: config.iterations,
          message: outcomeReason ?? "Auto research run completed."
        });

        return report;
      } finally {
        process.removeListener("SIGINT", handleAbort);
        process.removeListener("SIGTERM", handleAbort);
        await releaseRunLock(config.outputDir);
      }
    }
  };
}
