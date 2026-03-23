import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  getSelectedUniverseMarkets,
  getSelectedUniverseMarketsWithMinimumCandles,
  getCandidateMarketsWithMinimumCandles,
  loadCandlesForMarkets
} from "../db.js";
import { evaluateBlockCandidate } from "./block-evaluator.js";
import { preloadMarketData } from "../scored-runner.js";
import type { StrategyTimeframe } from "../../../../packages/shared/src/index.js";
import type { Candle } from "../types.js";
import { getStrategyFamilies, normalizeCandidateProposal } from "./catalog.js";
import { CliCodeMutationAgent, type CodeAgent } from "./code-agent.js";
import { executeCodeMutationInWorktree, readWorktreePatch } from "./code-worktree.js";
import { prepareExperimentKernel } from "./experiment-kernel.js";
import { generateHypothesisProposal } from "./hypothesis-orchestrator.js";
import {
  applyCodeMutationResultsToCatalog,
  buildRuntimeFamilies,
  createInitialCatalog,
  markCatalogFamilyState,
  mergeProposedFamilies,
  refreshCatalogImplementations,
  saveCatalogArtifact
} from "./proposed-catalog.js";
import { getBlockFamilyDefinitions } from "./block-families.js";
import {
  appendValidatedBlock,
  createEmptyBlockCatalog,
  loadValidatedBlockCatalogFromFile,
  promoteToValidatedBlock,
  saveValidatedBlockCatalog
} from "./block-catalog.js";
import { writeAutoResearchArtifactAudit } from "../audit-auto-research.js";
import { getBlockFamilyById } from "./block-families.js";
import { getPortfolioCompositionFamilies } from "./portfolio-composition-families.js";
import type {
  AutoResearchConfigRepair,
  AutoResearchRunConfig,
  AutoResearchRunOutcome,
  AutoResearchRunReport,
  AutoResearchRunVerification,
  CandidateBacktestEvaluation,
  CodeMutationExecutionResult,
  CatalogEntryRecord,
  CandidateProposal,
  ExperimentPlan,
  NormalizedCandidateProposal,
  PreparationExecutionResult,
  ProposalBatch,
  ResearchHypothesis,
  ResearchLineage,
  ResearchIterationRecord,
  ReviewDecision,
  StrategyFamilyDefinition,
  ValidatedBlockCatalog,
  ValidationCommandResult
} from "./types.js";
import type { ResearchLlmClient } from "./llm-adapter.js";
import { executePreparationActions } from "./preparation.js";
import { acquireRunLock, appendRunLog, loadRunState, reconcilePartialRunStatus, releaseRunLock, saveLeaderboard, saveRunState, saveRunStatus, toReport, type AutoResearchStatus } from "./run-manager.js";
import {
  appendLineageEvent,
  buildLineageSnapshot,
  loadOrCreateResearchLineage,
  saveLineageSnapshot,
  updateResearchLineageFromIterations
} from "./lineage-store.js";
import { generateIterationReview } from "./research-review.js";
import { renderAutoResearchHtmlWithOptions } from "./report-html.js";
import { runPostMutationValidation } from "./validation.js";
import { autoPromoteAndLog } from "./auto-promote.js";
import { discoverRuntimeScoredStrategyNames } from "./runtime-discovery.js";
import { repairWalkForwardConfig } from "./walk-forward-config.js";
import { calculateAutoResearchMinimumLimit, repairAutoResearchLimit } from "./limit-resolution.js";
import {
  calculateCandidateRiskAdjustedScore,
  compareCandidateEvaluations,
  passesPromotionGate,
  summarizeEvaluationRanking
} from "./ranking.js";
import {
  MULTI_TF_REGIME_SWITCH_PORTFOLIO
} from "./portfolio-runtime.js";

function createSafeAppendLineageEvent(log: (msg: string) => Promise<void>) {
  return async (params: Parameters<typeof appendLineageEvent>[0]): Promise<void> => {
    try {
      await appendLineageEvent(params);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await log(`[auto-research] lineage event write failed: ${message}`);
    }
  };
}

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

const DEFAULT_CANDIDATE_DIVERSIFICATION_MIN_DISTANCE = 0.08;

