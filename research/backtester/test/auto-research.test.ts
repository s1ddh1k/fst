import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createAutoResearchOrchestrator,
  createComposedScoredStrategy,
  type AutoResearchRunConfig,
  type ResearchLlmClient,
  type CandidateBacktestEvaluation,
  type NormalizedCandidateProposal
} from "../src/auto-research/index.js";

function buildEvaluation(candidate: NormalizedCandidateProposal, netReturn: number): CandidateBacktestEvaluation {
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
        rawHoldSignals: 86,
        avgUniverseSize: 7.5,
        minUniverseSize: 5,
        maxUniverseSize: 10,
        avgConsideredBuys: 1.2,
        avgEligibleBuys: 0.8
      },
      reasons: {
        strategy: { trend_regime_not_aligned: 14 },
        strategyTags: { leader_strength_below_floor: 10 },
        coordinator: { ranked_out_by_single_position: 3 },
        execution: { below_min_order_notional: 1 },
        risk: { target_weight_zero: 0 }
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
      crossChecks: [
        {
          mode: "walk-forward",
          status: "completed",
          netReturn: netReturn - 0.01,
          maxDrawdown: 0.06,
          tradeCount: 3,
          bootstrapSignificant: true,
          randomPercentile: 0.88,
          windowCount: 4
        }
      ],
      windows: {
        mode: "holdout",
        holdoutDays: 365,
        trainStartAt: "2024-01-01T00:00:00.000Z",
        trainEndAt: "2024-12-31T00:00:00.000Z",
        testStartAt: "2025-01-01T00:00:00.000Z",
        testEndAt: "2025-12-31T00:00:00.000Z"
      }
    },
    rawSummary: {
      backtestRunId: 1,
      strategyName: candidate.strategyName,
      marketCode: "UNIVERSE:krw-top",
      timeframe: "1h",
      holdoutDays: 365,
      trainRange: { start: new Date("2024-01-01T00:00:00.000Z"), end: new Date("2024-12-31T00:00:00.000Z") },
      testRange: { start: new Date("2025-01-01T00:00:00.000Z"), end: new Date("2025-12-31T00:00:00.000Z") },
      train: {
        initialCapital: 1_000_000,
        finalCapital: 1_010_000,
        totalReturn: 0.01,
        grossReturn: 0.01,
        netReturn: 0.01,
        maxDrawdown: 0.03,
        tradeCount: 4,
        winRate: 0.5,
        turnover: 0.2,
        avgHoldBars: 8,
        feePaid: 10,
        slippagePaid: 10,
        rejectedOrdersCount: 0,
        cooldownSkipsCount: 0
      },
      test: {
        initialCapital: 1_000_000,
        finalCapital: 1_015_000,
        totalReturn: netReturn,
        grossReturn: netReturn,
        netReturn,
        maxDrawdown: 0.05,
        tradeCount: 4,
        winRate: 0.5,
        turnover: 0.3,
        avgHoldBars: 10,
        feePaid: 10,
        slippagePaid: 15,
        rejectedOrdersCount: 0,
        cooldownSkipsCount: 0
      },
      parameters: candidate.parameters,
      scoredTrain: {} as never,
      scoredTest: {
        signalCount: 6,
        ghostSignalCount: 12,
        bootstrap: { pValue: 0.04, isSignificant: true },
        randomBenchmark: { percentileVsRandom: 0.93 }
      } as never
    }
  };
}

