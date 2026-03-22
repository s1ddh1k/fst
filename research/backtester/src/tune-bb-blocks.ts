import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { evaluateBlockCandidate } from "./auto-research/block-evaluator.js";
import { getBlockFamilyById } from "./auto-research/block-families.js";
import { calculateAutoResearchMinimumLimit } from "./auto-research/limit-resolution.js";
import type {
  AutoResearchRunConfig,
  CandidateBacktestEvaluation,
  NormalizedCandidateProposal,
  ResearchParameterSpec
} from "./auto-research/types.js";
import { getSelectedUniverseMarketsWithMinimumCandles, loadCandlesForMarkets } from "./db.js";
import type { Candle } from "./types.js";

type FamilyKey = "weekly" | "daily" | "hourly";

type FamilyRunConfig = {
  key: FamilyKey;
  familyId: string;
  holdoutConfig: AutoResearchRunConfig;
  walkForwardConfig: AutoResearchRunConfig;
};

type CandidateScore = {
  candidateId: string;
  familyId: string;
  parameters: Record<string, number>;
  netReturn: number;
  maxDrawdown: number;
  tradeCount: number;
  rawBuySignals: number;
  cooldownSkipsCount: number;
  positiveWindowRatio: number | null;
  score: number;
};

type CacheByTimeframe = Record<string, Record<string, Candle[]>>;

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

function collectMatchingArrays(node: unknown, familyId: string, matches: Record<string, number>[]): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      if (
        item &&
        typeof item === "object" &&
        "familyId" in item &&
        (item as { familyId?: unknown }).familyId === familyId &&
        "parameters" in item &&
        typeof (item as { parameters?: unknown }).parameters === "object"
      ) {
        matches.push((item as { parameters: Record<string, number> }).parameters);
      }
      collectMatchingArrays(item, familyId, matches);
    }
    return;
  }

  if (!node || typeof node !== "object") {
    return;
  }

  for (const value of Object.values(node as Record<string, unknown>)) {
    collectMatchingArrays(value, familyId, matches);
  }
}

function collectSeedParams(seedPaths: string[], familyId: string): Record<string, number>[] {
  const collected: Record<string, number>[] = [];
  for (const seedPath of seedPaths) {
    if (!fs.existsSync(seedPath)) {
      continue;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(seedPath, "utf8"));
      collectMatchingArrays(parsed, familyId, collected);
    } catch {
      // Ignore malformed seed reports and continue.
    }
  }
  return collected;
}

function scoreEvaluation(
  evaluation: CandidateBacktestEvaluation,
  familyKey: FamilyKey
): number {
  const tradeTarget = familyKey === "weekly" ? 10 : familyKey === "daily" ? 20 : 12;
  const tradePenalty = Math.max(0, tradeTarget - evaluation.summary.tradeCount) * 0.00035;
  const signalPenalty = Math.max(0, tradeTarget - evaluation.diagnostics.coverage.rawBuySignals) * 0.00015;
  const cooldownPenalty = evaluation.diagnostics.coverage.cooldownSkipsCount * 0.00003;
  return evaluation.summary.netReturn - evaluation.summary.maxDrawdown * 0.7 - tradePenalty - signalPenalty - cooldownPenalty;
}

