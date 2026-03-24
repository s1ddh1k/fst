import type {
  AutoResearchRunConfig,
  CandidateBacktestEvaluation,
  CodeMutationExecutionResult,
  PreparationExecutionResult,
  ProposalBatch,
  ResearchIterationRecord,
  StrategyFamilyDefinition,
  ValidatedBlockCatalog
} from "./types.js";

const AUTO_RESEARCH_SYSTEM_PROMPT = `
You are the system prompt for an autonomous crypto strategy researcher.

Operating principles:
- Long only, Upbit KRW spot, point-in-time universe, portfolio-level risk caps.
- Optimize for net return after costs, robustness across windows, and low fragility.
- Prefer structured evidence over intuition.
- Do not keep pushing a family that repeatedly yields zero trades, one-market dependency, or weak walk-forward robustness.
- If a candidate is derived from a previous one, keep genealogy explicit.
- If proposal or review quality is degraded, preserve exploration diversity and safety.
`.trim();

const AUTO_RESEARCH_GLOBAL_PROMPT = `
Global research policy:
- Use only the structured JSON facts provided in the prompt.
- Favor diverse hypotheses over narrow parameter twitching.
- Prefer walk-forward candidates with positive window breadth, tolerable worst-window outcomes, and non-trivial closed-trade counts.
- Treat code mutation as a last-mile tool, not the default action.
- When proposing a refinement of an earlier candidate, include parentCandidateIds.
`.trim();

