import type { StrategyTimeframe } from "../../../../packages/shared/src/index.js";
import type { HoldoutBacktestSummary, WalkForwardBacktestSummary } from "../types.js";

export type AutoResearchMode = "holdout" | "walk-forward";
export type AutoResearchRunOutcome = "completed" | "partial" | "aborted" | "invalid_config" | "failed";
export type AutoResearchLoopVersion = "v1" | "v2";

export type ResearchTimeframe = "1h" | "15m" | "5m" | "1m";
export type ResearchStage = "block" | "portfolio" | "auto";

export type ResearchPreparationAction =
  | {
      kind: "build_feature_cache";
      timeframe: "1h" | "15m" | "5m" | "1m";
      reason: string;
      familyId?: string;
      marketLimit?: number;
      limit?: number;
      minCandles?: number;
    }
  | {
      kind: "sync_latest_batch";
      timeframes: Array<"1h" | "15m" | "5m" | "1m" | "1d">;
      reason: string;
      markets?: string[];
    }
  | {
      kind: "backfill_batch";
      timeframes: Array<"1h" | "15m" | "5m" | "1m" | "1d">;
      pages: number;
      reason: string;
      markets?: string[];
    };

export type ProposedStrategyFamily = {
  familyId: string;
  title: string;
  thesis: string;
  timeframe: ResearchTimeframe;
  baseFamilyId?: string;
  basedOnFamilies: string[];
  parameterSpecs: ResearchParameterSpec[];
  requiredData: string[];
  implementationNotes: string[];
  composition?: StrategyFamilyCompositionProposal;
};

export type CatalogEntryState = "proposed" | "implemented" | "validated" | "discarded";

export type CatalogEntryRecord = {
  familyId: string;
  state: CatalogEntryState;
  source: "stable" | "llm";
  strategyName?: string;
  title: string;
  thesis: string;
  timeframe: ResearchTimeframe;
  parameterSpecs: ResearchParameterSpec[];
  requiredData: string[];
  implementationNotes: string[];
  basedOnFamilies: string[];
  compositionDraft?: StrategyFamilyCompositionProposal;
  composition?: ResolvedStrategyFamilyComposition;
  createdAt: string;
  updatedAt: string;
  notes: string[];
};

export type CodeMutationTask = {
  taskId?: string;
  familyId?: string;
  strategyName?: string;
  title: string;
  intent: "fix_bug" | "implement_strategy" | "refactor_research_loop" | "extend_catalog";
  rationale: string;
  acceptanceCriteria: string[];
  targetFiles: string[];
  prompt: string;
};

export type ResearchParameterSpec = {
  name: string;
  description: string;
  min: number;
  max: number;
};

export type StrategyFamilyDefinition = {
  familyId: string;
  strategyName: string;
  title: string;
  thesis: string;
  timeframe: ResearchTimeframe;
  requiredData?: string[];
  parameterSpecs: ResearchParameterSpec[];
  guardrails: string[];
  composition?: ResolvedStrategyFamilyComposition;
};

export type CandidateProposal = {
  candidateId?: string;
  familyId: string;
  thesis: string;
  parameters: Record<string, number>;
  invalidationSignals: string[];
  parentCandidateIds?: string[];
  origin?:
    | "llm"
    | "novelized"
    | "resume"
    | "artifact_seed"
    | "engine_mutation"
    | "engine_seed";
};

export type NormalizedCandidateProposal = CandidateProposal & {
  candidateId: string;
  strategyName: string;
  composition?: ResolvedStrategyFamilyComposition;
};

export type ResearchHypothesis = {
  hypothesisId: string;
  stage: "parametric" | "family" | "feature" | "code";
  title: string;
  thesis: string;
  targetFamilyIds: string[];
  parentHypothesisIds: string[];
  evidence: string[];
  proposedSpecChanges: ProposedStrategyFamily[];
  proposedCodeTasks: CodeMutationTask[];
  expectedMechanism: string;
  riskNotes: string[];
  origin: "llm" | "engine" | "artifact_seed" | "human_seed";
};

export type ExperimentPlan = {
  planId: string;
  hypothesisId: string;
  mode: "candidate_batch" | "code_mutation_smoke" | "family_validation";
  candidates: CandidateProposal[];
  preparation: ResearchPreparationAction[];
  validationCommands: string[];
  budget: {
    candidateLimit: number;
    marketLimit: number;
    timeoutMs?: number;
  };
};

export type ResearchDriftMetrics = {
  performanceDrift: number;
  noveltyDrift: number;
  structureDrift: number;
  reproducibilityDrift: number;
  stagnationScore: number;
};

