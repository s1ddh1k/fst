import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { getStrategyFamilies, normalizeCandidateProposal } from "../src/auto-research/catalog.js";
import {
  compileExperimentPlan,
  type ExperimentHintBatch
} from "../src/auto-research/experiment-compiler.js";
import type {
  AutoResearchRunConfig,
  CandidateBacktestEvaluation,
  NormalizedCandidateProposal,
  ProposalBatch,
  ResearchIterationRecord,
  StrategyFamilyDefinition
} from "../src/auto-research/types.js";

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
    ...overrides
  };
}

function buildEvaluation(
  candidate: NormalizedCandidateProposal,
  netReturn: number
): CandidateBacktestEvaluation {
  return {
    candidate,
    mode: "holdout",
    status: "completed",
    summary: {
      totalReturn: netReturn,
      grossReturn: netReturn + 0.01,
      netReturn,
      maxDrawdown: 0.05,
      turnover: 0.3,
      winRate: 0.5,
      avgHoldBars: 10,
      tradeCount: 4,
      feePaid: 10,
      slippagePaid: 15,
      rejectedOrdersCount: 0,
      cooldownSkipsCount: 0,
      signalCount: 6,
      ghostSignalCount: 12,
      bootstrapPValue: 0.04,
      bootstrapSignificant: true,
      randomPercentile: 0.93
    },
    diagnostics: {
      coverage: {
        tradeCount: 4,
        signalCount: 6,
        ghostSignalCount: 12,
        rejectedOrdersCount: 0,
        cooldownSkipsCount: 0,
        rawBuySignals: 10,
        rawSellSignals: 4,
        rawHoldSignals: 2,
        avgUniverseSize: 7.5,
        minUniverseSize: 5,
        maxUniverseSize: 10,
        avgConsideredBuys: 1.2,
        avgEligibleBuys: 0.8
      },
      reasons: {
        strategy: { trend_regime_not_aligned: 14 },
        strategyTags: {},
        coordinator: {},
        execution: {},
        risk: {}
      },
      costs: {
        feePaid: 10,
        slippagePaid: 15,
        totalCostsPaid: 25
      },
      robustness: {
        bootstrapPValue: 0.04,
        bootstrapSignificant: true,
        randomPercentile: 0.93
      },
      crossChecks: [],
      windows: {
        mode: "holdout",
        holdoutDays: 30,
        positiveWindowRatio: 0.75
      }
    }
  };
}

function midpointParameters(family: StrategyFamilyDefinition): Record<string, number> {
  return Object.fromEntries(
    family.parameterSpecs.map((spec) => [
      spec.name,
      Number(((spec.min + spec.max) / 2).toFixed(4))
    ])
  );
}

test("experiment compiler compiles hint batches into executable candidates with midpoint defaults", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-experiment-compiler-hints-"));
  const family = getStrategyFamilies(["relative-momentum-pullback"])[0]!;
  const [firstSpec] = family.parameterSpecs;

  const source: ExperimentHintBatch = {
    researchSummary: "compile deterministic hints",
    hints: [
      {
        familyId: family.familyId,
        thesis: "lean harder into pullback depth",
        parameters: {
          [firstSpec!.name]: firstSpec!.max
        }
      }
    ]
  };

  const plan = await compileExperimentPlan({
    source,
    config: buildConfig(outputDir, {
      strategyFamilyIds: [family.familyId],
      candidatesPerIteration: 1
    }),
    families: [family],
    history: [],
    iteration: 1
  });

  assert.equal(plan.sourceProposal.candidates[0]?.candidateId, `${family.familyId}-hint-01-01`);
  assert.equal(plan.sourceProposal.candidates[0]?.parameters[firstSpec!.name], firstSpec!.max);
  assert.deepEqual(
    Object.keys(plan.evaluationCandidates[0]!.parameters).sort(),
    family.parameterSpecs.map((spec) => spec.name).sort()
  );
});

test("experiment compiler warm-starts compiled plans with external artifact seeds", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-experiment-compiler-seeded-"));
  const artifactPath = path.join(outputDir, "seed-report.json");
  const family = getStrategyFamilies(["relative-momentum-pullback"])[0]!;
  const midpoint = midpointParameters(family);
  const highEdge = Object.fromEntries(
    family.parameterSpecs.map((spec) => [
      spec.name,
      Number((spec.min + (spec.max - spec.min) * 0.8).toFixed(4))
    ])
  );
  const lowEdge = Object.fromEntries(
    family.parameterSpecs.map((spec) => [
      spec.name,
      Number((spec.min + (spec.max - spec.min) * 0.2).toFixed(4))
    ])
  );
  const partialHighEdge = Object.fromEntries(Object.entries(highEdge).slice(0, 2));
  const partialLowEdge = Object.fromEntries(Object.entries(lowEdge).slice(0, 2));

  await writeFile(
    artifactPath,
    `${JSON.stringify(
      {
        familyId: family.familyId,
        walkForwardTop: [
          {
            candidateId: "artifact-top-01",
            familyId: family.familyId,
            parameters: partialHighEdge,
            netReturn: 0.04,
            maxDrawdown: 0.02,
            tradeCount: 18,
            positiveWindowRatio: 1
          },
          {
            candidateId: "artifact-top-02",
            familyId: family.familyId,
            parameters: partialLowEdge,
            netReturn: 0.03,
            maxDrawdown: 0.025,
            tradeCount: 14,
            positiveWindowRatio: 0.67
          }
        ]
      },
      null,
      2
    )}\n`
  );

  const source: ProposalBatch = {
    researchSummary: "one llm candidate",
    preparation: [],
    proposedFamilies: [],
    codeTasks: [],
    candidates: [
      {
        candidateId: "llm-only-01",
        familyId: family.familyId,
        thesis: "LLM midpoint candidate",
        parameters: midpoint,
        invalidationSignals: ["edge is weak"]
      }
    ]
  };

  const plan = await compileExperimentPlan({
    source,
    config: buildConfig(outputDir, {
      strategyFamilyIds: [family.familyId],
      candidatesPerIteration: 3,
      seedArtifactPaths: [artifactPath],
      seedCandidatesPerIteration: 2
    }),
    families: [family],
    history: [],
    iteration: 1
  });

  assert.equal(plan.stats.artifactSeedCount, 2);
  assert.equal(plan.augmentedProposal.candidates[0]?.origin, "artifact_seed");
  assert.equal(plan.augmentedProposal.candidates[1]?.origin, "artifact_seed");
  assert.equal(plan.augmentedProposal.candidates[2]?.candidateId, "llm-only-01");
});

