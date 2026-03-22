import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  buildBenchmarkPack,
  runBenchmarkPack,
  type BenchmarkCommandResult,
  type BenchmarkPack,
  type BenchmarkPackExecution
} from "./benchmark-pack.js";
import { CliCodeMutationAgent } from "./code-agent.js";
import type { CodeMutationTask } from "./types.js";

type GitStatusEntry = {
  code: string;
  path: string;
};

export type WorktreeBenchmarkResult = {
  command: string;
  cwd: string;
  status: "passed" | "failed" | "timed_out" | "skipped";
  detail: string;
};

export type CodeWorktreeSession = {
  repoRoot: string;
  baseRef: string;
  branchName: string;
  worktreePath: string;
  mergeCommands: string[];
  discardCommands: string[];
};

export type CodeWorktreeCleanupResult = {
  removedWorktree: boolean;
  removedBranch: boolean;
  errors: string[];
};

export type CodeTaskRunnerResult = {
  status?: "executed" | "failed";
  detail?: string;
};

export type CodeWorktreeExecutionResult = {
  task: CodeMutationTask;
  session: CodeWorktreeSession;
  status: "executed" | "failed" | "skipped";
  detail: string;
  worktreePath: string;
  branchName: string;
  codeAgentStatus: "executed" | "failed" | "skipped";
  codeAgentDetail: string;
  benchmarkPackId: string;
  benchmarkResults: WorktreeBenchmarkResult[];
  mergeRecommendation: "merge" | "discard";
  recommendedAction: "merge" | "discard";
  mergeable: boolean;
  patchPath?: string;
  mergeCommands: string[];
  discardCommands: string[];
  changedFiles: string[];
  violations: string[];
  benchmarkExecution?: BenchmarkPackExecution;
  cleanup?: CodeWorktreeCleanupResult;
};

function normalizeRepoPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\/+/, "").trim();
}

function sanitizeRefSegment(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/\/+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned || "task";
}

function quoteShellPath(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function toWorktreeBenchmarkResult(result: BenchmarkCommandResult): WorktreeBenchmarkResult {
  return {
    command: result.command,
    cwd: result.cwd,
    status: result.status,
    detail: result.detail
  };
}

async function runCommand(
  cmd: string,
  args: string[],
  cwd: string
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
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

async function resolveRepoRoot(repoPath: string): Promise<string> {
  const result = await runCommand("git", ["rev-parse", "--show-toplevel"], repoPath);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || "Failed to resolve git repository root");
  }
  return result.stdout.trim();
}

async function readGitStatus(cwd: string): Promise<GitStatusEntry[]> {
  const result = await runCommand(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    cwd
  );
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || "git status failed");
  }

  return result.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => ({
      code: line.slice(0, 2).trim(),
      path: normalizeRepoPath(line.slice(3).trim())
    }));
}

async function readGitDiff(cwd: string): Promise<string> {
  const result = await runCommand("git", ["diff", "--binary", "--"], cwd);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || "git diff failed");
  }
  return result.stdout;
}

function collectChangedFiles(before: GitStatusEntry[], after: GitStatusEntry[]): string[] {
  const beforeMap = new Map(before.map((entry) => [entry.path, entry.code]));
  return after
    .filter((entry) => beforeMap.get(entry.path) !== entry.code)
    .map((entry) => entry.path)
    .sort((left, right) => left.localeCompare(right));
}

function isAllowlisted(filePath: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) {
    return true;
  }

  return allowlist.some((allowed) =>
    filePath === allowed || filePath.startsWith(`${allowed}/`)
  );
}

