import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  getCandidateMarketsWithMinimumCandles
} from "../db.js";
import { getStrategyFamilies, normalizeCandidateProposal } from "./catalog.js";
import { UcmCodeMutationAgent, type CodeAgent } from "./code-agent.js";
import {
  buildRuntimeFamilies,
  createInitialCatalog,
  markCatalogFamilyState,
  mergeProposedFamilies,
  refreshCatalogImplementations,
  saveCatalogArtifact
} from "./proposed-catalog.js";
import type {
  AutoResearchRunConfig,
  AutoResearchRunReport,
  CandidateBacktestEvaluation,
  CodeMutationExecutionResult,
  CatalogEntryRecord,
  CandidateProposal,
  NormalizedCandidateProposal,
  PreparationExecutionResult,
  ProposalBatch,
  ResearchIterationRecord,
  StrategyFamilyDefinition,
  ValidationCommandResult
} from "./types.js";
import type { ResearchLlmClient } from "./llm-adapter.js";
import { executePreparationActions } from "./preparation.js";
import { acquireRunLock, appendRunLog, loadRunState, releaseRunLock, saveLeaderboard, saveRunState, saveRunStatus, toReport, type AutoResearchStatus } from "./run-manager.js";
import { renderAutoResearchHtmlWithOptions } from "./report-html.js";
import { runPostMutationValidation } from "./validation.js";