function jsonBlock(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function compactFamilies(families: StrategyFamilyDefinition[]) {
  return families.map((family) => ({
    familyId: family.familyId,
    strategyName: family.strategyName,
    title: family.title,
    thesis: family.thesis,
    timeframe: family.timeframe,
    requiredData: family.requiredData,
    parameterSpecs: family.parameterSpecs,
    guardrails: family.guardrails,
    composition: family.composition
  }));
}

export function compactEvaluation(evaluation: CandidateBacktestEvaluation) {
  return {
    candidate: evaluation.candidate,
    mode: evaluation.mode,
    status: evaluation.status,
    failure: evaluation.failure,
    summary: evaluation.summary,
    diagnostics: evaluation.diagnostics
  };
}

export function buildEvaluationAnalysis(evaluation: CandidateBacktestEvaluation) {
  const s = evaluation.summary;
  const d = evaluation.diagnostics;
  const w = d.windows;
  const feesAteProfits = s.grossReturn > 0 && s.netReturn <= 0;
  const fewTrades = s.tradeCount < 5;
  const highGhostRatio = d.coverage.ghostSignalCount > d.coverage.signalCount * 2;
  const windowSpread = (w.bestWindowNetReturn ?? 0) - (w.worstWindowNetReturn ?? 0);
  const topRejectReasons = Object.entries({ ...d.reasons.strategy, ...d.reasons.risk })
    .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}(${v})`);

  return {
    candidateId: evaluation.candidate.candidateId,
    familyId: evaluation.candidate.familyId,
    parameters: evaluation.candidate.parameters,
    netReturn: +(s.netReturn * 100).toFixed(2),
    grossReturn: +(s.grossReturn * 100).toFixed(2),
    maxDrawdown: +(s.maxDrawdown * 100).toFixed(2),
    tradeCount: s.tradeCount,
    feePaid: +s.feePaid.toFixed(4),
    winRate: +(s.winRate * 100).toFixed(1),
    positiveWindowRatio: w.positiveWindowRatio ?? 0,
    bestWindow: +(( w.bestWindowNetReturn ?? 0) * 100).toFixed(2),
    worstWindow: +((w.worstWindowNetReturn ?? 0) * 100).toFixed(2),
    windowCount: w.windowCount ?? 0,
    diagnosis: {
      feesAteProfits,
      fewTrades,
      highGhostRatio,
      windowSpread: +(windowSpread * 100).toFixed(2),
      topRejectReasons,
      signalsGenerated: d.coverage.signalCount,
      signalsBlocked: d.coverage.ghostSignalCount + d.coverage.rejectedOrdersCount
    }
  };
}

export function compactHistory(history: ResearchIterationRecord[]) {
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

export function compactRecentHistory(history: ResearchIterationRecord[], limit = 2) {
  return history.slice(-Math.max(0, limit)).map((iteration) => ({
    iteration: iteration.iteration,
    proposal: {
      researchSummary: iteration.proposal.researchSummary,
      candidateIds: iteration.proposal.candidates.map((candidate) => candidate.candidateId),
      families: Array.from(new Set(iteration.proposal.candidates.map((candidate) => candidate.familyId)))
    },
    topEvaluations: iteration.evaluations
      .map((evaluation) => ({
        candidateId: evaluation.candidate.candidateId,
        familyId: evaluation.candidate.familyId,
        netReturn: evaluation.summary.netReturn,
        maxDrawdown: evaluation.summary.maxDrawdown,
        tradeCount: evaluation.summary.tradeCount,
        status: evaluation.status
      }))
      .sort((left, right) => right.netReturn - left.netReturn)
      .slice(0, 5),
    review: {
      verdict: iteration.review.verdict,
      promotedCandidateId: iteration.review.promotedCandidateId,
      retireCandidateIds: iteration.review.retireCandidateIds,
      observationCount: iteration.review.observations.length
    }
  }));
}

export function compactPreparationResults(results: PreparationExecutionResult[]) {
  return results.map((result) => ({
    action: result.action,
    status: result.status,
    detail: result.detail
  }));
}

export function compactCodeMutationResults(results: CodeMutationExecutionResult[]) {
  return results.map((result) => ({
    taskId: result.taskId,
    familyId: result.familyId,
    strategyName: result.strategyName,
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

export function compactCandidateLedger(history: ResearchIterationRecord[], limit = 20) {
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
    .slice(0, limit);
}

export function compactCandidateGenealogy(history: ResearchIterationRecord[], limit = 30) {
  return history
    .flatMap((iteration) =>
      iteration.evaluations.map((evaluation) => ({
        iteration: iteration.iteration,
        candidateId: evaluation.candidate.candidateId,
        familyId: evaluation.candidate.familyId,
        origin: evaluation.candidate.origin ?? "llm",
        parentCandidateIds: evaluation.candidate.parentCandidateIds ?? [],
        netReturn: evaluation.summary.netReturn,
        tradeCount: evaluation.summary.tradeCount
      }))
    )
    .slice(-limit);
}

export function compactFamilyPerformance(history: ResearchIterationRecord[]) {
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
${AUTO_RESEARCH_SYSTEM_PROMPT}

${AUTO_RESEARCH_GLOBAL_PROMPT}

Goal:
- Long only
- Prefer portfolio structures that can survive regime shifts without blowing up.
- The primary anchor timeframe is 1h, but families may require 15m / 5m / 1m supporting data.
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
  candidateGenealogy: compactCandidateGenealogy(params.history),
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
      "implementationNotes": ["what code would need to change"],
      "composition": {
        "mode": "weighted_vote",
        "buyThreshold": 0.55,
        "sellThreshold": 0.55,
        "components": [
          {
            "familyId": "leader-pullback-state-machine",
            "weight": 1.0,
            "parameterBindings": {
              "strengthFloor": "leaderStrengthFloor",
              "trailAtrMult": "sharedTrailAtrMult"
            }
          },
          {
            "familyId": "momentum-reacceleration",
            "weight": 0.8,
            "parameterBindings": {
              "strengthFloor": "resetStrengthFloor",
              "minRiskOn": "sharedMinRiskOn",
              "trailAtrMult": "sharedTrailAtrMult"
            }
          }
        ]
      }
    }
  ],
  "codeTasks": [
    {
      "taskId": "optional-id",
      "familyId": "momentum-reacceleration-v1",
      "strategyName": "momentum-reacceleration-v1",
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
      "parentCandidateIds": ["prior-candidate-id"],
      "origin": "llm",
      "invalidationSignals": ["trade count collapses", "only one market drives pnl"]
    }
  ]
}

Requirements:
- Return 1 to ${params.config.candidatesPerIteration} candidates.
- Use only parameter names that belong to the chosen family.
- If you want a newly proposed family to become executable after a code task, make the familyId equal to the strategy registry name you expect the code task to add.
- If you want a newly proposed family to be executable immediately, set 'baseFamilyId' to an existing executable family.
- You may propose immediately executable composed families by adding a 'composition' block that references already executable familyIds.
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
${AUTO_RESEARCH_SYSTEM_PROMPT}

${AUTO_RESEARCH_GLOBAL_PROMPT}

You are reviewing an autonomous crypto strategy research iteration.

Output contract:
- Choose "keep_searching" when you can provide 1 to ${params.config.candidatesPerIteration} concrete nextCandidates.
- Fill nextCandidates with unique, executable candidates when you continue searching.
- Choose "stop_no_edge" when you prefer not to provide a next candidate batch.
- Return JSON only.

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
  candidateGenealogy: compactCandidateGenealogy(params.history),
  priorHistory: compactHistory(params.history)
})}

Task:
1. Decide whether one candidate is worth promoting now, whether to keep searching, or whether to stop because no edge is visible.
2. Explicitly retire failed ideas when appropriate.
3. If searching should continue, propose the next executable candidate batch.
4. Favor robustness over one-off lucky net returns.
5. Base your decision on the structured JSON facts, including failed evaluations, zero-signal runs, preparation outcomes, and validation results.
6. Use diagnostics.coverage and diagnostics.reasons to explain whether no-trade outcomes came from strategy filters, portfolio coordination, risk blocks, or execution rejects.
7. The orchestrator may apply objective promotion gates and local candidate augmentation. Your verdict remains important, but it is not the only control signal.
8. Optimize for risk-constrained growth. Do not promote candidates that rely on fragile drawdown-heavy performance.

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
      "parentCandidateIds": ["prior-candidate-id"],
      "origin": "llm",
      "invalidationSignals": ["..."]
    }
  ],
  "retireCandidateIds": ["candidate-id"],
  "observations": ["short bullet text"]
}

Requirements:
- If verdict=promote_candidate, promotedCandidateId must match one of the evaluated candidates.
- If verdict=keep_searching, provide 1 to ${params.config.candidatesPerIteration} concrete nextCandidates.
- Let nextCandidates be the fully populated next batch whenever you continue searching.
- Use verdict="stop_no_edge" when you do not want to provide a next candidate batch.
- Final response reminder: when verdict=keep_searching, fill nextCandidates with unique, executable candidates.
- Do not emit markdown.
`.trim();
}

