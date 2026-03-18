import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Candle } from "../src/types.js";
import {
  reconcilePartialRunStatus,
  repairWalkForwardConfig,
  type AutoResearchRunConfig
} from "../src/auto-research/index.js";

function buildReferenceCandles(days: number): Candle[] {
  return Array.from({ length: days + 1 }, (_, index) => ({
    marketCode: "KRW-BTC",
    timeframe: "1h",
    candleTimeUtc: new Date(Date.UTC(2024, 0, 1 + index, 0, 0, 0)),
    openPrice: 1000 + index,
    highPrice: 1005 + index,
    lowPrice: 995 + index,
    closePrice: 1002 + index,
    volume: 1
  }));
}

function buildConfig(overrides: Partial<AutoResearchRunConfig> = {}): AutoResearchRunConfig {
  return {
    universeName: "krw-top",
    timeframe: "1h",
    marketLimit: 5,
    limit: 12000,
    holdoutDays: 180,
    iterations: 2,
    candidatesPerIteration: 2,
    mode: "walk-forward",
    outputDir: "/tmp/fst-auto-research-test",
    allowDataCollection: false,
    allowFeatureCacheBuild: false,
    allowCodeMutation: false,
    ...overrides
  };
}

test("repairWalkForwardConfig shrinks invalid walk-forward settings into a valid window config", () => {
  const config = buildConfig({
    holdoutDays: 180
  });
  const resolution = repairWalkForwardConfig({
    config,
    referenceCandles: buildReferenceCandles(430)
  });

  assert.ok(resolution.repair);
  assert.ok(!resolution.invalidReason);
  assert.ok(resolution.windowCount > 0);
  assert.notEqual(resolution.config.holdoutDays, 180);
  assert.ok((resolution.config.trainingDays ?? 0) + resolution.config.holdoutDays <= 430);
});

test("repairWalkForwardConfig reports invalid_config when candle span is too short", () => {
  const config = buildConfig({
    holdoutDays: 180
  });
  const resolution = repairWalkForwardConfig({
    config,
    referenceCandles: buildReferenceCandles(5)
  });

  assert.equal(resolution.windowCount, 0);
  assert.ok(resolution.invalidReason);
  assert.equal(resolution.repair, undefined);
});

test("reconcilePartialRunStatus rewrites stale non-terminal status to partial", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-auto-research-partial-"));
  await writeFile(
    path.join(outputDir, "status.json"),
    `${JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        phase: "evaluation",
        iteration: 3,
        totalIterations: 10,
        message: "Evaluating 2 candidates."
      },
      null,
      2
    )}\n`
  );

  await reconcilePartialRunStatus(outputDir);
  const status = JSON.parse(await readFile(path.join(outputDir, "status.json"), "utf8"));

  assert.equal(status.phase, "partial");
  assert.match(status.message, /before reaching a terminal state/i);
});
