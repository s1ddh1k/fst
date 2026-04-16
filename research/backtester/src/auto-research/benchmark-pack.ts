import path from "node:path";
import { spawn } from "node:child_process";
import type { CodeMutationTask } from "./types.js";
import type { AutoResearchMetricSnapshot } from "./code-mutation-benchmark.js";

export type BenchmarkPackCommand = {
  command: string;
  cwd?: string;
  label?: string;
  timeoutMs?: number;
};

export type BenchmarkMetricGate = {
  metricName: string;
  direction: "higher" | "lower";
  baseline: number;
  minDelta?: number;
  minRelativeDelta?: number;
};

export type AutoResearchPerformanceBenchmark = {
  payloadPath: string;
  evaluationOutputPath: string;
  baselineMetrics: AutoResearchMetricSnapshot;
  timeoutMs?: number;
};

export type BenchmarkPack = {
  packId: string;
  title?: string;
  commands: BenchmarkPackCommand[];
  stopOnFailure?: boolean;
  metricGates?: BenchmarkMetricGate[];
};

export type BenchmarkCommandResult = {
  label: string;
  command: string;
  cwd: string;
  status: "passed" | "failed" | "timed_out" | "skipped";
  detail: string;
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  metrics: Record<string, number>;
};

export type BenchmarkMetricGateResult = {
  metricName: string;
  direction: "higher" | "lower";
  baseline: number;
  actual?: number;
  delta?: number;
  requiredDelta: number;
  status: "passed" | "failed";
  detail: string;
};

export type BenchmarkPackExecution = {
  packId: string;
  title: string;
  cwd: string;
  status: "passed" | "failed";
  commandStatus: "passed" | "failed";
  results: BenchmarkCommandResult[];
  summary: {
    passed: number;
    failed: number;
    timedOut: number;
    skipped: number;
  };
  metrics: Record<string, number>;
  metricGateStatus: "passed" | "failed" | "not_configured";
  metricGateResults: BenchmarkMetricGateResult[];
};

const METRIC_LINE_PATTERN =
  /^METRIC\s+([A-Za-z0-9._-]+)\s*=\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*$/;
