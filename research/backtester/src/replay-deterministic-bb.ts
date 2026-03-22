import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateBlockCandidate } from "./auto-research/block-evaluator.js";
import type { AutoResearchRunConfig, CandidateBacktestEvaluation } from "./auto-research/types.js";
import { loadCandlesForMarkets } from "./db.js";
import type {
  DeterministicBbResearchConfig,
  DeterministicBbResearchReport,
  FamilyKey
} from "./tune-bb-blocks.js";
import type { Candle } from "./types.js";

type ReplaySeverity = "error" | "warning";

type ReplayIssue = {
  severity: ReplaySeverity;
  code: string;
  message: string;
  filePath?: string;
  familyKey?: FamilyKey;
  candidateId?: string;
};

type ReplayFamilySummary = {
  familyKey: FamilyKey;
  replayedCandidates: number;
  passedCandidates: number;
};

export type DeterministicBbReplayReport = {
  generatedAt: string;
  outputDir: string;
  ok: boolean;
  errors: ReplayIssue[];
  warnings: ReplayIssue[];
  summary: {
    replayedCandidateCount: number;
    familyCount: number;
    dataSnapshotMatched: boolean;
  };
  families: Partial<Record<FamilyKey, ReplayFamilySummary>>;
};

type ReplayDeps = {
  loadCandles?: typeof loadCandlesForMarkets;
  evaluateCandidate?: typeof evaluateBlockCandidate;
};

type CacheByTimeframe = Record<string, Record<string, Candle[]>>;

type StableReplayProjection = {
  candidate: CandidateBacktestEvaluation["candidate"];
  mode: CandidateBacktestEvaluation["mode"];
  status: CandidateBacktestEvaluation["status"];
  summary: {
    totalReturn: number;
    grossReturn: number;
    netReturn: number;
    maxDrawdown: number;
    turnover: number;
    winRate: number;
    avgHoldBars: number;
    tradeCount: number;
    feePaid: number;
    slippagePaid: number;
    rejectedOrdersCount: number;
    cooldownSkipsCount: number;
    signalCount: number;
    ghostSignalCount: number;
  };
  coverage: {
    rawBuySignals: number;
    rawSellSignals: number;
    rawHoldSignals: number;
    rejectedOrdersCount: number;
    cooldownSkipsCount: number;
  };
  reasons: CandidateBacktestEvaluation["diagnostics"]["reasons"];
  windows: {
    mode: CandidateBacktestEvaluation["diagnostics"]["windows"]["mode"];
    holdoutDays: number;
    trainingDays?: number;
    stepDays?: number;
    windowCount?: number;
    positiveWindowCount?: number;
    positiveWindowRatio?: number;
    negativeWindowCount?: number;
    bestWindowNetReturn?: number;
    worstWindowNetReturn?: number;
    totalClosedTrades?: number;
    availableDays?: number;
    requiredDays?: number;
  };
};

function pushIssue(
  issues: ReplayIssue[],
  severity: ReplaySeverity,
  code: string,
  message: string,
  extras: Omit<ReplayIssue, "severity" | "code" | "message"> = {}
): void {
  issues.push({ severity, code, message, ...extras });
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tempPath, filePath);
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
    return Object.fromEntries(
      params.marketCodes.map((marketCode) => {
        const candles = timeframeCache[marketCode] ?? [];
        return [
          marketCode,
          params.limit && params.limit > 0 && candles.length > params.limit
            ? candles.slice(-params.limit)
            : candles.slice()
        ];
      })
    );
  };
}

function buildDataSnapshot(cache: CacheByTimeframe): DeterministicBbResearchReport["dataSnapshot"] {
  const summarize = (timeframe: "1h" | "5m") =>
    Object.entries(cache[timeframe] ?? {})
      .map(([marketCode, candles]) => ({
        marketCode,
        candleCount: candles.length,
        firstCandleTimeUtc: candles[0]?.candleTimeUtc?.toISOString?.() ?? null,
        lastCandleTimeUtc: candles[candles.length - 1]?.candleTimeUtc?.toISOString?.() ?? null
      }))
      .sort((left, right) => left.marketCode.localeCompare(right.marketCode));

  return {
    "1h": summarize("1h"),
    "5m": summarize("5m")
  };
}

