import type { HoldoutBacktestSummary, WalkForwardBacktestSummary } from "../types.js";

export type AutoResearchMode = "holdout" | "walk-forward";

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
  timeframe: "1h";
  baseFamilyId?: string;
  basedOnFamilies: string[];
  parameterSpecs: ResearchParameterSpec[];
  requiredData: string[];
  implementationNotes: string[];
};

export type CatalogEntryState = "proposed" | "implemented" | "validated" | "discarded";

export type CatalogEntryRecord = {
  familyId: string;
  state: CatalogEntryState;
  source: "stable" | "llm";
  strategyName?: string;
  title: string;
  thesis: string;
  timeframe: "1h";
  parameterSpecs: ResearchParameterSpec[];
  requiredData: string[];
  implementationNotes: string[];
  basedOnFamilies: string[];
  createdAt: string;
  updatedAt: string;
  notes: string[];
};

export type CodeMutationTask = {
  taskId?: string;
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
  timeframe: "1h";
  parameterSpecs: ResearchParameterSpec[];
  guardrails: string[];
};

export type CandidateProposal = {
  candidateId?: string;
  familyId: string;
  thesis: string;
  parameters: Record<string, number>;
  invalidationSignals: string[];
};

export type NormalizedCandidateProposal = CandidateProposal & {
  candidateId: string;
  strategyName: string;
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
  timeframe: "1h";
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
  maxNoTradeIterations?: number;
};

export type AutoResearchRunReport = {
  generatedAt: string;
  config: AutoResearchRunConfig;
  families: StrategyFamilyDefinition[];
  catalog: CatalogEntryRecord[];
  marketCodes: string[];
  iterations: ResearchIterationRecord[];
  bestCandidate?: CandidateBacktestEvaluation;
  bestTradeCandidate?: CandidateBacktestEvaluation;
};
