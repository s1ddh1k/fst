import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  resolveEvaluationMaxDrawdown,
  resolveEvaluationTradeCount
} from "./ranking.js";
import type { CandidateBacktestEvaluation } from "./types.js";

export type AutoResearchMetricSnapshot = {
  netReturn: number;
  maxDrawdown: number;
  tradeCount: number;
  positiveWindowRatio?: number;
  randomPercentile?: number;
  buyHoldExcess?: number;
};

function getOption(args: string[], key: string): string | undefined {
  const index = args.indexOf(key);
  return index === -1 ? undefined : args[index + 1];
}

function formatMetricValue(value: number): string {
  if (Number.isInteger(value)) {
    return String(value);
  }

  return value.toFixed(10).replace(/\.?0+$/u, "");
}

export function extractAutoResearchMetricSnapshot(
  evaluation: CandidateBacktestEvaluation
): AutoResearchMetricSnapshot {
  const randomPercentile =
    evaluation.summary.randomPercentile ??
    evaluation.diagnostics.robustness.randomPercentile;
  const buyHoldReturn = evaluation.summary.buyAndHoldReturn;

  return {
    netReturn: evaluation.summary.netReturn,
    maxDrawdown: resolveEvaluationMaxDrawdown(evaluation),
    tradeCount: resolveEvaluationTradeCount(evaluation),
    positiveWindowRatio: evaluation.diagnostics.windows.positiveWindowRatio,
    randomPercentile:
      typeof randomPercentile === "number" ? randomPercentile : undefined,
    buyHoldExcess:
      typeof buyHoldReturn === "number"
        ? evaluation.summary.netReturn - buyHoldReturn
        : undefined
  };
}

export function renderAutoResearchMetricLines(
  snapshot: AutoResearchMetricSnapshot
): string[] {
  const lines = [
    `METRIC net_return=${formatMetricValue(snapshot.netReturn)}`,
    `METRIC max_drawdown=${formatMetricValue(snapshot.maxDrawdown)}`,
    `METRIC trade_count=${formatMetricValue(snapshot.tradeCount)}`
  ];

  if (typeof snapshot.positiveWindowRatio === "number") {
    lines.push(
      `METRIC positive_window_ratio=${formatMetricValue(snapshot.positiveWindowRatio)}`
    );
  }

  if (typeof snapshot.randomPercentile === "number") {
    lines.push(
      `METRIC random_percentile=${formatMetricValue(snapshot.randomPercentile)}`
    );
  }

  if (typeof snapshot.buyHoldExcess === "number") {
    lines.push(
      `METRIC buy_hold_excess=${formatMetricValue(snapshot.buyHoldExcess)}`
    );
  }

  return lines;
}

async function runEvaluateWorker(params: {
  payloadPath: string;
  outputPath: string;
}): Promise<void> {
  const workerPath = path.resolve(process.cwd(), "src/auto-research/evaluate-worker.ts");

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", workerPath, "--payload", params.payloadPath, "--output", params.outputPath],
      {
        cwd: process.cwd(),
        stdio: ["ignore", "ignore", "pipe"]
      }
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr.trim() || `evaluate-worker failed with code ${code}`));
    });
  });
}

async function main(): Promise<void> {
  const payloadPath = getOption(process.argv, "--payload");
  const outputPath = getOption(process.argv, "--output");

  if (!payloadPath) {
    throw new Error("Missing required option: --payload");
  }

  if (!outputPath) {
    throw new Error("Missing required option: --output");
  }

  await runEvaluateWorker({
    payloadPath,
    outputPath
  });

  const evaluation = JSON.parse(
    await readFile(outputPath, "utf8")
  ) as CandidateBacktestEvaluation;

  if (evaluation.status !== "completed") {
    const reason = evaluation.failure?.message ?? "benchmark evaluation did not complete";
    throw new Error(reason);
  }

  const snapshot = extractAutoResearchMetricSnapshot(evaluation);
  process.stdout.write(`${renderAutoResearchMetricLines(snapshot).join("\n")}\n`);
}

const isMain =
  typeof process.argv[1] === "string" &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