const RESERVED_METRIC_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function uniqueCommands(commands: BenchmarkPackCommand[]): BenchmarkPackCommand[] {
  const seen = new Set<string>();
  return commands.filter((item) => {
    const key = `${item.cwd ?? ""}:${item.command}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function summarizeOutput(stdout: string, stderr: string): string {
  return [stdout.trim(), stderr.trim()].filter(Boolean).join("\n").slice(0, 4000);
}

function quoteShellPath(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function parseMetricLines(output: string): Record<string, number> {
  const metrics: Record<string, number> = {};

  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const match = line.match(METRIC_LINE_PATTERN);
    if (!match) {
      continue;
    }

    const metricName = match[1];
    if (!metricName || RESERVED_METRIC_KEYS.has(metricName)) {
      continue;
    }

    const metricValue = Number(match[2]);
    if (!Number.isFinite(metricValue)) {
      continue;
    }

    metrics[metricName] = metricValue;
  }

  return metrics;
}

function mergeMetrics(
  target: Record<string, number>,
  source: Record<string, number>
): Record<string, number> {
  for (const [metricName, metricValue] of Object.entries(source)) {
    target[metricName] = metricValue;
  }

  return target;
}

function collectCommandMetrics(stdout: string, stderr: string): Record<string, number> {
  return mergeMetrics(parseMetricLines(stdout), parseMetricLines(stderr));
}

function formatMetricValue(value: number): string {
  if (Number.isInteger(value)) {
    return String(value);
  }

  return value.toFixed(6).replace(/\.?0+$/u, "");
}

function resolveRequiredDelta(gate: BenchmarkMetricGate): number {
  const absoluteDelta = Math.max(0, gate.minDelta ?? 0);
  const relativeDelta = Math.max(0, gate.minRelativeDelta ?? 0);
  return Math.max(absoluteDelta, Math.abs(gate.baseline) * relativeDelta);
}

function evaluateMetricGates(
  metricGates: BenchmarkMetricGate[] | undefined,
  metrics: Record<string, number>
): {
  status: "passed" | "failed" | "not_configured";
  results: BenchmarkMetricGateResult[];
} {
  if (!metricGates || metricGates.length === 0) {
    return {
      status: "not_configured",
      results: []
    };
  }

  const results = metricGates.map<BenchmarkMetricGateResult>((gate) => {
    const actual = metrics[gate.metricName];
    const requiredDelta = resolveRequiredDelta(gate);

    if (!Number.isFinite(actual)) {
      return {
        metricName: gate.metricName,
        direction: gate.direction,
        baseline: gate.baseline,
        requiredDelta,
        status: "failed" as const,
        detail: `Metric ${gate.metricName} was not emitted by the benchmark pack.`
      };
    }

    const delta =
      gate.direction === "higher"
        ? actual - gate.baseline
        : gate.baseline - actual;
    const passed = delta >= requiredDelta;
    const status: BenchmarkMetricGateResult["status"] = passed ? "passed" : "failed";

    return {
      metricName: gate.metricName,
      direction: gate.direction,
      baseline: gate.baseline,
      actual,
      delta,
      requiredDelta,
      status,
      detail: passed
        ? `Metric ${gate.metricName} passed (${formatMetricValue(actual)} vs baseline ${formatMetricValue(gate.baseline)}).`
        : `Metric ${gate.metricName} failed (${formatMetricValue(actual)} vs baseline ${formatMetricValue(gate.baseline)}, required delta ${formatMetricValue(requiredDelta)}).`
    };
  });

  return {
    status: results.some((result) => result.status === "failed") ? "failed" : "passed",
    results
  };
}

function buildAutoResearchMetricGates(
  baseline: AutoResearchMetricSnapshot
): BenchmarkMetricGate[] {
  const gates: BenchmarkMetricGate[] = [
    {
      metricName: "net_return",
      direction: "higher",
      baseline: baseline.netReturn
    },
    {
      metricName: "max_drawdown",
      direction: "lower",
      baseline: baseline.maxDrawdown
    }
  ];

  if (baseline.tradeCount > 0) {
    gates.push({
      metricName: "trade_count",
      direction: "higher",
      baseline: baseline.tradeCount
    });
  }

  if (typeof baseline.positiveWindowRatio === "number") {
    gates.push({
      metricName: "positive_window_ratio",
      direction: "higher",
      baseline: baseline.positiveWindowRatio
    });
  }

  if (typeof baseline.randomPercentile === "number") {
    gates.push({
      metricName: "random_percentile",
      direction: "higher",
      baseline: baseline.randomPercentile
    });
  }

  if (typeof baseline.buyHoldExcess === "number") {
    gates.push({
      metricName: "buy_hold_excess",
      direction: "higher",
      baseline: baseline.buyHoldExcess
    });
  }

  return gates;
}

function countStatuses(results: BenchmarkCommandResult[]) {
  return results.reduce(
    (summary, result) => {
      if (result.status === "passed") {
        summary.passed += 1;
      } else if (result.status === "failed") {
        summary.failed += 1;
      } else if (result.status === "timed_out") {
        summary.timedOut += 1;
      } else if (result.status === "skipped") {
        summary.skipped += 1;
      }
      return summary;
    },
    {
      passed: 0,
      failed: 0,
      timedOut: 0,
      skipped: 0
    }
  );
}

function skippedResult(command: BenchmarkPackCommand, cwd: string): BenchmarkCommandResult {
  return {
    label: command.label ?? command.command,
    command: command.command,
    cwd,
    status: "skipped",
    detail: "Skipped because an earlier benchmark command failed.",
    exitCode: null,
    durationMs: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    metrics: {}
  };
}

export async function runBoundedCommand(
  command: BenchmarkPackCommand,
  defaultCwd: string
): Promise<BenchmarkCommandResult> {
  const cwd = command.cwd ?? defaultCwd;
  const startedAt = Date.now();
  const child = spawn("bash", ["-lc", command.command], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let timeoutHandle: NodeJS.Timeout | undefined;
  let killHandle: NodeJS.Timeout | undefined;

  const clearTimers = () => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    if (killHandle) {
      clearTimeout(killHandle);
    }
  };

  const killProcess = () => {
    if (child.exitCode !== null) {
      return;
    }

    try {
      child.kill("SIGTERM");
    } catch {}

    killHandle = setTimeout(() => {
      if (child.exitCode !== null) {
        return;
      }

      try {
        child.kill("SIGKILL");
      } catch {}
    }, 250);
    killHandle.unref();
  };

  if (command.timeoutMs && command.timeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      killProcess();
    }, command.timeoutMs);
    timeoutHandle.unref();
  }

  return await new Promise<BenchmarkCommandResult>((resolve) => {
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimers();
      resolve({
        label: command.label ?? command.command,
        command: command.command,
        cwd,
        status: timedOut ? "timed_out" : "failed",
        detail: stderr || error.message,
        exitCode: -1,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr: stderr || error.message,
        timedOut,
        metrics: collectCommandMetrics(stdout, stderr || error.message)
      });
    });
    child.on("close", (exitCode) => {
      clearTimers();
      resolve({
        label: command.label ?? command.command,
        command: command.command,
        cwd,
        status:
          timedOut
            ? "timed_out"
            : exitCode === 0
              ? "passed"
              : "failed",
        detail: summarizeOutput(stdout, stderr),
        exitCode,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr,
        timedOut,
        metrics: collectCommandMetrics(stdout, stderr)
      });
    });
  });
}

export async function runBenchmarkPack(params: {
  pack: BenchmarkPack;
  cwd: string;
}): Promise<BenchmarkPackExecution> {
  const results: BenchmarkCommandResult[] = [];
  const stopOnFailure = params.pack.stopOnFailure ?? true;

  for (let index = 0; index < params.pack.commands.length; index += 1) {
    const command = params.pack.commands[index];
    const result = await runBoundedCommand(command, params.cwd);
    results.push(result);

    if (
      stopOnFailure &&
      (result.status === "failed" || result.status === "timed_out")
    ) {
      for (const remaining of params.pack.commands.slice(index + 1)) {
        results.push(skippedResult(remaining, remaining.cwd ?? params.cwd));
      }
      break;
    }
  }

  const summary = countStatuses(results);
  const commandStatus =
    summary.failed > 0 || summary.timedOut > 0 ? "failed" : "passed";
  const metrics = results.reduce<Record<string, number>>(
    (aggregate, result) => mergeMetrics(aggregate, result.metrics),
    {}
  );
  const metricGateEvaluation = evaluateMetricGates(params.pack.metricGates, metrics);

  return {
    packId: params.pack.packId,
    title: params.pack.title ?? params.pack.packId,
    cwd: params.cwd,
    status:
      commandStatus === "failed" || metricGateEvaluation.status === "failed"
        ? "failed"
        : "passed",
    commandStatus,
    results,
    summary,
    metrics,
    metricGateStatus: metricGateEvaluation.status,
    metricGateResults: metricGateEvaluation.results
  };
}

export function createBacktesterBenchmarkPack(params?: {
  repoRoot?: string;
  includeTests?: boolean;
  timeoutMs?: number;
  testTimeoutMs?: number;
  testFiles?: string[];
  metricGates?: BenchmarkMetricGate[];
}): BenchmarkPack {
  const repoRoot = params?.repoRoot ?? process.cwd();
  const packageRoot = path.join(repoRoot, "research/backtester");
  const includeTests = params?.includeTests ?? true;
  const timeoutMs = params?.timeoutMs ?? 120_000;
  const testTimeoutMs = params?.testTimeoutMs ?? Math.max(timeoutMs, 180_000);
  const commands: BenchmarkPackCommand[] = [
    {
      label: "backtester typecheck",
      command: "pnpm --filter @fst/backtester typecheck",
      cwd: repoRoot,
      timeoutMs
    }
  ];

  if (includeTests) {
    const testCommand =
      params?.testFiles && params.testFiles.length > 0
        ? `node --import tsx --test ${params.testFiles.join(" ")}`
        : "pnpm --filter @fst/backtester test";
    commands.push({
      label: "backtester tests",
      command: testCommand,
      cwd: packageRoot,
      timeoutMs: testTimeoutMs
    });
  }

  return {
    packId: includeTests ? "backtester-typecheck-and-test" : "backtester-typecheck",
    title: includeTests ? "Backtester typecheck and tests" : "Backtester typecheck",
    commands,
    stopOnFailure: true,
    metricGates: params?.metricGates
  };
}

export function buildBenchmarkPack(params: {
  repoRoot: string;
  task: CodeMutationTask;
  metricGates?: BenchmarkMetricGate[];
  performanceBenchmark?: AutoResearchPerformanceBenchmark;
}): BenchmarkPack {
  const repoRoot = params.repoRoot;
  const packageRoot = path.join(repoRoot, "research/backtester");
  const commands: BenchmarkPackCommand[] = [
    {
      label: "backtester typecheck",
      command: "pnpm --filter @fst/backtester typecheck",
      cwd: repoRoot,
      timeoutMs: 120_000
    }
  ];

  if (params.task.intent === "fix_bug" || params.task.intent === "refactor_research_loop") {
    commands.push({
      label: "auto-research focused tests",
      command: "node --import tsx --test test/auto-research.test.ts test/llm-adapter.test.ts",
      cwd: packageRoot,
      timeoutMs: 180_000
    });
  }

  if (params.task.intent === "implement_strategy" || params.task.intent === "extend_catalog") {
    commands.push({
      label: "catalog and portfolio tests",
      command: "node --import tsx --test test/block-families.test.ts test/portfolio-auto-research.test.ts",
      cwd: packageRoot,
      timeoutMs: 180_000
    });
  }

  if (params.performanceBenchmark) {
    commands.push({
      label: "auto-research performance benchmark",
      command: [
        "node",
        "--import",
        "tsx",
        "src/auto-research/code-mutation-benchmark.ts",
        "--payload",
        quoteShellPath(params.performanceBenchmark.payloadPath),
        "--output",
        quoteShellPath(params.performanceBenchmark.evaluationOutputPath)
      ].join(" "),
      cwd: packageRoot,
      timeoutMs: params.performanceBenchmark.timeoutMs ?? 300_000
    });
  }

  const autoResearchMetricGates = params.performanceBenchmark
    ? buildAutoResearchMetricGates(params.performanceBenchmark.baselineMetrics)
    : [];

  return {
    packId: `benchmark-${params.task.intent}`,
    title: `Benchmark pack for ${params.task.intent}`,
    commands: uniqueCommands(commands),
    stopOnFailure: true,
    metricGates: [...(params.metricGates ?? []), ...autoResearchMetricGates]
  };
}