test("auto research orchestrator iterates, writes artifacts, and promotes best candidate", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-auto-research-"));
  let proposeCalls = 0;

  const llmClient: ResearchLlmClient = {
    async proposeCandidates() {
      proposeCalls += 1;
      return {
        researchSummary: "test iteration proposal",
        preparation: [],
        proposedFamilies: [
          {
            familyId: "momentum-reacceleration-v1",
            title: "Momentum Reacceleration",
            thesis: "new family proposal",
            timeframe: "1h",
            baseFamilyId: "relative-momentum-pullback",
            basedOnFamilies: ["relative-momentum-pullback"],
            parameterSpecs: [
              {
                name: "minStrengthPct",
                description: "relative strength floor",
                min: 0.6,
                max: 0.95
              },
              {
                name: "minRiskOn",
                description: "risk on threshold",
                min: -0.05,
                max: 0.35
              },
              {
                name: "pullbackZ",
                description: "pullback z threshold",
                min: 0.4,
                max: 1.8
              },
              {
                name: "trailAtrMult",
                description: "trail multiple",
                min: 1.2,
                max: 3.2
              }
            ],
            requiredData: ["1h"],
            implementationNotes: ["implement later"]
          }
        ],
        codeTasks: [
          {
            title: "investigate signal collapse bug",
            intent: "fix_bug",
            rationale: "test code task",
            acceptanceCriteria: ["artifact exists"],
            targetFiles: ["research/backtester/src/backtest/BacktestEngine.ts"],
            prompt: "inspect and fix signal collapse bug"
          }
        ],
        candidates: [
          {
            familyId: "momentum-reacceleration-v1",
            thesis: "buy strong pullbacks",
            parameters: {
              minStrengthPct: 0.8,
              minRiskOn: 0.1,
              pullbackZ: 0.9,
              trailAtrMult: 2.2
            },
            invalidationSignals: ["few trades"]
          }
        ]
      };
    },
    async reviewIteration({ evaluations }) {
      return {
        summary: "promote winner",
        verdict: "promote_candidate",
        promotedCandidateId: evaluations[0]?.candidate.candidateId,
        nextPreparation: [],
        proposedFamilies: [],
        codeTasks: [],
        nextCandidates: [],
        retireCandidateIds: [],
        observations: ["looks good"]
      };
    }
  };

  const orchestrator = createAutoResearchOrchestrator({
    llmClient,
    async evaluateCandidate({ candidate }) {
      return buildEvaluation(candidate, 0.12);
    },
    async prepareActions() {
      return [];
    },
    codeAgent: {
      async execute() {
        return [];
      }
    }
  });

  const report = await orchestrator.run({
    universeName: "krw-top",
    timeframe: "1h",
    marketLimit: 5,
    limit: 2000,
    holdoutDays: 180,
    iterations: 2,
    candidatesPerIteration: 2,
    mode: "holdout",
    outputDir,
    allowDataCollection: false,
    allowFeatureCacheBuild: false,
    allowCodeMutation: false
  });

  assert.equal(proposeCalls, 1);
  assert.equal(report.iterations.length, 1);
  assert.equal(report.bestCandidate?.summary.netReturn, 0.12);
  assert.equal(report.bestTradeCandidate?.summary.tradeCount, 4);
  assert.ok(report.catalog.some((entry) => entry.familyId === "momentum-reacceleration-v1"));

  const savedReport = JSON.parse(await readFile(path.join(outputDir, "report.json"), "utf8"));
  const savedCatalog = JSON.parse(await readFile(path.join(outputDir, "catalog.json"), "utf8"));
  const savedCatalogSummary = JSON.parse(await readFile(path.join(outputDir, "catalog-summary.json"), "utf8"));
  const savedIteration = JSON.parse(
    await readFile(path.join(outputDir, "iteration-01.json"), "utf8")
  );
  const savedStatus = JSON.parse(await readFile(path.join(outputDir, "status.json"), "utf8"));
  const savedLeaderboard = JSON.parse(await readFile(path.join(outputDir, "leaderboard.json"), "utf8"));
  const savedRunLog = await readFile(path.join(outputDir, "run.log"), "utf8");
  const savedHtml = await readFile(path.join(outputDir, "report.html"), "utf8");

  assert.ok(savedCatalog.some((entry: { familyId: string }) => entry.familyId === "momentum-reacceleration-v1"));
  assert.ok(savedCatalogSummary.totals.families >= 1);
  assert.equal(savedReport.bestCandidate.candidate.familyId, "momentum-reacceleration-v1");
  assert.match(savedIteration.review.summary, /promote winner/);
  assert.equal(savedStatus.phase, "completed");
  assert.equal(savedLeaderboard[0].candidateId, "momentum-reacceleration-v1-01");
  assert.match(savedRunLog, /auto-research/);
  assert.match(savedHtml, /Leaderboard/);
  assert.match(savedHtml, /Cross-Checks/);
});