test("experiment compiler stages confirm-family candidates from successful screen survivors", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-experiment-compiler-staged-"));
  const families = getStrategyFamilies([
    "multi-tf-regime-switch-screen",
    "multi-tf-regime-switch"
  ]);
  const screenFamily = families.find((family) => family.familyId === "multi-tf-regime-switch-screen")!;
  const confirmFamily = families.find((family) => family.familyId === "multi-tf-regime-switch")!;
  const screenCandidate = normalizeCandidateProposal(
    {
      candidateId: "screen-parent-01",
      familyId: screenFamily.familyId,
      thesis: "strong screen survivor",
      parameters: midpointParameters(screenFamily),
      invalidationSignals: ["confirm loses edge"]
    },
    families,
    0
  );
  const history: ResearchIterationRecord[] = [
    {
      iteration: 1,
      proposal: {
        researchSummary: "screen-only iteration",
        preparation: [],
        proposedFamilies: [],
        codeTasks: [],
        candidates: [
          {
            candidateId: screenCandidate.candidateId,
            familyId: screenCandidate.familyId,
            thesis: screenCandidate.thesis,
            parameters: screenCandidate.parameters,
            invalidationSignals: screenCandidate.invalidationSignals
          }
        ]
      },
      preparationResults: [],
      codeMutationResults: [],
      validationResults: [],
      evaluations: [buildEvaluation(screenCandidate, 0.04)],
      review: {
        summary: "keep searching",
        verdict: "keep_searching",
        nextPreparation: [],
        proposedFamilies: [],
        codeTasks: [],
        nextCandidates: [],
        retireCandidateIds: [],
        observations: []
      }
    }
  ];

  const plan = await compileExperimentPlan({
    source: {
      researchSummary: "screen follow-up",
      preparation: [],
      proposedFamilies: [],
      codeTasks: [],
      candidates: [
        {
          candidateId: "screen-proposal-02",
          familyId: screenFamily.familyId,
          thesis: "screen family proposal",
          parameters: midpointParameters(screenFamily),
          invalidationSignals: ["confirm loses edge"]
        }
      ]
    },
    config: buildConfig(outputDir, {
      strategyFamilyIds: [screenFamily.familyId],
      candidatesPerIteration: 2
    }),
    families,
    history,
    iteration: 2,
    hiddenFamilyIds: new Set([confirmFamily.familyId])
  });

  assert.ok(
    plan.engineCandidates.some((candidate) => candidate.familyId === confirmFamily.familyId)
  );
});

test("experiment compiler diversifies toward distant same-family candidates", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-experiment-compiler-diverse-"));
  const family = getStrategyFamilies(["relative-momentum-pullback"])[0]!;
  const specsByName = Object.fromEntries(
    family.parameterSpecs.map((spec) => [spec.name, spec])
  );
  const anchor = Object.fromEntries(
    family.parameterSpecs.map((spec) => [
      spec.name,
      Number((spec.min + (spec.max - spec.min) * 0.2).toFixed(4))
    ])
  );
  const near = {
    ...anchor,
    [family.parameterSpecs[0]!.name]: Number(
      (
        anchor[family.parameterSpecs[0]!.name] +
        (specsByName[family.parameterSpecs[0]!.name]!.max -
          specsByName[family.parameterSpecs[0]!.name]!.min) *
          0.02
      ).toFixed(4)
    )
  };
  const far = Object.fromEntries(
    family.parameterSpecs.map((spec) => [
      spec.name,
      Number((spec.min + (spec.max - spec.min) * 0.85).toFixed(4))
    ])
  );

  const plan = await compileExperimentPlan({
    source: {
      researchSummary: "same family, varied distances",
      preparation: [],
      proposedFamilies: [],
      codeTasks: [],
      candidates: [
        {
          candidateId: "candidate-a",
          familyId: family.familyId,
          thesis: "anchor candidate",
          parameters: anchor,
          invalidationSignals: ["none"]
        },
        {
          candidateId: "candidate-b",
          familyId: family.familyId,
          thesis: "near duplicate candidate",
          parameters: near,
          invalidationSignals: ["none"]
        },
        {
          candidateId: "candidate-c",
          familyId: family.familyId,
          thesis: "far candidate",
          parameters: far,
          invalidationSignals: ["none"]
        }
      ]
    },
    config: buildConfig(outputDir, {
      strategyFamilyIds: [family.familyId],
      candidatesPerIteration: 2,
      candidateDiversificationMinDistance: 0.2
    }),
    families: [family],
    history: [],
    iteration: 1
  });

  assert.deepEqual(
    plan.evaluationCandidates.map((candidate) => candidate.candidateId),
    ["candidate-a", "candidate-c"]
  );
});
