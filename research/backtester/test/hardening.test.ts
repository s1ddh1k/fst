import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { classifyLlmError, resolveFallbackChain } from "../src/auto-research/cli-llm.js";
import { withDbRetry } from "../src/sqlite.js";
import { isResearchConverged } from "../src/auto-research/lineage-metrics.js";
import { cleanIterationArtifacts, cleanStaleRuns } from "../src/auto-research/artifact-cleanup.js";

// --- LLM Error Classification ---

describe("classifyLlmError", () => {
  it("classifies 401/403 as AUTH", () => {
    assert.equal(classifyLlmError("Error: 401 Unauthorized"), "AUTH");
    assert.equal(classifyLlmError("Error: 403 Forbidden"), "AUTH");
    assert.equal(classifyLlmError("invalid api key provided"), "AUTH");
  });

  it("classifies rate limit errors as RATE_LIMIT", () => {
    assert.equal(classifyLlmError("rate limit exceeded"), "RATE_LIMIT");
    assert.equal(classifyLlmError("Error 429: Too Many Requests"), "RATE_LIMIT");
    assert.equal(classifyLlmError("API quota exceeded"), "RATE_LIMIT");
    assert.equal(classifyLlmError("server overloaded"), "RATE_LIMIT");
  });

  it("classifies network errors as TRANSIENT", () => {
    assert.equal(classifyLlmError("connect ECONNREFUSED 127.0.0.1:443"), "TRANSIENT");
    assert.equal(classifyLlmError("getaddrinfo ENOTFOUND api.anthropic.com"), "TRANSIENT");
    assert.equal(classifyLlmError("socket hang up"), "TRANSIENT");
    assert.equal(classifyLlmError("connect ETIMEDOUT"), "TRANSIENT");
  });

  it("classifies unknown errors as PERMANENT", () => {
    assert.equal(classifyLlmError("invalid JSON response"), "PERMANENT");
    assert.equal(classifyLlmError("unexpected token <"), "PERMANENT");
  });

  it("checks both stderr and stdout", () => {
    assert.equal(classifyLlmError("", "Error: 401 Unauthorized"), "AUTH");
  });
});

// --- Provider Fallback Chain ---

describe("resolveFallbackChain", () => {
  it("puts primary provider first", () => {
    const chain = resolveFallbackChain("claude");
    assert.equal(chain[0], "claude");
    assert.equal(chain.length, 3);
    assert.ok(chain.includes("codex"));
    assert.ok(chain.includes("gemini"));
  });

  it("defaults to codex first", () => {
    const chain = resolveFallbackChain();
    assert.equal(chain[0], "codex");
  });

  it("handles unknown provider by returning default chain", () => {
    const chain = resolveFallbackChain("unknown");
    assert.deepEqual(chain, ["codex", "claude", "gemini"]);
  });

  it("no duplicates", () => {
    const chain = resolveFallbackChain("gemini");
    assert.equal(new Set(chain).size, chain.length);
  });
});

// --- withDbRetry ---

describe("withDbRetry", () => {
  it("returns result on success", () => {
    const result = withDbRetry(() => 42);
    assert.equal(result, 42);
  });

  it("retries on SQLITE_BUSY then succeeds", () => {
    let attempts = 0;
    const result = withDbRetry(() => {
      attempts++;
      if (attempts < 3) throw new Error("SQLITE_BUSY");
      return "ok";
    }, 3);
    assert.equal(result, "ok");
    assert.equal(attempts, 3);
  });

  it("throws after max retries", () => {
    assert.throws(
      () => withDbRetry(() => { throw new Error("SQLITE_BUSY"); }, 1),
      /SQLITE_BUSY/
    );
  });

  it("throws immediately for non-BUSY errors", () => {
    assert.throws(
      () => withDbRetry(() => { throw new Error("SQLITE_CORRUPT"); }, 3),
      /SQLITE_CORRUPT/
    );
  });
});

// --- Artifact Cleanup ---