export async function createCodeWorktree(params: {
  repoRoot: string;
  taskId: string;
  baseRef?: string;
  worktreeRoot?: string;
}): Promise<CodeWorktreeSession> {
  const repoRoot = await resolveRepoRoot(params.repoRoot);
  const baseRef = params.baseRef?.trim() || "HEAD";
  const safeTaskId = sanitizeRefSegment(params.taskId);
  const uniqueSuffix = randomUUID().slice(0, 8);
  const branchName = `fst/auto-research/${safeTaskId}-${uniqueSuffix}`;
  const worktreeParent =
    params.worktreeRoot ??
    path.join(os.tmpdir(), "fst-auto-research-worktrees");
  const worktreePath = path.join(worktreeParent, `${safeTaskId}-${uniqueSuffix}`);

  await mkdir(worktreeParent, { recursive: true });

  const addResult = await runCommand(
    "git",
    ["worktree", "add", "-b", branchName, worktreePath, baseRef],
    repoRoot
  );
  if (addResult.code !== 0) {
    throw new Error(addResult.stderr.trim() || "git worktree add failed");
  }

  return {
    repoRoot,
    baseRef,
    branchName,
    worktreePath,
    mergeCommands: [
      `git -C ${quoteShellPath(repoRoot)} merge --ff-only ${quoteShellPath(branchName)}`
    ],
    discardCommands: [
      `git -C ${quoteShellPath(repoRoot)} worktree remove --force ${quoteShellPath(worktreePath)}`,
      `git -C ${quoteShellPath(repoRoot)} branch -D ${quoteShellPath(branchName)}`
    ]
  };
}