test("auto research fallback review diversifies next candidates instead of cloning the same proposal", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-auto-research-fallback-review-"));

  const llmClient: ResearchLlmClient = {
    async proposeCandidates() {
      return {
        researchSummary: "proposal before review failure",
        preparation: [],
        proposedFamilies: [],
        codeTasks: [],
        candidates: [
          {
            candidateId: "rmp-base",
            familyId: "relative-momentum-pullback",
            thesis: "first",
            parameters: {
              minStrengthPct: 0.8,
              minRiskOn: 0.1,
              pullbackZ: 0.9,
              trailAtrMult: 2.2
            },
            invalidationSignals: []
          },
          {
            candidateId: "lpsm-base",
            familyId: "leader-pullback-state-machine",
            thesis: "second",
            parameters: {
              strengthFloor: 0.7,
              pullbackAtr: 0.9,
              setupExpiryBars: 4,
              trailAtrMult: 2.2
            },
            invalidationSignals: []
          }
        ]
      };
    },
    async reviewIteration() {
      throw new Error("synthetic review outage");
    }
  };

  const orchestrator = createAutoResearchOrchestrator({
    llmClient,
    async evaluateCandidate({ candidate }) {
      return buildEvaluation(candidate, candidate.familyId === "leader-pullback-state-machine" ? 0.07 : 0.03);
    },
    async prepareActions() {
      return [];
    },
    codeAgent: {
      async execute() {
        return [];
      }
    }
  });

  const report = await orchestrator.run({
    universeName: "krw-top",
    timeframe: "1h",
    marketLimit: 5,
    limit: 2000,
    holdoutDays: 180,
    iterations: 1,
    candidatesPerIteration: 2,
    mode: "holdout",
    outputDir,
    allowDataCollection: false,
    allowFeatureCacheBuild: false,
    allowCodeMutation: false
  });

  const review = report.iterations[0]?.review;
  assert.equal(review?.verdict, "keep_searching");
  assert.equal(review?.nextCandidates.length, 2);
  assert.match(review?.observations[0] ?? "", /diversified fallback candidates/);
  assert.ok(review?.nextCandidates.every((candidate) => /fallback-01-0[12]/.test(candidate.candidateId ?? "")));
  assert.ok(review?.nextCandidates.some((candidate) => candidate.familyId === "leader-pullback-state-machine"));
});

test("auto research persists raw rows separately even when repeat suggestions are novelized", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-auto-research-unique-board-"));
  let reviewCalls = 0;

  const llmClient: ResearchLlmClient = {
    async proposeCandidates() {
      return {
        researchSummary: "repeat one candidate across iterations",
        preparation: [],
        proposedFamilies: [],
        codeTasks: [],
        candidates: [
          {
            candidateId: "repeat-rmp",
            familyId: "relative-momentum-pullback",
            thesis: "repeat candidate",
            parameters: {
              minStrengthPct: 0.8,
              minRiskOn: 0.1,
              pullbackZ: 0.9,
              trailAtrMult: 2.2
            },
            invalidationSignals: []
          }
        ]
      };
    },
    async reviewIteration() {
      reviewCalls += 1;
      return {
        summary: "repeat same candidate again",
        verdict: "keep_searching",
        nextPreparation: [],
        proposedFamilies: [],
        codeTasks: [],
        nextCandidates: [
          {
            candidateId: "repeat-rmp",
            familyId: "relative-momentum-pullback",
            thesis: "repeat candidate",
            parameters: {
              minStrengthPct: 0.8,
              minRiskOn: 0.1,
              pullbackZ: 0.9,
              trailAtrMult: 2.2
            },
            invalidationSignals: []
          }
        ],
        retireCandidateIds: [],
        observations: []
      };
    }
  };

  const orchestrator = createAutoResearchOrchestrator({
    llmClient,
    async evaluateCandidate({ candidate }) {
      return buildEvaluation(candidate, 0.04);
    },
    async prepareActions() {
      return [];
    },
    codeAgent: {
      async execute() {
        return [];
      }
    }
  });

  await orchestrator.run({
    universeName: "krw-top",
    timeframe: "1h",
    marketLimit: 5,
    limit: 2000,
    holdoutDays: 180,
    iterations: 2,
    candidatesPerIteration: 1,
    mode: "holdout",
    outputDir,
    allowDataCollection: false,
    allowFeatureCacheBuild: false,
    allowCodeMutation: false
  });

  assert.equal(reviewCalls, 2);

  const uniqueLeaderboard = JSON.parse(await readFile(path.join(outputDir, "leaderboard.json"), "utf8"));
  const rawLeaderboard = JSON.parse(await readFile(path.join(outputDir, "leaderboard.raw.json"), "utf8"));
  const savedHtml = await readFile(path.join(outputDir, "report.html"), "utf8");

  assert.equal(uniqueLeaderboard.length, 2);
  assert.equal(rawLeaderboard.length, 2);
  assert.notEqual(uniqueLeaderboard[0].candidateId, uniqueLeaderboard[1].candidateId);
  assert.match(savedHtml, /Unique Leaderboard/);
  assert.match(savedHtml, /Raw Leaderboard/);
});