type ArtifactSeedSnapshot = {
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

function defaultOutcomeMessage(outcome: AutoResearchRunOutcome): string {
  switch (outcome) {
    case "completed":
      return "Auto research run completed.";
    case "partial":
      return "Auto research run ended without reaching a promotable terminal outcome.";
    case "failed":
      return "Auto research run failed.";
    case "aborted":
      return "Auto research run aborted.";
    case "invalid_config":
      return "Auto research run has an invalid configuration.";
    default:
      return "Auto research run finished.";
  }
}

async function runShellCommand(command: string, cwd: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return await new Promise((resolve, reject) => {
    const child = spawn("bash", ["-lc", command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}

async function applyWorktreePatchToWorkspace(params: {
  patchPath?: string;
  repoRoot: string;
}): Promise<{ status: "applied" | "skipped" | "failed"; detail: string }> {
  const patchText = await readWorktreePatch(params.patchPath);
  if (!patchText || patchText.trim().length === 0) {
    return {
      status: "skipped",
      detail: "No patch generated from worktree execution."
    };
  }

  const escapedPath = params.patchPath!.replace(/'/g, "'\\''");
  const result = await runShellCommand(`git apply --index --whitespace=nowarn '${escapedPath}'`, params.repoRoot);
  if (result.code !== 0) {
    return {
      status: "failed",
      detail: result.stderr.trim() || result.stdout.trim() || "git apply failed"
    };
  }

  return {
    status: "applied",
    detail: "Applied benchmarked worktree patch back to the main workspace."
  };
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
  researchStage?: string;
}): number {
  const safeMarketLimit = Math.max(1, params.marketLimit);

  // Block stage: single-strategy evaluation needs fewer markets
  if (params.researchStage === "block") {
    return Math.max(safeMarketLimit, safeMarketLimit + 2);
  }

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

function normalizeCandidateRequirementTimeframe(timeframe: StrategyTimeframe): StrategyTimeframe {
  return timeframe === "15m" ? "5m" : timeframe;
}

function isCandidateRequirementTimeframe(value: string): value is StrategyTimeframe {
  return value === "1m" || value === "5m" || value === "15m" || value === "1h" || value === "1d";
}

export function resolveCandidateMarketRequirements(params: {
  config: AutoResearchRunConfig;
  families: StrategyFamilyDefinition[];
}): Array<{ timeframe: StrategyTimeframe; minCandles: number }> {
  const primaryTimeframe = normalizeCandidateRequirementTimeframe(params.config.timeframe);
  const requirementsByTimeframe = new Map<StrategyTimeframe, number>([
    [primaryTimeframe, Math.max(250, params.config.limit)]
  ]);

  for (const family of params.families) {
    const requiredTimeframes = (family.requiredData ?? [family.timeframe])
      .filter(isCandidateRequirementTimeframe)
      .map((timeframe) => normalizeCandidateRequirementTimeframe(timeframe));

    for (const timeframe of requiredTimeframes) {
      const minCandles = timeframe === primaryTimeframe
        ? Math.max(250, params.config.limit)
        : calculateAutoResearchMinimumLimit({
            timeframe,
            holdoutDays: params.config.holdoutDays,
            trainingDays: params.config.trainingDays,
            stepDays: params.config.stepDays,
            mode: params.config.mode
          });
      const current = requirementsByTimeframe.get(timeframe) ?? 0;
      requirementsByTimeframe.set(timeframe, Math.max(current, minCandles));
    }
  }

  return Array.from(requirementsByTimeframe.entries()).map(([timeframe, minCandles]) => ({
    timeframe,
    minCandles
  }));
}

async function resolveUniverseCandidateMarkets(params: {
  universeName: string;
  requirements: Array<{ timeframe: StrategyTimeframe; minCandles: number }>;
}): Promise<string[]> {
  const orderedMarkets = await getSelectedUniverseMarkets({ universeName: params.universeName });
  if (orderedMarkets.length === 0) {
    return [];
  }

  const eligibleByTimeframe = await Promise.all(
    params.requirements.map(async (requirement) => {
      const markets = await getSelectedUniverseMarketsWithMinimumCandles({
        universeName: params.universeName,
        timeframe: requirement.timeframe,
        minCandles: requirement.minCandles
      });
      return new Set(markets.map((item) => item.marketCode));
    })
  );

  return orderedMarkets.filter((marketCode) =>
    eligibleByTimeframe.every((eligible) => eligible.has(marketCode))
  );
}

async function resolveFallbackCandidateMarkets(params: {
  requirements: Array<{ timeframe: StrategyTimeframe; minCandles: number }>;
}): Promise<string[]> {
  if (params.requirements.length === 0) {
    return [];
  }

  const eligibleLists = await Promise.all(
    params.requirements.map(async (requirement) =>
      getCandidateMarketsWithMinimumCandles({
        timeframe: requirement.timeframe,
        minCandles: requirement.minCandles
      })
    )
  );

  const [primary, ...rest] = eligibleLists;
  const fallbackSets = rest.map((items) => new Set(items.map((item) => item.marketCode)));

  return primary
    .map((item) => item.marketCode)
    .filter((marketCode) => fallbackSets.every((eligible) => eligible.has(marketCode)));
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

// Review governance functions are in research-review.ts — called via generateIterationReview()

function normalizeCandidates(
  proposals: CandidateProposal[],
  familyIds: ReturnType<typeof getStrategyFamilies>
): NormalizedCandidateProposal[] {
  return proposals.map((proposal, index) => normalizeCandidateProposal(proposal, familyIds, index));
}

// toReviewProposalBatch is in research-review.ts

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
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tempPath, filePath);
}

function classifyEvaluationFailureStage(
  message: string
): NonNullable<CandidateBacktestEvaluation["failure"]>["stage"] {
  if (/worker|result\.json|unexpected end of json|enoent|eperm|pipe/i.test(message)) {
    return "worker";
  }

  if (/window|split/i.test(message)) {
    return "split";
  }

  if (/candle|market|load/i.test(message)) {
    return "preload";
  }

  return "backtest";
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

function snapshotFromArtifactNode(node: unknown, sourcePath: string): ArtifactSeedSnapshot | undefined {
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

function getStepFraction(iteration?: number): number {
  if (iteration === undefined || iteration <= 3) return 0.10;
  if (iteration <= 6) return 0.15;
  return 0.25;
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
  iteration?: number;
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

    const stepFraction = portfolioFamily ? 0.1 : getStepFraction(params.iteration);
    const step = Math.max(width * stepFraction, width / (portfolioFamily ? 10 : 20));

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
  families: StrategyFamilyDefinition[],
  limit: number,
  minDistance = DEFAULT_CANDIDATE_DIVERSIFICATION_MIN_DISTANCE
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
    const sameFamilyPool = remaining.filter((candidate) => selected.some((picked) => picked.familyId === candidate.familyId));
    const candidatePool = sameFamilyPool.length > 0 ? sameFamilyPool : remaining;
    const distantPool = candidatePool.filter((candidate) => {
      const sameFamilySelected = selected.filter((picked) => picked.familyId === candidate.familyId);
      if (sameFamilySelected.length === 0) {
        return true;
      }

      const closestDistance = Math.min(
        ...sameFamilySelected.map((picked) => calculateCandidateParameterDistance(candidate, picked, familyMap))
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
            ...sameFamilySelected.map((picked) => calculateCandidateParameterDistance(candidate, picked, familyMap))
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

async function buildArtifactSeedCandidates(params: {
  config: AutoResearchRunConfig;
  families: StrategyFamilyDefinition[];
  hiddenFamilyIds: Set<string>;
  usedFingerprints: Set<string>;
  iteration: number;
}): Promise<CandidateProposal[]> {
  const seedPaths = (params.config.seedArtifactPaths ?? []).filter(Boolean);
  if (seedPaths.length === 0) {
    return [];
  }

  const seedBudget = Math.min(
    params.config.candidatesPerIteration,
    Math.max(1, params.config.seedCandidatesPerIteration ?? Math.ceil(params.config.candidatesPerIteration / 2))
  );
  if (seedBudget <= 0) {
    return [];
  }

  const eligibleFamilies = params.families.filter((family) => !params.hiddenFamilyIds.has(family.familyId));
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

      const artifactSlug = path.basename(snapshot.sourcePath).replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "seed";
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
  const diversified = selectDiversifiedCandidates(
    rankedCandidates,
    eligibleFamilies,
    seedBudget,
    params.config.candidateDiversificationMinDistance ?? DEFAULT_CANDIDATE_DIVERSIFICATION_MIN_DISTANCE
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

async function buildEngineAugmentedCandidates(params: {
  proposal: ProposalBatch;
  config: AutoResearchRunConfig;
  families: StrategyFamilyDefinition[];
  history: ResearchIterationRecord[];
  iteration: number;
  hiddenFamilyIds: Set<string>;
}): Promise<CandidateProposal[]> {
  const representedFamilies = new Set(params.proposal.candidates.map((candidate) => candidate.familyId));
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

  const diversityTarget = Math.min(params.config.candidatesPerIteration, params.families.length);
  const shouldAugment =
    engineCandidates.length < params.config.candidatesPerIteration &&
    (
      params.proposal.candidates.length < params.config.candidatesPerIteration ||
      representedFamilies.size < diversityTarget
    );

  if (!shouldAugment) {
    return engineCandidates;
  }
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

async function augmentProposalBatchWithEngineCandidates(params: {
  proposal: ProposalBatch;
  config: AutoResearchRunConfig;
  families: StrategyFamilyDefinition[];
  history: ResearchIterationRecord[];
  iteration: number;
  hiddenFamilyIds: Set<string>;
}): Promise<ProposalBatch> {
  const engineCandidates = await buildEngineAugmentedCandidates(params);

  if (engineCandidates.length === 0) {
    return params.proposal;
  }

  const artifactSeedCount = engineCandidates.filter((candidate) => candidate.origin === "artifact_seed").length;
  const mutationCount = engineCandidates.filter((candidate) => candidate.origin === "engine_mutation").length;
  const seedCount = engineCandidates.filter((candidate) => candidate.origin === "engine_seed").length;
  const artifactSeeds = engineCandidates.filter((candidate) => candidate.origin === "artifact_seed");
  const runtimeSeeds = engineCandidates.filter((candidate) => candidate.origin !== "artifact_seed");

  return {
    ...params.proposal,
    researchSummary: `${params.proposal.researchSummary} Engine augmentation added ${engineCandidates.length} candidates (${artifactSeedCount} artifact seeds, ${mutationCount} mutations, ${seedCount} seeds).`,
    candidates: [...artifactSeeds, ...params.proposal.candidates, ...runtimeSeeds]
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
  lineage?: ResearchLineage;
  verification?: AutoResearchRunVerification;
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
    noTradeIterations: params.noTradeIterations,
    lineage: params.lineage,
    verification: params.verification
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
  if (params.lineage) {
    const snapshot = buildLineageSnapshot({
      iterations: params.iterations,
      config: params.config,
      savedAt: params.generatedAt
    });
    await saveLineageSnapshot(params.outputDir, snapshot);
  }
  const reportMarkdownPath = path.join(params.outputDir, "report.md");
  const reportHtmlPath = path.join(params.outputDir, "report.html");
  const reportMarkdownTempPath = `${reportMarkdownPath}.${process.pid}.${Date.now()}.tmp`;
  const reportHtmlTempPath = `${reportHtmlPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(reportMarkdownTempPath, summarizeMarkdown(report));
  await rename(reportMarkdownTempPath, reportMarkdownPath);
  await writeFile(
    reportHtmlTempPath,
    renderAutoResearchHtmlWithOptions(report, {
      status: params.status,
      leaderboard,
      rawLeaderboard,
      candidateLedger,
      familySummary,
      candidateGenealogy
    })
  );
  await rename(reportHtmlTempPath, reportHtmlPath);

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
    universeName: string;
    families: StrategyFamilyDefinition[];
    config: AutoResearchRunConfig;
  }) => Promise<string[]>;
  preloadReferenceCandles?: (params: {
    config: AutoResearchRunConfig;
    marketCodes: string[];
  }) => Promise<Candle[]>;
}) {
  const evaluateCandidate = deps.evaluateCandidate ?? (async ({ config, candidate, marketCodes, outputDir }) => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "fst-auto-research-worker-"));
    const payloadPath = path.join(tempDir, "payload.json");
    const workerPath = path.resolve(process.cwd(), "src/auto-research/evaluate-worker.ts");
    const resultPath = path.join(tempDir, "result.json");

    try {
      await writeFile(
        payloadPath,
        `${JSON.stringify({ config, candidate, marketCodes }, null, 2)}\n`
      );

      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            "--import",
            "tsx",
            workerPath,
            "--payload",
            payloadPath,
            "--output",
            resultPath
          ],
          {
            cwd: process.cwd(),
            stdio: ["ignore", "ignore", "pipe"]
          }
        );
        let err = "";
        child.stderr.on("data", (chunk) => {
          err += String(chunk);
        });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) {
            resolve();
            return;
          }

          reject(new Error(err.trim() || `evaluate-worker failed with code ${code}`));
        });
      });

      let stdout: string;
      try {
        stdout = await readFile(resultPath, "utf8");
      } catch (error) {
        throw new Error(`worker output unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }

      let evaluation: CandidateBacktestEvaluation;
      try {
        evaluation = JSON.parse(stdout) as CandidateBacktestEvaluation;
      } catch (error) {
        throw new Error(`worker output invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
      }

      await saveJson(path.join(outputDir, `${candidate.candidateId}.json`), evaluation);
      return evaluation;
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
  // Block stage: in-process evaluation with lazy candle loading per timeframe group.
  // Candidates are grouped by required timeframes so each group loads only the data
  // it needs, then releases it before the next group runs.
  type CandleMap = Record<string, Candle[]>;

  function getBlockCandidateRequiredTimeframes(familyId: string): StrategyTimeframe[] {
    try {
      const def = getBlockFamilyById(familyId);
      return (def.requiredData ?? [def.timeframe]) as StrategyTimeframe[];
    } catch {
      return ["1h", "5m"];
    }
  }

  function blockCandidateNeeds1m(familyId: string): boolean {
    return getBlockCandidateRequiredTimeframes(familyId).includes("1m");
  }

  function groupCandidatesByTimeframes(
    candidates: NormalizedCandidateProposal[]
  ): Map<string, NormalizedCandidateProposal[]> {
    const groups = new Map<string, NormalizedCandidateProposal[]>();
    for (const c of candidates) {
      const tfs = getBlockCandidateRequiredTimeframes(c.familyId).slice().sort().join("+");
      const bucket = groups.get(tfs) ?? [];
      bucket.push(c);
      groups.set(tfs, bucket);
    }
    return groups;
  }

  // E2: Inter-iteration candle cache — data doesn't change between iterations
  const candleCache = new Map<string, CandleMap>();

  async function loadCandlesForTimeframes(params: {
    timeframes: StrategyTimeframe[];
    marketCodes: string[];
    config: AutoResearchRunConfig;
  }): Promise<Partial<Record<StrategyTimeframe, CandleMap>>> {
    const loadLimit = (tf: StrategyTimeframe) =>
      calculateAutoResearchMinimumLimit({
        timeframe: tf,
        holdoutDays: params.config.holdoutDays,
        trainingDays: params.config.trainingDays,
        stepDays: params.config.stepDays,
        mode: params.config.mode
      });
    const needs1h = params.timeframes.includes("1h");
    const needs5m = params.timeframes.includes("5m") || params.timeframes.includes("15m");
    const needs1m = params.timeframes.includes("1m");

    const loadOrCache = async (tf: StrategyTimeframe, marketCodes: string[], limit: number): Promise<CandleMap> => {
      const cacheKey = `${tf}:${limit}:${marketCodes.slice().sort().join(",")}`;
      const cached = candleCache.get(cacheKey);
      if (cached) return cached;
      const data = await loadCandlesForMarkets({ marketCodes, timeframe: tf, limit }) as CandleMap;
      candleCache.set(cacheKey, data);
      return data;
    };

    // 1m: cap to 6 months + fewer markets — scalping doesn't need long history
    const MAX_1M_CANDLES = 180 * 24 * 60;
    const marketCodes1m = needs1m
      ? params.marketCodes.slice(0, Math.min(params.marketCodes.length, Math.max(params.config.marketLimit, 3)))
      : [];
    const limit1m = needs1m ? Math.min(loadLimit("1m"), MAX_1M_CANDLES) : 0;
    const [candles1h, candles5m, candles1m] = await Promise.all([
      needs1h ? loadOrCache("1h", params.marketCodes, Math.max(params.config.limit, loadLimit("1h"))) : Promise.resolve({} as CandleMap),
      needs5m ? loadOrCache("5m", params.marketCodes, loadLimit("5m")) : Promise.resolve({} as CandleMap),
      needs1m ? loadOrCache("1m", marketCodes1m, limit1m) : Promise.resolve({} as CandleMap)
    ]);
    const result: Partial<Record<StrategyTimeframe, CandleMap>> = {};
    if (needs1h) result["1h"] = candles1h;
    if (needs5m) result["5m"] = candles5m;
    if (needs1m) result["1m"] = candles1m;
    return result;
  }

  function createCandleLoaderFromCache(cache: Partial<Record<StrategyTimeframe, CandleMap>>): typeof loadCandlesForMarkets {
    return async (params) => {
      const cached = cache[params.timeframe as StrategyTimeframe];
      if (cached) {
        const result: CandleMap = {};
        for (const code of params.marketCodes) {
          if (cached[code]) result[code] = cached[code];
        }

        if (Object.keys(result).length === params.marketCodes.length) {
          return result;
        }
      }
      return loadCandlesForMarkets(params);
    };
  }

  async function evaluateBlockCandidatesInProcess(params: {
    config: AutoResearchRunConfig;
    candidates: NormalizedCandidateProposal[];
    marketCodes: string[];
    outputDir: string;
    log: (msg: string) => Promise<void>;
    iteration: number;
    onEvaluated: (evaluation: CandidateBacktestEvaluation, index: number) => Promise<void>;
  }): Promise<CandidateBacktestEvaluation[]> {
    const groups = groupCandidatesByTimeframes(params.candidates);
    const resultMap = new Map<string, CandidateBacktestEvaluation>();
    let globalIndex = 0;

    for (const [tfKey, groupCandidates] of groups) {
      const timeframes = tfKey.split("+") as StrategyTimeframe[];
      await params.log(`[auto-research] loading candles for timeframes=[${tfKey}] (${groupCandidates.length} candidates)`);
      const cache = await loadCandlesForTimeframes({
        timeframes,
        marketCodes: params.marketCodes,
        config: params.config
      });
      const loader = createCandleLoaderFromCache(cache);

      for (const candidate of groupCandidates) {
        const idx = globalIndex;
        globalIndex += 1;
        await params.log(
          `[auto-research] iteration ${params.iteration}/${params.config.iterations} evaluate ${idx + 1}/${params.candidates.length} ${candidate.candidateId}`
        );
        let evaluation: CandidateBacktestEvaluation;
        try {
          evaluation = await evaluateBlockCandidate({
            config: params.config,
            candidate,
            marketCodes: params.marketCodes,
            loadCandles: loader
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          evaluation = buildBlockFailedEvaluation(params.config, candidate, message);
        }
        await saveJson(path.join(params.outputDir, `${candidate.candidateId}.json`), evaluation);
        resultMap.set(candidate.candidateId, evaluation);
        await params.onEvaluated(evaluation, idx);
      }
      // Release candle data for this group before loading next
      for (const tf of Object.keys(cache) as StrategyTimeframe[]) {
        delete cache[tf];
      }
      if (global.gc) global.gc();
    }

    // Return in original candidate order
    return params.candidates.map((c) => resultMap.get(c.candidateId)!);
  }

  function buildBlockFailedEvaluation(
    config: AutoResearchRunConfig,
    candidate: NormalizedCandidateProposal,
    message: string
  ): CandidateBacktestEvaluation {
    return {
      candidate,
      mode: config.mode,
      status: "failed",
      failure: {
        stage: classifyEvaluationFailureStage(message),
        message
      },
      summary: {
        totalReturn: 0, grossReturn: 0, netReturn: 0, maxDrawdown: 0, turnover: 0, winRate: 0,
        avgHoldBars: 0, tradeCount: 0, feePaid: 0, slippagePaid: 0, rejectedOrdersCount: 0,
        cooldownSkipsCount: 0, signalCount: 0, ghostSignalCount: 0
      },
      diagnostics: {
        coverage: {
          tradeCount: 0, signalCount: 0, ghostSignalCount: 0, rejectedOrdersCount: 0,
          cooldownSkipsCount: 0, rawBuySignals: 0, rawSellSignals: 0, rawHoldSignals: 0,
          avgUniverseSize: 0, minUniverseSize: 0, maxUniverseSize: 0, avgConsideredBuys: 0, avgEligibleBuys: 0
        },
        reasons: { strategy: {}, strategyTags: {}, coordinator: {}, execution: {}, risk: {} },
        costs: { feePaid: 0, slippagePaid: 0, totalCostsPaid: 0 },
        robustness: {},
        crossChecks: [],
        windows: { mode: config.mode, holdoutDays: config.holdoutDays, trainingDays: config.trainingDays, stepDays: config.stepDays }
      }
    };
  }

  const prepareActions = deps.prepareActions ?? executePreparationActions;
  const codeAgent = deps.codeAgent ?? new CliCodeMutationAgent();
  const discoverRuntimeStrategies = deps.discoverRuntimeScoredStrategies ?? discoverRuntimeScoredStrategyNames;
  const resolveCandidateMarkets =
    deps.resolveCandidateMarkets ??
    (async ({ universeName, families, config }) => {
      const requirements = resolveCandidateMarketRequirements({
        config,
        families
      });
      const universeMarkets = await resolveUniverseCandidateMarkets({
        universeName,
        requirements
      });

      if (universeMarkets.length > 0) {
        return universeMarkets;
      }

      return resolveFallbackCandidateMarkets({ requirements });
    });
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
            maxNoTradeIterations: inputConfig.maxNoTradeIterations ?? restored.config.maxNoTradeIterations,
            seedArtifactPaths: inputConfig.seedArtifactPaths ?? restored.config.seedArtifactPaths,
            seedCandidatesPerIteration:
              inputConfig.seedCandidatesPerIteration ?? restored.config.seedCandidatesPerIteration,
            candidateDiversificationMinDistance:
              inputConfig.candidateDiversificationMinDistance ??
              restored.config.candidateDiversificationMinDistance,
            loopVersion: inputConfig.loopVersion ?? restored.config.loopVersion
          }
        : inputConfig;
      config = {
        ...config,
        loopVersion: config.loopVersion ?? "v1"
      };
      const originalStage = config.researchStage;
      if (config.researchStage === "auto") {
        config = { ...config, researchStage: "block" };
      }

      let blockCatalog: ValidatedBlockCatalog | undefined;
      let selectedFamilies: StrategyFamilyDefinition[];

      if (config.researchStage === "block") {
        // Block stage: use shorter walk-forward windows for more statistical power.
        // Default holdout=365 yields only 2 windows; holdout=90 yields ~12 windows.
        if (config.holdoutDays >= 365) {
          config = {
            ...config,
            holdoutDays: 90,
            trainingDays: config.trainingDays && config.trainingDays < 365 ? config.trainingDays : 180,
            stepDays: config.stepDays && config.stepDays < 365 ? config.stepDays : 90
          };
        }
        selectedFamilies = config.strategyFamilyIds
          ? getBlockFamilyDefinitions().filter((f) => config.strategyFamilyIds!.includes(f.familyId))
          : getBlockFamilyDefinitions();
        blockCatalog = createEmptyBlockCatalog();
      } else if (config.researchStage === "portfolio" && config.blockCatalogPath) {
        blockCatalog = await loadValidatedBlockCatalogFromFile(config.blockCatalogPath);
        selectedFamilies = getPortfolioCompositionFamilies(blockCatalog);
      } else {
        selectedFamilies = config.strategyFamilyIds
          ? getStrategyFamilies(config.strategyFamilyIds)
          : (restored?.families ?? getStrategyFamilies());
      }

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
        candleCache.clear();
        await reconcilePartialRunStatus(config.outputDir);
        const limitResolution = repairAutoResearchLimit(config);
        config = limitResolution.config;
        const minCandles = Math.max(250, config.limit);
        const candidateMarketTarget = resolveCandidateMarketTarget({
          families: runtimeFamilies,
          marketLimit: config.marketLimit,
          researchStage: config.researchStage
        });
        const marketCodes = (await resolveCandidateMarkets({
          timeframe: config.timeframe,
          minCandles,
          marketLimit: config.marketLimit,
          universeName: config.universeName,
          families: runtimeFamilies,
          config
        })).slice(0, candidateMarketTarget);

        if (marketCodes.length === 0) {
          throw new Error("No candidate markets available for auto research");
        }

        const iterations: ResearchIterationRecord[] = restored?.iterations ?? [];
        let outcome: AutoResearchRunOutcome =
          restored?.outcome && restored.outcome !== "completed"
            ? restored.outcome
            : "partial";
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

        // Cap parallelism based on available memory and CPUs
        const totalMemMb = Math.round(os.totalmem() / 1024 / 1024);
        const memAwareCap = totalMemMb <= 8192 ? 1 : totalMemMb <= 16384 ? 2 : Math.max(1, os.cpus().length - 1);
        const parallelism = Math.min(memAwareCap, Math.max(1, config.parallelism ?? Math.min(config.candidatesPerIteration ?? 1, memAwareCap)));
        const log = async (message: string) => {
          console.error(message);
          await appendRunLog(config.outputDir, message);
        };
        const safeAppendLineageEvent = createSafeAppendLineageEvent(log);
        let lineage = await loadOrCreateResearchLineage({
          outputDir: config.outputDir,
          stage: config.researchStage ?? "auto",
          objective: `Auto research ${config.researchStage ?? "auto"} ${config.universeName} ${config.timeframe} ${config.mode}`,
          lineageId: restored?.lineage?.lineageId
        });
        let artifactWriteQueue = Promise.resolve<void>(undefined);
        const queueArtifactWrite = async <T>(task: () => Promise<T>): Promise<T> => {
          const next = artifactWriteQueue.catch(() => undefined).then(task);
          artifactWriteQueue = next.then(() => undefined, () => undefined);
          return next;
        };
        const failRun = async (message: string, pendingProposal?: ProposalBatch): Promise<never> => {
          outcome = "failed";
          outcomeReason = message;
          await log(`[auto-research] failed ${message}`);
          if (config.loopVersion === "v2") {
            await safeAppendLineageEvent({
              outputDir: config.outputDir,
              event: {
                eventId: `${lineage.lineageId}-failed-${Date.now()}`,
                lineageId: lineage.lineageId,
                at: new Date().toISOString(),
                type: "run_failed",
                payload: {
                  iteration: iterations.length,
                  message
                }
              }
            });
          }
          await queueArtifactWrite(() => persistRunArtifacts({
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
            lineage,
            status: {
              updatedAt: new Date().toISOString(),
              phase: "failed",
              iteration: iterations.length,
              totalIterations: config.iterations,
              message
            }
          }));
          throw new Error(message);
        };
        process.once("SIGINT", handleAbort);
        process.once("SIGTERM", handleAbort);

        // Data freshness check (only in continuous/daemon mode unless explicitly requested)
        if (!config.allowStaleData && config.continuousMode) {
          try {
            const { checkDataFreshness } = await import("./data-health.js");
            const freshness = checkDataFreshness({
              timeframe: config.timeframe,
              allowStaleData: false
            });
            if (freshness.warning) await log(`[auto-research] WARNING: ${freshness.warning}`);
            if (!freshness.ok) await failRun(freshness.refusal ?? "Data freshness check failed");
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            if (msg.includes("Data is") || msg.includes("No candles")) throw error;
            await log(`[auto-research] data freshness check skipped: ${msg}`);
          }
        }

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
              lineage,
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
          lineage,
          status: startingStatus
        });

        const blockFamilyBestMap = new Map<string, CandidateBacktestEvaluation>();
        const blockFamilyIds = new Set(
          config.researchStage === "block" ? selectedFamilies.map((f) => f.familyId) : []
        );
        const blockFamilyConsecutiveZeroTrades = new Map<string, number>();
        const familyStagnationStreak = new Map<string, number>();
        const familyIterationCounts = new Map<string, number>();
        const familyBestNetReturn = new Map<string, number>(); // monotonic max for stagnation tracking
        const skippedFamilyIds = new Set<string>();
        const CONSECUTIVE_ZERO_TRADE_SKIP_THRESHOLD = 3;
        const stagnationRetireThreshold = config.stagnationRetireThreshold ?? 8;
        const familyIterationBudget = config.familyIterationBudget ?? 20;
        const runStartedAt = Date.now();
        const maxRunDurationMs = config.maxRunDurationMs ?? 0;
        const iterationTimeoutMs = config.iterationTimeoutMs ?? 0;

        // Restore blockFamilyBestMap from prior iterations on resume
        if (iterations.length > 0 && config.researchStage === "block") {
          for (const priorIteration of iterations) {
            for (const evaluation of priorIteration.evaluations) {
              const fid = evaluation.candidate.familyId;
              if (!blockFamilyIds.has(fid)) continue;
              const current = blockFamilyBestMap.get(fid);
              if (!current || compareEvaluations(current, evaluation) > 0) {
                blockFamilyBestMap.set(fid, evaluation);
              }
            }
          }
          if (blockFamilyBestMap.size > 0) {
            await log(`[auto-research] restored blockFamilyBestMap from ${iterations.length} prior iterations (${blockFamilyBestMap.size} families)`);
          }
        }

        // Restore familyStagnationStreak and familyIterationCounts from prior iterations
        if (iterations.length > 0 && config.researchStage === "block") {
          const STAGNATION_RESUME_EPSILON = 1e-6;
          for (const priorIteration of iterations) {
            const familiesInIteration = new Set<string>();
            for (const evaluation of priorIteration.evaluations) {
              const fid = evaluation.candidate.familyId;
              if (!blockFamilyIds.has(fid)) continue;
              familiesInIteration.add(fid);
            }
            for (const fid of familiesInIteration) {
              familyIterationCounts.set(fid, (familyIterationCounts.get(fid) ?? 0) + 1);

              // Rebuild stagnation streak from best improvement history
              const iterBest = priorIteration.evaluations
                .filter((e) => e.candidate.familyId === fid)
                .sort(compareEvaluations)[0];
              const prevBest = familyBestNetReturn.get(fid) ?? -Infinity;
              const currentBest = iterBest?.summary.netReturn ?? -Infinity;

              if (currentBest > prevBest + STAGNATION_RESUME_EPSILON) {
                familyStagnationStreak.set(fid, 0);
                familyBestNetReturn.set(fid, currentBest);
              } else {
                familyStagnationStreak.set(fid, (familyStagnationStreak.get(fid) ?? 0) + 1);
              }
            }
          }
          if (familyStagnationStreak.size > 0) {
            const stagnationSummary = [...familyStagnationStreak.entries()]
              .map(([fid, streak]) => `${fid}=${streak}`)
              .join(", ");
            await log(`[auto-research] restored stagnation streaks: ${stagnationSummary}`);
          }
        }

        const startIteration = iterations.length + 1;
        const isContinuousMode = config.continuousMode === true;
        const shouldContinueLoop = (iter: number): boolean => {
          if (abortRequested) return false;
          if (maxRunDurationMs > 0 && (Date.now() - runStartedAt) >= maxRunDurationMs) return false;
          if (isContinuousMode) {
            // Check if all tracked families are retired (works for all stages)
            if (skippedFamilyIds.size > 0 && familyIterationCounts.size > 0) {
              const activeFamilies = [...familyIterationCounts.keys()].filter(
                (fid) => !skippedFamilyIds.has(fid)
              );
              if (activeFamilies.length === 0) return false;
            }
            if (config.researchStage === "block") {
              const activeFamilies = [...blockFamilyIds].filter(
                (fid) => !skippedFamilyIds.has(fid)
              );
              return activeFamilies.length > 0;
            }
            return true;
          }
          return iter <= config.iterations;
        };

        for (let iteration = startIteration; shouldContinueLoop(iteration); iteration += 1) {
          if (abortRequested) {
            outcome = "aborted";
            outcomeReason = `Received ${abortSignal ?? "termination signal"}.`;
            break;
          }
          if (maxRunDurationMs > 0 && (Date.now() - runStartedAt) >= maxRunDurationMs) {
            outcome = "completed";
            outcomeReason = `Max run duration reached (${Math.round(maxRunDurationMs / 60_000)}min).`;
            break;
          }

          // Write heartbeat for daemon watchdog
          const iterationStartedAt = Date.now();
          try {
            await writeFile(
              path.join(config.outputDir, "heartbeat.json"),
              JSON.stringify({ pid: process.pid, iteration, updatedAt: new Date().toISOString() })
            );
          } catch { /* best-effort */ }

          // Iteration timeout check helper
          const isIterationTimedOut = (): boolean =>
            iterationTimeoutMs > 0 && (Date.now() - iterationStartedAt) >= iterationTimeoutMs;

          // Discovery cycle: every N iterations, ask LLM for new strategy ideas
          const discoveryInterval = config.discoveryInterval ?? 5;
          if (isContinuousMode && discoveryInterval > 0 && iteration > 1 && iteration % discoveryInterval === 0) {
            try {
              await log(`[auto-research] discovery cycle at iteration ${iteration}`);
              const { buildDiscoveryPrompt, buildDesignPrompt, buildImplementationPrompt } = await import("./discovery-prompts.js");
              const { generateStrategyScaffold } = await import("./strategy-scaffold.js");
              const { validateGeneratedStrategy } = await import("./validation.js");

              // Step 1: Discovery — ask for ideas
              // Load journal for discovery context
              let journalSummary: { patterns: string[]; antiPatterns: string[]; recentEntries: string[] } | undefined;
              try {
                const { loadJournal, buildJournalSummary } = await import("./research-journal.js");
                const journal = await loadJournal(config.outputDir);
                journalSummary = buildJournalSummary(journal);
              } catch { /* journal not available yet */ }

              const discoveryPrompt = buildDiscoveryPrompt({
                config,
                marketCodes,
                families: runtimeFamilies,
                history: iterations,
                journalSummary
              });
              const discoveryResult = await deps.llmClient.proposeCandidates({
                config: { ...config, candidatesPerIteration: 1 },
                families: runtimeFamilies,
                marketCodes,
                history: iterations
              }).catch(() => null);

              // Try to get discovery ideas via direct LLM call
              type DiscoveryIdea = { ideaId: string; title: string; thesis: string; mechanism: string; indicators: string[] };
              let discoveryBatch: { ideas: DiscoveryIdea[] } | null = null;
              try {
                const { llmJson } = await import("./cli-llm.js");
                const { data } = await llmJson(discoveryPrompt, { provider: config.llmProvider, model: config.llmModel, timeoutMs: config.llmTimeoutMs });
                if (data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).ideas)) {
                  discoveryBatch = data as { ideas: DiscoveryIdea[] };
                }
              } catch (error) {
                await log(`[auto-research] discovery LLM failed: ${error instanceof Error ? error.message : String(error)}`);
              }

              if (discoveryBatch && discoveryBatch.ideas.length > 0) {
                const topIdea = discoveryBatch.ideas[0]!;
                await log(`[auto-research] top idea: ${topIdea.title} — ${topIdea.thesis}`);

                // Step 2: Design
                try {
                  const designPrompt = buildDesignPrompt({ idea: topIdea, config });
                  const { llmJson: llmJsonDesign } = await import("./cli-llm.js");
                  const { data: designData } = await llmJsonDesign(designPrompt, { provider: config.llmProvider, model: config.llmModel, timeoutMs: config.llmTimeoutMs });

                  if (designData && typeof designData === "object") {
                    const design = designData as {
                      familyId: string; strategyName: string; title: string; thesis: string;
                      family: "trend" | "breakout" | "micro" | "meanreversion";
                      sleeveId: string; signalLogicDescription: string;
                      indicators: string[]; entryLogic: string; exitLogic: string;
                      parameterSpecs: Array<{ name: string; description: string; min: number; max: number }>;
                      regimeGate: { allowedRegimes: string[] };
                    };

                    // Step 3: Generate scaffold
                    const scaffold = generateStrategyScaffold({
                      familyId: design.familyId ?? `generated:${topIdea.ideaId}`,
                      strategyName: design.strategyName ?? `generated-${topIdea.ideaId}`,
                      title: design.title ?? topIdea.title,
                      thesis: design.thesis ?? topIdea.thesis,
                      family: design.family ?? "meanreversion",
                      sleeveId: design.sleeveId ?? "reversion",
                      decisionTimeframe: config.timeframe,
                      executionTimeframe: "5m",
                      parameterSpecs: Array.isArray(design.parameterSpecs) ? design.parameterSpecs : [],
                      regimeGate: design.regimeGate ?? { allowedRegimes: ["trend_up", "range"] },
                      signalLogicDescription: design.signalLogicDescription ?? "",
                      indicators: Array.isArray(design.indicators) ? design.indicators : []
                    });

                    // Step 4: Ask LLM to fill in the logic
                    const implPrompt = buildImplementationPrompt({
                      design: {
                        familyId: design.familyId ?? `generated:${topIdea.ideaId}`,
                        strategyName: design.strategyName ?? `generated-${topIdea.ideaId}`,
                        title: design.title ?? topIdea.title,
                        thesis: design.thesis ?? topIdea.thesis,
                        signalLogicDescription: design.signalLogicDescription ?? "",
                        entryLogic: design.entryLogic ?? "",
                        exitLogic: design.exitLogic ?? "",
                        indicators: Array.isArray(design.indicators) ? design.indicators : [],
                        parameterSpecs: Array.isArray(design.parameterSpecs) ? design.parameterSpecs : []
                      },
                      scaffoldCode: scaffold
                    });

                    const { llmText } = await import("./cli-llm.js");
                    const { text: implementedCode } = await llmText(implPrompt, { provider: config.llmProvider, model: config.llmModel, timeoutMs: config.llmTimeoutMs });

                    if (implementedCode && implementedCode.length > 200) {
                      // Write to generated-strategies directory
                      const safeName = (design.strategyName ?? `generated-${topIdea.ideaId}`).replace(/[^a-zA-Z0-9-]/g, "-");
                      const strategyPath = path.join(process.cwd(), "src", "generated-strategies", `${safeName}.ts`);
                      await writeFile(strategyPath, implementedCode);
                      await log(`[auto-research] wrote generated strategy: ${strategyPath}`);

                      // Step 5: Validate
                      const validation = await validateGeneratedStrategy({ filePath: strategyPath, cwd: process.cwd() });
                      if (validation.ok) {
                        await log(`[auto-research] strategy validated: ${safeName}`);
                        // Add to runtime families for subsequent iterations
                        const newFamilyId = design.familyId ?? `generated:${topIdea.ideaId}`;
                        const newFamily: StrategyFamilyDefinition = {
                          familyId: newFamilyId,
                          strategyName: safeName,
                          title: design.title ?? topIdea.title,
                          thesis: design.thesis ?? topIdea.thesis,
                          timeframe: config.timeframe as "1h" | "15m" | "5m" | "1m",
                          parameterSpecs: Array.isArray(design.parameterSpecs) ? design.parameterSpecs : [],
                          guardrails: []
                        };
                        runtimeFamilies = [...runtimeFamilies, newFamily];
                        selectedFamilies = [...selectedFamilies, newFamily];
                        await log(`[auto-research] added new family: ${newFamilyId} — ${design.title ?? topIdea.title}`);
                      } else {
                        await log(`[auto-research] strategy validation failed: ${validation.results.map((r) => `${r.step}=${r.passed}`).join(", ")}`);
                        try { await rm(strategyPath); } catch { /* best-effort cleanup */ }
                      }
                    }
                  }
                } catch (error) {
                  await log(`[auto-research] design/implement failed: ${error instanceof Error ? error.message : String(error)}`);
                }
              }
            } catch (error) {
              await log(`[auto-research] discovery cycle failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`);
            }
          }

          const proposalFamiliesForLlm = runtimeFamilies.filter((family) => !hiddenFamilyIds.has(family.familyId));
          const totalLabel = isContinuousMode ? "∞" : String(config.iterations);
          await log(`[auto-research] iteration ${iteration}/${totalLabel} proposal`);
          const proposalStatus: AutoResearchStatus = {
            updatedAt: new Date().toISOString(),
            phase: "proposal",
            iteration,
            totalIterations: isContinuousMode ? iteration : config.iterations,
            message: isContinuousMode
              ? `Continuous mode iteration ${iteration}. Active families: ${[...blockFamilyIds].filter((f) => !skippedFamilyIds.has(f)).length}/${blockFamilyIds.size}.`
              : "Waiting for LLM proposal."
          };
          await saveRunStatus(config.outputDir, proposalStatus);
          let proposalResult: Awaited<ReturnType<typeof generateHypothesisProposal>>;
          try {
            proposalResult = await generateHypothesisProposal({
              llmClient: deps.llmClient,
              config,
              families: proposalFamiliesForLlm,
              marketCodes,
              history: iterations,
              iteration,
              nextProposal,
              blockCatalog,
              hiddenFamilyIds
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await failRun(`LLM proposal failed: ${message}`, nextProposal);
          }

          if (isIterationTimedOut()) {
            await log(`[auto-research] iteration ${iteration} timed out after proposal phase (${Math.round((Date.now() - iterationStartedAt) / 1000)}s)`);
            continue;
          }

          let proposal = proposalResult!.proposal;
          if (proposalResult!.source !== "llm") {
            await log(
              `[auto-research] proposal source=${proposalResult!.source}${proposalResult!.note ? ` detail=${proposalResult!.note}` : ""}`
            );
          }
        catalog = mergeProposedFamilies(catalog, proposal.proposedFamilies);
        runtimeFamilies = mergeStrategyFamilies(buildRuntimeFamilies(catalog), configuredFamilies);
        await saveCatalogArtifact(config.outputDir, catalog);
        let hypotheses: ResearchHypothesis[] = [];
        if (config.loopVersion === "v2") {
          hypotheses = proposalResult!.hypotheses;
          await safeAppendLineageEvent({
            outputDir: config.outputDir,
            event: {
              eventId: `${lineage.lineageId}-proposal-${iteration}`,
              lineageId: lineage.lineageId,
              at: new Date().toISOString(),
              type: "proposal_recorded",
              payload: {
                iteration,
                hypothesisCount: hypotheses.length,
                candidateCount: proposal.candidates.length,
                codeTaskCount: proposal.codeTasks.length,
                familyCount: proposal.proposedFamilies.length
              }
            }
          });
        }

        let experimentPlan: ExperimentPlan | undefined;
        let normalizedCandidates: NormalizedCandidateProposal[];
        let diversifiedCandidates: NormalizedCandidateProposal[];

        if (config.loopVersion === "v2") {
          const preparedKernel = await prepareExperimentKernel({
            config,
            proposal,
            families: runtimeFamilies,
            history: iterations,
            iteration,
            hiddenFamilyIds,
            hypotheses
          });
          proposal = preparedKernel.proposal;
          experimentPlan = preparedKernel.experimentPlan;
          normalizedCandidates = preparedKernel.normalizedCandidates;
          diversifiedCandidates = preparedKernel.diversifiedCandidates;
        } else {
          proposal = await augmentProposalBatchWithEngineCandidates({
            proposal,
            config,
            families: runtimeFamilies,
            history: iterations,
            iteration,
            hiddenFamilyIds
          });
          normalizedCandidates = topUpCandidatesForEvaluation({
            candidates: (() => {
              const baseCandidates = dedupeCandidates(normalizeCandidates(proposal.candidates, runtimeFamilies));
              const novelCandidates = ensureNovelCandidates({
                candidates: baseCandidates,
                families: runtimeFamilies,
                iterations,
                iteration
              });
              return novelCandidates.length > 0 ? novelCandidates : baseCandidates;
            })(),
            families: runtimeFamilies,
            iterations,
            iteration,
            limit: config.candidatesPerIteration
          });
          diversifiedCandidates = selectDiversifiedCandidates(
            skippedFamilyIds.size > 0
              ? normalizedCandidates.filter((c) => !skippedFamilyIds.has(c.familyId))
              : normalizedCandidates,
            runtimeFamilies,
            config.candidatesPerIteration,
            config.candidateDiversificationMinDistance ?? DEFAULT_CANDIDATE_DIVERSIFICATION_MIN_DISTANCE
          );
        }

        if (experimentPlan && config.loopVersion === "v2") {
          await safeAppendLineageEvent({
            outputDir: config.outputDir,
            event: {
              eventId: `${lineage.lineageId}-plan-${iteration}`,
              lineageId: lineage.lineageId,
              at: new Date().toISOString(),
              type: "plan_compiled",
              payload: {
                iteration,
                planId: experimentPlan.planId,
                hypothesisId: experimentPlan.hypothesisId,
                mode: experimentPlan.mode,
                candidateCount: experimentPlan.candidates.length
              }
            }
          });
        }
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
        const codeMutationResults = config.loopVersion === "v2"
          ? await Promise.all(proposal.codeTasks.map(async (task, taskIndex) => {
              const taskId = task.taskId ?? `code-task-${String(taskIndex + 1).padStart(2, "0")}`;
              const worktreeResult = await executeCodeMutationInWorktree({
                repoRoot: process.cwd(),
                outputDir: path.join(
                  config.outputDir,
                  `iteration-${String(iteration).padStart(2, "0")}`,
                  "code-worktrees",
                  taskId
                ),
                task: {
                  ...task,
                  taskId
                },
                allowCodeMutation: config.allowCodeMutation,
                provider: config.llmProvider,
                model: config.llmModel
              });
              const applyResult = worktreeResult.mergeRecommendation === "merge"
                ? await applyWorktreePatchToWorkspace({
                    patchPath: worktreeResult.patchPath,
                    repoRoot: process.cwd()
                  })
                : {
                    status: "skipped" as const,
                    detail: "Worktree benchmark did not recommend applying the patch."
                  };

              return {
                task,
                status:
                  worktreeResult.codeAgentStatus === "executed" && applyResult.status === "applied"
                    ? "executed" as const
                    : worktreeResult.codeAgentStatus === "failed" || applyResult.status === "failed"
                      ? "failed" as const
                      : "skipped" as const,
                detail: [
                  `worktree=${worktreeResult.worktreePath}`,
                  `benchmarks=${worktreeResult.benchmarkResults.map((result) => `${result.status}:${result.command}`).join(" | ") || "none"}`,
                  `apply=${applyResult.status}:${applyResult.detail}`,
                  worktreeResult.codeAgentDetail
                ].join("\n")
              };
            }))
          : await codeAgent.execute({
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
        const normalizedCodeMutationResults: CodeMutationExecutionResult[] = codeMutationResults.map((item): CodeMutationExecutionResult => ({
          taskId: item.task.taskId ?? item.task.title,
          familyId: item.task.familyId,
          strategyName: item.task.strategyName,
          title: item.task.title,
          status: item.status,
          detail: item.detail
        }));
        if (config.loopVersion === "v2" && normalizedCodeMutationResults.length > 0) {
          await safeAppendLineageEvent({
            outputDir: config.outputDir,
            event: {
              eventId: `${lineage.lineageId}-code-${iteration}`,
              lineageId: lineage.lineageId,
              at: new Date().toISOString(),
              type: "code_mutation_finished",
              payload: {
                iteration,
                results: normalizedCodeMutationResults.map((result) => ({
                  taskId: result.taskId,
                  status: result.status,
                  familyId: result.familyId,
                  strategyName: result.strategyName
                }))
              }
            }
          });
        }
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
        const useInProcessBlock = config.researchStage === "block" && !deps.evaluateCandidate;
        const evalOutputDir = path.join(config.outputDir, `iteration-${String(iteration).padStart(2, "0")}`, "evaluations");

        const onCandidateEvaluated = async (evaluation: CandidateBacktestEvaluation) => {
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
          await queueArtifactWrite(() => persistRunArtifacts({
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
            lineage,
            outcome,
            outcomeReason,
            configRepairs,
            status: progressStatus,
            liveEvaluations: liveEvaluations.slice()
          }));
          await log(
            `[auto-research] iteration ${iteration}/${config.iterations} done ${evaluation.candidate.candidateId} net=${evaluation.summary.netReturn} trades=${evaluation.summary.tradeCount}`
          );
        };

        let evaluations: CandidateBacktestEvaluation[];

        if (useInProcessBlock) {
          // All blocks in-process — 1m is capped to 6 months so memory is safe
          const inProcessCandidates = diversifiedCandidates;
          const workerCandidates: NormalizedCandidateProposal[] = [];

          const inProcessResults = inProcessCandidates.length > 0
            ? await evaluateBlockCandidatesInProcess({
                config,
                candidates: inProcessCandidates,
                marketCodes,
                outputDir: evalOutputDir,
                log,
                iteration,
                onEvaluated: async (evaluation) => { await onCandidateEvaluated(evaluation); }
              })
            : [];

          const workerResults = await runWithConcurrency(workerCandidates, 1, async (candidate) => {
            await log(
              `[auto-research] iteration ${iteration}/${config.iterations} evaluate (worker) ${candidate.candidateId}`
            );
            let evaluation: CandidateBacktestEvaluation;
            try {
              evaluation = await evaluateCandidate({
                config,
                candidate,
                marketCodes,
                outputDir: evalOutputDir
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              evaluation = buildBlockFailedEvaluation(config, candidate, message);
              await saveJson(path.join(evalOutputDir, `${candidate.candidateId}.json`), evaluation);
            }
            await onCandidateEvaluated(evaluation);
            return evaluation;
          });

          // Reassemble in original order
          const resultMap = new Map<string, CandidateBacktestEvaluation>();
          for (const e of [...inProcessResults, ...workerResults]) resultMap.set(e.candidate.candidateId, e);
          evaluations = diversifiedCandidates.map((c) => resultMap.get(c.candidateId)!);
        } else {
          evaluations = await runWithConcurrency(diversifiedCandidates, parallelism, async (candidate, index) => {
            await log(
              `[auto-research] iteration ${iteration}/${config.iterations} evaluate ${index + 1}/${diversifiedCandidates.length} ${candidate.candidateId}`
            );
            let evaluation: CandidateBacktestEvaluation;
            try {
              evaluation = await evaluateCandidate({
                config,
                candidate,
                marketCodes,
                outputDir: evalOutputDir
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              evaluation = buildBlockFailedEvaluation(config, candidate, message);
              await saveJson(path.join(evalOutputDir, `${candidate.candidateId}.json`), evaluation);
            }
            await onCandidateEvaluated(evaluation);
            return evaluation;
          });
        }
        evaluations.sort(compareEvaluations);
        if (!bestCandidate || (evaluations[0] && compareEvaluations(bestCandidate, evaluations[0]) > 0)) {
          bestCandidate = evaluations[0];
        }

        if (config.researchStage === "block") {
          // Track per-family best and consecutive zero-trade count
          const familyTradeMap = new Map<string, boolean>();
          for (const evaluation of evaluations) {
            const fid = evaluation.candidate.familyId;
            if (!blockFamilyIds.has(fid)) continue;
            const current = blockFamilyBestMap.get(fid);
            if (!current || compareEvaluations(current, evaluation) > 0) {
              blockFamilyBestMap.set(fid, evaluation);
            }
            if (evaluation.summary.tradeCount > 0) {
              familyTradeMap.set(fid, true);
            } else if (!familyTradeMap.has(fid)) {
              familyTradeMap.set(fid, false);
            }
          }
          for (const [fid, hadTrades] of familyTradeMap) {
            if (hadTrades) {
              blockFamilyConsecutiveZeroTrades.set(fid, 0);
            } else {
              const count = (blockFamilyConsecutiveZeroTrades.get(fid) ?? 0) + 1;
              blockFamilyConsecutiveZeroTrades.set(fid, count);
              if (count >= CONSECUTIVE_ZERO_TRADE_SKIP_THRESHOLD && !skippedFamilyIds.has(fid)) {
                skippedFamilyIds.add(fid);
                await log(`[auto-research] skipping family ${fid} after ${count} consecutive 0-trade iterations`);
              }
            }
          }

        }

        // Track per-family stagnation (all stages, not just block)
        {
          const STAGNATION_EPSILON = 1e-6;
          const familiesEvaluatedThisIteration = new Set<string>();
          for (const evaluation of evaluations) {
            familiesEvaluatedThisIteration.add(evaluation.candidate.familyId);
          }
          for (const fid of familiesEvaluatedThisIteration) {
            familyIterationCounts.set(fid, (familyIterationCounts.get(fid) ?? 0) + 1);
            const prevBestReturn = familyBestNetReturn.get(fid) ?? -Infinity;
            const iterBest = evaluations
              .filter((e) => e.candidate.familyId === fid)
              .sort(compareEvaluations)[0];
            const improved = iterBest && iterBest.summary.netReturn > prevBestReturn + STAGNATION_EPSILON;

            if (improved) {
              familyStagnationStreak.set(fid, 0);
              familyBestNetReturn.set(fid, iterBest.summary.netReturn);
            } else {
              const streak = (familyStagnationStreak.get(fid) ?? 0) + 1;
              familyStagnationStreak.set(fid, streak);

              if (streak >= stagnationRetireThreshold && !skippedFamilyIds.has(fid)) {
                skippedFamilyIds.add(fid);
                await log(`[auto-research] retiring family ${fid} after ${streak} stagnant iterations (no improvement)`);
              }
            }

            const iterCount = familyIterationCounts.get(fid) ?? 0;
            if (iterCount >= familyIterationBudget && !skippedFamilyIds.has(fid)) {
              skippedFamilyIds.add(fid);
              await log(`[auto-research] retiring family ${fid} after exhausting iteration budget (${iterCount}/${familyIterationBudget})`);
            }
          }
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
        const reviewFamiliesForLlm = runtimeFamilies.filter((family) => !hiddenFamilyIds.has(family.familyId));
        let reviewResult: Awaited<ReturnType<typeof generateIterationReview>>;
        try {
          reviewResult = await generateIterationReview({
            llmClient: deps.llmClient,
            config,
            families: reviewFamiliesForLlm,
            history: iterations,
            proposal,
            evaluations,
            preparationResults,
            codeMutationResults: normalizedCodeMutationResults,
            validationResults,
            iteration,
            blockCatalog,
            familyStagnationStreak,
            familyIterationCounts
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes("timed out") || message.includes("transport") || message.includes("review")) {
            await failRun(`LLM review failed: ${message}`, proposal);
          }
          await failRun(`Invalid review decision: ${message}`, proposal);
        }
        const review = reviewResult!.review;
        if (reviewResult!.reviewFailureMessage && config.loopVersion === "v2") {
          await log(`[auto-research] review degraded to objective governance: ${reviewResult!.reviewFailureMessage}`);
        }
        if (reviewResult!.usedObjectiveGovernance && !reviewResult!.reviewFailureMessage) {
          await log("[auto-research] review continued under objective governance.");
        }
        if (config.loopVersion === "v2") {
          await safeAppendLineageEvent({
            outputDir: config.outputDir,
            event: {
              eventId: `${lineage.lineageId}-review-${iteration}`,
              lineageId: lineage.lineageId,
              at: new Date().toISOString(),
              type: "iteration_reviewed",
              payload: {
                iteration,
                verdict: review.verdict,
                promotedCandidateId: review.promotedCandidateId,
                nextCandidateCount: review.nextCandidates.length
              }
            }
          });
        }
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
          provenance: {
            proposalSource: proposalResult!.source,
            proposalFailureMessage: proposalResult!.note,
            reviewUsedObjectiveGovernance: reviewResult!.usedObjectiveGovernance,
            reviewFailureMessage: reviewResult!.reviewFailureMessage
          },
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
        if (config.loopVersion === "v2") {
          lineage = await updateResearchLineageFromIterations({
            outputDir: config.outputDir,
            lineage,
            iterations
          });
        }

        // Update research journal with evaluation results
        try {
          const { appendJournalEntry, createEvaluationEntry } = await import("./research-journal.js");
          const topEval = evaluations[0];
          if (topEval) {
            const promoted = review.verdict === "promote_candidate" &&
              review.promotedCandidateId === topEval.candidate.candidateId;
            const familyDef = runtimeFamilies.find((f) => f.familyId === topEval.candidate.familyId);
            await appendJournalEntry(config.outputDir, createEvaluationEntry({
              iteration,
              familyId: topEval.candidate.familyId,
              title: familyDef?.title ?? topEval.candidate.familyId,
              thesis: familyDef?.thesis ?? topEval.candidate.thesis,
              netReturn: topEval.summary.netReturn,
              tradeCount: topEval.summary.tradeCount,
              maxDrawdown: topEval.summary.maxDrawdown,
              promoted
            }));
          }
        } catch { /* journal is best-effort */ }
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
        await queueArtifactWrite(() => persistRunArtifacts({
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
          lineage,
          status: {
            updatedAt: new Date().toISOString(),
            phase:
              review.verdict === "promote_candidate" || review.verdict === "stop_no_edge"
                ? (config.researchStage === "block" ? "review" : "completed")
                : "review",
            iteration,
            totalIterations: config.iterations,
            message:
              review.verdict === "promote_candidate" || review.verdict === "stop_no_edge"
                ? `Run stopped with verdict ${review.verdict}.`
                : `Iteration ${iteration} completed.`
          }
        }));

        if (review.verdict === "promote_candidate" || review.verdict === "stop_no_edge") {
          if (review.promotedCandidateId) {
            bestCandidate = evaluations.find(
              (evaluation) => evaluation.candidate.candidateId === review.promotedCandidateId
            ) ?? bestCandidate;
          }

          if (config.researchStage === "block" && blockCatalog) {
            // Per-family block promotion: promote all families that pass the gate
            const gateConfig = promotionGateConfig(config);
            const promotedFamilyIds = new Set(blockCatalog.blocks.map((b) => b.sourceFamilyId));
            for (const [fid, best] of blockFamilyBestMap) {
              if (promotedFamilyIds.has(fid)) continue;
              if (!passesPromotionGate(best, gateConfig)) continue;
              try {
                const familyDef = getBlockFamilyById(fid);
                const validated = await promoteToValidatedBlock({
                  evaluation: best,
                  familyDef,
                  blockFamilyId: fid
                });
                blockCatalog = appendValidatedBlock(blockCatalog, validated);
                promotedFamilyIds.add(fid);
                await log(`[auto-research] block promoted: ${validated.blockId} family=${validated.sourceFamilyId} net=${validated.performance.netReturn}`);
              } catch {
                // best-effort
              }
            }
            const catalogPath = path.join(config.outputDir, "validated-blocks.json");
            await saveValidatedBlockCatalog(catalogPath, blockCatalog);

            // Check if all families are covered
            const uncoveredFamilies = [...blockFamilyIds].filter(
              (fid) => !promotedFamilyIds.has(fid) && !skippedFamilyIds.has(fid)
            );
            if (uncoveredFamilies.length === 0) {
              const skippedCount = skippedFamilyIds.size;
              const stagnatedCount = [...skippedFamilyIds].filter((fid) => (familyStagnationStreak.get(fid) ?? 0) >= stagnationRetireThreshold).length;
              const zeroTradeCount = [...skippedFamilyIds].filter((fid) => (blockFamilyConsecutiveZeroTrades.get(fid) ?? 0) >= CONSECUTIVE_ZERO_TRADE_SKIP_THRESHOLD).length;
              const budgetExhaustedCount = [...skippedFamilyIds].filter((fid) => (familyIterationCounts.get(fid) ?? 0) >= familyIterationBudget).length;
              const blockSummary = `${promotedFamilyIds.size} block families validated, ${skippedCount} skipped`
                + (stagnatedCount > 0 ? ` (${stagnatedCount} stagnated)` : "")
                + (zeroTradeCount > 0 ? ` (${zeroTradeCount} 0-trade)` : "")
                + (budgetExhaustedCount > 0 ? ` (${budgetExhaustedCount} budget-exhausted)` : "")
                + `.`;

              if (isContinuousMode && blockCatalog.blocks.length > 0) {
                await log(`[auto-research] block stage completed: ${blockSummary} Transitioning to portfolio stage.`);
                // Continuous mode: transition to portfolio stage by exiting with success
                // The daemon will restart and index.ts auto-chaining will pick up the portfolio stage
                outcome = "completed";
                outcomeReason = `Block stage completed. ${blockSummary} Portfolio stage will be started by daemon.`;
              } else {
                outcome = "completed";
                outcomeReason = blockSummary;
              }
              break;
            } else if (!isContinuousMode && iteration >= config.iterations && promotedFamilyIds.size > 0) {
              outcome = "completed";
              outcomeReason = `Max iterations reached. ${promotedFamilyIds.size}/${blockFamilyIds.size} families promoted. Uncovered: ${uncoveredFamilies.join(",")}.`;
              break;
            } else {
              await log(`[auto-research] block families uncovered: ${uncoveredFamilies.join(",")} — continuing`);
            }
          } else {
            // Non-block stage: original behavior
            outcome = "completed";
            outcomeReason = `Run stopped with verdict ${review.verdict}.`;
            break;
          }
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

        // Clean old iteration artifacts to prevent disk bloat
        if (isContinuousMode && iteration % 5 === 0) {
          try {
            const { cleanIterationArtifacts } = await import("./artifact-cleanup.js");
            await cleanIterationArtifacts({ outputDir: config.outputDir, keepDays: 3, log: (msg) => log(msg) });
          } catch { /* best-effort */ }
        }

        // WAL checkpoint to prevent unbounded WAL growth
        try {
          const { walCheckpoint } = await import("../sqlite.js");
          walCheckpoint();
        } catch { /* best-effort */ }

        // Cooldown between iterations: let GC run and CPU/memory stabilize
        if (isContinuousMode) {
          const iterDurationMs = Date.now() - iterationStartedAt;
          const cooldownMs = Math.min(10_000, Math.max(2_000, Math.floor(iterDurationMs * 0.05)));
          await new Promise((resolve) => setTimeout(resolve, cooldownMs));
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

        if (config.researchStage === "block" && blockCatalog) {
          // Best-effort: promote remaining families from blockFamilyBestMap
          const promotedFamilyIds = new Set(blockCatalog.blocks.map((b) => b.sourceFamilyId));
          const gateConfig = promotionGateConfig(config);
          for (const [fid, best] of blockFamilyBestMap) {
            if (promotedFamilyIds.has(fid)) continue;
            if (!passesPromotionGate(best, gateConfig)) continue;
            try {
              const familyDef = getBlockFamilyById(fid);
              const validated = await promoteToValidatedBlock({
                evaluation: best,
                familyDef,
                blockFamilyId: fid
              });
              blockCatalog = appendValidatedBlock(blockCatalog, validated);
            } catch {
              // best-effort
            }
          }
          const catalogPath = path.join(config.outputDir, "validated-blocks.json");
          await saveValidatedBlockCatalog(catalogPath, blockCatalog);
        }

        let verification: AutoResearchRunVerification | undefined;
        const terminalGeneratedAt = new Date().toISOString();
        const terminalPendingProposal = outcome === "invalid_config" ? undefined : nextProposal;
        const preAuditOutcome = outcome === "completed" ? "partial" : outcome;
        const preAuditPhase = outcome === "completed" ? "verifying" : outcome;
        const preAuditMessage = outcome === "completed"
          ? "Terminal candidate loop completed. Verifying auto-research artifacts."
          : (outcomeReason ?? defaultOutcomeMessage(outcome));

        await queueArtifactWrite(() => persistRunArtifacts({
          outputDir: config.outputDir,
          generatedAt: terminalGeneratedAt,
          config,
          families: runtimeFamilies,
          catalog,
          marketCodes,
          iterations,
          outcome: preAuditOutcome,
          outcomeReason,
          configRepairs,
          bestCandidate,
          pendingProposal: terminalPendingProposal,
          noTradeIterations,
          lineage,
          verification,
          status: {
            updatedAt: new Date().toISOString(),
            phase: preAuditPhase,
            iteration: iterations.length,
            totalIterations: config.iterations,
            message: preAuditMessage
          }
        }));

        await releaseRunLock(config.outputDir);
        const artifactAudit = await writeAutoResearchArtifactAudit(config.outputDir);
        verification = { artifactAudit };
        if (outcome === "completed" && !artifactAudit.ok) {
          outcome = "failed";
          outcomeReason = `Auto research artifact audit failed: ${artifactAudit.failureReason ?? "unknown mismatch"}`;
          await log(`[auto-research] artifact-audit failed ${artifactAudit.failureReason ?? "unknown mismatch"}`);
        }

        if (config.loopVersion === "v2") {
          await safeAppendLineageEvent({
            outputDir: config.outputDir,
            event: {
              eventId: `${lineage.lineageId}-completed-${Date.now()}`,
              lineageId: lineage.lineageId,
              at: new Date().toISOString(),
              type: outcome === "failed" ? "run_failed" : "run_completed",
              payload: {
                outcome,
                outcomeReason,
                iterations: iterations.length,
                bestCandidateId: bestCandidate?.candidate.candidateId,
                artifactAuditOk: artifactAudit.ok
              }
            }
          });
        }

        // Auto-promote top candidates to paper-trading DB
        if (outcome === "completed" && config.autoPromote !== false) {
          try {
            const promoteResult = await autoPromoteAndLog({
              outputDir: config.outputDir,
              maxCandidates: config.autoPromoteMaxCandidates ?? 5,
              log: (msg) => log(msg)
            });
            if (promoteResult.promoted) {
              await log(`[auto-research] auto-promoted ${promoteResult.publishedCount} candidates to paper-trading`);
            }
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            await log(`[auto-research] auto-promote failed (non-fatal): ${msg}`);
          }
        }

        const finalReport = await queueArtifactWrite(() => persistRunArtifacts({
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
          pendingProposal: terminalPendingProposal,
          noTradeIterations,
          lineage,
          verification,
          status: {
            updatedAt: new Date().toISOString(),
            phase: outcome,
            iteration: iterations.length,
            totalIterations: config.iterations,
            message: outcomeReason ?? defaultOutcomeMessage(outcome),
            verification
          }
        }));

        return finalReport;
      } finally {
        process.removeListener("SIGINT", handleAbort);
        process.removeListener("SIGTERM", handleAbort);
        await releaseRunLock(config.outputDir);
      }
    }
  };
}