export async function cleanupCodeWorktree(
  session: CodeWorktreeSession,
  options?: {
    removeBranch?: boolean;
  }
): Promise<CodeWorktreeCleanupResult> {
  const errors: string[] = [];
  let removedWorktree = false;
  let removedBranch = false;

  const worktreeRemoval = await runCommand(
    "git",
    ["worktree", "remove", "--force", session.worktreePath],
    session.repoRoot
  );
  if (worktreeRemoval.code === 0) {
    removedWorktree = true;
  } else if (!/not a working tree|does not exist/i.test(worktreeRemoval.stderr)) {
    errors.push(worktreeRemoval.stderr.trim() || "git worktree remove failed");
  }

  if (options?.removeBranch ?? true) {
    const branchRemoval = await runCommand(
      "git",
      ["branch", "-D", session.branchName],
      session.repoRoot
    );
    if (branchRemoval.code === 0) {
      removedBranch = true;
    } else if (!/not found|unknown revision|not fully merged/i.test(branchRemoval.stderr)) {
      errors.push(branchRemoval.stderr.trim() || "git branch -D failed");
    }
  }

  try {
    await rm(session.worktreePath, { recursive: true, force: true });
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  return {
    removedWorktree,
    removedBranch,
    errors
  };
}

export async function runCodeTaskInWorktree(params: {
  repoRoot: string;
  task: CodeMutationTask;
  runner: (context: {
    cwd: string;
    repoRoot: string;
    branchName: string;
    worktreePath: string;
    task: CodeMutationTask;
  }) => Promise<CodeTaskRunnerResult | void>;
  baseRef?: string;
  worktreeRoot?: string;
  benchmarkPack?: BenchmarkPack;
  cleanupMode?: "never" | "always" | "on_failure";
  removeBranchOnCleanup?: boolean;
}): Promise<CodeWorktreeExecutionResult> {
  const session = await createCodeWorktree({
    repoRoot: params.repoRoot,
    taskId: params.task.taskId ?? params.task.title,
    baseRef: params.baseRef,
    worktreeRoot: params.worktreeRoot
  });

  const allowlist = Array.from(
    new Set((params.task.targetFiles ?? []).map(normalizeRepoPath).filter(Boolean))
  );
  const before = await readGitStatus(session.worktreePath);
  let codeAgentStatus: "executed" | "failed" | "skipped" = "executed";
  let codeAgentDetail = "";

  try {
    const outcome = await params.runner({
      cwd: session.worktreePath,
      repoRoot: session.repoRoot,
      branchName: session.branchName,
      worktreePath: session.worktreePath,
      task: params.task
    });
    if (outcome?.status === "failed") {
      codeAgentStatus = "failed";
    }
    codeAgentDetail = outcome?.detail?.trim() ?? "";
  } catch (error) {
    codeAgentStatus = "failed";
    codeAgentDetail = error instanceof Error ? error.message : String(error);
  }

  const after = await readGitStatus(session.worktreePath);
  const changedFiles = collectChangedFiles(before, after);
  const diff = changedFiles.length > 0 ? await readGitDiff(session.worktreePath) : "";
  const violations = changedFiles.filter((filePath) => !isAllowlisted(filePath, allowlist));

  let benchmarkExecution: BenchmarkPackExecution | undefined;
  if (params.benchmarkPack && codeAgentStatus !== "failed") {
    benchmarkExecution = await runBenchmarkPack({
      pack: params.benchmarkPack,
      cwd: session.worktreePath
    });
  }

  const mergeable =
    codeAgentStatus === "executed" &&
    violations.length === 0 &&
    changedFiles.length > 0 &&
    (benchmarkExecution ? benchmarkExecution.status === "passed" : true);
  const cleanupMode = params.cleanupMode ?? "never";
  let cleanup: CodeWorktreeCleanupResult | undefined;

  if (
    cleanupMode === "always" ||
    (cleanupMode === "on_failure" && !mergeable)
  ) {
    cleanup = await cleanupCodeWorktree(session, {
      removeBranch: params.removeBranchOnCleanup ?? true
    });
  }

  return {
    task: params.task,
    session,
    status: codeAgentStatus,
    detail: codeAgentDetail,
    worktreePath: session.worktreePath,
    branchName: session.branchName,
    codeAgentStatus,
    codeAgentDetail,
    benchmarkPackId: params.benchmarkPack?.packId ?? "none",
    benchmarkResults: benchmarkExecution
      ? benchmarkExecution.results.map(toWorktreeBenchmarkResult)
      : [],
    mergeRecommendation: mergeable ? "merge" : "discard",
    recommendedAction: mergeable ? "merge" : "discard",
    mergeable,
    patchPath: undefined,
    mergeCommands: session.mergeCommands,
    discardCommands: session.discardCommands,
    changedFiles,
    violations,
    benchmarkExecution,
    cleanup
  };
}

export async function executeCodeMutationInWorktree(params: {
  repoRoot: string;
  outputDir: string;
  task: CodeMutationTask;
  allowCodeMutation: boolean;
  provider?: string;
  model?: string;
  baseRef?: string;
  worktreeRoot?: string;
}): Promise<CodeWorktreeExecutionResult> {
  await mkdir(params.outputDir, { recursive: true });
  const patchPath = path.join(
    params.outputDir,
    `${sanitizeRefSegment(params.task.taskId ?? params.task.title)}.patch`
  );
  const agent = new CliCodeMutationAgent();
  const benchmarkPack = buildBenchmarkPack({
    repoRoot: params.repoRoot,
    task: params.task
  });

  const execution = await runCodeTaskInWorktree({
    repoRoot: params.repoRoot,
    task: params.task,
    baseRef: params.baseRef,
    worktreeRoot: params.worktreeRoot,
    benchmarkPack,
    cleanupMode: "on_failure",
    runner: async ({ cwd }) => {
      const results = await agent.execute({
        tasks: [params.task],
        outputDir: path.join(params.outputDir, "code-agent"),
        allowCodeMutation: params.allowCodeMutation,
        cwd,
        provider: params.provider,
        model: params.model
      });
      const codeAgentResult = results[0];
      return {
        status:
          codeAgentResult?.status === "executed"
            ? "executed"
            : "failed",
        detail: codeAgentResult?.detail ?? "No code-agent result."
      };
    }
  });

  let nextPatchPath: string | undefined;
  if (execution.changedFiles.length > 0 && execution.cleanup?.removedWorktree !== true) {
    const diff = await readGitDiff(execution.worktreePath);
    if (diff.trim()) {
      await writeFile(patchPath, diff);
      nextPatchPath = patchPath;
    }
  }

  const nextExecution: CodeWorktreeExecutionResult = {
    ...execution,
    patchPath: nextPatchPath
  };
  await writeFile(
    path.join(params.outputDir, "worktree-result.json"),
    `${JSON.stringify(nextExecution, null, 2)}\n`
  );
  return nextExecution;
}

export async function readWorktreePatch(patchPath: string | undefined): Promise<string | undefined> {
  if (!patchPath) {
    return undefined;
  }

  try {
    return await readFile(patchPath, "utf8");
  } catch {
    return undefined;
  }
}
