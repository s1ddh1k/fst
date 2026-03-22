import { mkdir, readdir, writeFile } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditDeterministicBbArtifacts } from "./audit-deterministic-bb.js";
import { calculateAutoResearchMinimumLimit } from "./auto-research/limit-resolution.js";
import { getSelectedUniverseMarketsWithMinimumCandles, loadCandlesForMarkets } from "./db.js";
import { replayDeterministicBbArtifacts } from "./replay-deterministic-bb.js";

type DoctorIssue = {
  severity: "error" | "warn";
  code: string;
  message: string;
  marketCode?: string;
  filePath?: string;
};

type DoctorReport = {
  generatedAt: string;
  ok: boolean;
  config: {
    universeName: string;
    marketLimit: number;
    holdoutDays: number;
    trainingDays: number;
    stepDays: number;
    limit: number;
    min5mCandles: number;
  };
  data: {
    required1hCandles: number;
    required5mCandles: number;
    selected5mCount: number;
    selected1hCount: number;
    intersectedMarketCount: number;
    selectedMarkets: Array<{
      marketCode: string;
      candles1h: number;
      candles5m: number;
      first1h: string | null;
      last1h: string | null;
      first5m: string | null;
      last5m: string | null;
      executionLagDays: number | null;
    }>;
  };
  deterministic?: {
    outputDir: string;
    auditOk: boolean;
    replayOk: boolean;
    auditErrors: number;
    replayErrors: number;
  };
  issues: DoctorIssue[];
};

function getOption(args: string[], key: string): string | undefined {
  const index = args.indexOf(key);
  return index === -1 ? undefined : args[index + 1];
}