export type ResearchLineage = {
  lineageId: string;
  stage: ResearchStage;
  objective: string;
  startedAt: string;
  updatedAt: string;
  activeHypothesisIds: string[];
  convergedFamilyIds: string[];
  retiredHypothesisIds: string[];
  drift: ResearchDriftMetrics;
};

export type ResearchLineageEvent = {
  eventId: string;
  lineageId: string;
  at: string;
  type:
    | "lineage_started"
    | "proposal_recorded"
    | "plan_compiled"
    | "code_mutation_finished"
    | "iteration_reviewed"
    | "iteration_completed"
    | "run_completed"
    | "run_failed";
  payload: Record<string, unknown>;
};

export type StrategyCompositionMode = "weighted_vote" | "confirmatory";

export type StrategyCompositionComponentProposal = {
  familyId: string;
  weight?: number;
  parameterBindings?: Record<string, string>;
};

export type StrategyFamilyCompositionProposal = {
  mode: StrategyCompositionMode;
  buyThreshold?: number;
  sellThreshold?: number;
  components: StrategyCompositionComponentProposal[];
};

export type ResolvedStrategyCompositionComponent = {
  familyId: string;
  strategyName: string;
  weight: number;
  parameterBindings: Record<string, string>;
};

export type ResolvedStrategyFamilyComposition = {
  mode: StrategyCompositionMode;
  buyThreshold: number;
  sellThreshold: number;
  components: ResolvedStrategyCompositionComponent[];
};

export type CandidateEvaluationFailure = {
  stage: "proposal" | "preload" | "split" | "backtest" | "review" | "worker" | "unknown";
  message: string;
};

export type CandidateEvaluationDiagnostics = {
  coverage: {
    tradeCount: number;
    signalCount: number;
    ghostSignalCount: number;
    rejectedOrdersCount: number;
    cooldownSkipsCount: number;
    rawBuySignals: number;
    rawSellSignals: number;
    rawHoldSignals: number;
    avgUniverseSize: number;
    minUniverseSize: number;
    maxUniverseSize: number;
    avgConsideredBuys: number;
    avgEligibleBuys: number;
  };
  reasons: {
    strategy: Record<string, number>;
    strategyTags: Record<string, number>;
    coordinator: Record<string, number>;
    execution: Record<string, number>;
    risk: Record<string, number>;
  };
  costs: {
    feePaid: number;
    slippagePaid: number;
    totalCostsPaid: number;
  };
  robustness: {
    bootstrapPValue?: number;
    bootstrapSignificant?: boolean;
    randomPercentile?: number;
  };
  crossChecks: Array<{
    mode: AutoResearchMode;
    status: "completed" | "failed";
    failureMessage?: string;
    netReturn: number;
    maxDrawdown: number;
    tradeCount: number;
    bootstrapSignificant?: boolean;
    randomPercentile?: number;
    testStartAt?: string;
    testEndAt?: string;
    windowCount?: number;
  }>;
  windows: {
    mode: AutoResearchMode;
    holdoutDays: number;
    trainingDays?: number;
    stepDays?: number;
    trainStartAt?: string;
    trainEndAt?: string;
    testStartAt?: string;
    testEndAt?: string;
    windowCount?: number;
    availableStartAt?: string;
    availableEndAt?: string;
    availableDays?: number;
    requiredDays?: number;
    positiveWindowCount?: number;
    positiveWindowRatio?: number;
    negativeWindowCount?: number;
    bestWindowNetReturn?: number;
    worstWindowNetReturn?: number;
    totalClosedTrades?: number;
  };
};

export type CandidateBacktestEvaluation = {
  candidate: NormalizedCandidateProposal;
  mode: AutoResearchMode;
  status: "completed" | "failed";
  failure?: CandidateEvaluationFailure;
  summary: {
    totalReturn: number;
    grossReturn: number;
    netReturn: number;
    maxDrawdown: number;
    turnover: number;
    winRate: number;
    avgHoldBars: number;
    tradeCount: number;
    feePaid: number;
    slippagePaid: number;
    rejectedOrdersCount: number;
    cooldownSkipsCount: number;
    signalCount: number;
    ghostSignalCount: number;
    bootstrapPValue?: number;
    bootstrapSignificant?: boolean;
    randomPercentile?: number;
  };
  diagnostics: CandidateEvaluationDiagnostics;
  rawSummary?: HoldoutBacktestSummary | WalkForwardBacktestSummary;
};

