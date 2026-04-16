import fs from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { appendValidatedBlock, createEmptyBlockCatalog, promoteToValidatedBlock, saveValidatedBlockCatalog } from "./auto-research/block-catalog.js";
import { evaluateBlockCandidate } from "./auto-research/block-evaluator.js";
import { getBlockFamilyById } from "./auto-research/block-families.js";
import { calculateAutoResearchMinimumLimit } from "./auto-research/limit-resolution.js";
import { passesPromotionGate, compareCandidateEvaluations, calculateCandidateRiskAdjustedScore } from "./auto-research/ranking.js";
import { auditDeterministicBbArtifacts, writeDeterministicBbAuditReport } from "./audit-deterministic-bb.js";
import { replayDeterministicBbArtifacts, writeDeterministicBbReplayReport } from "./replay-deterministic-bb.js";
import type {
  AutoResearchRunConfig,
  CandidateBacktestEvaluation,
  NormalizedCandidateProposal,
  ResearchParameterSpec
} from "./auto-research/types.js";
import { getSelectedUniverseMarketsWithMinimumCandles, loadCandlesForMarkets } from "./db.js";
import type { Candle } from "./types.js";

export type FamilyKey = "weekly" | "daily" | "hourly";

type FamilyRunConfig = {
  key: FamilyKey;
  familyId: string;
  holdoutConfig: AutoResearchRunConfig;
  walkForwardConfig: AutoResearchRunConfig;
};

type CacheByTimeframe = Record<string, Record<string, Candle[]>>;

type CandidateSourceLabel =
  | "midpoint"
  | "artifact_seed"
  | "artifact_seed_mutation"
  | "elite_replay"
  | "elite_mutation";

type CandidateInput = {
  parameters: Record<string, number>;
  source: CandidateSourceLabel;
  parentCandidateIds: string[];
};

type CandidateMeasurement = {
  candidateId: string;
  familyId: string;
  familyKey: FamilyKey;
  generation: number | null;
  source: CandidateSourceLabel;
  parentCandidateIds: string[];
  parameters: Record<string, number>;
  totalReturn: number;
  grossReturn: number;
  netReturn: number;
  maxDrawdown: number;
  turnover: number;
  winRate: number;
  avgHoldBars: number;
  tradeCount: number;
  totalClosedTrades: number;
  signalCount: number;
  ghostSignalCount: number;
  rawBuySignals: number;
  rawSellSignals: number;
  rawHoldSignals: number;
  cooldownSkipsCount: number;
  rejectedOrdersCount: number;
  feePaid: number;
  slippagePaid: number;
  totalCostsPaid: number;
  positiveWindowRatio: number | null;
  bestWindowNetReturn: number | null;
  worstWindowNetReturn: number | null;
  randomPercentile: number | null;
  bootstrapSignificant: boolean | null;
  score: number;
  riskAdjustedScore: number;
  strategyReasonCounts: Record<string, number>;
  coordinatorReasonCounts: Record<string, number>;
  executionReasonCounts: Record<string, number>;
  riskReasonCounts: Record<string, number>;
  regimeTaggedStrategyReasons: Record<string, number>;
};

type MeasuredEvaluation = {
  evaluation: CandidateBacktestEvaluation;
  summary: CandidateMeasurement;
};

type FamilyGenerationSummary = {
  generation: number;
  candidateCount: number;
  bestCandidateId?: string;
  bestNetReturn?: number;
  bestRiskAdjustedScore?: number;
  tradefulCandidates: number;
  positiveCandidates: number;
};

type FamilyPromotionResult = {
  promoted: boolean;
  reason: string;
  candidateId?: string;
  blockId?: string;
};

export type FamilyReport = {
  key: FamilyKey;
  familyId: string;
  familyTitle: string;
  evaluatedCandidateCount: number;
  holdoutAttemptedCount: number;
  holdoutSucceededCount: number;
  walkForwardAttemptedCount: number;
  walkForwardSucceededCount: number;
  marketCodes: string[];
  generationSummaries: FamilyGenerationSummary[];
  holdoutTop: CandidateMeasurement[];
  walkForwardTop: CandidateMeasurement[];
  topSeeds: CandidateMeasurement[];
  topSeedsSource: "walk-forward" | "holdout-fallback";
  promotion: FamilyPromotionResult;
  failureCounts: {
    holdout: number;
    walkForward: number;
  };
  feeDrag: {
    grossReturn: number;
    netReturn: number;
    feePaid: number;
    slippagePaid: number;
    totalCostsPaid: number;
  } | null;
  regimeDiagnostics: {
    scope: "all_regimes";
    topStrategyReasons: Record<string, number>;
    regimeTaggedReasons: Record<string, number>;
  } | null;
  timings: {
    totalMs: number;
    avgHoldoutEvalMs: number;
    avgWalkForwardEvalMs: number;
  };
};

export type DeterministicBbResearchStatus = {
  updatedAt: string;
  phase: "starting" | "preload" | "holdout" | "walk-forward" | "completed" | "failed";
  family?: FamilyKey;
  generation?: number;
  totalGenerations: number;
  completedCandidates?: number;
  candidateTotal?: number;
  message: string;
  audit?: {
    ok: boolean;
    errorCount: number;
    warningCount: number;
    reportPath: string;
  };
  replay?: {
    ok: boolean;
    errorCount: number;
    warningCount: number;
    reportPath: string;
  };
};

export type DeterministicBbResearchConfig = {
  familyKeys: FamilyKey[];
  universeName: string;
  min5mCandles: number;
  marketLimit: number;
  candidateCount: number;
  eliteCount: number;
  generations: number;
  walkForwardTop: number;
  topSeedExportCount: number;
  holdoutDays: number;
  trainingDays: number;
  stepDays: number;
  limit: number;
  randomSeed: number;
  outputDir: string;
  reportPath: string;
  legacyOutputPath?: string;
  seedReports: string[];
  promotionGate: {
    minTrades?: number;
    minNetReturn?: number;
    maxDrawdown?: number;
    minPositiveWindowRatio?: number;
    minRandomPercentile?: number;
    requireBootstrapSignificance?: boolean;
  };
};

export type DeterministicBbResearchReport = {
  generatedAt: string;
  outputDir: string;
  reportPath: string;
  config: Omit<DeterministicBbResearchConfig, "outputDir" | "reportPath" | "legacyOutputPath">;
  marketCodes: string[];
  seedReports: string[];
  preloadMs: number;
  preloadLimits: { limit1h: number; limit5m: number };
  dataSnapshot: {
    "1h": Array<{
      marketCode: string;
      candleCount: number;
      firstCandleTimeUtc: string | null;
      lastCandleTimeUtc: string | null;
    }>;
    "5m": Array<{
      marketCode: string;
      candleCount: number;
      firstCandleTimeUtc: string | null;
      lastCandleTimeUtc: string | null;
    }>;
  };
  totalRuntimeMs: number;
  overallLeaderboard: CandidateMeasurement[];
  topSeeds: CandidateMeasurement[];
  validatedBlockCount: number;
  families: Partial<Record<FamilyKey, FamilyReport>>;
};