function getNumberOption(args: string[], key: string, fallback: number): number {
  const raw = getOption(args, key);
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function pushIssue(issues: DoctorIssue[], severity: DoctorIssue["severity"], code: string, message: string, extras: Omit<DoctorIssue, "severity" | "code" | "message"> = {}) {
  issues.push({ severity, code, message, ...extras });
}

async function findLatestDeterministicArtifact(rootDir: string): Promise<string | null> {
  if (!fs.existsSync(rootDir)) {
    return null;
  }
  const entries = (await readdir(rootDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("bb-deterministic"))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  return entries[0] ? path.join(rootDir, entries[0]) : null;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  await fs.promises.rename(tempPath, filePath);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const universeName = getOption(args, "--universe") ?? "krw-top";
  const marketLimit = getNumberOption(args, "--market-limit", 12);
  const holdoutDays = getNumberOption(args, "--holdout-days", 180);
  const trainingDays = getNumberOption(args, "--training-days", 180);
  const stepDays = getNumberOption(args, "--step-days", 90);
  const limit = getNumberOption(args, "--limit", 6000);
  const min5mCandles = getNumberOption(args, "--min-5m-candles", 150000);
  const outputDir = path.resolve(
    process.cwd(),
    getOption(args, "--output-dir") ??
      `research/backtester/artifacts/research-doctor-${new Date().toISOString().replace(/[:.]/g, "-")}`
  );
  const artifactsRoot = path.resolve(process.cwd(), "research/backtester/artifacts");
  const deterministicOutputDir =
    getOption(args, "--deterministic-output-dir")
      ? path.resolve(process.cwd(), getOption(args, "--deterministic-output-dir")!)
      : await findLatestDeterministicArtifact(artifactsRoot);

  const issues: DoctorIssue[] = [];
  const required1hCandles = Math.max(
    limit,
    calculateAutoResearchMinimumLimit({
      timeframe: "1h",
      holdoutDays,
      trainingDays,
      stepDays,
      mode: "walk-forward"
    }),
    calculateAutoResearchMinimumLimit({
      timeframe: "1h",
      holdoutDays,
      trainingDays,
      stepDays,
      mode: "holdout"
    })
  );
  const required5mCandles = Math.max(
    min5mCandles,
    calculateAutoResearchMinimumLimit({
      timeframe: "5m",
      holdoutDays,
      trainingDays,
      stepDays,
      mode: "walk-forward"
    }),
    calculateAutoResearchMinimumLimit({
      timeframe: "5m",
      holdoutDays,
      trainingDays,
      stepDays,
      mode: "holdout"
    }),
    required1hCandles * 12
  );

  const [rows5m, rows1h] = await Promise.all([
    getSelectedUniverseMarketsWithMinimumCandles({
      universeName,
      timeframe: "5m",
      minCandles: required5mCandles,
      limit: marketLimit * 4
    }),
    getSelectedUniverseMarketsWithMinimumCandles({
      universeName,
      timeframe: "1h",
      minCandles: required1hCandles,
      limit: marketLimit * 4
    })
  ]);

  const oneHourCounts = new Map(rows1h.map((row) => [row.marketCode, row.candleCount]));
  const selectedMarkets = rows5m
    .filter((row) => oneHourCounts.has(row.marketCode))
    .slice(0, marketLimit);

  if (selectedMarkets.length === 0) {
    pushIssue(
      issues,
      "error",
      "no_intersected_markets",
      `No markets satisfy both 1h>=${required1hCandles} and 5m>=${required5mCandles} in ${universeName}.`
    );
  }

  const marketCodes = selectedMarkets.map((row) => row.marketCode);
  const [candles1h, candles5m] = await Promise.all([
    loadCandlesForMarkets({ marketCodes, timeframe: "1h", limit: required1hCandles }),
    loadCandlesForMarkets({ marketCodes, timeframe: "5m", limit: required5mCandles })
  ]);

  const selectedSummaries = marketCodes.map((marketCode) => {
    const oneHour = candles1h[marketCode] ?? [];
    const fiveMinute = candles5m[marketCode] ?? [];
    const first1h = oneHour[0]?.candleTimeUtc ?? null;
    const last1h = oneHour[oneHour.length - 1]?.candleTimeUtc ?? null;
    const first5m = fiveMinute[0]?.candleTimeUtc ?? null;
    const last5m = fiveMinute[fiveMinute.length - 1]?.candleTimeUtc ?? null;
    const executionLagDays =
      first1h && first5m ? Math.round((first5m.getTime() - first1h.getTime()) / (24 * 60 * 60 * 1000)) : null;
    if (executionLagDays !== null && executionLagDays > 7) {
      pushIssue(
        issues,
        "warn",
        "execution_coverage_lag",
        `5m execution data starts ${executionLagDays} days after 1h reference data.`,
        { marketCode }
      );
    }
    if (oneHour.length < required1hCandles || fiveMinute.length < required5mCandles) {
      pushIssue(
        issues,
        "error",
        "loaded_candle_shortfall",
        `Loaded candles are below required minimum after selection.`,
        { marketCode }
      );
    }
    return {
      marketCode,
      candles1h: oneHour.length,
      candles5m: fiveMinute.length,
      first1h: first1h?.toISOString() ?? null,
      last1h: last1h?.toISOString() ?? null,
      first5m: first5m?.toISOString() ?? null,
      last5m: last5m?.toISOString() ?? null,
      executionLagDays
    };
  });

  let deterministic: DoctorReport["deterministic"];
  if (deterministicOutputDir) {
    const [audit, replay] = await Promise.all([
      auditDeterministicBbArtifacts(deterministicOutputDir),
      replayDeterministicBbArtifacts(deterministicOutputDir)
    ]);
    deterministic = {
      outputDir: deterministicOutputDir,
      auditOk: audit.ok,
      replayOk: replay.ok,
      auditErrors: audit.errors.length,
      replayErrors: replay.errors.length
    };
    if (!audit.ok) {
      pushIssue(issues, "error", "deterministic_audit_failed", `Latest deterministic artifact audit failed: ${audit.errors.length} errors.`, { filePath: deterministicOutputDir });
    }
    if (!replay.ok) {
      pushIssue(issues, "error", "deterministic_replay_failed", `Latest deterministic replay failed: ${replay.errors.length} errors.`, { filePath: deterministicOutputDir });
    }
  } else {
    pushIssue(issues, "warn", "missing_deterministic_artifact", "No deterministic BB artifact directory was found to audit.");
  }

  const report: DoctorReport = {
    generatedAt: new Date().toISOString(),
    ok: !issues.some((issue) => issue.severity === "error"),
    config: {
      universeName,
      marketLimit,
      holdoutDays,
      trainingDays,
      stepDays,
      limit,
      min5mCandles
    },
    data: {
      required1hCandles,
      required5mCandles,
      selected5mCount: rows5m.length,
      selected1hCount: rows1h.length,
      intersectedMarketCount: selectedMarkets.length,
      selectedMarkets: selectedSummaries
    },
    deterministic,
    issues
  };

  const reportPath = path.join(outputDir, "report.json");
  await writeJsonAtomic(reportPath, report);
  console.log(JSON.stringify({ outputDir, reportPath, ok: report.ok, issueCount: report.issues.length }, null, 2));
  if (!report.ok) {
    process.exitCode = 1;
  }
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMain) {
  await main();
}