export function buildBlockProposalPrompt(params: {
  config: AutoResearchRunConfig;
  families: StrategyFamilyDefinition[];
  marketCodes: string[];
  history: ResearchIterationRecord[];
}): string {
  return `
${AUTO_RESEARCH_SYSTEM_PROMPT}

${AUTO_RESEARCH_GLOBAL_PROMPT}

Goal:
- You are optimizing a SINGLE strategy block (not a full portfolio).
- Each block has strategy-specific parameters plus optional regime controls.
- Some block families may expose more than 12 tunable parameters.
- Find the optimal parameters for this strategy in its target regime.
- Long only, Upbit KRW spot, point-in-time.

Current run config:
${jsonBlock({
  universe: params.config.universeName,
  timeframe: params.config.timeframe,
  marketLimit: params.config.marketLimit,
  limit: params.config.limit,
  holdoutDays: params.config.holdoutDays,
  mode: params.config.mode,
  researchStage: "block",
  candidatesPerIteration: params.config.candidatesPerIteration,
  marketCodes: params.marketCodes,
  families: compactFamilies(params.families),
  familyPerformanceSummary: compactFamilyPerformance(params.history),
  recentEvaluations: params.history.slice(-2).flatMap(h => h.evaluations.map(buildEvaluationAnalysis))
})}

Task — think like a researcher:
1. Look at recentEvaluations.diagnosis for each candidate:
   - feesAteProfits=true → reduce trade frequency (widen thresholds, increase rebalanceBars)
   - fewTrades=true → relax entry conditions (lower RSI threshold, widen regime gate)
   - highGhostRatio=true → signals generated but blocked — relax position limits or cooldown
   - worstWindow much worse than bestWindow → strategy is regime-dependent, tighten regime gate
   - topRejectReasons tells you exactly what's blocking trades — address those specific reasons
2. Each nextCandidate must state in its thesis WHAT problem it's fixing from the previous evaluation.
3. Explore parameter extremes and corners, not just midpoints.
4. Generate executable candidates from the listed block families only.

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
      "familyId": "block:leader-1h-trend-up",
      "marketLimit": 10,
      "limit": 40000,
      "minCandles": 5000
    }
  ],
  "proposedFamilies": [],
  "codeTasks": [],
  "candidates": [
    {
      "candidateId": "optional-id",
      "familyId": "block:leader-1h-trend-up",
      "thesis": "one sentence",
      "parameters": {
        "strengthFloor": 0.78,
        "pullbackAtr": 0.9,
        "setupExpiryBars": 4,
        "trailAtrMult": 2.4
      },
      "parentCandidateIds": ["prior-candidate-id"],
      "origin": "llm",
      "invalidationSignals": ["trade count collapses", "drawdown expands in trend_down"]
    }
  ]
}

Requirements:
- Return 1 to ${params.config.candidatesPerIteration} candidates.
- Every response MUST include a top-level "candidates" array, even when empty.
- Use only parameter names that belong to the chosen family.
- Do not emit markdown.
`.trim();
}