test("auto research novelizes repeated historical candidates and persists family artifacts", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-auto-research-novelize-"));

  const llmClient: ResearchLlmClient = {
    async proposeCandidates() {
      return {
        researchSummary: "repeat candidate across iterations",
        preparation: [],
        proposedFamilies: [],
        codeTasks: [],
        candidates: [
          {
            candidateId: "repeat-lpsm",
            familyId: "leader-pullback-state-machine",
            thesis: "repeat leader pullback",
            parameters: {
              strengthFloor: 0.7,
              pullbackAtr: 0.9,
              setupExpiryBars: 4,
              trailAtrMult: 2.2
            },
            invalidationSignals: []
          }
        ]
      };
    },
    async reviewIteration() {
      return {
        summary: "repeat it again",
        verdict: "keep_searching",
        nextPreparation: [],
        proposedFamilies: [],
        codeTasks: [],
        nextCandidates: [
          {
            candidateId: "repeat-lpsm",
            familyId: "leader-pullback-state-machine",
            thesis: "repeat leader pullback",
            parameters: {
              strengthFloor: 0.7,
              pullbackAtr: 0.9,
              setupExpiryBars: 4,
              trailAtrMult: 2.2
            },
            invalidationSignals: []
          }
        ],
        retireCandidateIds: [],
        observations: []
      };
    }
  };

  const orchestrator = createAutoResearchOrchestrator({
    llmClient,
    async evaluateCandidate({ candidate }) {
      return buildEvaluation(candidate, candidate.parameters.pullbackAtr > 0.9 ? 0.05 : 0.03);
    },
    async prepareActions() {
      return [];
    },
    codeAgent: {
      async execute() {
        return [];
      }
    }
  });

  const report = await orchestrator.run({
    universeName: "krw-top",
    timeframe: "1h",
    marketLimit: 5,
    limit: 2000,
    holdoutDays: 180,
    iterations: 2,
    candidatesPerIteration: 1,
    mode: "holdout",
    outputDir,
    allowDataCollection: false,
    allowFeatureCacheBuild: false,
    allowCodeMutation: false
  });

  assert.equal(report.iterations.length, 2);
  assert.equal(report.iterations[0]?.evaluations[0]?.candidate.parameters.pullbackAtr, 0.9);
  assert.notEqual(
    JSON.stringify(report.iterations[1]?.evaluations[0]?.candidate.parameters),
    JSON.stringify(report.iterations[0]?.evaluations[0]?.candidate.parameters)
  );
  assert.match(report.iterations[1]?.evaluations[0]?.candidate.candidateId ?? "", /novel-02/);

  const ledger = JSON.parse(await readFile(path.join(outputDir, "candidate-ledger.json"), "utf8"));
  const familySummary = JSON.parse(await readFile(path.join(outputDir, "family-summary.json"), "utf8"));
  const html = await readFile(path.join(outputDir, "report.html"), "utf8");

  assert.equal(ledger.length, 2);
  assert.equal(familySummary[0].familyId, "leader-pullback-state-machine");
  assert.match(html, /Family Summary/);
  assert.match(html, /Candidate Ledger/);
});

test("auto research prefers family diversity when selecting candidates for evaluation", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-auto-research-diversity-"));
  const seenFamilies: string[] = [];

  const llmClient: ResearchLlmClient = {
    async proposeCandidates() {
      return {
        researchSummary: "prefer one candidate per family first",
        preparation: [],
        proposedFamilies: [],
        codeTasks: [],
        candidates: [
          {
            familyId: "leader-pullback-state-machine",
            thesis: "leader idea A",
            parameters: {
              strengthFloor: 0.7,
              pullbackAtr: 0.7,
              setupExpiryBars: 4,
              trailAtrMult: 2.2
            },
            invalidationSignals: []
          },
          {
            familyId: "leader-pullback-state-machine",
            thesis: "leader idea B",
            parameters: {
              strengthFloor: 0.8,
              pullbackAtr: 0.8,
              setupExpiryBars: 4,
              trailAtrMult: 2.2
            },
            invalidationSignals: []
          },
          {
            familyId: "momentum-reacceleration",
            thesis: "momentum idea",
            parameters: {
              strengthFloor: 0.72,
              minRiskOn: 0.1,
              resetRsiFloor: 52,
              trailAtrMult: 2.0
            },
            invalidationSignals: []
          }
        ]
      };
    },
    async reviewIteration() {
      return {
        summary: "stop",
        verdict: "stop_no_edge",
        nextPreparation: [],
        proposedFamilies: [],
        codeTasks: [],
        nextCandidates: [],
        retireCandidateIds: [],
        observations: []
      };
    }
  };

  const orchestrator = createAutoResearchOrchestrator({
    llmClient,
    async evaluateCandidate({ candidate }) {
      seenFamilies.push(candidate.familyId);
      return buildEvaluation(candidate, 0.01);
    },
    async prepareActions() {
      return [];
    },
    codeAgent: {
      async execute() {
        return [];
      }
    }
  });

  await orchestrator.run({
    universeName: "krw-top",
    timeframe: "1h",
    marketLimit: 5,
    limit: 2000,
    holdoutDays: 180,
    iterations: 1,
    candidatesPerIteration: 2,
    mode: "holdout",
    outputDir,
    allowDataCollection: false,
    allowFeatureCacheBuild: false,
    allowCodeMutation: false
  });

  assert.deepEqual(seenFamilies.sort(), ["leader-pullback-state-machine", "momentum-reacceleration"].sort());
});

