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
import { getStrategyFamilies } from "./catalog.js";
import { CliCodeMutationAgent, type CodeAgent } from "./code-agent.js";
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
  NormalizedCandidateProposal,
  PreparationExecutionResult,
  ProposalBatch,
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
import { loadJournal } from "./research-journal.js";
import { renderSessionContractMarkdown } from "./session-contract.js";
import { runPostMutationValidation } from "./validation.js";
import { autoPromoteAndLog } from "./auto-promote.js";
import { discoverRuntimeScoredStrategyNames } from "./runtime-discovery.js";
import { repairWalkForwardConfig } from "./walk-forward-config.js";
import { calculateAutoResearchMinimumLimit, repairAutoResearchLimit } from "./limit-resolution.js";
import { buildAutoResearchArtifactSummaries } from "./artifact-summaries.js";
import {
  compareCandidateEvaluations,
  passesPromotionGate,
  summarizeEvaluationRanking
} from "./ranking.js";

const SCREEN_FAMILY_TO_CONFIRM_FAMILY = new Map<string, string>([
  ["multi-tf-regime-switch-screen", "multi-tf-regime-switch"],
  ["multi-tf-trend-burst", "multi-tf-regime-switch"],
  ["multi-tf-defensive-reclaim", "multi-tf-regime-switch"]
]);

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