export function buildBlockReviewPrompt(params: {
  config: AutoResearchRunConfig;
  families: StrategyFamilyDefinition[];
  history: ResearchIterationRecord[];
  latestProposal: ProposalBatch;
  preparationResults: PreparationExecutionResult[];
  codeMutationResults: CodeMutationExecutionResult[];
  validationResults: Array<{ command: string; status: "passed" | "failed" | "skipped"; detail: string }>;
  evaluations: CandidateBacktestEvaluation[];
}): string {
  return `
${AUTO_RESEARCH_SYSTEM_PROMPT}

${AUTO_RESEARCH_GLOBAL_PROMPT}

You are reviewing a BLOCK-level research iteration (single strategy optimization).

Output contract:
- Choose "keep_searching" when you can provide 1 to ${params.config.candidatesPerIteration} concrete nextCandidates.
- Fill nextCandidates with unique, executable parameter sets when you continue searching.
- Choose "stop_no_edge" when you prefer not to provide a next candidate batch.
- Return JSON only.

Structured run facts:
${jsonBlock({
  config: {
    mode: params.config.mode,
    universe: params.config.universeName,
    timeframe: params.config.timeframe,
    researchStage: "block",
    holdoutDays: params.config.holdoutDays
  },
  families: compactFamilies(params.families),
  latestEvaluations: params.evaluations.map(buildEvaluationAnalysis),
  familyPerformanceSummary: compactFamilyPerformance(params.history)
})}

Task — analyze like a researcher, not a parameter optimizer:

1. DIAGNOSE: For each candidate, analyze WHY it performed the way it did:
   - Check costs.totalCostsPaid vs summary.grossReturn — is the strategy profitable before fees but killed by costs? → reduce trade frequency
   - Check windows.positiveWindowRatio — does it win in some periods and lose in others? → identify which market conditions work
   - Check windows.bestWindowNetReturn vs worstWindowNetReturn — how wide is the spread? → strategy may need regime filtering
   - Check coverage.ghostSignalCount vs signalCount — are signals being generated but not executed? → position limits or cooldown too tight
   - Check reasons.strategy / reasons.risk — what's blocking trades? → these are specific strategy rejection reasons
   - Compare per-window returns — is the loss concentrated in 1-2 bad windows or spread evenly?

2. EXPLAIN: In your summary, state the specific failure mechanism:
   - "Gross return +2.3% but fees ate 3.1% → need fewer trades with higher conviction"
   - "4 out of 6 windows profitable but window 3 lost -5% → strategy fails in downtrends, add trend filter"
   - "Only 3 trades in 90 days → entry conditions too restrictive, relax RSI threshold from 25 to 35"
   NOT just "keep searching" or "weak performance"

3. PRESCRIBE: Your nextCandidates should address the SPECIFIC diagnosed issue:
   - If fees too high → widen entry/exit thresholds to reduce trade count
   - If regime-dependent → change regime gate parameters
   - If signals blocked → relax position limits or cooldown
   - If one bad window → add drawdown protection or trend alignment
   Do NOT just nudge parameters randomly. Each change must address a diagnosed problem.

4. PROMOTE only if: net return > 0, positive window ratio >= 0.5, and trade count >= 10.

Return JSON only — the verdict field MUST be exactly one of these three strings:
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
      "familyId": "block:leader-1h-trend-up",
      "thesis": "one sentence",
      "parameters": {},
      "parentCandidateIds": ["prior-candidate-id"],
      "origin": "llm",
      "invalidationSignals": ["..."]
    }
  ],
  "retireCandidateIds": ["candidate-id"],
  "observations": ["short bullet text"]
}

Requirements:
- verdict MUST be one of: "keep_searching", "promote_candidate", "stop_no_edge". No other values are accepted.
- If verdict=promote_candidate, promotedCandidateId must match one of the evaluated candidates.
- If verdict=keep_searching, provide 1 to ${params.config.candidatesPerIteration} nextCandidates with meaningfully different parameters.
- Let nextCandidates be the fully populated next batch whenever you continue searching.
- Use verdict="stop_no_edge" when you do not want to provide a next candidate batch.
- Final response reminder: when verdict=keep_searching, fill nextCandidates with unique, executable candidates.
- Do not emit markdown.
`.trim();
}

