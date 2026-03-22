import test from "node:test";
import assert from "node:assert/strict";
import {
  buildBlockReviewPrompt,
  buildPortfolioCompositionReviewPrompt,
  buildReviewPrompt,
  type AutoResearchRunConfig,
  type ProposalBatch,
  type StrategyFamilyDefinition,
  type ValidatedBlockCatalog
} from "../src/auto-research/index.js";

const BASE_CONFIG: AutoResearchRunConfig = {
  universeName: "krw-top",
  timeframe: "1h",
  marketLimit: 5,
  limit: 500,
  holdoutDays: 30,
  trainingDays: 60,
  stepDays: 30,
  iterations: 2,
  candidatesPerIteration: 3,
  parallelism: 2,
  mode: "walk-forward",
  llmProvider: "codex",
  llmModel: "medium",
  llmTimeoutMs: 120000,
  outputDir: "/tmp/fst-prompt-builder-test",
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

const BASE_PROPOSAL: ProposalBatch = {
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
};

const BASE_BLOCK_CATALOG: ValidatedBlockCatalog = {
  generatedAt: "2026-03-21T00:00:00.000Z",
  universeName: "krw-top",
  mode: "walk-forward",
  blocks: []
};

function assertPromptFrontAndBack(prompt: string): void {
  const frontNeedle = 'Choose "keep_searching" when you can provide 1 to 3 concrete nextCandidates.';
  const backNeedle = "Final response reminder: when verdict=keep_searching, fill nextCandidates with unique, executable candidates.";
  const factsNeedle = "Structured run facts:";

  const frontIndex = prompt.indexOf(frontNeedle);
  const factsIndex = prompt.indexOf(factsNeedle);
  const backIndex = prompt.lastIndexOf(backNeedle);

  assert.notEqual(frontIndex, -1);
  assert.notEqual(backIndex, -1);
  assert.notEqual(factsIndex, -1);
  assert.ok(frontIndex < factsIndex);
  assert.ok(backIndex > factsIndex);
}

test("review prompts place nextCandidates contract at the front and the end", () => {
  const common = {
    config: BASE_CONFIG,
    families: [BASE_FAMILY],
    history: [],
    latestProposal: BASE_PROPOSAL,
    preparationResults: [],
    codeMutationResults: [],
    validationResults: [],
    evaluations: []
  };

  assertPromptFrontAndBack(buildReviewPrompt(common));
  assertPromptFrontAndBack(buildBlockReviewPrompt(common));
  assertPromptFrontAndBack(buildPortfolioCompositionReviewPrompt({
    ...common,
    blockCatalog: BASE_BLOCK_CATALOG
  }));
});