function createFamilyRun(
  _key: FamilyKey,
  config: Pick<
    DeterministicBbResearchConfig,
    "universeName" | "holdoutDays" | "trainingDays" | "stepDays" | "limit"
  >,
  marketLimit: number
): { walkForwardConfig: AutoResearchRunConfig } {
  return {
    walkForwardConfig: {
      researchStage: "block",
      mode: "walk-forward",
      timeframe: "1h",
      holdoutDays: config.holdoutDays,
      trainingDays: config.trainingDays,
      stepDays: config.stepDays,
      universeName: config.universeName,
      marketLimit,
      limit: config.limit,
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

function familyDir(outputDir: string, familyKey: FamilyKey): string {
  return path.join(outputDir, familyKey);
}

async function loadRawWalkForwardEvaluations(outputDir: string, familyKey: FamilyKey): Promise<CandidateBacktestEvaluation[]> {
  const rawDir = path.join(familyDir(outputDir, familyKey), "walk-forward-raw");
  if (!fs.existsSync(rawDir)) {
    return [];
  }
  const entries = fs.readdirSync(rawDir).filter((name) => name.endsWith(".json")).sort();
  const evaluations: CandidateBacktestEvaluation[] = [];
  for (const entry of entries) {
    evaluations.push(await readJson<CandidateBacktestEvaluation>(path.join(rawDir, entry)));
  }
  return evaluations;
}

function comparableEvaluation(evaluation: CandidateBacktestEvaluation): StableReplayProjection {
  return {
    candidate: evaluation.candidate,
    mode: evaluation.mode,
    status: evaluation.status,
    summary: {
      totalReturn: evaluation.summary.totalReturn,
      grossReturn: evaluation.summary.grossReturn,
      netReturn: evaluation.summary.netReturn,
      maxDrawdown: evaluation.summary.maxDrawdown,
      turnover: evaluation.summary.turnover,
      winRate: evaluation.summary.winRate,
      avgHoldBars: evaluation.summary.avgHoldBars,
      tradeCount: evaluation.summary.tradeCount,
      feePaid: evaluation.summary.feePaid,
      slippagePaid: evaluation.summary.slippagePaid,
      rejectedOrdersCount: evaluation.summary.rejectedOrdersCount,
      cooldownSkipsCount: evaluation.summary.cooldownSkipsCount,
      signalCount: evaluation.summary.signalCount,
      ghostSignalCount: evaluation.summary.ghostSignalCount
    },
    coverage: {
      rawBuySignals: evaluation.diagnostics.coverage.rawBuySignals,
      rawSellSignals: evaluation.diagnostics.coverage.rawSellSignals,
      rawHoldSignals: evaluation.diagnostics.coverage.rawHoldSignals,
      rejectedOrdersCount: evaluation.diagnostics.coverage.rejectedOrdersCount,
      cooldownSkipsCount: evaluation.diagnostics.coverage.cooldownSkipsCount
    },
    reasons: evaluation.diagnostics.reasons,
    windows: evaluation.diagnostics.windows
  };
}

function almostEqual(left: number, right: number, epsilon = 1e-9): boolean {
  return Math.abs(left - right) <= epsilon;
}

function deepAlmostEqual(left: unknown, right: unknown): boolean {
  if (typeof left === "number" && typeof right === "number") {
    return almostEqual(left, right);
  }
  if (left === null || right === null || left === undefined || right === undefined) {
    return left === right;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => deepAlmostEqual(item, right[index]));
  }
  if (typeof left === "object" && typeof right === "object") {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord).sort();
    const rightKeys = Object.keys(rightRecord).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key, index) => key === rightKeys[index] && deepAlmostEqual(leftRecord[key], rightRecord[key]))
    );
  }
  return left === right;
}

async function preloadReplayCache(
  report: DeterministicBbResearchReport,
  loadCandles: typeof loadCandlesForMarkets
): Promise<CacheByTimeframe> {
  const [candles1h, candles5m] = await Promise.all([
    loadCandles({
      marketCodes: report.marketCodes,
      timeframe: "1h",
      limit: report.preloadLimits.limit1h
    }),
    loadCandles({
      marketCodes: report.marketCodes,
      timeframe: "5m",
      limit: report.preloadLimits.limit5m
    })
  ]);
  return {
    "1h": candles1h,
    "5m": candles5m
  };
}