function summarizeEvaluation(
  evaluation: CandidateBacktestEvaluation,
  familyKey: FamilyKey
): CandidateScore {
  return {
    candidateId: evaluation.candidate.candidateId,
    familyId: evaluation.candidate.familyId,
    parameters: evaluation.candidate.parameters,
    netReturn: evaluation.summary.netReturn,
    maxDrawdown: evaluation.summary.maxDrawdown,
    tradeCount: evaluation.summary.tradeCount,
    rawBuySignals: evaluation.diagnostics.coverage.rawBuySignals,
    cooldownSkipsCount: evaluation.diagnostics.coverage.cooldownSkipsCount,
    positiveWindowRatio: evaluation.diagnostics.windows.positiveWindowRatio ?? null,
    score: scoreEvaluation(evaluation, familyKey)
  };
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
    loadCandlesForMarkets({ marketCodes: params.marketCodes, timeframe: "1h", limit: limit1h }),
    loadCandlesForMarkets({ marketCodes: params.marketCodes, timeframe: "5m", limit: limit5m })
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const familyKeys = getListOption(args, "--families", ["daily", "hourly"])
    .map((value) => value.toLowerCase())
    .flatMap((value) => value === "all" ? ["weekly", "daily", "hourly"] : [value])
    .filter((value): value is FamilyKey => value === "weekly" || value === "daily" || value === "hourly");
  const uniqueFamilyKeys = [...new Set(familyKeys)];
  const universeName = getOption(args, "--universe") ?? "krw-top";
  const min5mCandles = getNumberOption(args, "--min-5m-candles", 150_000);
  const marketLimit = getNumberOption(args, "--market-limit", 20);
  const candidateCount = getNumberOption(args, "--candidate-count", 18);
  const walkForwardTop = getNumberOption(args, "--walk-forward-top", 4);
  const holdoutDays = getNumberOption(args, "--holdout-days", 365);
  const trainingDays = getNumberOption(args, "--training-days", 270);
  const stepDays = getNumberOption(args, "--step-days", 90);
  const limit = getNumberOption(args, "--limit", 10_000);
  const randomSeed = getNumberOption(args, "--seed", 20260321);
  const outputPath = getOption(args, "--output") ?? `/tmp/fst-bb-tune-${Date.now()}.json`;
  const seedReports = getListOption(args, "--seed-report", []);

  if (uniqueFamilyKeys.length === 0) {
    throw new Error("No valid --families provided. Use weekly,daily,hourly or all.");
  }

  const marketRows = await getSelectedUniverseMarketsWithMinimumCandles({
    universeName,
    timeframe: "5m",
    minCandles: min5mCandles,
    limit: marketLimit
  });
  const marketCodes = marketRows.map((row) => row.marketCode);
  if (marketCodes.length === 0) {
    throw new Error(`No markets available for universe=${universeName} with min5mCandles=${min5mCandles}`);
  }

  const familyRuns = uniqueFamilyKeys.map((key) =>
    createFamilyRun(key, {
      universeName,
      marketLimit: marketCodes.length,
      limit,
      holdoutDays,
      trainingDays,
      stepDays
    })
  );

  const { cache, preloadMs, limits } = await preloadBbCandles({ marketCodes, familyRuns });
  const cachedLoadCandles = buildCachedLoader(cache);
  const overallStartedAt = performance.now();
  const result: Record<string, unknown> = {
    outputPath,
    universeName,
    marketCodes,
    seedReports,
    preloadMs: Math.round(preloadMs),
    preloadLimits: limits
  };

  for (const [familyIndex, familyRun] of familyRuns.entries()) {
    const startedAt = performance.now();
    const familyDef = getBlockFamilyById(familyRun.familyId);
    const random = mulberry32(randomSeed + familyIndex * 9973);
    const seedParams = collectSeedParams(seedReports, familyRun.familyId);
    const candidates: Record<string, number>[] = [];
    const seen = new Set<string>();
    const pushCandidate = (params: Record<string, number>) => {
      const normalized = normalizeBbParams(params);
      const key = JSON.stringify(normalized);
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      candidates.push(normalized);
    };

    pushCandidate(buildMidpointParams(familyDef.parameterSpecs));
    for (const params of seedParams) {
      pushCandidate(params);
    }

    while (candidates.length < candidateCount) {
      const base = candidates[Math.floor(random() * candidates.length)] ?? buildMidpointParams(familyDef.parameterSpecs);
      pushCandidate(mutateParams(base, familyDef.parameterSpecs, random, 0.16 + random() * 0.18));
    }

    const holdoutEvaluations: CandidateScore[] = [];
    let holdoutEvalMs = 0;
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate: NormalizedCandidateProposal = {
        candidateId: `bb-${familyRun.key}-cached-${String(index + 1).padStart(2, "0")}`,
        familyId: familyRun.familyId,
        strategyName: familyDef.strategyName,
        thesis: familyDef.thesis,
        invalidationSignals: [],
        origin: "engine_seed",
        parameters: candidates[index]
      };
      const candidateStartedAt = performance.now();
      const evaluation = await evaluateBlockCandidate({
        config: familyRun.holdoutConfig,
        candidate,
        marketCodes,
        loadCandles: cachedLoadCandles
      });
      const elapsedMs = performance.now() - candidateStartedAt;
      holdoutEvalMs += elapsedMs;
      const summary = summarizeEvaluation(evaluation, familyRun.key);
      holdoutEvaluations.push(summary);
      console.log(
        `[bb-tune][holdout][${familyRun.key}] ${index + 1}/${candidates.length} ` +
          `net=${summary.netReturn.toFixed(4)} dd=${summary.maxDrawdown.toFixed(4)} trades=${summary.tradeCount} ` +
          `signals=${summary.rawBuySignals} elapsedMs=${Math.round(elapsedMs)}`
      );
    }

    holdoutEvaluations.sort((left, right) => right.score - left.score);
    const walkForwardEvaluations: CandidateScore[] = [];
    let walkForwardEvalMs = 0;
    const walkForwardSeeds = holdoutEvaluations.slice(0, Math.min(walkForwardTop, holdoutEvaluations.length));
    for (let index = 0; index < walkForwardSeeds.length; index += 1) {
      const top = walkForwardSeeds[index]!;
      const candidate: NormalizedCandidateProposal = {
        candidateId: `${top.candidateId}-wf`,
        familyId: top.familyId,
        strategyName: familyDef.strategyName,
        thesis: familyDef.thesis,
        invalidationSignals: [],
        origin: "engine_seed",
        parameters: top.parameters
      };
      const candidateStartedAt = performance.now();
      const evaluation = await evaluateBlockCandidate({
        config: familyRun.walkForwardConfig,
        candidate,
        marketCodes,
        loadCandles: cachedLoadCandles
      });
      const elapsedMs = performance.now() - candidateStartedAt;
      walkForwardEvalMs += elapsedMs;
      const summary = summarizeEvaluation(evaluation, familyRun.key);
      walkForwardEvaluations.push(summary);
      console.log(
        `[bb-tune][walk-forward][${familyRun.key}] ${index + 1}/${walkForwardSeeds.length} ` +
          `net=${summary.netReturn.toFixed(4)} dd=${summary.maxDrawdown.toFixed(4)} trades=${summary.tradeCount} ` +
          `signals=${summary.rawBuySignals} elapsedMs=${Math.round(elapsedMs)}`
      );
    }

    walkForwardEvaluations.sort((left, right) => right.score - left.score);
    result[familyRun.key] = {
      familyId: familyRun.familyId,
      evaluatedCandidateCount: candidates.length,
      holdoutTop5: holdoutEvaluations.slice(0, 5),
      walkForwardTop: walkForwardEvaluations,
      timings: {
        totalMs: Math.round(performance.now() - startedAt),
        avgHoldoutEvalMs: Math.round(holdoutEvalMs / Math.max(1, candidates.length)),
        avgWalkForwardEvalMs: Math.round(walkForwardEvalMs / Math.max(1, walkForwardSeeds.length))
      }
    };
  }

  result.totalRuntimeMs = Math.round(performance.now() - overallStartedAt);

  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(outputPath);
  console.log(JSON.stringify(result, null, 2));
}

await main();