type DeterministicBbResearchDeps = {
  selectMarkets?: typeof getSelectedUniverseMarketsWithMinimumCandles;
  loadCandles?: typeof loadCandlesForMarkets;
  evaluateCandidate?: typeof evaluateBlockCandidate;
  auditArtifacts?: typeof auditDeterministicBbArtifacts;
  writeAuditReport?: typeof writeDeterministicBbAuditReport;
  replayArtifacts?: typeof import("./replay-deterministic-bb.js").replayDeterministicBbArtifacts;
  writeReplayReport?: typeof import("./replay-deterministic-bb.js").writeDeterministicBbReplayReport;
};

function getOption(args: string[], key: string): string | undefined {
  const index = args.indexOf(key);
  return index === -1 ? undefined : args[index + 1];
}

function getNumberOption(args: string[], key: string, fallback: number): number {
  const raw = getOption(args, key);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getListOption(args: string[], key: string, fallback: string[]): string[] {
  const raw = getOption(args, key);
  if (!raw) return fallback;
  return raw.split(",").map((value) => value.trim()).filter(Boolean);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
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

function candidateFingerprint(familyId: string, parameters: Record<string, number>): string {
  return `${familyId}:${stableParametersKey(parameters)}`;
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function isIntLike(name: string): boolean {
  return /(Window|Period|Bars|Lookback)/.test(name);
}

function roundForSpec(name: string, value: number): number {
  return isIntLike(name) ? Math.round(value) : Math.round(value * 1000) / 1000;
}

function buildMidpointParams(specs: ResearchParameterSpec[]): Record<string, number> {
  const params: Record<string, number> = {};
  for (const spec of specs) {
    params[spec.name] = roundForSpec(spec.name, (spec.min + spec.max) / 2);
  }
  return params;
}

function normalizeBbParams(params: Record<string, number>): Record<string, number> {
  const normalized = { ...params };
  if (typeof normalized.entryPercentB === "number" && typeof normalized.deepTouchEntryPercentB === "number") {
    normalized.deepTouchEntryPercentB = Math.min(
      normalized.deepTouchEntryPercentB,
      normalized.entryPercentB - 0.002
    );
  }
  if (typeof normalized.entryRsiThreshold === "number" && typeof normalized.deepTouchRsiThreshold === "number") {
    normalized.deepTouchRsiThreshold = Math.min(
      normalized.deepTouchRsiThreshold,
      normalized.entryRsiThreshold
    );
  }
  if (typeof normalized.reclaimPercentBThreshold === "number" && typeof normalized.entryPercentB === "number") {
    normalized.reclaimPercentBThreshold = Math.max(
      normalized.reclaimPercentBThreshold,
      normalized.entryPercentB + 0.01
    );
  }
  return normalized;
}

function mutateParams(
  baseParams: Record<string, number>,
  specs: ResearchParameterSpec[],
  random: () => number,
  intensity: number
): Record<string, number> {
  const next: Record<string, number> = {};
  for (const spec of specs) {
    const base = baseParams[spec.name] ?? (spec.min + spec.max) / 2;
    const range = spec.max - spec.min;
    const jitter = (random() * 2 - 1) * range * intensity;
    next[spec.name] = roundForSpec(spec.name, clamp(base + jitter, spec.min, spec.max));
  }
  return normalizeBbParams(next);
}

function scoreSeedCandidate(node: Record<string, unknown>): number {
  const netReturn = typeof node.netReturn === "number" ? node.netReturn : 0;
  const positiveWindowRatio = typeof node.positiveWindowRatio === "number" ? node.positiveWindowRatio : 0;
  const tradeCount = typeof node.tradeCount === "number" ? node.tradeCount : 0;
  return netReturn * 10 + positiveWindowRatio * 2 + Math.min(tradeCount, 25) * 0.01;
}

function collectRankedSeeds(
  node: unknown,
  familyId: string,
  matches: Array<{ parameters: Record<string, number>; score: number }>
): void {
  if (!Array.isArray(node)) {
    return;
  }

  for (const item of node) {
    if (
      item &&
      typeof item === "object" &&
      "familyId" in item &&
      (item as { familyId?: unknown }).familyId === familyId &&
      "parameters" in item &&
      typeof (item as { parameters?: unknown }).parameters === "object"
    ) {
      matches.push({
        parameters: (item as { parameters: Record<string, number> }).parameters,
        score: scoreSeedCandidate(item as Record<string, unknown>)
      });
    }
  }
}

function collectSeedParams(seedPaths: string[], familyId: string): Record<string, number>[] {
  const collected: Array<{ parameters: Record<string, number>; score: number }> = [];
  for (const seedPath of seedPaths) {
    if (!fs.existsSync(seedPath)) {
      continue;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(seedPath, "utf8"));
      if (parsed && typeof parsed === "object") {
        const record = parsed as Record<string, unknown>;
        collectRankedSeeds(record.topSeeds, familyId, collected);
        collectRankedSeeds(record.overallLeaderboard, familyId, collected);
        collectRankedSeeds(record.walkForwardTop, familyId, collected);
        collectRankedSeeds(record.holdoutTop, familyId, collected);
        if (record.families && typeof record.families === "object") {
          const familyNode = (record.families as Record<string, unknown>)[
            familyId.includes("hourly") ? "hourly" : familyId.includes("daily") ? "daily" : "weekly"
          ];
          if (familyNode && typeof familyNode === "object") {
            const familyRecord = familyNode as Record<string, unknown>;
            collectRankedSeeds(familyRecord.topSeeds, familyId, collected);
            collectRankedSeeds(familyRecord.walkForwardTop, familyId, collected);
            collectRankedSeeds(familyRecord.holdoutTop, familyId, collected);
          }
        }
      }
    } catch {
      // Ignore malformed seed reports and continue.
    }
  }

  const deduped = new Map<string, { parameters: Record<string, number>; score: number }>();
  for (const item of collected) {
    const normalized = normalizeBbParams(item.parameters);
    const fingerprint = candidateFingerprint(familyId, normalized);
    const existing = deduped.get(fingerprint);
    if (!existing || item.score > existing.score) {
      deduped.set(fingerprint, { parameters: normalized, score: item.score });
    }
  }

  return [...deduped.values()]
    .sort((left, right) => right.score - left.score)
    .map((item) => item.parameters);
}

function familyIdForKey(key: FamilyKey): string {
  switch (key) {
    case "weekly":
      return "block:bb-reversion-1h";
    case "daily":
      return "block:bb-reversion-1h-daily";
    case "hourly":
      return "block:bb-reversion-1h-hourly";
    default:
      return "block:bb-reversion-1h-daily";
  }
}

function createFamilyRun(key: FamilyKey, params: {
  universeName: string;
  marketLimit: number;
  limit: number;
  holdoutDays: number;
  trainingDays: number;
  stepDays: number;
}): FamilyRunConfig {
  return {
    key,
    familyId: familyIdForKey(key),
    holdoutConfig: {
      researchStage: "block",
      mode: "holdout",
      timeframe: "1h",
      holdoutDays: params.holdoutDays,
      trainingDays: params.trainingDays,
      stepDays: params.stepDays,
      universeName: params.universeName,
      marketLimit: params.marketLimit,
      limit: params.limit,
      iterations: 1,
      candidatesPerIteration: 1,
      parallelism: 1,
      outputDir: "/tmp",
      allowDataCollection: false,
      allowFeatureCacheBuild: false,
      allowCodeMutation: false
    },
    walkForwardConfig: {
      researchStage: "block",
      mode: "walk-forward",
      timeframe: "1h",
      holdoutDays: params.holdoutDays,
      trainingDays: params.trainingDays,
      stepDays: params.stepDays,
      universeName: params.universeName,
      marketLimit: params.marketLimit,
      limit: params.limit,
      iterations: 1,
      candidatesPerIteration: 1,
      parallelism: 1,
      outputDir: "/tmp",
      allowDataCollection: false,
      allowFeatureCacheBuild: false,
      allowCodeMutation: false
    }
  };
}

function buildCachedLoader(cache: CacheByTimeframe) {
  return async function cachedLoadCandles(params: {
    marketCodes: string[];
    timeframe: string;
    limit?: number;
  }): Promise<Record<string, Candle[]>> {
    const timeframeCache = cache[params.timeframe];
    if (!timeframeCache) {
      throw new Error(`Missing cached candles for timeframe=${params.timeframe}`);
    }
    const output: Record<string, Candle[]> = {};
    for (const marketCode of params.marketCodes) {
      const candles = timeframeCache[marketCode] ?? [];
      output[marketCode] =
        params.limit && params.limit > 0 && candles.length > params.limit
          ? candles.slice(-params.limit)
          : candles.slice();
    }
    return output;
  };
}

async function preloadBbCandles(params: {
  marketCodes: string[];
  familyRuns: FamilyRunConfig[];
  loadCandles: typeof loadCandlesForMarkets;
}): Promise<{ cache: CacheByTimeframe; preloadMs: number; limits: { limit1h: number; limit5m: number } }> {
  const startedAt = performance.now();
  let limit1h = 0;
  let limit5m = 0;

  for (const familyRun of params.familyRuns) {
    for (const config of [familyRun.holdoutConfig, familyRun.walkForwardConfig]) {
      const needed1h = Math.max(
        config.limit,
        calculateAutoResearchMinimumLimit({
          timeframe: "1h",
          holdoutDays: config.holdoutDays,
          trainingDays: config.trainingDays,
          stepDays: config.stepDays,
          mode: config.mode
        })
      );
      const needed5m = Math.max(
        calculateAutoResearchMinimumLimit({
          timeframe: "5m",
          holdoutDays: config.holdoutDays,
          trainingDays: config.trainingDays,
          stepDays: config.stepDays,
          mode: config.mode
        }),
        needed1h * 12
      );
      limit1h = Math.max(limit1h, needed1h);
      limit5m = Math.max(limit5m, needed5m);
    }
  }

  const [candles1h, candles5m] = await Promise.all([
    params.loadCandles({ marketCodes: params.marketCodes, timeframe: "1h", limit: limit1h }),
    params.loadCandles({ marketCodes: params.marketCodes, timeframe: "5m", limit: limit5m })
  ]);

  return {
    cache: {
      "1h": candles1h,
      "5m": candles5m
    },
    preloadMs: performance.now() - startedAt,
    limits: { limit1h, limit5m }
  };
}

function buildDataSnapshot(cache: CacheByTimeframe): DeterministicBbResearchReport["dataSnapshot"] {
  const summarizeTimeframe = (timeframe: "1h" | "5m") =>
    Object.entries(cache[timeframe] ?? {})
      .map(([marketCode, candles]) => ({
        marketCode,
        candleCount: candles.length,
        firstCandleTimeUtc: candles[0]?.candleTimeUtc?.toISOString?.() ?? null,
        lastCandleTimeUtc: candles[candles.length - 1]?.candleTimeUtc?.toISOString?.() ?? null
      }))
      .sort((left, right) => left.marketCode.localeCompare(right.marketCode));

  return {
    "1h": summarizeTimeframe("1h"),
    "5m": summarizeTimeframe("5m")
  };
}

function topCounts(record: Record<string, number>, limit = 8): Record<string, number> {
  return Object.fromEntries(
    Object.entries(record)
      .sort((left, right) => right[1] - left[1])
      .slice(0, limit)
  );
}

function compareMeasuredEvaluations(left: MeasuredEvaluation, right: MeasuredEvaluation): number {
  return compareCandidateEvaluations(left.evaluation, right.evaluation);
}

function summarizeEvaluation(params: {
  evaluation: CandidateBacktestEvaluation;
  familyKey: FamilyKey;
  generation: number | null;
  source: CandidateSourceLabel;
}): CandidateMeasurement {
  const { evaluation } = params;
  const regimeTaggedStrategyReasons = Object.fromEntries(
    Object.entries(evaluation.diagnostics.reasons.strategy).filter(([reason]) =>
      reason.toLowerCase().includes("regime")
    )
  );

  return {
    candidateId: evaluation.candidate.candidateId,
    familyId: evaluation.candidate.familyId,
    familyKey: params.familyKey,
    generation: params.generation,
    source: params.source,
    parentCandidateIds: evaluation.candidate.parentCandidateIds ?? [],
    parameters: evaluation.candidate.parameters,
    totalReturn: evaluation.summary.totalReturn,
    grossReturn: evaluation.summary.grossReturn,
    netReturn: evaluation.summary.netReturn,
    maxDrawdown: evaluation.summary.maxDrawdown,
    turnover: evaluation.summary.turnover,
    winRate: evaluation.summary.winRate,
    avgHoldBars: evaluation.summary.avgHoldBars,
    tradeCount: evaluation.summary.tradeCount,
    totalClosedTrades: evaluation.diagnostics.windows.totalClosedTrades ?? evaluation.summary.tradeCount,
    signalCount: evaluation.summary.signalCount,
    ghostSignalCount: evaluation.summary.ghostSignalCount,
    rawBuySignals: evaluation.diagnostics.coverage.rawBuySignals,
    rawSellSignals: evaluation.diagnostics.coverage.rawSellSignals,
    rawHoldSignals: evaluation.diagnostics.coverage.rawHoldSignals,
    cooldownSkipsCount: evaluation.diagnostics.coverage.cooldownSkipsCount,
    rejectedOrdersCount: evaluation.summary.rejectedOrdersCount,
    feePaid: evaluation.summary.feePaid,
    slippagePaid: evaluation.summary.slippagePaid,
    totalCostsPaid: evaluation.summary.feePaid + evaluation.summary.slippagePaid,
    positiveWindowRatio: evaluation.diagnostics.windows.positiveWindowRatio ?? null,
    bestWindowNetReturn: evaluation.diagnostics.windows.bestWindowNetReturn ?? null,
    worstWindowNetReturn: evaluation.diagnostics.windows.worstWindowNetReturn ?? null,
    randomPercentile:
      evaluation.summary.randomPercentile ??
      evaluation.diagnostics.robustness.randomPercentile ??
      null,
    bootstrapSignificant:
      evaluation.summary.bootstrapSignificant ??
      evaluation.diagnostics.robustness.bootstrapSignificant ??
      null,
    score: calculateCandidateRiskAdjustedScore(evaluation),
    riskAdjustedScore: calculateCandidateRiskAdjustedScore(evaluation),
    strategyReasonCounts: topCounts(evaluation.diagnostics.reasons.strategy),
    coordinatorReasonCounts: topCounts(evaluation.diagnostics.reasons.coordinator),
    executionReasonCounts: topCounts(evaluation.diagnostics.reasons.execution),
    riskReasonCounts: topCounts(evaluation.diagnostics.reasons.risk),
    regimeTaggedStrategyReasons: topCounts(regimeTaggedStrategyReasons)
  };
}

function buildCandidateInputPool(params: {
  familyId: string;
  specs: ResearchParameterSpec[];
  generation: number;
  candidateCount: number;
  eliteCount: number;
  seedParams: Record<string, number>[];
  elites: MeasuredEvaluation[];
  random: () => number;
}): CandidateInput[] {
  const inputs: CandidateInput[] = [];
  const seen = new Set<string>();

  const push = (input: CandidateInput) => {
    const normalized = normalizeBbParams(input.parameters);
    const fingerprint = candidateFingerprint(params.familyId, normalized);
    if (seen.has(fingerprint)) {
      return;
    }
    if (inputs.length >= params.candidateCount) {
      return;
    }
    seen.add(fingerprint);
    inputs.push({
      parameters: normalized,
      source: input.source,
      parentCandidateIds: input.parentCandidateIds
    });
  };

  const midpoint = buildMidpointParams(params.specs);

  if (params.generation === 1) {
    push({
      parameters: midpoint,
      source: "midpoint",
      parentCandidateIds: []
    });

    for (const seed of params.seedParams) {
      push({
        parameters: seed,
        source: "artifact_seed",
        parentCandidateIds: []
      });
    }
  } else {
    for (const elite of params.elites.slice(0, params.eliteCount)) {
      push({
        parameters: elite.summary.parameters,
        source: "elite_replay",
        parentCandidateIds: [elite.summary.candidateId]
      });
    }
  }

  const sourcePool =
    params.generation === 1
      ? [
          ...inputs,
          {
            parameters: midpoint,
            source: "midpoint" as const,
            parentCandidateIds: []
          }
        ]
      : params.elites.slice(0, Math.max(1, params.eliteCount)).map((elite) => ({
          parameters: elite.summary.parameters,
          source: "elite_mutation" as const,
          parentCandidateIds: [elite.summary.candidateId]
        }));

  if (sourcePool.length === 0) {
    sourcePool.push({
      parameters: midpoint,
      source: "midpoint",
      parentCandidateIds: []
    });
  }

  const intensityBase = Math.max(0.045, 0.22 * Math.pow(0.72, params.generation - 1));

  while (inputs.length < params.candidateCount) {
    const source = sourcePool[Math.floor(params.random() * sourcePool.length)] ?? sourcePool[0]!;
    push({
      parameters: mutateParams(
        source.parameters,
        params.specs,
        params.random,
        intensityBase + params.random() * intensityBase * 0.35
      ),
      source: source.source === "artifact_seed" ? "artifact_seed_mutation" : "elite_mutation",
      parentCandidateIds: source.parentCandidateIds
    });
  }

  return inputs;
}

function buildCandidateProposal(params: {
  familyRun: FamilyRunConfig;
  candidateInput: CandidateInput;
  familyTitle: string;
  familyThesis: string;
  generation: number;
  index: number;
}): NormalizedCandidateProposal {
  const prefix =
    params.candidateInput.source === "artifact_seed"
      ? "seed"
      : params.candidateInput.source === "artifact_seed_mutation"
        ? "seedmut"
      : params.candidateInput.source === "midpoint"
        ? "mid"
        : params.candidateInput.source === "elite_replay"
          ? "elite"
          : "mut";

  return {
    candidateId: `bb-${params.familyRun.key}-g${String(params.generation).padStart(2, "0")}-${prefix}-${String(params.index + 1).padStart(2, "0")}`,
    familyId: params.familyRun.familyId,
    strategyName: params.familyTitle,
    thesis: params.familyThesis,
    invalidationSignals: [],
    origin:
      params.candidateInput.source === "artifact_seed"
        ? "artifact_seed"
        : params.candidateInput.source === "artifact_seed_mutation"
          ? "engine_mutation"
        : params.candidateInput.source === "elite_mutation"
          ? "engine_mutation"
          : "engine_seed",
    parentCandidateIds: params.candidateInput.parentCandidateIds,
    parameters: params.candidateInput.parameters
  };
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tempPath, filePath);
}

async function appendLog(outputDir: string, message: string): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  fs.appendFileSync(path.join(outputDir, "run.log"), `[${new Date().toISOString()}] ${message}\n`);
  console.log(message);
}