test("composed scored strategy combines component votes and parameter bindings", () => {
  const seenParameters: Record<string, number>[] = [];
  const strategy = createComposedScoredStrategy({
    name: "composed:test",
    parameters: {
      sharedStrength: 0.78,
      sharedTrail: 2.4
    },
    composition: {
      mode: "weighted_vote",
      buyThreshold: 0.5,
      sellThreshold: 0.5,
      components: [
        {
          familyId: "leader-pullback-state-machine",
          strategyName: "leader-pullback-state-machine",
          weight: 1,
          parameterBindings: {
            strengthFloor: "sharedStrength",
            trailAtrMult: "sharedTrail"
          }
        },
        {
          familyId: "momentum-reacceleration",
          strategyName: "momentum-reacceleration",
          weight: 0.8,
          parameterBindings: {
            strengthFloor: "sharedStrength"
          }
        }
      ]
    },
    createComponent(strategyName, parameters) {
      seenParameters.push(parameters ?? {});
      return {
        name: strategyName,
        parameters: parameters ?? {},
        parameterCount: Object.keys(parameters ?? {}).length,
        generateSignal() {
          return {
            signal: "BUY",
            conviction: strategyName === "leader-pullback-state-machine" ? 0.9 : 0.7
          };
        }
      };
    }
  });

  const result = strategy.generateSignal({
    candles: [],
    index: 0,
    hasPosition: false
  });

  assert.equal(result.signal, "BUY");
  assert.ok(result.conviction > 0.5);
  assert.equal(seenParameters[0]?.strengthFloor, 0.78);
  assert.equal(seenParameters[0]?.trailAtrMult, 2.4);
  assert.equal(seenParameters[1]?.strengthFloor, 0.78);
});

test("auto research proposed composed family becomes executable in the same iteration", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-auto-research-composed-family-"));
  const seenCandidates: NormalizedCandidateProposal[] = [];

  const llmClient: ResearchLlmClient = {
    async proposeCandidates() {
      return {
        researchSummary: "propose a composed family",
        preparation: [],
        proposedFamilies: [
          {
            familyId: "leader-confirmed-reacceleration",
            title: "Leader Confirmed Reacceleration",
            thesis: "Require leader pullback plus reset confirmation.",
            timeframe: "1h",
            basedOnFamilies: ["leader-pullback-state-machine", "momentum-reacceleration"],
            parameterSpecs: [
              {
                name: "sharedStrength",
                description: "shared leader strength floor",
                min: 0.6,
                max: 0.9
              },
              {
                name: "sharedTrail",
                description: "shared trail ATR multiplier",
                min: 1.5,
                max: 3
              }
            ],
            requiredData: ["1h"],
            implementationNotes: ["compose existing executable families"],
            composition: {
              mode: "weighted_vote",
              buyThreshold: 0.55,
              sellThreshold: 0.55,
              components: [
                {
                  familyId: "leader-pullback-state-machine",
                  weight: 1,
                  parameterBindings: {
                    strengthFloor: "sharedStrength",
                    trailAtrMult: "sharedTrail"
                  }
                },
                {
                  familyId: "momentum-reacceleration",
                  weight: 0.8,
                  parameterBindings: {
                    strengthFloor: "sharedStrength",
                    trailAtrMult: "sharedTrail"
                  }
                }
              ]
            }
          }
        ],
        codeTasks: [],
        candidates: [
          {
            familyId: "leader-confirmed-reacceleration",
            thesis: "composed family candidate",
            parameters: {
              sharedStrength: 0.78,
              sharedTrail: 2.2
            },
            invalidationSignals: []
          }
        ]
      };
    },
    async reviewIteration() {
      return {
        summary: "stop",
        verdict: "stop_no_edge",
        nextPreparation: [],
        proposedFamilies: [],
        codeTasks: [],
        nextCandidates: [],
        retireCandidateIds: [],
        observations: []
      };
    }
  };

  const orchestrator = createAutoResearchOrchestrator({
    llmClient,
    async evaluateCandidate({ candidate }) {
      seenCandidates.push(candidate);
      return buildEvaluation(candidate, 0.02);
    },
    async prepareActions() {
      return [];
    },
    codeAgent: {
      async execute() {
        return [];
      }
    }
  });

  await orchestrator.run({
    universeName: "krw-top",
    timeframe: "1h",
    marketLimit: 5,
    limit: 2000,
    holdoutDays: 180,
    iterations: 1,
    candidatesPerIteration: 1,
    mode: "walk-forward",
    outputDir,
    allowDataCollection: false,
    allowFeatureCacheBuild: false,
    allowCodeMutation: false
  });

  assert.equal(seenCandidates[0]?.familyId, "leader-confirmed-reacceleration");
  assert.equal(seenCandidates[0]?.strategyName, "composed:leader-confirmed-reacceleration");
  assert.equal(seenCandidates[0]?.composition?.components.length, 2);
});