function buildJournalNextActionHint(review: ReviewDecision): string | undefined {
  const nextCandidate = review.nextCandidates[0];
  if (nextCandidate) {
    return `Probe the next ${nextCandidate.familyId} candidate with materially different parameters before widening scope.`;
  }

  const nextPreparation = review.nextPreparation[0];
  if (nextPreparation) {
    return `Run preparation step ${nextPreparation.kind} before proposing another batch.`;
  }

  const nextCodeTask = review.codeTasks[0];
  if (nextCodeTask) {
    return `Resolve code task "${nextCodeTask.title}" before trusting the next iteration.`;
  }

  if (review.verdict === "stop_no_edge") {
    return "Rotate to a different family or evaluation shape; the current batch did not clear the promotion gate.";
  }

  if (review.verdict === "keep_searching") {
    return "Keep searching, but force the next batch to be meaningfully different from the current parameters.";
  }

  return undefined;
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

function promotionGateConfig(config: AutoResearchRunConfig) {
  return {
    minTrades: config.minTradesForPromotion,
    minNetReturn: config.minNetReturnForPromotion,
    maxDrawdown: config.maxDrawdownForPromotion,
    minPositiveWindowRatio: config.minPositiveWindowRatioForPromotion,
    minWorstWindowNetReturn: config.minWorstWindowNetReturnForPromotion,
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
  const {
    rawLeaderboard,
    leaderboard,
    candidateLedger,
    familySummary,
    candidateGenealogy
  } = buildAutoResearchArtifactSummaries({
    iterations: params.iterations,
    liveEvaluations: params.liveEvaluations
  });

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
  const sessionMarkdownPath = path.join(params.outputDir, "session.md");
  const reportMarkdownTempPath = `${reportMarkdownPath}.${process.pid}.${Date.now()}.tmp`;
  const reportHtmlTempPath = `${reportHtmlPath}.${process.pid}.${Date.now()}.tmp`;
  const sessionMarkdownTempPath = `${sessionMarkdownPath}.${process.pid}.${Date.now()}.tmp`;
  const journal = await loadJournal(params.outputDir);
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
  await writeFile(
    sessionMarkdownTempPath,
    renderSessionContractMarkdown({
      generatedAt: params.generatedAt,
      config: params.config,
      outcome: params.outcome,
      outcomeReason: params.outcomeReason,
      families: params.families,
      iterations: params.iterations.length,
      bestCandidate: params.bestCandidate,
      pendingProposal: params.pendingProposal,
      status: params.status,
      journal
    })
  );
  await rename(sessionMarkdownTempPath, sessionMarkdownPath);

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

  async function loadCandlesForTimeframesLocal(params: {
    timeframes: StrategyTimeframe[];
    marketCodes: string[];
    config: AutoResearchRunConfig;
  }): Promise<Partial<Record<StrategyTimeframe, CandleMap>>> {
    const { loadCandlesForTimeframes: loadCandles } = await import("./candle-loader.js");
    return loadCandles({
      timeframes: params.timeframes,
      marketCodes: params.marketCodes,
      config: params.config,
      cache: candleCache
    });
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
      const cache = await loadCandlesForTimeframesLocal({
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
              restored.config.candidateDiversificationMinDistance
          }
        : inputConfig;
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
        const safeAppendLineageEvent = async (
          params: Parameters<typeof appendLineageEvent>[0]
        ): Promise<void> => {
          try {
            await appendLineageEvent(params);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await log(`[auto-research] lineage event write failed: ${message}`);
          }
        };
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
        const skippedFamilyIds = new Set<string>();
        const runStartedAt = Date.now();
        const maxRunDurationMs = config.maxRunDurationMs ?? 0;
        const iterationTimeoutMs = config.iterationTimeoutMs ?? 0;

        const { FamilyLifecycleTracker } = await import("./family-lifecycle.js");
        const lifecycle = new FamilyLifecycleTracker({
          stagnationThreshold: config.stagnationRetireThreshold,
          iterationBudget: config.familyIterationBudget
        });

        // Restore blockFamilyBestMap from prior iterations on resume
        if (iterations.length > 0 && config.researchStage === "block") {
          for (const priorIteration of iterations) {
            for (const evaluation of priorIteration.evaluations) {
              const fid = evaluation.candidate.familyId;
              if (!blockFamilyIds.has(fid)) continue;
              const current = blockFamilyBestMap.get(fid);
              if (!current || compareCandidateEvaluations(current, evaluation) > 0) {
                blockFamilyBestMap.set(fid, evaluation);
              }
            }
          }
          if (blockFamilyBestMap.size > 0) {
            await log(`[auto-research] restored blockFamilyBestMap from ${iterations.length} prior iterations (${blockFamilyBestMap.size} families)`);
          }
        }

        // Restore lifecycle tracking from prior iterations
        if (iterations.length > 0) {
          lifecycle.restoreFromHistory(iterations, blockFamilyIds, compareCandidateEvaluations);
          const summary = lifecycle.getSummary();
          if (summary) await log(`[auto-research] restored lifecycle: ${summary}`);
        }

        const startIteration = iterations.length + 1;
        const isContinuousMode = config.continuousMode === true;
        const shouldContinueLoop = (iter: number): boolean => {
          if (abortRequested) return false;
          if (maxRunDurationMs > 0 && (Date.now() - runStartedAt) >= maxRunDurationMs) return false;
          if (isContinuousMode) {
            // Check lifecycle tracker for all-retired condition
            if (!lifecycle.hasActiveFamily(lifecycle.getIterationCounts().keys())) {
              if (lifecycle.getIterationCounts().size > 0) return false;
            }
            if (config.researchStage === "block") {
              return lifecycle.hasActiveFamily(blockFamilyIds);
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

          // Discovery cycle: every N iterations in continuous mode
          const discoveryInterval = config.discoveryInterval ?? 5;
          if (isContinuousMode && discoveryInterval > 0 && iteration > 1 && iteration % discoveryInterval === 0) {
            try {
              await log(`[auto-research] discovery cycle at iteration ${iteration}`);
              const { runDiscoveryCycle } = await import("./discovery-cycle.js");
              const { newFamily } = await runDiscoveryCycle({ config, marketCodes, runtimeFamilies, iterations, log });
              if (newFamily) {
                runtimeFamilies = [...runtimeFamilies, newFamily];
                selectedFamilies = [...selectedFamilies, newFamily];
                if (config.researchStage === "block") {
                  blockFamilyIds.add(newFamily.familyId);
                  await log(`[auto-research] discovery family ${newFamily.familyId} added to block evaluation`);
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
              blockCatalog
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
            await log(`[auto-research] proposal source=${proposalResult!.source}`);
          }
        catalog = mergeProposedFamilies(catalog, proposal.proposedFamilies);
        runtimeFamilies = mergeStrategyFamilies(buildRuntimeFamilies(catalog), configuredFamilies);
        await saveCatalogArtifact(config.outputDir, catalog);
        const hypothesisIds = proposalResult!.hypothesisIds;
        await safeAppendLineageEvent({
          outputDir: config.outputDir,
          event: {
            eventId: `${lineage.lineageId}-proposal-${iteration}`,
            lineageId: lineage.lineageId,
            at: new Date().toISOString(),
            type: "proposal_recorded",
            payload: {
              iteration,
              hypothesisCount: hypothesisIds.length,
              candidateCount: proposal.candidates.length,
              codeTaskCount: proposal.codeTasks.length,
              familyCount: proposal.proposedFamilies.length
            }
          }
        });

        const preparedKernel = prepareExperimentKernel({
          config,
          proposal,
          families: runtimeFamilies,
          iteration,
          hiddenFamilyIds,
          hypothesisIds
        });
        const experimentPlan = preparedKernel.experimentPlan;
        const diversifiedCandidates = preparedKernel.diversifiedCandidates;

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
        const normalizedCodeMutationResults: CodeMutationExecutionResult[] = codeMutationResults.map((item): CodeMutationExecutionResult => ({
          taskId: item.task.taskId ?? item.task.title,
          familyId: item.task.familyId,
          strategyName: item.task.strategyName,
          title: item.task.title,
          status: item.status,
          detail: item.detail
        }));
        if (normalizedCodeMutationResults.length > 0) {
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
          liveEvaluations.sort(compareCandidateEvaluations);
          if (!bestCandidate || compareCandidateEvaluations(bestCandidate, liveEvaluations[0]) > 0) {
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
        evaluations.sort(compareCandidateEvaluations);
        if (!bestCandidate || (evaluations[0] && compareCandidateEvaluations(bestCandidate, evaluations[0]) > 0)) {
          bestCandidate = evaluations[0];
        }

        if (config.researchStage === "block") {
          // Track the best seen evaluation for each block family.
          for (const evaluation of evaluations) {
            const fid = evaluation.candidate.familyId;
            if (!blockFamilyIds.has(fid)) continue;
            const current = blockFamilyBestMap.get(fid);
            if (!current || compareCandidateEvaluations(current, evaluation) > 0) {
              blockFamilyBestMap.set(fid, evaluation);
            }
          }
        }

        // Track per-family stagnation and budget (all stages)
        const newlyRetired = lifecycle.trackIteration(evaluations, compareCandidateEvaluations);
        for (const fid of newlyRetired) {
          skippedFamilyIds.add(fid);
          await log(`[auto-research] retiring family ${fid} (${lifecycle.getSummary()})`);
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
            blockCatalog
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes("timed out") || message.includes("transport") || message.includes("review")) {
            await failRun(`LLM review failed: ${message}`, proposal);
          }
          await failRun(`Invalid review decision: ${message}`, proposal);
        }
        const review = reviewResult!.review;
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
            proposalSource: proposalResult!.source
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
        lineage = await updateResearchLineageFromIterations({
          outputDir: config.outputDir,
          lineage,
          iterations
        });

        // Update research journal with evaluation results
        try {
          const { appendJournalEntry, createEvaluationEntry, createObservationEntry } = await import("./research-journal.js");
          const journalEntries = [];
          const topEval = evaluations[0];
          if (topEval) {
            const promoted = review.verdict === "promote_candidate" &&
              review.promotedCandidateId === topEval.candidate.candidateId;
            const familyDef = runtimeFamilies.find((f) => f.familyId === topEval.candidate.familyId);
            journalEntries.push(createEvaluationEntry({
              iteration,
              familyId: topEval.candidate.familyId,
              title: familyDef?.title ?? topEval.candidate.familyId,
              thesis: familyDef?.thesis ?? topEval.candidate.thesis,
              netReturn: topEval.summary.netReturn,
              tradeCount: topEval.summary.tradeCount,
              maxDrawdown: topEval.summary.maxDrawdown,
              promoted,
              candidateId: topEval.candidate.candidateId,
              reviewVerdict: review.verdict,
              nextActionHint: buildJournalNextActionHint(review),
              observations: review.observations
            }));
          }

          for (const item of codeMutationResults.filter((result) => result.status === "failed")) {
            journalEntries.push(createObservationEntry({
              iteration,
              title: `Code mutation failed: ${item.task.title}`,
              thesis: item.task.rationale,
              outcome: "failure",
              outcomeReason: item.detail,
              relatedFamilyIds: item.task.familyId ? [item.task.familyId] : [],
              failureMode: "code_mutation_failed",
              nextActionHint: "Tighten the mutation scope or simplify the implementation ask before retrying.",
              evidence: [
                `task=${item.task.taskId ?? item.task.title}`,
                `intent=${item.task.intent}`,
                `targets=${item.task.targetFiles.join(", ")}`
              ],
              tags: ["code-mutation", item.status]
            }));
          }

          for (const item of validationResults.filter((result) => result.status === "failed")) {
            journalEntries.push(createObservationEntry({
              iteration,
              title: `Validation failed: ${item.command}`,
              thesis: item.command,
              outcome: "failure",
              outcomeReason: item.detail,
              relatedFamilyIds: topEval ? [topEval.candidate.familyId] : [],
              candidateId: topEval?.candidate.candidateId,
              relatedCandidateIds: topEval ? [topEval.candidate.candidateId] : undefined,
              reviewVerdict: review.verdict,
              failureMode: "validation_failed",
              nextActionHint: "Reproduce the failure locally and narrow the change before running another iteration.",
              evidence: [`command=${item.command}`],
              tags: ["validation", item.command]
            }));
          }

          for (const entry of journalEntries) {
            await appendJournalEntry(config.outputDir, entry);
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
              const stagnationStreak = lifecycle.getStagnationStreak();
              const iterCounts = lifecycle.getIterationCounts();
              const stagnatedCount = [...skippedFamilyIds].filter((fid) => (stagnationStreak.get(fid) ?? 0) >= (config.stagnationRetireThreshold ?? 8)).length;
              const budgetExhaustedCount = [...skippedFamilyIds].filter((fid) => (iterCounts.get(fid) ?? 0) >= (config.familyIterationBudget ?? 20)).length;
              const blockSummary = `${promotedFamilyIds.size} block families validated, ${skippedCount} skipped`
                + (stagnatedCount > 0 ? ` (${stagnatedCount} stagnated)` : "")
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
          outcome === "partial" &&
          isContinuousMode &&
          !abortRequested &&
          lifecycle.getIterationCounts().size > 0
        ) {
          const hasActiveFamilies = config.researchStage === "block"
            ? lifecycle.hasActiveFamily(blockFamilyIds)
            : lifecycle.hasActiveFamily(lifecycle.getIterationCounts().keys());

          if (!hasActiveFamilies) {
            outcome = "completed";
            outcomeReason = "All active families retired.";
          }
        }

        if (
          outcome === "partial" &&
          !abortRequested &&
          iterations.length >= config.iterations
        ) {
          outcome = "completed";
          outcomeReason = `Configured iterations exhausted after ${iterations.length} iteration(s). Final review verdict was ${iterations[iterations.length - 1]?.review.verdict ?? "unknown"}.`;
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

        // Auto-promote only after final completed state is fully persisted.
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

        return finalReport;
      } finally {
        process.removeListener("SIGINT", handleAbort);
        process.removeListener("SIGTERM", handleAbort);
        await releaseRunLock(config.outputDir);
      }
    }
  };
}