export function buildPortfolioCompositionProposalPrompt(params: {
  config: AutoResearchRunConfig;
  families: StrategyFamilyDefinition[];
  marketCodes: string[];
  history: ResearchIterationRecord[];
  blockCatalog: ValidatedBlockCatalog;
}): string {
  const blockSummary = params.blockCatalog.blocks.map((b) => ({
    blockId: b.blockId,
    family: b.family,
    sleeveId: b.sleeveId,
    decisionTimeframe: b.decisionTimeframe,
    regimeGate: b.regimeGate.allowedRegimes,
    performance: b.performance
  }));

  return `
${AUTO_RESEARCH_SYSTEM_PROMPT}

${AUTO_RESEARCH_GLOBAL_PROMPT}

Goal:
- You are composing a PORTFOLIO from pre-validated strategy blocks.
- Block parameters are FROZEN — you cannot change them.
- Your job: decide sleeve capital allocations and portfolio-level parameters.

Validated blocks:
${jsonBlock(blockSummary)}

Current run config:
${jsonBlock({
  universe: params.config.universeName,
  mode: params.config.mode,
  researchStage: "portfolio",
  candidatesPerIteration: params.config.candidatesPerIteration,
  marketCodes: params.marketCodes,
  families: compactFamilies(params.families),
  priorHistory: compactHistory(params.history)
})}

Tunable parameters:
- sleeveAlloc_<sleeveId>: float 0.05-0.8 for each sleeve
- universeTopN, maxOpenPositions, maxCapitalUsagePct, cooldownBarsAfterLoss, minBarsBetweenEntries, universeLookbackBars, refreshEveryBars

Task:
1. Propose capital allocation across sleeves that diversifies regime exposure.
2. Set portfolio-level risk controls appropriately.
3. Use the standard proposal JSON format.

Return JSON only.
`.trim();
}

export function buildPortfolioCompositionReviewPrompt(params: {
  config: AutoResearchRunConfig;
  families: StrategyFamilyDefinition[];
  history: ResearchIterationRecord[];
  latestProposal: ProposalBatch;
  preparationResults: PreparationExecutionResult[];
  codeMutationResults: CodeMutationExecutionResult[];
  validationResults: Array<{ command: string; status: "passed" | "failed" | "skipped"; detail: string }>;
  evaluations: CandidateBacktestEvaluation[];
  blockCatalog: ValidatedBlockCatalog;
}): string {
  return `
${AUTO_RESEARCH_SYSTEM_PROMPT}

${AUTO_RESEARCH_GLOBAL_PROMPT}

You are reviewing a PORTFOLIO COMPOSITION research iteration.
Blocks are frozen; you are only tuning allocations and portfolio-level params.

Output contract:
- Choose "keep_searching" when you can provide 1 to ${params.config.candidatesPerIteration} concrete nextCandidates.
- Fill nextCandidates with unique, executable allocation candidates when you continue searching.
- Choose "stop_no_edge" when you prefer not to provide a next candidate batch.
- Return JSON only.

Structured run facts:
${jsonBlock({
  config: {
    mode: params.config.mode,
    universe: params.config.universeName,
    researchStage: "portfolio",
    holdoutDays: params.config.holdoutDays
  },
  families: compactFamilies(params.families),
  latestProposal: params.latestProposal,
  latestEvaluations: params.evaluations.map(compactEvaluation),
  priorHistory: compactHistory(params.history),
  validatedBlocks: params.blockCatalog.blocks.map((b) => ({
    blockId: b.blockId,
    family: b.family,
    sleeveId: b.sleeveId,
    performance: b.performance
  }))
})}

Task:
1. Evaluate whether the allocation produces a well-diversified portfolio.
2. If searching should continue, propose different sleeve allocations or portfolio-level params.

Return JSON only — the verdict field MUST be exactly one of these three strings:
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
      "familyId": "assembled-portfolio",
      "thesis": "one sentence",
      "parameters": {},
      "parentCandidateIds": ["prior-candidate-id"],
      "origin": "llm",
      "invalidationSignals": ["..."]
    }
  ],
  "retireCandidateIds": ["candidate-id"],
  "observations": ["short bullet text"]
}

Requirements:
- verdict MUST be one of: "keep_searching", "promote_candidate", "stop_no_edge". No other values are accepted.
- If verdict=promote_candidate, promotedCandidateId must match one of the evaluated candidates.
- If verdict=keep_searching, provide 1 to ${params.config.candidatesPerIteration} concrete nextCandidates.
- Let nextCandidates be the fully populated next batch whenever you continue searching.
- Use verdict="stop_no_edge" when you do not want to provide a next candidate batch.
- Final response reminder: when verdict=keep_searching, fill nextCandidates with unique, executable candidates.
- Do not emit markdown.
`.trim();
}