test("auto research reflects executed code mutations into catalog using runtime discovery", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-auto-research-runtime-discovery-"));

  const llmClient: ResearchLlmClient = {
    async proposeCandidates() {
      return {
        researchSummary: "code mutation should add a new family",
        preparation: [],
        proposedFamilies: [
          {
            familyId: "new-llm-family",
            title: "New LLM Family",
            thesis: "created by code task",
            timeframe: "1h",
            basedOnFamilies: [],
            parameterSpecs: [
              {
                name: "minStrengthPct",
                description: "strength floor",
                min: 0.6,
                max: 0.9
              }
            ],
            requiredData: ["1h"],
            implementationNotes: ["implemented by code task"]
          }
        ],
        codeTasks: [
          {
            taskId: "impl-new-family",
            familyId: "new-llm-family",
            strategyName: "new-llm-family",
            title: "implement new llm family",
            intent: "implement_strategy",
            rationale: "needed for runtime discovery test",
            acceptanceCriteria: ["family is visible in runtime registry"],
            targetFiles: ["research/strategies/src/new-llm-family.ts"],
            prompt: "add strategy"
          }
        ],
        candidates: [
          {
            familyId: "relative-momentum-pullback",
            thesis: "baseline",
            parameters: {
              minStrengthPct: 0.8,
              minRiskOn: 0.1,
              pullbackZ: 0.9,
              trailAtrMult: 2.2
            },
            invalidationSignals: []
          }
        ]
      };
    },
    async reviewIteration() {
      return {
        summary: "stop",
        verdict: "stop_no_edge",
        nextPreparation: [],
        proposedFamilies: [],
        codeTasks: [],
        nextCandidates: [],
        retireCandidateIds: [],
        observations: []
      };
    }
  };

  const orchestrator = createAutoResearchOrchestrator({
    llmClient,
    async evaluateCandidate({ candidate }) {
      return buildEvaluation(candidate, 0.01);
    },
    async prepareActions() {
      return [];
    },
    codeAgent: {
      async execute({ tasks }) {
        return tasks.map((task) => ({
          task,
          status: "executed" as const,
          detail: "implemented"
        }));
      }
    },
    async discoverRuntimeScoredStrategies() {
      return [
        "relative-momentum-pullback",
        "leader-pullback-state-machine",
        "momentum-reacceleration",
        "new-llm-family"
      ];
    }
  });

  const report = await orchestrator.run({
    universeName: "krw-top",
    timeframe: "1h",
    marketLimit: 5,
    limit: 2000,
    holdoutDays: 180,
    iterations: 1,
    candidatesPerIteration: 1,
    mode: "walk-forward",
    outputDir,
    allowDataCollection: false,
    allowFeatureCacheBuild: false,
    allowCodeMutation: true
  });

  const discoveredFamily = report.catalog.find((entry) => entry.familyId === "new-llm-family");
  const catalogSummary = JSON.parse(await readFile(path.join(outputDir, "catalog-summary.json"), "utf8"));

  assert.equal(discoveredFamily?.state, "implemented");
  assert.equal(discoveredFamily?.strategyName, "new-llm-family");
  assert.ok(catalogSummary.families.some((entry: { familyId: string }) => entry.familyId === "new-llm-family"));
});