describe("cleanIterationArtifacts", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "fst-cleanup-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("deletes old iteration evaluation files", async () => {
    const iterDir = path.join(tmpDir, "iteration-01");
    await mkdir(iterDir, { recursive: true });

    // Create a fake evaluation file
    await writeFile(path.join(iterDir, "candidate-01.json"), '{"test": true}');
    await writeFile(path.join(iterDir, "candidate-02.json"), '{"test": true}');

    // Set mtime to 5 days ago
    const oldTime = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const { utimes } = await import("node:fs/promises");
    await utimes(iterDir, oldTime, oldTime);

    const result = await cleanIterationArtifacts({ outputDir: tmpDir, keepDays: 3 });
    assert.equal(result.deletedCount, 2);
    assert.ok(result.freedBytes > 0);
  });

  it("preserves recent iteration files", async () => {
    const iterDir = path.join(tmpDir, "iteration-01");
    await mkdir(iterDir, { recursive: true });
    await writeFile(path.join(iterDir, "candidate-01.json"), '{"test": true}');

    // mtime is now (recent) — should not be deleted
    const result = await cleanIterationArtifacts({ outputDir: tmpDir, keepDays: 3 });
    assert.equal(result.deletedCount, 0);
  });

  it("ignores non-iteration directories", async () => {
    const otherDir = path.join(tmpDir, "some-other-dir");
    await mkdir(otherDir, { recursive: true });
    await writeFile(path.join(otherDir, "file.json"), '{}');

    const result = await cleanIterationArtifacts({ outputDir: tmpDir, keepDays: 0 });
    assert.equal(result.deletedCount, 0);
  });
});

describe("cleanStaleRuns", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "fst-stale-runs-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("deletes non-essential files from old run directories", async () => {
    const runDir = path.join(tmpDir, "run-2026-01-01");
    await mkdir(runDir, { recursive: true });

    // Essential files (should be kept)
    await writeFile(path.join(runDir, "report.json"), '{}');
    await writeFile(path.join(runDir, "leaderboard.json"), '{}');

    // Non-essential files (should be deleted)
    await writeFile(path.join(runDir, "some-eval.json"), '{}');

    const oldTime = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    const { utimes } = await import("node:fs/promises");
    await utimes(runDir, oldTime, oldTime);

    const result = await cleanStaleRuns({ parentDir: tmpDir, retentionDays: 14 });
    assert.equal(result.deletedCount, 1); // only some-eval.json

    const remaining = await readdir(runDir);
    assert.ok(remaining.includes("report.json"));
    assert.ok(remaining.includes("leaderboard.json"));
    assert.ok(!remaining.includes("some-eval.json"));
  });
});

// --- Resource defaults ---

describe("resource defaults", () => {
  it("computes correct heap for 8GB machine", () => {
    const totalMb = 8192;
    const available = Math.max(totalMb - 2048, 1024);
    const heap = Math.min(Math.floor(available / 3), 4096);
    assert.equal(heap, 2048);
  });

  it("computes correct heap for 16GB machine", () => {
    const totalMb = 16384;
    const available = Math.max(totalMb - 2048, 1024);
    const heap = Math.min(Math.floor(available / 3), 4096);
    assert.equal(heap, 4096); // capped at 4096
  });

  it("computes correct heap for 4GB machine", () => {
    const totalMb = 4096;
    const available = Math.max(totalMb - 2048, 1024);
    const heap = Math.min(Math.floor(available / 3), 4096);
    assert.equal(heap, 682); // (4096-2048)/3 = 682
  });

  it("parallelism cap is 1 for 8GB", () => {
    const totalMb = 8192;
    const memAwareCap = totalMb <= 8192 ? 1 : totalMb <= 16384 ? 2 : 4;
    assert.equal(memAwareCap, 1);
  });

  it("parallelism cap is 2 for 16GB", () => {
    const totalMb = 16384;
    const memAwareCap = totalMb <= 8192 ? 1 : totalMb <= 16384 ? 2 : 4;
    assert.equal(memAwareCap, 2);
  });

  it("default candidates is 2 for 8GB", () => {
    const totalMem = 8 * 1024 ** 3;
    const defaultCandidates = totalMem <= 8 * 1024 ** 3 ? 2 : 3;
    assert.equal(defaultCandidates, 2);
  });
});
