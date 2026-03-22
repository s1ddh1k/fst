import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { getStrategyFamilies } from "../src/auto-research/catalog.js";
import { generateHypothesisProposal } from "../src/auto-research/hypothesis-orchestrator.js";
import type { AutoResearchRunConfig } from "../src/auto-research/types.js";

function buildConfig(
  outputDir: string,
  overrides: Partial<AutoResearchRunConfig> = {}
): AutoResearchRunConfig {
  return {
    strategyFamilyIds: overrides.strategyFamilyIds,
    universeName: "krw-top",
    timeframe: "1h",
    marketLimit: 3,
    limit: 2_000,
    holdoutDays: 30,
    trainingDays: 90,
    stepDays: 30,
    iterations: 2,
    candidatesPerIteration: 2,
    parallelism: 1,
    mode: "holdout",
    outputDir,
    allowDataCollection: false,
    allowFeatureCacheBuild: false,
    allowCodeMutation: false,
    loopVersion: "v2",
    ...overrides
  };
}

test("hypothesis orchestrator falls back to objective seeds when proposal LLM fails", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-hypothesis-orchestrator-"));
  const family = getStrategyFamilies(["relative-momentum-pullback"])[0]!;

  const result = await generateHypothesisProposal({
    llmClient: {
      async proposeCandidates() {
        throw new Error("proposal transport failed");
      },
      async reviewIteration() {
        throw new Error("not used");
      }
    },
    config: buildConfig(outputDir, {
      strategyFamilyIds: [family.familyId]
    }),
    families: [family],
    marketCodes: ["KRW-BTC", "KRW-ETH"],
    history: [],
    iteration: 1
  });

  assert.equal(result.source, "objective_seed");
  assert.match(result.note ?? "", /proposal transport failed/i);
  assert.ok(result.proposal.candidates.length > 0);
  assert.ok(result.proposal.candidates.every((candidate) => candidate.familyId === family.familyId));
  assert.ok(result.hypotheses.length > 0);
});
