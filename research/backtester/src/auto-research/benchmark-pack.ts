import path from "node:path";
import { spawn } from "node:child_process";
import type { CodeMutationTask } from "./types.js";

export type BenchmarkPackCommand = {
  command: string;
  cwd?: string;
  label?: string;
  timeoutMs?: number;
};

export type BenchmarkPack = {
  packId: string;
  title?: string;
  commands: BenchmarkPackCommand[];
  stopOnFailure?: boolean;
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
};

export type BenchmarkPackExecution = {
  packId: string;
  title: string;
  cwd: string;
  status: "passed" | "failed";
  results: BenchmarkCommandResult[];
  summary: {
    passed: number;
    failed: number;
    timedOut: number;
    skipped: number;
  };
};

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
    timedOut: false
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
        timedOut
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
        timedOut
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
  return {
    packId: params.pack.packId,
    title: params.pack.title ?? params.pack.packId,
    cwd: params.cwd,
    status: summary.failed > 0 || summary.timedOut > 0 ? "failed" : "passed",
    results,
    summary
  };
}

export function createBacktesterBenchmarkPack(params?: {
  repoRoot?: string;
  includeTests?: boolean;
  timeoutMs?: number;
  testTimeoutMs?: number;
  testFiles?: string[];
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
    stopOnFailure: true
  };
}

export function buildBenchmarkPack(params: {
  repoRoot: string;
  task: CodeMutationTask;
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

  return {
    packId: `benchmark-${params.task.intent}`,
    title: `Benchmark pack for ${params.task.intent}`,
    commands: uniqueCommands(commands),
    stopOnFailure: true
  };
}