test("auto research run lock prevents concurrent writes to the same output dir", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-auto-research-lock-"));

  const llmClient: ResearchLlmClient = {
    async proposeCandidates() {
      return {
        researchSummary: "lock test",
        preparation: [],
        proposedFamilies: [],
        codeTasks: [],
        candidates: [
          {
            familyId: "relative-momentum-pullback",
            thesis: "lock candidate",
            parameters: {
              minStrengthPct: 0.8,
              minRiskOn: 0.1,
              pullbackZ: 0.9,
              trailAtrMult: 2.2
            },
            invalidationSignals: []
          }
        ]
      };
    },
    async reviewIteration() {
      return {
        summary: "stop",
        verdict: "stop_no_edge",
        nextPreparation: [],
        proposedFamilies: [],
        codeTasks: [],
        nextCandidates: [],
        retireCandidateIds: [],
        observations: []
      };
    }
  };

  const orchestrator = createAutoResearchOrchestrator({
    llmClient,
    async evaluateCandidate({ candidate }) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return buildEvaluation(candidate, 0.01);
    },
    async prepareActions() {
      return [];
    },
    codeAgent: {
      async execute() {
        return [];
      }
    }
  });

  const firstRun = orchestrator.run({
    universeName: "krw-top",
    timeframe: "1h",
    marketLimit: 5,
    limit: 2000,
    holdoutDays: 180,
    iterations: 1,
    candidatesPerIteration: 1,
    mode: "holdout",
    outputDir,
    allowDataCollection: false,
    allowFeatureCacheBuild: false,
    allowCodeMutation: false
  });

  await new Promise((resolve) => setTimeout(resolve, 20));

  await assert.rejects(
    orchestrator.run({
      universeName: "krw-top",
      timeframe: "1h",
      marketLimit: 5,
      limit: 2000,
      holdoutDays: 180,
      iterations: 1,
      candidatesPerIteration: 1,
      mode: "holdout",
      outputDir,
      allowDataCollection: false,
      allowFeatureCacheBuild: false,
      allowCodeMutation: false
    }),
    /already active/
  );

  await firstRun;
});

test("auto research resume continues from saved run-state", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-auto-research-resume-"));
  let proposeCalls = 0;

  const llmClient: ResearchLlmClient = {
    async proposeCandidates() {
      proposeCalls += 1;
      return {
        researchSummary: `proposal-${proposeCalls}`,
        preparation: [],
        proposedFamilies: [],
        codeTasks: [],
        candidates: [
          {
            familyId: "relative-momentum-pullback",
            thesis: "resume candidate",
            parameters: {
              minStrengthPct: 0.8,
              minRiskOn: 0.1,
              pullbackZ: 0.9,
              trailAtrMult: 2.2
            },
            invalidationSignals: ["none"]
          }
        ]
      };
    },
    async reviewIteration({ evaluations }) {
      return {
        summary: `review-${evaluations[0]?.candidate.candidateId ?? "none"}`,
        verdict: "keep_searching",
        promotedCandidateId: undefined,
        nextPreparation: [],
        proposedFamilies: [],
        codeTasks: [],
        nextCandidates: [
          {
            familyId: "relative-momentum-pullback",
            thesis: "next",
            parameters: {
              minStrengthPct: 0.82,
              minRiskOn: 0.1,
              pullbackZ: 1.0,
              trailAtrMult: 2.2
            },
            invalidationSignals: ["none"]
          }
        ],
        retireCandidateIds: [],
        observations: []
      };
    }
  };

  const orchestrator = createAutoResearchOrchestrator({
    llmClient,
    async evaluateCandidate({ candidate }) {
      return buildEvaluation(candidate, 0.01);
    },
    async prepareActions() {
      return [];
    },
    codeAgent: {
      async execute() {
        return [];
      }
    }
  });

  await orchestrator.run({
    universeName: "krw-top",
    timeframe: "1h",
    marketLimit: 5,
    limit: 2000,
    holdoutDays: 180,
    iterations: 1,
    candidatesPerIteration: 1,
    mode: "holdout",
    outputDir,
    allowDataCollection: false,
    allowFeatureCacheBuild: false,
    allowCodeMutation: false,
    maxNoTradeIterations: 0
  });

  const resumed = await orchestrator.run({
    universeName: "krw-top",
    timeframe: "1h",
    marketLimit: 5,
    limit: 2000,
    holdoutDays: 180,
    iterations: 2,
    candidatesPerIteration: 1,
    mode: "holdout",
    outputDir,
    resumeFrom: outputDir,
    allowDataCollection: false,
    allowFeatureCacheBuild: false,
    allowCodeMutation: false,
    maxNoTradeIterations: 0
  });

  assert.equal(resumed.iterations.length, 2);
  assert.equal(proposeCalls, 1);
  const resumedStatus = JSON.parse(await readFile(path.join(outputDir, "status.json"), "utf8"));
  const resumedLog = await readFile(path.join(outputDir, "run.log"), "utf8");
  assert.equal(resumedStatus.phase, "completed");
  assert.match(resumedLog, /iteration 2\/2/);
});

