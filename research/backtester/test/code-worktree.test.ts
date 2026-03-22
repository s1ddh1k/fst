import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  cleanupCodeWorktree,
  createCodeWorktree,
  runCodeTaskInWorktree
} from "../src/auto-research/code-worktree.js";

async function run(
  command: string,
  args: string[],
  cwd: string
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
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

async function assertExists(targetPath: string): Promise<void> {
  await access(targetPath, fsConstants.F_OK);
}

async function assertMissing(targetPath: string): Promise<void> {
  await assert.rejects(() => access(targetPath, fsConstants.F_OK));
}

async function setupGitRepo(): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "fst-code-worktree-test-"));
  await run("git", ["init"], repoRoot);
  await run("git", ["config", "user.email", "worker2@example.com"], repoRoot);
  await run("git", ["config", "user.name", "Worker Two"], repoRoot);
  await writeFile(path.join(repoRoot, "README.md"), "initial\n");
  await run("git", ["add", "README.md"], repoRoot);
  await run("git", ["commit", "-m", "initial"], repoRoot);
  return repoRoot;
}

test("createCodeWorktree creates an isolated worktree and cleanup removes it", async () => {
  const repoRoot = await setupGitRepo();
  const session = await createCodeWorktree({
    repoRoot,
    taskId: "isolation-check"
  });

  try {
    await assertExists(session.worktreePath);
    const content = await readFile(path.join(session.worktreePath, "README.md"), "utf8");
    assert.match(content, /initial/);
    assert.match(session.branchName, /^fst\/auto-research\//);
  } finally {
    const cleanup = await cleanupCodeWorktree(session);
    assert.equal(cleanup.errors.length, 0);
    await assertMissing(session.worktreePath);
  }
});

test("runCodeTaskInWorktree returns merge metadata for a valid isolated mutation", async () => {
  const repoRoot = await setupGitRepo();
  const result = await runCodeTaskInWorktree({
    repoRoot,
    task: {
      taskId: "edit-readme",
      title: "Update README",
      targetFiles: ["README.md"]
    },
    runner: async ({ cwd }) => {
      await writeFile(path.join(cwd, "README.md"), "changed\n");
      return {
        status: "executed",
        detail: "Updated README"
      };
    },
    benchmarkPack: {
      packId: "verify-readme",
      title: "Verify README",
      commands: [
        {
          label: "check changed text",
          command: "grep -q changed README.md",
          timeoutMs: 5_000
        }
      ]
    }
  });

  try {
    assert.equal(result.status, "executed");
    assert.equal(result.mergeable, true);
    assert.equal(result.recommendedAction, "merge");
    assert.deepEqual(result.changedFiles, ["README.md"]);
    assert.equal(result.violations.length, 0);
    assert.equal(result.benchmarkExecution?.status, "passed");
    assert.match(result.session.mergeCommands[0] ?? "", /merge --ff-only/);
    assert.match(result.session.discardCommands[0] ?? "", /worktree remove --force/);
  } finally {
    const cleanup = await cleanupCodeWorktree(result.session);
    assert.equal(cleanup.errors.length, 0);
  }
});

test("runCodeTaskInWorktree marks out-of-scope changes as discardable", async () => {
  const repoRoot = await setupGitRepo();
  const result = await runCodeTaskInWorktree({
    repoRoot,
    task: {
      taskId: "scope-violation",
      title: "Write wrong file",
      targetFiles: ["README.md"]
    },
    runner: async ({ cwd }) => {
      await writeFile(path.join(cwd, "README.md"), "changed\n");
      await writeFile(path.join(cwd, "notes.txt"), "unexpected\n");
      return {
        status: "executed",
        detail: "Changed README and notes"
      };
    },
    cleanupMode: "on_failure"
  });

  assert.equal(result.status, "executed");
  assert.equal(result.mergeable, false);
  assert.equal(result.recommendedAction, "discard");
  assert.deepEqual(result.violations, ["notes.txt"]);
  assert.equal(result.cleanup?.removedWorktree, true);
});