export type ProposalBatch = {
  researchSummary: string;
  preparation: ResearchPreparationAction[];
  proposedFamilies: ProposedStrategyFamily[];
  codeTasks: CodeMutationTask[];
  candidates: CandidateProposal[];
};

export type ReviewDecision = {
  summary: string;
  verdict: "keep_searching" | "promote_candidate" | "stop_no_edge";
  promotedCandidateId?: string;
  nextPreparation: ResearchPreparationAction[];
  proposedFamilies: ProposedStrategyFamily[];
  codeTasks: CodeMutationTask[];
  nextCandidates: CandidateProposal[];
  retireCandidateIds: string[];
  observations: string[];
};

export type PreparationExecutionResult = {
  action: ResearchPreparationAction;
  status: "executed" | "skipped" | "failed";
  detail: string;
};

export type CodeMutationExecutionResult = {
  taskId: string;
  familyId?: string;
  strategyName?: string;
  title: string;
  status: "planned" | "executed" | "failed" | "skipped";
  detail: string;
};

export type ValidationCommandResult = {
  command: string;
  status: "passed" | "failed" | "skipped";
  detail: string;
};

export type ResearchIterationRecord = {
  iteration: number;
  proposal: ProposalBatch;
  preparationResults: PreparationExecutionResult[];
  codeMutationResults: CodeMutationExecutionResult[];
  validationResults: ValidationCommandResult[];
  evaluations: CandidateBacktestEvaluation[];
  review: ReviewDecision;
};

export type AutoResearchRunConfig = {
  strategyFamilyIds?: string[];
  universeName: string;
  timeframe: ResearchTimeframe;
  marketLimit: number;
  limit: number;
  holdoutDays: number;
  trainingDays?: number;
  stepDays?: number;
  iterations: number;
  candidatesPerIteration: number;
  parallelism?: number;
  mode: AutoResearchMode;
  llmProvider?: string;
  llmModel?: string;
  llmTimeoutMs?: number;
  outputDir: string;
  resumeFrom?: string;
  allowDataCollection: boolean;
  allowFeatureCacheBuild: boolean;
  allowCodeMutation: boolean;
  minTradesForPromotion?: number;
  minNetReturnForPromotion?: number;
  maxDrawdownForPromotion?: number;
  minPositiveWindowRatioForPromotion?: number;
  minRandomPercentileForPromotion?: number;
  requireBootstrapSignificanceForPromotion?: boolean;
  maxNoTradeIterations?: number;
  researchStage?: ResearchStage;
  blockCatalogPath?: string;
  seedArtifactPaths?: string[];
  seedCandidatesPerIteration?: number;
  candidateDiversificationMinDistance?: number;
  loopVersion?: AutoResearchLoopVersion;
};

export type AutoResearchConfigRepair = {
  appliedAt: string;
  reason: string;
  previous: {
    holdoutDays: number;
    trainingDays: number;
    stepDays: number;
    requiredDays: number;
  };
  next: {
    holdoutDays: number;
    trainingDays: number;
    stepDays: number;
    requiredDays: number;
    expectedWindowCount: number;
  };
  available: {
    startAt?: string;
    endAt?: string;
    availableDays: number;
  };
};

export type AutoResearchRunReport = {
  generatedAt: string;
  config: AutoResearchRunConfig;
  families: StrategyFamilyDefinition[];
  catalog: CatalogEntryRecord[];
  marketCodes: string[];
  iterations: ResearchIterationRecord[];
  outcome: AutoResearchRunOutcome;
  outcomeReason?: string;
  configRepairs: AutoResearchConfigRepair[];
  bestCandidate?: CandidateBacktestEvaluation;
  bestTradeCandidate?: CandidateBacktestEvaluation;
  lineage?: ResearchLineage;
};

export type ValidatedBlock = {
  blockId: string;
  strategyType: string;
  strategyName: string;
  decisionTimeframe: StrategyTimeframe;
  executionTimeframe: StrategyTimeframe;
  family: "trend" | "breakout" | "micro" | "meanreversion";
  sleeveId: string;
  regimeGate: { allowedRegimes: string[]; [key: string]: unknown };
  parameters: Record<string, number>;
  performance: {
    netReturn: number;
    maxDrawdown: number;
    tradeCount: number;
    positiveWindowRatio: number;
    riskAdjustedScore: number;
  };
  validatedAt: string;
  sourceFamilyId: string;
};

export type ValidatedBlockCatalog = {
  version: number;
  blocks: ValidatedBlock[];
  updatedAt: string;
};