test("auto research resume reuses saved run configuration when flags are omitted", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-auto-research-resume-config-"));

  const llmClient: ResearchLlmClient = {
    async proposeCandidates() {
      return {
        researchSummary: "proposal",
        preparation: [],
        proposedFamilies: [],
        codeTasks: [],
        candidates: [
          {
            familyId: "relative-momentum-pullback",
            thesis: "resume config candidate",
            parameters: {
              minStrengthPct: 0.8,
              minRiskOn: 0.1,
              pullbackZ: 0.9,
              trailAtrMult: 2.2
            },
            invalidationSignals: []
          }
        ]
      };
    },
    async reviewIteration() {
      return {
        summary: "keep",
        verdict: "keep_searching",
        nextPreparation: [],
        proposedFamilies: [],
        codeTasks: [],
        nextCandidates: [
          {
            familyId: "relative-momentum-pullback",
            thesis: "resume config candidate next",
            parameters: {
              minStrengthPct: 0.81,
              minRiskOn: 0.1,
              pullbackZ: 1.0,
              trailAtrMult: 2.2
            },
            invalidationSignals: []
          }
        ],
        retireCandidateIds: [],
        observations: []
      };
    }
  };

  const seenConfigs: AutoResearchRunConfig[] = [];
  const orchestrator = createAutoResearchOrchestrator({
    llmClient,
    async evaluateCandidate({ candidate, config }) {
      seenConfigs.push(config);
      return buildEvaluation(candidate, 0.02);
    },
    async prepareActions() {
      return [];
    },
    codeAgent: {
      async execute() {
        return [];
      }
    }
  });

  await orchestrator.run({
    universeName: "krw-top",
    timeframe: "1h",
    marketLimit: 7,
    limit: 12000,
    holdoutDays: 180,
    iterations: 1,
    candidatesPerIteration: 1,
    mode: "holdout",
    outputDir,
    allowDataCollection: false,
    allowFeatureCacheBuild: true,
    allowCodeMutation: false,
    maxNoTradeIterations: 0
  });

  await orchestrator.run({
    universeName: "krw-top",
    timeframe: "1h",
    marketLimit: 5,
    limit: 500,
    holdoutDays: 365,
    iterations: 2,
    candidatesPerIteration: 3,
    mode: "holdout",
    outputDir,
    resumeFrom: outputDir,
    allowDataCollection: false,
    allowFeatureCacheBuild: false,
    allowCodeMutation: false,
    maxNoTradeIterations: 0
  });

  assert.equal(seenConfigs.length, 2);
  assert.equal(seenConfigs[1].marketLimit, 7);
  assert.equal(seenConfigs[1].limit, 12000);
  assert.equal(seenConfigs[1].holdoutDays, 180);
});

test("auto research converts evaluation failures into structured artifacts instead of crashing", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "fst-auto-research-failure-"));

  const llmClient: ResearchLlmClient = {
    async proposeCandidates() {
      return {
        researchSummary: "failure path proposal",
        preparation: [],
        proposedFamilies: [],
        codeTasks: [],
        candidates: [
          {
            familyId: "relative-momentum-pullback",
            thesis: "failure candidate",
            parameters: {
              minStrengthPct: 0.8,
              minRiskOn: 0.1,
              pullbackZ: 0.9,
              trailAtrMult: 2.2
            },
            invalidationSignals: []
          }
        ]
      };
    },
    async reviewIteration({ evaluations }) {
      assert.equal(evaluations[0]?.status, "failed");
      assert.match(evaluations[0]?.failure?.message ?? "", /split/i);
      return {
        summary: "stop on structured failure",
        verdict: "stop_no_edge",
        nextPreparation: [],
        proposedFamilies: [],
        codeTasks: [],
        nextCandidates: [],
        retireCandidateIds: [],
        observations: ["structured failure observed"]
      };
    }
  };

  const orchestrator = createAutoResearchOrchestrator({
    llmClient,
    async evaluateCandidate() {
      throw new Error("Split produced too few candles for train or test");
    },
    async prepareActions() {
      return [];
    },
    codeAgent: {
      async execute() {
        return [];
      }
    }
  });

  const report = await orchestrator.run({
    universeName: "krw-top",
    timeframe: "1h",
    marketLimit: 5,
    limit: 2000,
    holdoutDays: 180,
    iterations: 1,
    candidatesPerIteration: 1,
    mode: "holdout",
    outputDir,
    allowDataCollection: false,
    allowFeatureCacheBuild: false,
    allowCodeMutation: false
  });

  assert.equal(report.iterations.length, 1);
  assert.equal(report.iterations[0]?.evaluations[0]?.status, "failed");
  const savedIteration = JSON.parse(await readFile(path.join(outputDir, "iteration-01.json"), "utf8"));
  assert.equal(savedIteration.evaluations[0].status, "failed");
  assert.match(savedIteration.evaluations[0].failure.message, /split/i);
});
