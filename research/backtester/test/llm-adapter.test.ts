import test from "node:test";
import assert from "node:assert/strict";
import {
  CliResearchLlmClient,
  type AutoResearchRunConfig,
  type StrategyFamilyDefinition
} from "../src/auto-research/index.js";

const BASE_CONFIG: AutoResearchRunConfig = {
  universeName: "krw-top",
  timeframe: "1h",
  marketLimit: 5,
  limit: 500,
  holdoutDays: 30,
  trainingDays: 60,
  stepDays: 30,
  iterations: 1,
  candidatesPerIteration: 1,
  parallelism: 1,
  mode: "walk-forward",
  llmProvider: "codex",
  llmTimeoutMs: 1_500,
  outputDir: "/tmp/fst-llm-adapter-test",
  allowDataCollection: false,
  allowFeatureCacheBuild: false,
  allowCodeMutation: false
};

const BASE_FAMILY: StrategyFamilyDefinition = {
  familyId: "relative-momentum-pullback",
  strategyName: "relative-momentum-pullback",
  title: "Relative Momentum Pullback",
  thesis: "Test family",
  timeframe: "1h",
  requiredData: ["1h"],
  parameterSpecs: [{
    name: "minStrengthPct",
    description: "strength floor",
    min: 0.5,
    max: 0.95
  }],
  guardrails: []
};

test("CliResearchLlmClient forwards timeout budget and defaults codex auto-research to medium reasoning", async () => {
  const calls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
  const client = new CliResearchLlmClient({
    provider: "codex",
    cwd: "/tmp/fst",
    jsonRunner: async (prompt, options) => {
      calls.push({ prompt, options });
      return {
        data: {
          researchSummary: "ok",
          preparation: [],
          proposedFamilies: [],
          codeTasks: [],
          candidates: [{
            familyId: BASE_FAMILY.familyId,
            thesis: "test",
            parameters: {
              minStrengthPct: 0.8
            },
            invalidationSignals: []
          }]
        }
      };
    }
  });

  const proposal = await client.proposeCandidates({
    config: BASE_CONFIG,
    families: [BASE_FAMILY],
    marketCodes: ["KRW-BTC"],
    history: []
  });

  assert.equal(proposal.candidates.length, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0]?.prompt ?? "", /Current run config:/);
  assert.deepEqual(calls[0]?.options, {
    provider: "codex",
    model: "medium",
    cwd: "/tmp/fst",
    timeoutMs: 1_500,
    idleTimeoutMs: undefined,
    hardTimeoutMs: 3_000
  });
});

test("CliResearchLlmClient preserves explicit model overrides for review prompts", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const client = new CliResearchLlmClient({
    provider: "codex",
    model: "medium",
    cwd: "/tmp/fst",
    jsonRunner: async (_prompt, options) => {
      calls.push(options);
      return {
        data: {
          summary: "keep searching",
          verdict: "keep_searching",
          nextPreparation: [],
          proposedFamilies: [],
          codeTasks: [],
          nextCandidates: [{
            familyId: BASE_FAMILY.familyId,
            thesis: "retry",
            parameters: {
              minStrengthPct: 0.7
            },
            invalidationSignals: []
          }],
          retireCandidateIds: [],
          observations: []
        }
      };
    }
  });

  const review = await client.reviewIteration({
    config: BASE_CONFIG,
    families: [BASE_FAMILY],
    history: [],
    latestProposal: {
      researchSummary: "test",
      preparation: [],
      proposedFamilies: [],
      codeTasks: [],
      candidates: [{
        candidateId: "candidate-01",
        familyId: BASE_FAMILY.familyId,
        thesis: "test",
        parameters: {
          minStrengthPct: 0.8
        },
        invalidationSignals: []
      }]
    },
    preparationResults: [],
    codeMutationResults: [],
    validationResults: [],
    evaluations: []
  });

  assert.equal(review.verdict, "keep_searching");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.provider, "codex");
  assert.equal(calls[0]?.model, "medium");
  assert.equal(calls[0]?.timeoutMs, 1_500);
  assert.equal(calls[0]?.idleTimeoutMs, undefined);
  assert.equal(calls[0]?.hardTimeoutMs, 3_000);
});