export async function replayDeterministicBbArtifacts(
  outputDir: string,
  deps: ReplayDeps = {}
): Promise<DeterministicBbReplayReport> {
  const loadCandles = deps.loadCandles ?? loadCandlesForMarkets;
  const evaluateCandidate = deps.evaluateCandidate ?? evaluateBlockCandidate;
  const report = await readJson<DeterministicBbResearchReport>(path.join(outputDir, "report.json"));
  const issues: ReplayIssue[] = [];
  const warnings: ReplayIssue[] = [];
  const families: Partial<Record<FamilyKey, ReplayFamilySummary>> = {};

  const cache = await preloadReplayCache(report, loadCandles);
  const currentSnapshot = buildDataSnapshot(cache);
  const dataSnapshotMatched = JSON.stringify(currentSnapshot) === JSON.stringify(report.dataSnapshot);
  if (!dataSnapshotMatched) {
    pushIssue(
      issues,
      "error",
      "data_snapshot_mismatch",
      "Current candle snapshot does not match the snapshot captured during the deterministic run.",
      { filePath: path.join(outputDir, "report.json") }
    );
  }
  const cachedLoadCandles = buildCachedLoader(cache);
  let replayedCandidateCount = 0;

  for (const familyKey of report.config.familyKeys) {
    const rawEvaluations = await loadRawWalkForwardEvaluations(outputDir, familyKey);
    const familyRun = createFamilyRun(familyKey, report.config, report.marketCodes.length);
    let passedCandidates = 0;

    for (const stored of rawEvaluations) {
      replayedCandidateCount += 1;
      const replayed = await evaluateCandidate({
        config: familyRun.walkForwardConfig,
        candidate: stored.candidate,
        marketCodes: report.marketCodes,
        loadCandles: cachedLoadCandles
      });

      if (replayed.status !== "completed") {
        pushIssue(
          issues,
          "error",
          "replay_failed_status",
          `Replay returned ${replayed.status} for ${stored.candidate.candidateId}.`,
          {
            familyKey,
            candidateId: stored.candidate.candidateId,
            filePath: path.join(familyDir(outputDir, familyKey), "walk-forward-raw", `${stored.candidate.candidateId}.json`)
          }
        );
        continue;
      }

      if (!deepAlmostEqual(comparableEvaluation(replayed), comparableEvaluation(stored))) {
        pushIssue(
          issues,
          "error",
          "replay_metric_mismatch",
          `Replay metrics differ for ${stored.candidate.candidateId}.`,
          {
            familyKey,
            candidateId: stored.candidate.candidateId,
            filePath: path.join(familyDir(outputDir, familyKey), "walk-forward-raw", `${stored.candidate.candidateId}.json`)
          }
        );
        continue;
      }

      passedCandidates += 1;
    }

    families[familyKey] = {
      familyKey,
      replayedCandidates: rawEvaluations.length,
      passedCandidates
    };
  }

  return {
    generatedAt: new Date().toISOString(),
    outputDir,
    ok: issues.length === 0,
    errors: issues,
    warnings,
    summary: {
      replayedCandidateCount,
      familyCount: report.config.familyKeys.length,
      dataSnapshotMatched
    },
    families
  };
}

export async function writeDeterministicBbReplayReport(
  outputDir: string,
  replay: DeterministicBbReplayReport
): Promise<string> {
  const replayPath = path.join(outputDir, "replay-verification.json");
  await writeJsonAtomic(replayPath, replay);
  return replayPath;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outputDirIndex = args.indexOf("--output-dir");
  if (outputDirIndex === -1 || !args[outputDirIndex + 1]) {
    throw new Error("Expected --output-dir <path>");
  }
  const outputDir = path.resolve(args[outputDirIndex + 1]);
  const replay = await replayDeterministicBbArtifacts(outputDir);
  const replayPath = await writeDeterministicBbReplayReport(outputDir, replay);
  console.log(JSON.stringify({ outputDir, replayPath, ok: replay.ok, errors: replay.errors.length, warnings: replay.warnings.length }, null, 2));
  if (!replay.ok) {
    process.exitCode = 1;
  }
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMain) {
  await main();
}
