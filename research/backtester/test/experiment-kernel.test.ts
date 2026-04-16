import test from "node:test";
import assert from "node:assert/strict";
import {
  getStrategyFamilies,
  prepareExperimentKernel
} from "../src/auto-research/index.js";
import type { AutoResearchRunConfig, ProposalBatch } from "../src/auto-research/index.js";

const BASE_CONFIG: AutoResearchRunConfig = {
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
  outputDir: "/tmp/fst-experiment-kernel-test",
  allowDataCollection: false,
  allowFeatureCacheBuild: false,
  allowCodeMutation: false,
};

test("prepareExperimentKernel keeps the LLM proposal batch instead of inventing new candidates", async () => {
  const family = getStrategyFamilies(["relative-momentum-pullback"])[0]!;
  const proposal: ProposalBatch = {
    researchSummary: "test",
    preparation: [],
    proposedFamilies: [],
    codeTasks: [],
    candidates: [
      {
        candidateId: "llm-candidate-1",
        familyId: family.familyId,
        thesis: "first",
        parameters: {
          minStrengthPct: 0.8,
          minRiskOn: 0.1,
          pullbackZ: 1,
          trailAtrMult: 2.2
        },
        invalidationSignals: [],
        origin: "llm"
      },
      {
        candidateId: "llm-candidate-2",
        familyId: family.familyId,
        thesis: "duplicate with a different id",
        parameters: {
          minStrengthPct: 0.8,
          minRiskOn: 0.1,
          pullbackZ: 1,
          trailAtrMult: 2.2
        },
        invalidationSignals: [],
        origin: "llm"
      }
    ]
  };

  const prepared = await prepareExperimentKernel({
    config: BASE_CONFIG,
    proposal,
    families: [family],
    iteration: 1
  });

  assert.equal(prepared.normalizedCandidates.length, 1);
  assert.equal(prepared.experimentPlan.candidates.length, 1);
  assert.equal(prepared.normalizedCandidates[0]?.candidateId, "llm-candidate-1");
  assert.equal(prepared.experimentPlan.candidates[0]?.candidateId, "llm-candidate-1");
  assert.equal(prepared.experimentPlan.candidates[0]?.origin, "llm");
});

test("prepareExperimentKernel prefers family diversity without inventing new candidates", async () => {
  const families = getStrategyFamilies([
    "leader-pullback-state-machine",
    "momentum-reacceleration"
  ]);
  const [leaderFamily, momentumFamily] = families;

  assert.ok(leaderFamily);
  assert.ok(momentumFamily);

  const prepared = await prepareExperimentKernel({
    config: {
      ...BASE_CONFIG,
      candidatesPerIteration: 2
    },
    proposal: {
      researchSummary: "family diversity",
      preparation: [],
      proposedFamilies: [],
      codeTasks: [],
      candidates: [
        {
          candidateId: "leader-a",
          familyId: leaderFamily.familyId,
          thesis: "leader A",
          parameters: {
            strengthFloor: 0.7,
            pullbackAtr: 0.7,
            setupExpiryBars: 4,
            trailAtrMult: 2.2
          },
          invalidationSignals: [],
          origin: "llm"
        },
        {
          candidateId: "leader-b",
          familyId: leaderFamily.familyId,
          thesis: "leader B",
          parameters: {
            strengthFloor: 0.8,
            pullbackAtr: 0.8,
            setupExpiryBars: 4,
            trailAtrMult: 2.2
          },
          invalidationSignals: [],
          origin: "llm"
        },
        {
          candidateId: "momentum-a",
          familyId: momentumFamily.familyId,
          thesis: "momentum A",
          parameters: {
            strengthFloor: 0.72,
            minRiskOn: 0.1,
            resetRsiFloor: 52,
            trailAtrMult: 2
          },
          invalidationSignals: [],
          origin: "llm"
        }
      ]
    },
    families,
    iteration: 1
  });

  assert.equal(prepared.diversifiedCandidates.length, 2);
  assert.deepEqual(
    prepared.diversifiedCandidates.map((candidate) => candidate.familyId).sort(),
    [leaderFamily.familyId, momentumFamily.familyId].sort()
  );
  assert.deepEqual(
    prepared.experimentPlan.candidates.map((candidate) => candidate.familyId).sort(),
    [leaderFamily.familyId, momentumFamily.familyId].sort()
  );
});