test("CliResearchLlmClient block proposal prompt uses the structured inlined context", async () => {
  const calls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
  const client = new CliResearchLlmClient({
    provider: "codex",
    cwd: "/tmp/fst",
    jsonRunner: async (prompt, options) => {
      calls.push({ prompt, options });
      return {
        data: {
          researchSummary: "ok",
          preparation: [],
          proposedFamilies: [],
          codeTasks: [],
          candidates: [{
            familyId: "block:leader-1h-trend-up",
            thesis: "test",
            parameters: {
              strengthFloor: 0.78
            },
            invalidationSignals: []
          }]
        }
      };
    }
  });

  await client.proposeCandidates({
    config: {
      ...BASE_CONFIG,
      researchStage: "block"
    },
    families: [{
      ...BASE_FAMILY,
      familyId: "block:leader-1h-trend-up",
      strategyName: "block:leader-1h-trend-up"
    }],
    marketCodes: ["KRW-BTC"],
    history: []
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0]?.prompt ?? "", /Current run config:/);
  assert.match(calls[0]?.prompt ?? "", /"candidates": \[/);
  assert.doesNotMatch(calls[0]?.prompt ?? "", /Read these workspace files before answering:/);
});

test("CliResearchLlmClient unwraps nested proposal envelopes that contain candidates", async () => {
  const client = new CliResearchLlmClient({
    provider: "codex",
    cwd: "/tmp/fst",
    jsonRunner: async () => {
      return {
        data: {
          proposal: {
            researchSummary: "wrapped",
            preparation: [],
            proposedFamilies: [],
            codeTasks: [],
            candidates: [{
              familyId: BASE_FAMILY.familyId,
              thesis: "wrapped candidate",
              parameters: {
                minStrengthPct: 0.81
              },
              invalidationSignals: []
            }]
          }
        }
      };
    }
  });

  const proposal = await client.proposeCandidates({
    config: BASE_CONFIG,
    families: [BASE_FAMILY],
    marketCodes: ["KRW-BTC"],
    history: []
  });

  assert.equal(proposal.researchSummary, "wrapped");
  assert.equal(proposal.candidates.length, 1);
  assert.equal(proposal.candidates[0]?.familyId, BASE_FAMILY.familyId);
});

test("CliResearchLlmClient repairs keep_searching reviews that omit next candidates", async () => {
  const calls: string[] = [];
  const client = new CliResearchLlmClient({
    provider: "codex",
    cwd: "/tmp/fst",
    jsonRunner: async (prompt) => {
      calls.push(prompt);

      if (calls.length === 1) {
        return {
          data: {
            summary: "keep going",
            verdict: "keep_searching",
            nextPreparation: [],
            proposedFamilies: [],
            codeTasks: [],
            nextCandidates: [],
            retireCandidateIds: [],
            observations: []
          }
        };
      }

      return {
        data: {
          summary: "keep going with corrected next candidates",
          verdict: "keep_searching",
          nextPreparation: [],
          proposedFamilies: [],
          codeTasks: [],
          nextCandidates: [{
            familyId: BASE_FAMILY.familyId,
            thesis: "retry with a stronger strength floor",
            parameters: {
              minStrengthPct: 0.84
            },
            invalidationSignals: ["trade count collapses"]
          }],
          retireCandidateIds: [],
          observations: []
        }
      };
    }
  });

  const review = await client.reviewIteration({
    config: BASE_CONFIG,
    families: [BASE_FAMILY],
    history: [],
    latestProposal: {
      researchSummary: "test",
      preparation: [],
      proposedFamilies: [],
      codeTasks: [],
      candidates: [{
        candidateId: "candidate-01",
        familyId: BASE_FAMILY.familyId,
        thesis: "test",
        parameters: {
          minStrengthPct: 0.8
        },
        invalidationSignals: []
      }]
    },
    preparationResults: [],
    codeMutationResults: [],
    validationResults: [],
    evaluations: []
  });

  assert.equal(calls.length, 2);
  assert.match(calls[1] ?? "", /Provide 1 to 1 concrete, unique nextCandidates/);
  assert.equal(review.verdict, "keep_searching");
  assert.equal(review.nextCandidates.length, 1);
  assert.equal(review.nextCandidates[0]?.familyId, BASE_FAMILY.familyId);
});

test("CliResearchLlmClient block review fails fast on non-JSON responses", async () => {
  const calls: string[] = [];
  const client = new CliResearchLlmClient({
    provider: "codex",
    cwd: "/tmp/fst",
    textRunner: async (prompt) => {
      calls.push(prompt);

      if (calls.length === 1) {
        return {
          text: 'summary: keep searching but not valid json'
        };
      }

      return {
        text: JSON.stringify({
          summary: "corrected review",
          verdict: "stop_no_edge",
          promotedCandidateId: null,
          nextPreparation: [],
          proposedFamilies: [],
          codeTasks: [],
          nextCandidates: [],
          retireCandidateIds: [],
          observations: []
        })
      };
    }
  });

  await assert.rejects(
    () =>
      client.reviewIteration({
        config: {
          ...BASE_CONFIG,
          researchStage: "block"
        },
        families: [{
          ...BASE_FAMILY,
          familyId: "block:test",
          strategyName: "block:test"
        }],
        history: [],
        latestProposal: {
          researchSummary: "test",
          preparation: [],
          proposedFamilies: [],
          codeTasks: [],
          candidates: [{
            candidateId: "candidate-01",
            familyId: "block:test",
            thesis: "test",
            parameters: {
              minStrengthPct: 0.8
            },
            invalidationSignals: []
          }]
        },
        preparationResults: [],
        codeMutationResults: [],
        validationResults: [],
        evaluations: []
      }),
    /Failed to extract JSON from LLM response/
  );

  assert.equal(calls.length, 1);
  assert.match(calls[0] ?? "", /Structured run facts:/);
});

test("CliResearchLlmClient proposal parse errors expose top-level keys for debugging", async () => {
  const client = new CliResearchLlmClient({
    provider: "codex",
    cwd: "/tmp/fst",
    jsonRunner: async () => {
      return {
        data: {
          researchSummary: "broken",
          proposedFamilies: []
        }
      };
    }
  });

  await assert.rejects(
    () =>
      client.proposeCandidates({
        config: BASE_CONFIG,
        families: [BASE_FAMILY],
        marketCodes: ["KRW-BTC"],
        history: []
      }),
    /missing candidates array.*researchSummary, proposedFamilies/i
  );
});