function summarizeMarkdown(report: AutoResearchRunReport): string {
  const lines = [
    "# Auto Research Report",
    "",
    `generatedAt: ${report.generatedAt}`,
    `mode: ${report.config.mode}`,
    `universe: ${report.config.universeName}`,
    `marketLimit: ${report.config.marketLimit}`,
    `limit: ${report.config.limit}`,
    ""
  ];

  if (report.bestCandidate) {
    lines.push("## Best Candidate");
    lines.push(`- id: ${report.bestCandidate.candidate.candidateId}`);
    lines.push(`- family: ${report.bestCandidate.candidate.familyId}`);
    lines.push(`- params: \`${JSON.stringify(report.bestCandidate.candidate.parameters)}\``);
    lines.push(`- netReturn: ${report.bestCandidate.summary.netReturn}`);
    lines.push(`- maxDrawdown: ${report.bestCandidate.summary.maxDrawdown}`);
    lines.push(`- tradeCount: ${report.bestCandidate.summary.tradeCount}`);
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
  if (left.status !== right.status) {
    return left.status === "failed" ? 1 : -1;
  }

  if (right.summary.netReturn !== left.summary.netReturn) {
    return right.summary.netReturn - left.summary.netReturn;
  }

  if (left.summary.maxDrawdown !== right.summary.maxDrawdown) {
    return left.summary.maxDrawdown - right.summary.maxDrawdown;
  }

  return right.summary.tradeCount - left.summary.tradeCount;
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
      netReturn: evaluation.summary.netReturn,
      maxDrawdown: evaluation.summary.maxDrawdown,
      tradeCount: evaluation.summary.tradeCount,
      parameters: evaluation.candidate.parameters
    }))
  ].sort((left, right) => {
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function quantize(value: number): number {
  return Number(value.toFixed(4));
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

  const directions = [1, -1, 2, -2];

  for (let offset = 0; offset < params.family.parameterSpecs.length; offset += 1) {
    const spec = params.family.parameterSpecs[(params.seed + offset) % params.family.parameterSpecs.length];
    const width = spec.max - spec.min;
    const current = params.candidate.parameters[spec.name];

    if (!Number.isFinite(current) || width <= 0) {
      continue;
    }

    const step = Math.max(width * 0.05, width / 20);

    for (const direction of directions) {
      const next = clamp(current + step * direction, spec.min, spec.max);
      if (Math.abs(next - current) < 1e-9) {
        continue;
      }

      const candidate: NormalizedCandidateProposal = {
        ...params.candidate,
        candidateId: `${params.candidate.familyId}-${params.suffix}-${String(params.seed + offset + Math.abs(direction)).padStart(2, "0")}`,
        thesis: `${params.candidate.thesis} Novelized from historical duplicate.`,
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

async function persistRunArtifacts(params: {
  outputDir: string;
  generatedAt: string;
  config: AutoResearchRunConfig;
  families: StrategyFamilyDefinition[];
  catalog: CatalogEntryRecord[];
  marketCodes: string[];
  iterations: ResearchIterationRecord[];
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
    bestCandidate: params.bestCandidate,
    pendingProposal: params.pendingProposal,
    noTradeIterations: params.noTradeIterations
  };
  const report = toReport(state);
  const rawLeaderboard = buildLeaderboard(params.iterations, params.liveEvaluations);
  const leaderboard = buildUniqueLeaderboard(rawLeaderboard);
  const candidateLedger = buildCandidateLedger(params.iterations, params.liveEvaluations);
  const familySummary = buildFamilySummary(candidateLedger);

  await saveRunState(params.outputDir, state);
  await saveLeaderboard(params.outputDir, leaderboard);
  await saveLeaderboard(params.outputDir, rawLeaderboard, "leaderboard.raw.json");
  await saveJson(path.join(params.outputDir, "candidate-ledger.json"), candidateLedger);
  await saveJson(path.join(params.outputDir, "family-summary.json"), familySummary);
  await saveJson(path.join(params.outputDir, "report.json"), report);
  await writeFile(path.join(params.outputDir, "report.md"), summarizeMarkdown(report));
  await writeFile(
    path.join(params.outputDir, "report.html"),
    renderAutoResearchHtmlWithOptions(report, {
      status: params.status,
      leaderboard,
      rawLeaderboard,
      candidateLedger,
      familySummary
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
  const codeAgent = deps.codeAgent ?? new UcmCodeMutationAgent();

  return {
    async run(inputConfig: AutoResearchRunConfig): Promise<AutoResearchRunReport> {
      const restored = inputConfig.resumeFrom ? await loadRunState(inputConfig.resumeFrom) : undefined;
      const config: AutoResearchRunConfig = restored?.config
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
            maxNoTradeIterations: inputConfig.maxNoTradeIterations ?? restored.config.maxNoTradeIterations
          }
        : inputConfig;
      const families = restored?.families ?? getStrategyFamilies(config.strategyFamilyIds);

      if (families.length === 0) {
        throw new Error("No strategy families selected for auto research");
      }

      await mkdir(config.outputDir, { recursive: true });
      await acquireRunLock(config.outputDir);

      try {
        const minCandles = Math.max(250, config.limit);
        const marketCodes = (
          await getCandidateMarketsWithMinimumCandles({
            timeframe: config.timeframe,
            minCandles
          })
        )
          .map((item) => item.marketCode)
          .slice(0, Math.max(config.marketLimit * 3, config.marketLimit + 5));

        if (marketCodes.length === 0) {
          throw new Error("No candidate markets available for auto research");
        }

        const iterations: ResearchIterationRecord[] = restored?.iterations ?? [];
        let catalog: CatalogEntryRecord[] = refreshCatalogImplementations(
          restored?.catalog ?? createInitialCatalog(families)
        );
        let runtimeFamilies = buildRuntimeFamilies(catalog);
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
          bestCandidate,
          pendingProposal: nextProposal,
          noTradeIterations,
          status: startingStatus
        });

        const startIteration = iterations.length + 1;
        for (let iteration = startIteration; iteration <= config.iterations; iteration += 1) {
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
                  families: runtimeFamilies,
                  marketCodes,
                  history: iterations
                }),
                config.llmTimeoutMs,
                "auto-research proposal"
              );
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              await log(`[auto-research] proposal-fallback ${message}`);
              break;
            }
          }
        catalog = mergeProposedFamilies(catalog, proposal.proposedFamilies);
        runtimeFamilies = buildRuntimeFamilies(catalog);
        await saveCatalogArtifact(config.outputDir, catalog);
        const baseCandidates = dedupeCandidates(normalizeCandidates(proposal.candidates, runtimeFamilies));
        const novelCandidates = ensureNovelCandidates({
          candidates: baseCandidates,
          families: runtimeFamilies,
          iterations,
          iteration
        });
        const normalizedCandidates = novelCandidates.length > 0 ? novelCandidates : baseCandidates;
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
        catalog = refreshCatalogImplementations(catalog);
        runtimeFamilies = buildRuntimeFamilies(catalog);
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
          let review;
          try {
            review = await withTimeout(
              deps.llmClient.reviewIteration({
                config,
                families: runtimeFamilies,
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
        catalog = mergeProposedFamilies(catalog, review.proposedFamilies);
        catalog = refreshCatalogImplementations(catalog);
        runtimeFamilies = buildRuntimeFamilies(catalog);
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
            const minTradesForPromotion = config.minTradesForPromotion;
            const minNetReturnForPromotion = config.minNetReturnForPromotion;
            const passesPromotionGate =
              promoted.status === "completed" &&
              (minTradesForPromotion === undefined || promoted.summary.tradeCount >= minTradesForPromotion) &&
              (minNetReturnForPromotion === undefined || promoted.summary.netReturn > minNetReturnForPromotion);

            catalog = markCatalogFamilyState(
              catalog,
              promoted.candidate.familyId,
              passesPromotionGate ? "validated" : "implemented",
              passesPromotionGate
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
          `[auto-research] iteration ${iteration}/${config.iterations} verdict=${review.verdict} bestNet=${evaluations[0]?.summary.netReturn ?? "n/a"}`
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
          break;
        }
      }

        const report = toReport({
        generatedAt: new Date().toISOString(),
        config,
        families: runtimeFamilies,
        catalog,
        marketCodes,
        iterations,
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
          bestCandidate,
          pendingProposal: nextProposal,
          noTradeIterations,
          status: {
            updatedAt: new Date().toISOString(),
            phase: "completed",
            iteration: report.iterations.length,
            totalIterations: config.iterations,
            message: "Auto research run completed."
          }
        });
        await saveRunStatus(config.outputDir, {
          updatedAt: new Date().toISOString(),
          phase: "completed",
          iteration: report.iterations.length,
          totalIterations: config.iterations,
          message: "Auto research run completed."
        });

        return report;
      } finally {
        await releaseRunLock(config.outputDir);
      }
    }
  };
}
