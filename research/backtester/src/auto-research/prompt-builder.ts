import type {
  AutoResearchRunConfig,
  CandidateBacktestEvaluation,
  CodeMutationExecutionResult,
  PreparationExecutionResult,
  ProposalBatch,
  ResearchIterationRecord,
  StrategyFamilyDefinition
} from "./types.js";

function jsonBlock(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function compactFamilies(families: StrategyFamilyDefinition[]) {
  return families.map((family) => ({
    familyId: family.familyId,
    strategyName: family.strategyName,
    title: family.title,
    thesis: family.thesis,
    timeframe: family.timeframe,
    parameterSpecs: family.parameterSpecs,
    guardrails: family.guardrails
  }));
}

function compactEvaluation(evaluation: CandidateBacktestEvaluation) {
  return {
    candidate: evaluation.candidate,
    mode: evaluation.mode,
    status: evaluation.status,
    failure: evaluation.failure,
    summary: evaluation.summary,
    diagnostics: evaluation.diagnostics
  };
}

function compactHistory(history: ResearchIterationRecord[]) {
  return history.map((iteration) => ({
    iteration: iteration.iteration,
    proposal: {
      researchSummary: iteration.proposal.researchSummary,
      candidates: iteration.proposal.candidates,
      preparation: iteration.proposal.preparation
    },
    preparationResults: iteration.preparationResults,
    codeMutationResults: iteration.codeMutationResults,
    validationResults: iteration.validationResults,
    evaluations: iteration.evaluations.map(compactEvaluation),
    review: iteration.review
  }));
}

function compactPreparationResults(results: PreparationExecutionResult[]) {
  return results.map((result) => ({
    action: result.action,
    status: result.status,
    detail: result.detail
  }));
}

function compactCodeMutationResults(results: CodeMutationExecutionResult[]) {
  return results.map((result) => ({
    taskId: result.taskId,
    title: result.title,
    status: result.status,
    detail: result.detail
  }));
}

function parameterKey(parameters: Record<string, number>) {
  return JSON.stringify(
    Object.keys(parameters)
      .sort((left, right) => left.localeCompare(right))
      .reduce<Record<string, number>>((result, key) => {
        const value = parameters[key];
        result[key] = Number.isFinite(value) ? Number(value.toFixed(4)) : value;
        return result;
      }, {})
  );
}

function compactCandidateLedger(history: ResearchIterationRecord[]) {
  const ledger = new Map<string, {
    familyId: string;
    parameters: Record<string, number>;
    appearances: number;
    bestNetReturn: number;
    tradefulAppearances: number;
    lastIteration: number;
  }>();

  for (const iteration of history) {
    for (const evaluation of iteration.evaluations) {
      const key = `${evaluation.candidate.familyId}:${parameterKey(evaluation.candidate.parameters)}`;
      const existing = ledger.get(key);

      if (!existing) {
        ledger.set(key, {
          familyId: evaluation.candidate.familyId,
          parameters: evaluation.candidate.parameters,
          appearances: 1,
          bestNetReturn: evaluation.summary.netReturn,
          tradefulAppearances: evaluation.summary.tradeCount > 0 ? 1 : 0,
          lastIteration: iteration.iteration
        });
        continue;
      }

      existing.appearances += 1;
      existing.bestNetReturn = Math.max(existing.bestNetReturn, evaluation.summary.netReturn);
      existing.tradefulAppearances += evaluation.summary.tradeCount > 0 ? 1 : 0;
      existing.lastIteration = iteration.iteration;
    }
  }

  return [...ledger.values()]
    .sort((left, right) => {
      if (right.bestNetReturn !== left.bestNetReturn) {
        return right.bestNetReturn - left.bestNetReturn;
      }

      return right.appearances - left.appearances;
    })
    .slice(0, 20);
}

function compactFamilyPerformance(history: ResearchIterationRecord[]) {
  const byFamily = new Map<string, {
    evaluations: number;
    tradeful: number;
    positive: number;
    bestNetReturn: number;
    bestTradeCount: number;
    topReasons: Record<string, number>;
  }>();

  for (const iteration of history) {
    for (const evaluation of iteration.evaluations) {
      const current = byFamily.get(evaluation.candidate.familyId) ?? {
        evaluations: 0,
        tradeful: 0,
        positive: 0,
        bestNetReturn: Number.NEGATIVE_INFINITY,
        bestTradeCount: 0,
        topReasons: {}
      };

      current.evaluations += 1;
      current.tradeful += evaluation.summary.tradeCount > 0 ? 1 : 0;
      current.positive += evaluation.summary.netReturn > 0 ? 1 : 0;
      current.bestNetReturn = Math.max(current.bestNetReturn, evaluation.summary.netReturn);
      current.bestTradeCount = Math.max(current.bestTradeCount, evaluation.summary.tradeCount);
      for (const [reason, count] of Object.entries(evaluation.diagnostics.reasons.strategy)) {
        current.topReasons[reason] = (current.topReasons[reason] ?? 0) + count;
      }
      byFamily.set(evaluation.candidate.familyId, current);
    }
  }

  return [...byFamily.entries()]
    .map(([familyId, value]) => ({
      familyId,
      evaluations: value.evaluations,
      tradeful: value.tradeful,
      positive: value.positive,
      bestNetReturn: value.bestNetReturn,
      bestTradeCount: value.bestTradeCount,
      topStrategyReasons: Object.entries(value.topReasons)
        .sort((left, right) => right[1] - left[1])
        .slice(0, 5)
    }))
    .sort((left, right) => right.bestNetReturn - left.bestNetReturn);
}

export function buildProposalPrompt(params: {
  config: AutoResearchRunConfig;
  families: StrategyFamilyDefinition[];
  marketCodes: string[];
  history: ResearchIterationRecord[];
}): string {
  return `
You are an autonomous crypto strategy researcher for Upbit KRW spot.

Goal:
- Long only
- Single position portfolio
- 1h decision timeframe
- Point-in-time universe
- Same-bar fill forbidden
- Optimize for net return after fees/slippage, sane turnover, and robustness

Current run config:
${jsonBlock({
  universe: params.config.universeName,
  timeframe: params.config.timeframe,
  marketLimit: params.config.marketLimit,
  limit: params.config.limit,
  holdoutDays: params.config.holdoutDays,
  mode: params.config.mode,
  candidatesPerIteration: params.config.candidatesPerIteration,
  marketCodes: params.marketCodes,
  families: compactFamilies(params.families),
  familyPerformanceSummary: compactFamilyPerformance(params.history),
  candidateLedgerSummary: compactCandidateLedger(params.history),
  priorHistory: compactHistory(params.history)
})}

Task:
1. Think like an auto-research agent, not a human explainer.
2. Generate executable candidates only from the listed families.
3. If useful, request preparation actions such as feature cache build or candle refresh.
4. Prefer diverse hypotheses, not tiny parameter nudges of the same idea.
5. Keep each thesis short and falsifiable.
6. Use the JSON facts above directly. Do not assume hidden heuristics. If the history shows repeated zero-signal or failed evaluations, propose candidates or data/code actions that specifically target those failure modes.

Return JSON only:
{
  "researchSummary": "short summary",
  "preparation": [
    {
      "kind": "build_feature_cache" | "sync_latest_batch" | "backfill_batch",
      "timeframe": "1h" | "15m" | "5m" | "1m",
      "timeframes": ["1h"],
      "pages": 4,
      "reason": "why this is worth doing",
      "familyId": "relative-momentum-pullback",
      "marketLimit": 10,
      "limit": 40000,
      "minCandles": 5000
    }
  ],
  "proposedFamilies": [
    {
      "familyId": "momentum-reacceleration-v1",
      "title": "Momentum Reacceleration",
      "thesis": "one sentence",
      "timeframe": "1h",
      "baseFamilyId": "relative-momentum-pullback",
      "basedOnFamilies": ["relative-momentum-pullback"],
      "parameterSpecs": [
        {
          "name": "strengthFloor",
          "description": "relative strength floor",
          "min": 0.6,
          "max": 0.95
        }
      ],
      "requiredData": ["1h", "feature_cache:breadth"],
      "implementationNotes": ["what code would need to change"]
    }
  ],
  "codeTasks": [
    {
      "taskId": "optional-id",
      "title": "implement new family",
      "intent": "implement_strategy",
      "rationale": "why code change is worth doing",
      "acceptanceCriteria": ["criterion"],
      "targetFiles": ["research/strategies/src/example.ts"],
      "prompt": "precise coding task"
    }
  ],
  "candidates": [
    {
      "candidateId": "optional-id",
      "familyId": "relative-momentum-pullback",
      "thesis": "one sentence",
      "parameters": {
        "minStrengthPct": 0.8,
        "minRiskOn": 0.1,
        "pullbackZ": 0.9,
        "trailAtrMult": 2.2
      },
      "invalidationSignals": ["trade count collapses", "only one market drives pnl"]
    }
  ]
}

Requirements:
- Return 1 to ${params.config.candidatesPerIteration} candidates.
- Use only parameter names that belong to the chosen family.
- If you want a newly proposed family to become executable after a code task, make the familyId equal to the strategy registry name you expect the code task to add.
- If you want a newly proposed family to be executable immediately, set 'baseFamilyId' to an existing executable family.
- Do not emit markdown.
`.trim();
}

export function buildReviewPrompt(params: {
  config: AutoResearchRunConfig;
  families: StrategyFamilyDefinition[];
  history: ResearchIterationRecord[];
  latestProposal: ProposalBatch;
  preparationResults: PreparationExecutionResult[];
  codeMutationResults: CodeMutationExecutionResult[];
  validationResults: Array<{
    command: string;
    status: "passed" | "failed" | "skipped";
    detail: string;
  }>;
  evaluations: CandidateBacktestEvaluation[];
}): string {
  return `
You are reviewing an autonomous crypto strategy research iteration.

Structured run facts:
${jsonBlock({
  config: {
    mode: params.config.mode,
    universe: params.config.universeName,
    timeframe: params.config.timeframe,
    marketLimit: params.config.marketLimit,
    limit: params.config.limit,
    holdoutDays: params.config.holdoutDays
  },
  families: compactFamilies(params.families),
  latestProposal: params.latestProposal,
  latestPreparationResults: compactPreparationResults(params.preparationResults),
  latestCodeMutationResults: compactCodeMutationResults(params.codeMutationResults),
  latestValidationResults: params.validationResults,
  latestEvaluations: params.evaluations.map(compactEvaluation),
  familyPerformanceSummary: compactFamilyPerformance(params.history),
  candidateLedgerSummary: compactCandidateLedger(params.history),
  priorHistory: compactHistory(params.history)
})}

Task:
1. Decide whether one candidate is worth promoting now, whether to keep searching, or whether to stop because no edge is visible.
2. Explicitly retire failed ideas when appropriate.
3. If searching should continue, propose the next executable candidate batch.
4. Favor robustness over one-off lucky net returns.
5. Base your decision on the structured JSON facts, including failed evaluations, zero-signal runs, preparation outcomes, and validation results.
6. Use diagnostics.coverage and diagnostics.reasons to explain whether no-trade outcomes came from strategy filters, portfolio coordination, risk blocks, or execution rejects.
7. The orchestrator will not auto-promote or auto-stop by default. Your verdict is the primary control signal.

Return JSON only:
{
  "summary": "short assessment",
  "verdict": "keep_searching" | "promote_candidate" | "stop_no_edge",
  "promotedCandidateId": "candidate-id-or-null",
  "nextPreparation": [],
  "proposedFamilies": [],
  "codeTasks": [],
  "nextCandidates": [
    {
      "candidateId": "optional-id",
      "familyId": "relative-momentum-pullback",
      "thesis": "one sentence",
      "parameters": {},
      "invalidationSignals": ["..."]
    }
  ],
  "retireCandidateIds": ["candidate-id"],
  "observations": ["short bullet text"]
}

Requirements:
- If verdict=promote_candidate, promotedCandidateId must match one of the evaluated candidates.
- If verdict=keep_searching, provide at least 1 next candidate unless you also conclude stop_no_edge.
- Do not emit markdown.
`.trim();
}