async function saveStatus(outputDir: string, status: DeterministicBbResearchStatus): Promise<void> {
  await writeJsonAtomic(path.join(outputDir, "status.json"), status);
}

function summarizeGeneration(generation: number, evaluations: MeasuredEvaluation[]): FamilyGenerationSummary {
  const sorted = evaluations.slice().sort(compareMeasuredEvaluations);
  const best = sorted[0];
  return {
    generation,
    candidateCount: evaluations.length,
    bestCandidateId: best?.summary.candidateId,
    bestNetReturn: best?.summary.netReturn,
    bestRiskAdjustedScore: best?.summary.riskAdjustedScore,
    tradefulCandidates: evaluations.filter((item) => item.summary.tradeCount > 0).length,
    positiveCandidates: evaluations.filter((item) => item.summary.netReturn > 0).length
  };
}

function summarizeMarkdown(report: DeterministicBbResearchReport): string {
  const lines = [
    "# Deterministic BB Research",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- outputDir: ${report.outputDir}`,
    `- families: ${report.config.familyKeys.join(", ")}`,
    `- markets: ${report.marketCodes.join(", ")}`,
    `- validatedBlocks: ${report.validatedBlockCount}`,
    `- totalRuntimeMs: ${report.totalRuntimeMs}`,
    ""
  ];

  for (const familyKey of report.config.familyKeys) {
    const family = report.families[familyKey];
    if (!family) {
      continue;
    }

    const best = family.walkForwardTop[0] ?? family.holdoutTop[0];
    lines.push(`## ${familyKey}`);
    lines.push(`- familyId: ${family.familyId}`);
    lines.push(`- evaluatedCandidateCount: ${family.evaluatedCandidateCount}`);
    lines.push(`- promoted: ${family.promotion.promoted ? "yes" : "no"} (${family.promotion.reason})`);
    if (best) {
      lines.push(
        `- best: ${best.candidateId} net=${(best.netReturn * 100).toFixed(2)}% dd=${(best.maxDrawdown * 100).toFixed(2)}% trades=${best.tradeCount}`
      );
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function resolveOutputTargets(args: string[]): {
  outputDir: string;
  reportPath: string;
  legacyOutputPath?: string;
} {
  const outputDirOption = getOption(args, "--output-dir");
  const legacyOutput = getOption(args, "--output");
  const defaultOutputDir = path.resolve(
    process.cwd(),
    `research/backtester/artifacts/bb-deterministic-${new Date().toISOString().replace(/[:.]/g, "-")}`
  );

  if (outputDirOption) {
    const outputDir = path.resolve(process.cwd(), outputDirOption);
    return {
      outputDir,
      reportPath: path.join(outputDir, "report.json"),
      legacyOutputPath: legacyOutput ? path.resolve(process.cwd(), legacyOutput) : undefined
    };
  }

  if (legacyOutput) {
    const resolved = path.resolve(process.cwd(), legacyOutput);
    if (resolved.endsWith(".json")) {
      return {
        outputDir: path.dirname(resolved),
        reportPath: path.join(path.dirname(resolved), "report.json"),
        legacyOutputPath: resolved
      };
    }

    return {
      outputDir: resolved,
      reportPath: path.join(resolved, "report.json")
    };
  }

  return {
    outputDir: defaultOutputDir,
    reportPath: path.join(defaultOutputDir, "report.json")
  };
}

export function parseDeterministicBbResearchConfig(args: string[]): DeterministicBbResearchConfig {
  const familyKeys = getListOption(args, "--families", ["weekly", "daily", "hourly"])
    .map((value) => value.toLowerCase())
    .flatMap((value) => (value === "all" ? ["weekly", "daily", "hourly"] : [value]))
    .filter((value): value is FamilyKey => value === "weekly" || value === "daily" || value === "hourly");
  const uniqueFamilyKeys = [...new Set(familyKeys)];

  if (uniqueFamilyKeys.length === 0) {
    throw new Error("No valid --families provided. Use weekly,daily,hourly or all.");
  }

  const targets = resolveOutputTargets(args);

  return {
    familyKeys: uniqueFamilyKeys,
    universeName: getOption(args, "--universe") ?? "krw-top",
    min5mCandles: getNumberOption(args, "--min-5m-candles", 150_000),
    marketLimit: getNumberOption(args, "--market-limit", 20),
    candidateCount: getNumberOption(args, "--candidate-count", 18),
    eliteCount: getNumberOption(args, "--elite-count", 6),
    generations: getNumberOption(args, "--generations", 3),
    walkForwardTop: getNumberOption(args, "--walk-forward-top", 4),
    topSeedExportCount: getNumberOption(args, "--top-seeds", 4),
    holdoutDays: getNumberOption(args, "--holdout-days", 365),
    trainingDays: getNumberOption(args, "--training-days", 270),
    stepDays: getNumberOption(args, "--step-days", 90),
    limit: getNumberOption(args, "--limit", 10_000),
    randomSeed: getNumberOption(args, "--seed", 20260321),
    outputDir: targets.outputDir,
    reportPath: targets.reportPath,
    legacyOutputPath: targets.legacyOutputPath,
    seedReports: getListOption(args, "--seed-report", []).map((seedPath) => path.resolve(process.cwd(), seedPath)),
    promotionGate: {
      minTrades: getOption(args, "--min-trades") ? getNumberOption(args, "--min-trades", 0) : undefined,
      minNetReturn: getOption(args, "--min-net-return") ? getNumberOption(args, "--min-net-return", 0) : undefined,
      maxDrawdown: getOption(args, "--max-drawdown") ? getNumberOption(args, "--max-drawdown", 0) : undefined,
      minPositiveWindowRatio: getOption(args, "--min-positive-window-ratio")
        ? getNumberOption(args, "--min-positive-window-ratio", 0)
        : undefined,
      minRandomPercentile: getOption(args, "--min-random-percentile")
        ? getNumberOption(args, "--min-random-percentile", 0)
        : undefined,
      requireBootstrapSignificance: args.includes("--require-bootstrap-significance")
    }
  };
}

export async function runDeterministicBbResearch(
  config: DeterministicBbResearchConfig,
  deps: DeterministicBbResearchDeps = {}
): Promise<DeterministicBbResearchReport> {
  const selectMarkets = deps.selectMarkets ?? getSelectedUniverseMarketsWithMinimumCandles;
  const loadCandles = deps.loadCandles ?? loadCandlesForMarkets;
  const evaluateCandidateFn = deps.evaluateCandidate ?? evaluateBlockCandidate;
  const auditArtifacts = deps.auditArtifacts ?? auditDeterministicBbArtifacts;
  const writeAuditReport = deps.writeAuditReport ?? writeDeterministicBbAuditReport;
  const replayArtifacts = deps.replayArtifacts ?? replayDeterministicBbArtifacts;
  const writeReplayReport = deps.writeReplayReport ?? writeDeterministicBbReplayReport;

  const overallStartedAt = performance.now();
  await mkdir(config.outputDir, { recursive: true });
  await writeJsonAtomic(path.join(config.outputDir, "config.json"), config);
  await appendLog(config.outputDir, `[bb-deterministic] starting output=${config.outputDir}`);
  await saveStatus(config.outputDir, {
    updatedAt: new Date().toISOString(),
    phase: "starting",
    totalGenerations: config.generations,
    message: "Selecting markets."
  });

  const required1hCandles = Math.max(
    config.limit,
    calculateAutoResearchMinimumLimit({
      timeframe: "1h",
      holdoutDays: config.holdoutDays,
      trainingDays: config.trainingDays,
      stepDays: config.stepDays,
      mode: "walk-forward"
    }),
    calculateAutoResearchMinimumLimit({
      timeframe: "1h",
      holdoutDays: config.holdoutDays,
      trainingDays: config.trainingDays,
      stepDays: config.stepDays,
      mode: "holdout"
    })
  );
  const required5mCandles = Math.max(
    config.min5mCandles,
    calculateAutoResearchMinimumLimit({
      timeframe: "5m",
      holdoutDays: config.holdoutDays,
      trainingDays: config.trainingDays,
      stepDays: config.stepDays,
      mode: "walk-forward"
    }),
    calculateAutoResearchMinimumLimit({
      timeframe: "5m",
      holdoutDays: config.holdoutDays,
      trainingDays: config.trainingDays,
      stepDays: config.stepDays,
      mode: "holdout"
    }),
    required1hCandles * 12
  );

  const [rows5m, rows1h] = await Promise.all([
    selectMarkets({
      universeName: config.universeName,
      timeframe: "5m",
      minCandles: required5mCandles,
      limit: config.marketLimit * 4
    }),
    selectMarkets({
      universeName: config.universeName,
      timeframe: "1h",
      minCandles: required1hCandles,
      limit: config.marketLimit * 4
    })
  ]);

  const eligible1h = new Set(rows1h.map((row) => row.marketCode));
  const marketCodes = rows5m
    .map((row) => row.marketCode)
    .filter((marketCode) => eligible1h.has(marketCode))
    .slice(0, config.marketLimit);
  if (marketCodes.length === 0) {
    throw new Error(
      `No markets available for universe=${config.universeName} with min5mCandles=${required5mCandles} and min1hCandles=${required1hCandles}`
    );
  }

  const familyRuns = config.familyKeys.map((key) =>
    createFamilyRun(key, {
      universeName: config.universeName,
      marketLimit: marketCodes.length,
      limit: config.limit,
      holdoutDays: config.holdoutDays,
      trainingDays: config.trainingDays,
      stepDays: config.stepDays
    })
  );

  await saveStatus(config.outputDir, {
    updatedAt: new Date().toISOString(),
    phase: "preload",
    totalGenerations: config.generations,
    message: `Preloading candles for ${marketCodes.length} markets.`
  });

  const { cache, preloadMs, limits } = await preloadBbCandles({
    marketCodes,
    familyRuns,
    loadCandles
  });
  const cachedLoadCandles = buildCachedLoader(cache);
  const dataSnapshot = buildDataSnapshot(cache);

  const families: Partial<Record<FamilyKey, FamilyReport>> = {};
  const overallWalkForward: MeasuredEvaluation[] = [];
  let blockCatalog = createEmptyBlockCatalog();

  for (const [familyIndex, familyRun] of familyRuns.entries()) {
    const familyDir = path.join(config.outputDir, familyRun.key);
    await mkdir(path.join(familyDir, "holdout-raw"), { recursive: true });
    await mkdir(path.join(familyDir, "walk-forward-raw"), { recursive: true });
    const familyStartedAt = performance.now();
    const familyDef = getBlockFamilyById(familyRun.familyId);
    const random = mulberry32(config.randomSeed + familyIndex * 9973);
    const seedParams = collectSeedParams(config.seedReports, familyRun.familyId);
    const overallHoldoutByFingerprint = new Map<string, MeasuredEvaluation>();
    const generationSummaries: FamilyGenerationSummary[] = [];
    let elites: MeasuredEvaluation[] = [];
    let holdoutEvalMs = 0;
    let holdoutFailureCount = 0;
    let walkForwardFailureCount = 0;
    let holdoutAttemptedCount = 0;
    let holdoutSucceededCount = 0;

    await appendLog(
      config.outputDir,
      `[bb-deterministic][${familyRun.key}] family=${familyRun.familyId} seeds=${seedParams.length} generations=${config.generations}`
    );

    for (let generation = 1; generation <= config.generations; generation += 1) {
      const candidateInputs = buildCandidateInputPool({
        familyId: familyRun.familyId,
        specs: familyDef.parameterSpecs,
        generation,
        candidateCount: config.candidateCount,
        eliteCount: config.eliteCount,
        seedParams,
        elites,
        random
      });
      const generationEvaluations: MeasuredEvaluation[] = [];
      holdoutAttemptedCount += candidateInputs.length;
      const holdoutGenerationRawDir = path.join(
        familyDir,
        "holdout-raw",
        `generation-${String(generation).padStart(2, "0")}`
      );
      await mkdir(holdoutGenerationRawDir, { recursive: true });

      await saveStatus(config.outputDir, {
        updatedAt: new Date().toISOString(),
        phase: "holdout",
        family: familyRun.key,
        generation,
        totalGenerations: config.generations,
        candidateTotal: candidateInputs.length,
        completedCandidates: 0,
        message: `Evaluating ${familyRun.key} holdout generation ${generation}.`
      });

      for (const [index, candidateInput] of candidateInputs.entries()) {
        const candidate = buildCandidateProposal({
          familyRun,
          candidateInput,
          familyTitle: familyDef.strategyName,
          familyThesis: familyDef.thesis,
          generation,
          index
        });
        const candidateStartedAt = performance.now();
        try {
          const evaluation = await evaluateCandidateFn({
            config: familyRun.holdoutConfig,
            candidate,
            marketCodes,
            loadCandles: cachedLoadCandles
          });
          if (evaluation.status !== "completed") {
            holdoutFailureCount += 1;
            await appendLog(
              config.outputDir,
              `[bb-deterministic][holdout][${familyRun.key}][g${generation}] returned status=${evaluation.status} candidate=${candidate.candidateId}`
            );
            continue;
          }
          holdoutEvalMs += performance.now() - candidateStartedAt;
          const summary = summarizeEvaluation({
            evaluation,
            familyKey: familyRun.key,
            generation,
            source: candidateInput.source
          });
          const measured: MeasuredEvaluation = { evaluation, summary };
          generationEvaluations.push(measured);
          holdoutSucceededCount += 1;
          await writeJsonAtomic(path.join(holdoutGenerationRawDir, `${candidate.candidateId}.json`), evaluation);

          const fingerprint = candidateFingerprint(familyRun.familyId, summary.parameters);
          const existing = overallHoldoutByFingerprint.get(fingerprint);
          if (!existing || compareMeasuredEvaluations(measured, existing) < 0) {
            overallHoldoutByFingerprint.set(fingerprint, measured);
          }

          console.log(
            `[bb-deterministic][holdout][${familyRun.key}][g${generation}] ${index + 1}/${candidateInputs.length} ` +
              `net=${summary.netReturn.toFixed(4)} dd=${summary.maxDrawdown.toFixed(4)} trades=${summary.tradeCount} ` +
              `source=${summary.source}`
          );
        } catch (error) {
          holdoutFailureCount += 1;
          await appendLog(
            config.outputDir,
            `[bb-deterministic][holdout][${familyRun.key}][g${generation}] failed candidate=${candidate.candidateId} error=${error instanceof Error ? error.message : String(error)}`
          );
        }
        await saveStatus(config.outputDir, {
          updatedAt: new Date().toISOString(),
          phase: "holdout",
          family: familyRun.key,
          generation,
          totalGenerations: config.generations,
          candidateTotal: candidateInputs.length,
          completedCandidates: index + 1,
          message: `Evaluated ${familyRun.key} generation ${generation} holdout candidates.`
        });
      }

      generationEvaluations.sort(compareMeasuredEvaluations);
      const generationTop = generationEvaluations.map((item) => item.summary);
      await writeJsonAtomic(path.join(familyDir, `generation-${String(generation).padStart(2, "0")}-holdout.json`), generationTop);
      const generationSummary = summarizeGeneration(generation, generationEvaluations);
      generationSummaries.push(generationSummary);
      elites = [...overallHoldoutByFingerprint.values()].sort(compareMeasuredEvaluations).slice(0, Math.max(1, config.eliteCount));
    }

    const overallHoldout = [...overallHoldoutByFingerprint.values()].sort(compareMeasuredEvaluations);
    const walkForwardSeeds = overallHoldout.slice(0, Math.min(config.walkForwardTop, overallHoldout.length));
    let walkForwardEvalMs = 0;
    const walkForwardEvaluations: MeasuredEvaluation[] = [];
    const walkForwardAttemptedCount = walkForwardSeeds.length;

    await saveStatus(config.outputDir, {
      updatedAt: new Date().toISOString(),
      phase: "walk-forward",
      family: familyRun.key,
      totalGenerations: config.generations,
      candidateTotal: walkForwardSeeds.length,
      completedCandidates: 0,
      message: `Evaluating ${familyRun.key} walk-forward survivors.`
    });

    for (const [index, seed] of walkForwardSeeds.entries()) {
      const candidate: NormalizedCandidateProposal = {
        ...seed.evaluation.candidate,
        candidateId: `${seed.summary.candidateId}-wf`
      };
      const candidateStartedAt = performance.now();
      try {
        const evaluation = await evaluateCandidateFn({
          config: familyRun.walkForwardConfig,
          candidate,
          marketCodes,
          loadCandles: cachedLoadCandles
        });
        if (evaluation.status !== "completed") {
          walkForwardFailureCount += 1;
          await appendLog(
            config.outputDir,
            `[bb-deterministic][walk-forward][${familyRun.key}] returned status=${evaluation.status} candidate=${candidate.candidateId}`
          );
          continue;
        }
        walkForwardEvalMs += performance.now() - candidateStartedAt;
        const summary = summarizeEvaluation({
          evaluation,
          familyKey: familyRun.key,
          generation: seed.summary.generation,
          source: seed.summary.source
        });
        const measured: MeasuredEvaluation = { evaluation, summary };
        walkForwardEvaluations.push(measured);
        overallWalkForward.push(measured);
        await writeJsonAtomic(path.join(familyDir, "walk-forward-raw", `${candidate.candidateId}.json`), evaluation);

        console.log(
          `[bb-deterministic][walk-forward][${familyRun.key}] ${index + 1}/${walkForwardSeeds.length} ` +
            `net=${summary.netReturn.toFixed(4)} dd=${summary.maxDrawdown.toFixed(4)} trades=${summary.tradeCount}`
        );
      } catch (error) {
        walkForwardFailureCount += 1;
        await appendLog(
          config.outputDir,
          `[bb-deterministic][walk-forward][${familyRun.key}] failed candidate=${candidate.candidateId} error=${error instanceof Error ? error.message : String(error)}`
        );
      }
      await saveStatus(config.outputDir, {
        updatedAt: new Date().toISOString(),
        phase: "walk-forward",
        family: familyRun.key,
        totalGenerations: config.generations,
        candidateTotal: walkForwardSeeds.length,
        completedCandidates: index + 1,
        message: `Evaluated ${familyRun.key} walk-forward survivors.`
      });
    }

    walkForwardEvaluations.sort(compareMeasuredEvaluations);
    const topSeeds = (walkForwardEvaluations.length > 0 ? walkForwardEvaluations : overallHoldout)
      .slice(0, Math.min(config.topSeedExportCount, Math.max(1, walkForwardEvaluations.length || overallHoldout.length)))
      .map((item) => item.summary);
    const topSeedsSource = walkForwardEvaluations.length > 0 ? "walk-forward" as const : "holdout-fallback" as const;
    const promotionCandidate = walkForwardEvaluations.find((item) =>
      passesPromotionGate(item.evaluation, config.promotionGate)
    );
    const promotion: FamilyPromotionResult = promotionCandidate
      ? await (async () => {
          const validated = await promoteToValidatedBlock({
            evaluation: promotionCandidate.evaluation,
            familyDef,
            blockFamilyId: familyRun.familyId
          });
          blockCatalog = appendValidatedBlock(blockCatalog, validated);
          return {
            promoted: true,
            reason: "Promotion gate passed on walk-forward.",
            candidateId: promotionCandidate.summary.candidateId,
            blockId: validated.blockId
          };
        })()
      : {
          promoted: false,
          reason: "No walk-forward survivor passed the promotion gate."
        };

    const bestWalkForward = walkForwardEvaluations[0];
    const feeDrag = bestWalkForward
      ? {
          grossReturn: bestWalkForward.summary.grossReturn,
          netReturn: bestWalkForward.summary.netReturn,
          feePaid: bestWalkForward.summary.feePaid,
          slippagePaid: bestWalkForward.summary.slippagePaid,
          totalCostsPaid: bestWalkForward.summary.totalCostsPaid
        }
      : null;
    const regimeDiagnostics = bestWalkForward
      ? {
          scope: "all_regimes" as const,
          topStrategyReasons: bestWalkForward.summary.strategyReasonCounts,
          regimeTaggedReasons: bestWalkForward.summary.regimeTaggedStrategyReasons
        }
      : null;

    const familyReport: FamilyReport = {
      key: familyRun.key,
      familyId: familyRun.familyId,
      familyTitle: familyDef.title,
      evaluatedCandidateCount: holdoutAttemptedCount,
      holdoutAttemptedCount,
      holdoutSucceededCount,
      walkForwardAttemptedCount,
      walkForwardSucceededCount: walkForwardEvaluations.length,
      marketCodes,
      generationSummaries,
      holdoutTop: overallHoldout.slice(0, 10).map((item) => item.summary),
      walkForwardTop: walkForwardEvaluations.slice(0, 10).map((item) => item.summary),
      topSeeds,
      topSeedsSource,
      promotion,
      failureCounts: {
        holdout: holdoutFailureCount,
        walkForward: walkForwardFailureCount
      },
      feeDrag,
      regimeDiagnostics,
      timings: {
        totalMs: Math.round(performance.now() - familyStartedAt),
        avgHoldoutEvalMs: Math.round(holdoutEvalMs / Math.max(1, holdoutSucceededCount)),
        avgWalkForwardEvalMs: Math.round(walkForwardEvalMs / Math.max(1, walkForwardEvaluations.length))
      }
    };

    families[familyRun.key] = familyReport;

    await writeJsonAtomic(path.join(familyDir, "leaderboard.json"), familyReport.walkForwardTop);
    await writeJsonAtomic(path.join(familyDir, "holdout-leaderboard.json"), familyReport.holdoutTop);
    await writeJsonAtomic(path.join(familyDir, "top-seeds.json"), familyReport.topSeeds);
    await writeJsonAtomic(path.join(familyDir, "walk-forward-evaluations.json"), walkForwardEvaluations.map((item) => item.summary));
    await writeJsonAtomic(path.join(familyDir, "fee-drag.json"), feeDrag);
    await writeJsonAtomic(path.join(familyDir, "regime-diagnostics.json"), regimeDiagnostics);
    await writeJsonAtomic(path.join(familyDir, "promotion.json"), promotion);
    await writeJsonAtomic(path.join(familyDir, "report.json"), familyReport);
  }

  overallWalkForward.sort(compareMeasuredEvaluations);
  const overallLeaderboard = overallWalkForward.slice(0, 20).map((item) => item.summary);
  const topSeeds = config.familyKeys
    .flatMap((familyKey) => families[familyKey]?.topSeeds ?? [])
    .sort((left, right) => right.riskAdjustedScore - left.riskAdjustedScore)
    .slice(0, 12);

  const report: DeterministicBbResearchReport = {
    generatedAt: new Date().toISOString(),
    outputDir: config.outputDir,
    reportPath: config.reportPath,
    config: {
      familyKeys: config.familyKeys,
      universeName: config.universeName,
      min5mCandles: config.min5mCandles,
      marketLimit: config.marketLimit,
      candidateCount: config.candidateCount,
      eliteCount: config.eliteCount,
      generations: config.generations,
      walkForwardTop: config.walkForwardTop,
      topSeedExportCount: config.topSeedExportCount,
      holdoutDays: config.holdoutDays,
      trainingDays: config.trainingDays,
      stepDays: config.stepDays,
      limit: config.limit,
      randomSeed: config.randomSeed,
      seedReports: config.seedReports,
      promotionGate: config.promotionGate
    },
    marketCodes,
    seedReports: config.seedReports,
    preloadMs: Math.round(preloadMs),
    preloadLimits: limits,
    dataSnapshot,
    totalRuntimeMs: Math.round(performance.now() - overallStartedAt),
    overallLeaderboard,
    topSeeds,
    validatedBlockCount: blockCatalog.blocks.length,
    families
  };

  await writeJsonAtomic(config.reportPath, report);
  if (config.legacyOutputPath && config.legacyOutputPath !== config.reportPath) {
    await writeJsonAtomic(config.legacyOutputPath, report);
  }
  await writeJsonAtomic(path.join(config.outputDir, "leaderboard.json"), overallLeaderboard);
  await writeJsonAtomic(path.join(config.outputDir, "top-seeds.json"), topSeeds);
  await saveValidatedBlockCatalog(path.join(config.outputDir, "validated-blocks.json"), blockCatalog);
  await writeJsonAtomic(path.join(config.outputDir, "family-summary.json"), config.familyKeys.map((familyKey) => families[familyKey]));
  await writeFile(path.join(config.outputDir, "report.md"), summarizeMarkdown(report));
  const audit = await auditArtifacts(config.outputDir, { allowNonCompletedStatus: true });
  const auditPath = await writeAuditReport(config.outputDir, audit);
  if (!audit.ok) {
    await saveStatus(config.outputDir, {
      updatedAt: new Date().toISOString(),
      phase: "failed",
      totalGenerations: config.generations,
      message: `Artifact audit failed with ${audit.errors.length} errors.`,
      audit: {
        ok: false,
        errorCount: audit.errors.length,
        warningCount: audit.warnings.length,
        reportPath: auditPath
      }
    });
    throw new Error(`Deterministic BB artifact audit failed with ${audit.errors.length} errors. See ${auditPath}`);
  }
  const replay = await replayArtifacts(config.outputDir, {
    loadCandles,
    evaluateCandidate: evaluateCandidateFn
  });
  const replayPath = await writeReplayReport(config.outputDir, replay);
  if (!replay.ok) {
    await saveStatus(config.outputDir, {
      updatedAt: new Date().toISOString(),
      phase: "failed",
      totalGenerations: config.generations,
      message: `Replay verification failed with ${replay.errors.length} errors.`,
      audit: {
        ok: true,
        errorCount: audit.errors.length,
        warningCount: audit.warnings.length,
        reportPath: auditPath
      },
      replay: {
        ok: false,
        errorCount: replay.errors.length,
        warningCount: replay.warnings.length,
        reportPath: replayPath
      }
    });
    throw new Error(`Deterministic BB replay verification failed with ${replay.errors.length} errors. See ${replayPath}`);
  }
  await saveStatus(config.outputDir, {
    updatedAt: new Date().toISOString(),
    phase: "completed",
    totalGenerations: config.generations,
    message: "Deterministic BB research completed and passed audit + replay verification.",
    audit: {
      ok: true,
      errorCount: audit.errors.length,
      warningCount: audit.warnings.length,
      reportPath: auditPath
    },
    replay: {
      ok: true,
      errorCount: replay.errors.length,
      warningCount: replay.warnings.length,
      reportPath: replayPath
    }
  });
  await appendLog(config.outputDir, `[bb-deterministic] completed output=${config.outputDir}`);

  return report;
}

async function main(): Promise<void> {
  const config = parseDeterministicBbResearchConfig(process.argv.slice(2));
  try {
    const report = await runDeterministicBbResearch(config);
    console.log(config.outputDir);
    console.log(config.reportPath);
    console.log(JSON.stringify({
      outputDir: report.outputDir,
      reportPath: report.reportPath,
      validatedBlockCount: report.validatedBlockCount,
      overallBest: report.overallLeaderboard[0] ?? null
    }, null, 2));
  } catch (error) {
    await saveStatus(config.outputDir, {
      updatedAt: new Date().toISOString(),
      phase: "failed",
      totalGenerations: config.generations,
      message: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMain) {
  await main();
}
