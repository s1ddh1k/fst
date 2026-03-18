import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { llmText } from "./cli-llm.js";
import type { CodeMutationTask } from "./types.js";

export type CodeMutationExecution = {
  task: CodeMutationTask;
  status: "planned" | "executed" | "failed" | "skipped";
  detail: string;
};

export type CodeAgent = {
  execute(params: {
    tasks: CodeMutationTask[];
    outputDir: string;
    allowCodeMutation: boolean;
    cwd?: string;
    provider?: string;
    model?: string;
  }): Promise<CodeMutationExecution[]>;
};

type GitStatusEntry = {
  code: string;
  path: string;
};

type MutationScopeAudit = {
  before: GitStatusEntry[];
  after: GitStatusEntry[];
  newOrChangedPaths: string[];
  allowlistedPaths: string[];
  violations: string[];
};

const AUTO_RESEARCH_SCOPE_DEFAULTS = [
  "research/backtester/src/strategy-registry.ts",
  "research/backtester/src/auto-research/catalog.ts",
  "research/backtester/src/auto-research/proposed-catalog.ts",
  "research/backtester/src/auto-research/index.ts"
];

function normalizeRepoPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\/+/, "").trim();
}

function buildAllowlist(task: CodeMutationTask): string[] {
  return Array.from(
    new Set(
      [...task.targetFiles.map(normalizeRepoPath), ...AUTO_RESEARCH_SCOPE_DEFAULTS]
        .filter(Boolean)
    )
  );
}

function isAllowlisted(filePath: string, allowlist: string[]): boolean {
  const normalized = normalizeRepoPath(filePath);
  return allowlist.some((entry) => normalized === entry || normalized.startsWith(`${entry}/`));
}

export function auditMutationScope(params: {
  before: GitStatusEntry[];
  after: GitStatusEntry[];
  allowlist: string[];
}): MutationScopeAudit {
  const beforeMap = new Map(params.before.map((item) => [normalizeRepoPath(item.path), item.code]));
  const afterMap = new Map(params.after.map((item) => [normalizeRepoPath(item.path), item.code]));
  const newOrChangedPaths = [...afterMap.entries()]
    .filter(([filePath, code]) => beforeMap.get(filePath) !== code)
    .map(([filePath]) => filePath)
    .sort((left, right) => left.localeCompare(right));

  return {
    before: params.before,
    after: params.after,
    newOrChangedPaths,
    allowlistedPaths: params.allowlist,
    violations: newOrChangedPaths.filter((filePath) => !isAllowlisted(filePath, params.allowlist))
  };
}

async function runCommand(
  cmd: string,
  args: string[],
  cwd: string
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });
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

async function readGitStatus(cwd: string): Promise<GitStatusEntry[]> {
  const result = await runCommand("git", ["status", "--porcelain=v1"], cwd);
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
  const result = await runCommand("git", ["diff", "--"], cwd);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || "git diff failed");
  }

  return result.stdout;
}

export class CliCodeMutationAgent implements CodeAgent {
  constructor(
    private readonly runner: typeof llmText = llmText
  ) {}

  async execute(params: {
    tasks: CodeMutationTask[];
    outputDir: string;
    allowCodeMutation: boolean;
    cwd?: string;
    provider?: string;
    model?: string;
  }): Promise<CodeMutationExecution[]> {
    await mkdir(params.outputDir, { recursive: true });

    const executions: CodeMutationExecution[] = [];

    for (const [index, task] of params.tasks.entries()) {
      const normalizedTask = {
        ...task,
        taskId: task.taskId ?? `code-task-${String(index + 1).padStart(2, "0")}`
      };
      const taskDir = path.join(params.outputDir, normalizedTask.taskId);
      await mkdir(taskDir, { recursive: true });

      if (!params.allowCodeMutation) {
        executions.push({
          task: normalizedTask,
          status: "skipped",
          detail: "Code mutation disabled by config."
        });
        continue;
      }

      if (normalizedTask.targetFiles.length === 0) {
        executions.push({
          task: normalizedTask,
          status: "failed",
          detail: "Unsafe code mutation task: targetFiles must not be empty."
        });
        continue;
      }

      const allowlist = buildAllowlist(normalizedTask);

      const prompt = [
        "You are acting as an autonomous coding agent inside the fst repository.",
        "Make the requested code change directly in the repository.",
        "Only touch files inside the allowed scope.",
        `Allowed scope: ${allowlist.join(", ")}`,
        "After editing, run the minimum relevant validation commands.",
        "Do not output markdown fences.",
        "",
        `Task: ${normalizedTask.title}`,
        `Intent: ${normalizedTask.intent}`,
        `FamilyId: ${normalizedTask.familyId ?? "not specified"}`,
        `StrategyName: ${normalizedTask.strategyName ?? "not specified"}`,
        `Rationale: ${normalizedTask.rationale}`,
        `Acceptance criteria: ${normalizedTask.acceptanceCriteria.join("; ") || "none provided"}`,
        `Target files: ${normalizedTask.targetFiles.join(", ") || "not specified"}`,
        "",
        normalizedTask.prompt,
        "",
        "Return a short plain-text summary of what changed and what validation ran."
      ].join("\n");

      try {
        const before = await readGitStatus(params.cwd ?? process.cwd());
        const diffBefore = await readGitDiff(params.cwd ?? process.cwd());
        await writeFile(path.join(taskDir, "prompt.txt"), `${prompt}\n`);
        const result = await this.runner(prompt, {
          provider: params.provider,
          model: params.model,
          cwd: params.cwd ?? process.cwd()
        });
        const after = await readGitStatus(params.cwd ?? process.cwd());
        const diffAfter = await readGitDiff(params.cwd ?? process.cwd());
        const audit = auditMutationScope({
          before,
          after,
          allowlist
        });
        await writeFile(path.join(taskDir, "result.txt"), `${result.text.trim()}\n`);
        await writeFile(path.join(taskDir, "git-diff-before.patch"), diffBefore);
        await writeFile(path.join(taskDir, "git-diff-after.patch"), diffAfter);
        await writeFile(path.join(taskDir, "mutation-scope.json"), `${JSON.stringify(audit, null, 2)}\n`);

        if (audit.violations.length > 0) {
          executions.push({
            task: normalizedTask,
            status: "failed",
            detail: `Mutation scope violation: ${audit.violations.join(", ")}`
          });
          continue;
        }

        executions.push({
          task: normalizedTask,
          status: "executed",
          detail: result.text.trim()
        });
      } catch (error) {
        executions.push({
          task: normalizedTask,
          status: "failed",
          detail: error instanceof Error ? error.message : String(error)
        });
      }
    }

    await writeFile(
      path.join(params.outputDir, "code-tasks.json"),
      `${JSON.stringify(executions, null, 2)}\n`
    );

    return executions;
  }
}
