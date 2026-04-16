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
- Focus on STRATEGY STRUCTURE and LOGIC — which indicators, entry/exit rules, regime filters.
- Do not spend effort on tiny numeric nudges. Change the thesis, entry logic, exit logic, or family structure when the evidence says the current idea is weak.
- Favor diverse strategy STRUCTURES over narrow parameter twitching of existing strategies.
- Prefer walk-forward candidates with positive window breadth, tolerable worst-window outcomes, and non-trivial closed-trade counts (minimum 10 trades across all windows).
- Strategies that underperform buy-and-hold are useless — focus on generating genuine edge.
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

export type EvaluationDiagnosis = {
  primaryFailureMode:
    | "failed_evaluation"
    | "blocked_signals"
    | "too_few_trades"
    | "cost_drag"
    | "no_edge"
    | "regime_fragility"
    | "risk_pressure"
    | "healthy_edge"
    | "mixed";
  blockingLayer: "strategy" | "risk" | "execution" | "coordinator" | "mixed" | "none";
  summary: string;
  prescriptions: string[];
  dominantReasons: string[];
  feesAteProfits: boolean;
  fewTrades: boolean;
  tooFewTradesForStatistics: boolean;
  underperformsBaseline: boolean;
  highGhostRatio: boolean;
  windowSpread: number;
  signalsGenerated: number;
  signalsBlocked: number;
};

function sumReasonCounts(reasonMap: Record<string, number>): number {
  return Object.values(reasonMap).reduce((sum, count) => sum + count, 0);
}

function topReasonEntries(reasonMap: Record<string, number>, limit = 3): string[] {
  return Object.entries(reasonMap)
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([reason, count]) => `${reason}(${count})`);
}

function collectTopRejectReasons(diagnostics: CandidateBacktestEvaluation["diagnostics"]): string[] {
  return [
    ...Object.entries(diagnostics.reasons.strategy).map(([reason, count]) => [`strategy:${reason}`, count] as const),
    ...Object.entries(diagnostics.reasons.strategyTags).map(([reason, count]) => [`strategy_tag:${reason}`, count] as const),
    ...Object.entries(diagnostics.reasons.risk).map(([reason, count]) => [`risk:${reason}`, count] as const),
    ...Object.entries(diagnostics.reasons.execution).map(([reason, count]) => [`execution:${reason}`, count] as const),
    ...Object.entries(diagnostics.reasons.coordinator).map(([reason, count]) => [`coordinator:${reason}`, count] as const)
  ]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)
    .map(([reason, count]) => `${reason}(${count})`);
}

function dominantBlockingLayer(diagnostics: CandidateBacktestEvaluation["diagnostics"]): {
  blockingLayer: EvaluationDiagnosis["blockingLayer"];
  dominantReasons: string[];
} {
  const layers = [
    {
      layer: "strategy" as const,
      count: sumReasonCounts(diagnostics.reasons.strategy) + sumReasonCounts(diagnostics.reasons.strategyTags),
      reasons: [
        ...topReasonEntries(diagnostics.reasons.strategy, 2),
        ...topReasonEntries(diagnostics.reasons.strategyTags, 1)
      ]
    },
    {
      layer: "risk" as const,
      count: sumReasonCounts(diagnostics.reasons.risk),
      reasons: topReasonEntries(diagnostics.reasons.risk)
    },
    {
      layer: "execution" as const,
      count: sumReasonCounts(diagnostics.reasons.execution),
      reasons: topReasonEntries(diagnostics.reasons.execution)
    },
    {
      layer: "coordinator" as const,
      count: sumReasonCounts(diagnostics.reasons.coordinator),
      reasons: topReasonEntries(diagnostics.reasons.coordinator)
    }
  ].sort((left, right) => right.count - left.count);

  const top = layers[0];
  const second = layers[1];

  if (!top || top.count <= 0) {
    return {
      blockingLayer: "none",
      dominantReasons: []
    };
  }

  if (second && second.count > 0 && second.count >= top.count * 0.85) {
    return {
      blockingLayer: "mixed",
      dominantReasons: [...top.reasons, ...second.reasons].filter(Boolean).slice(0, 3)
    };
  }

  return {
    blockingLayer: top.layer,
    dominantReasons: top.reasons
  };
}

function failedEvaluationDiagnosis(
  evaluation: CandidateBacktestEvaluation
): EvaluationDiagnosis {
  const stage = evaluation.failure?.stage ?? "unknown";
  const message = evaluation.failure?.message ?? "evaluation failed";
  const stagePrescriptionMap: Record<string, string[]> = {
    worker: [
      "Stabilize the evaluation worker path before tuning strategy logic.",
      "Treat this as infrastructure debt, not a trading signal."
    ],
    preload: [
      "Fix market data availability or preload assumptions before changing strategy parameters.",
      "Do not trust performance conclusions until the data path is stable."
    ],
    split: [
      "Repair the train/test or walk-forward split before tuning the strategy.",
      "Use a valid window layout or a longer candle span before retesting."
    ],
    backtest: [
      "Fix the backtest/runtime failure before interpreting performance.",
      "Do not continue parameter search until the strategy executes end to end."
    ]
  };

  return {
    primaryFailureMode: "failed_evaluation",
    blockingLayer: "none",
    summary: `Evaluation failed at ${stage}: ${message}`.slice(0, 220),
    prescriptions: stagePrescriptionMap[stage] ?? stagePrescriptionMap.backtest,
    dominantReasons: [],
    feesAteProfits: false,
    fewTrades: true,
    tooFewTradesForStatistics: true,
    underperformsBaseline: false,
    highGhostRatio: false,
    windowSpread: 0,
    signalsGenerated: 0,
    signalsBlocked: 0
  };
}

export function deriveEvaluationDiagnosis(
  evaluation: CandidateBacktestEvaluation
): EvaluationDiagnosis {
  if (evaluation.status !== "completed") {
    return failedEvaluationDiagnosis(evaluation);
  }

  const s = evaluation.summary;
  const d = evaluation.diagnostics;
  const w = d.windows;
  const totalClosedTrades = w.totalClosedTrades ?? s.tradeCount;
  const signalsGenerated = d.coverage.signalCount;
  const signalsBlocked =
    d.coverage.ghostSignalCount +
    d.coverage.rejectedOrdersCount +
    d.coverage.cooldownSkipsCount;
  const fewTrades = totalClosedTrades < 5;
  const tooFewTradesForStatistics = totalClosedTrades < 10;
  const highGhostRatio =
    signalsGenerated > 0 &&
    d.coverage.ghostSignalCount > signalsGenerated * 1.5;
  const feesAteProfits =
    s.grossReturn > 0 &&
    (s.netReturn <= 0 || (s.grossReturn - s.netReturn) >= Math.max(s.grossReturn * 0.5, 0.01));
  const windowSpread = (w.bestWindowNetReturn ?? s.netReturn) - (w.worstWindowNetReturn ?? s.netReturn);
  const buyAndHoldReturn = s.buyAndHoldReturn;
  const excessReturn =
    typeof buyAndHoldReturn === "number"
      ? s.netReturn - buyAndHoldReturn
      : undefined;
  const underperformsBaseline =
    typeof excessReturn === "number"
      ? excessReturn <= 0
      : s.netReturn <= 0;
  const { blockingLayer, dominantReasons } = dominantBlockingLayer(d);
  const positiveWindowRatio = w.positiveWindowRatio ?? 0;
  const regimeFragility =
    (w.windowCount ?? 0) >= 3 &&
    (
      positiveWindowRatio < 0.6 ||
      (windowSpread >= 0.12 && (w.worstWindowNetReturn ?? s.netReturn) < 0)
    );
  const blockedSignals =
    signalsGenerated > 0 &&
    (
      signalsBlocked >= Math.max(signalsGenerated, 5) ||
      highGhostRatio
    );
  const topRejectReasons = collectTopRejectReasons(d);

  if (blockedSignals) {
    return {
      primaryFailureMode: "blocked_signals",
      blockingLayer,
      summary:
        blockingLayer === "none"
          ? `Signals are firing (${signalsGenerated}) but ${signalsBlocked} are being blocked before turning into trades.`
          : `Signals are firing (${signalsGenerated}) but ${signalsBlocked} are being blocked mainly by ${blockingLayer}: ${dominantReasons.join(", ") || "no dominant reason recorded"}.`,
      prescriptions: [
        blockingLayer === "strategy"
          ? "Relax the dominant strategy filters before changing exits or risk caps."
          : blockingLayer === "risk"
            ? "Tune stops, cooldowns, or risk caps before changing entry logic."
            : blockingLayer === "execution"
              ? "Fix order sizing, min-notional, or execution constraints before adding new signals."
              : blockingLayer === "coordinator"
                ? "Relax portfolio coordination bottlenecks such as ranking or slot limits before tuning indicators."
                : "Separate true signal generation from downstream blocking before the next tuning pass.",
        "Do not interpret net return until enough of the generated signals can actually turn into trades."
      ],
      dominantReasons: dominantReasons.length > 0 ? dominantReasons : topRejectReasons,
      feesAteProfits,
      fewTrades,
      tooFewTradesForStatistics,
      underperformsBaseline,
      highGhostRatio,
      windowSpread: +(windowSpread * 100).toFixed(2),
      signalsGenerated,
      signalsBlocked
    };
  }

  if (tooFewTradesForStatistics) {
    return {
      primaryFailureMode: "too_few_trades",
      blockingLayer,
      summary: `Only ${totalClosedTrades} closed trades were observed, so the measured return is still mostly noise.`,
      prescriptions: [
        "Relax entry conditions or widen trigger bands until the candidate clears at least 10 closed trades.",
        "Do not overfit this candidate's return until trade count becomes statistically meaningful."
      ],
      dominantReasons: dominantReasons.length > 0 ? dominantReasons : topRejectReasons,
      feesAteProfits,
      fewTrades,
      tooFewTradesForStatistics,
      underperformsBaseline,
      highGhostRatio,
      windowSpread: +(windowSpread * 100).toFixed(2),
      signalsGenerated,
      signalsBlocked
    };
  }

  if (feesAteProfits) {
    return {
      primaryFailureMode: "cost_drag",
      blockingLayer,
      summary: `Gross return ${(s.grossReturn * 100).toFixed(2)}% is being dragged down to net ${(s.netReturn * 100).toFixed(2)}% by costs and turnover.`,
      prescriptions: [
        "Reduce turnover with wider thresholds, slower exits, or fewer low-conviction trades.",
        "Prefer higher-conviction trades before adding more signal complexity."
      ],
      dominantReasons: dominantReasons.length > 0 ? dominantReasons : topRejectReasons,
      feesAteProfits,
      fewTrades,
      tooFewTradesForStatistics,
      underperformsBaseline,
      highGhostRatio,
      windowSpread: +(windowSpread * 100).toFixed(2),
      signalsGenerated,
      signalsBlocked
    };
  }

  if (underperformsBaseline) {
    return {
      primaryFailureMode: "no_edge",
      blockingLayer,
      summary:
        typeof excessReturn === "number"
          ? `Net return ${(s.netReturn * 100).toFixed(2)}% trails buy-and-hold by ${(Math.abs(excessReturn) * 100).toFixed(2)}%, so the current structure is not producing real edge.`
          : `Net return ${(s.netReturn * 100).toFixed(2)}% does not show enough edge after costs.`,
      prescriptions: [
        "Change the strategy structure or family rather than nudging the same parameters again.",
        "Keep only hypotheses that can beat passive holding after costs."
      ],
      dominantReasons: dominantReasons.length > 0 ? dominantReasons : topRejectReasons,
      feesAteProfits,
      fewTrades,
      tooFewTradesForStatistics,
      underperformsBaseline,
      highGhostRatio,
      windowSpread: +(windowSpread * 100).toFixed(2),
      signalsGenerated,
      signalsBlocked
    };
  }

  if (regimeFragility) {
    return {
      primaryFailureMode: "regime_fragility",
      blockingLayer,
      summary: `The candidate has edge in some windows but the ${+(windowSpread * 100).toFixed(2)}% window spread and ${(positiveWindowRatio * 100).toFixed(1)}% positive-window ratio show regime fragility.`,
      prescriptions: [
        "Add or tighten regime filters so the bad windows are explicitly screened out.",
        "Tune for smoother worst-window behavior before chasing higher peak returns."
      ],
      dominantReasons: dominantReasons.length > 0 ? dominantReasons : topRejectReasons,
      feesAteProfits,
      fewTrades,
      tooFewTradesForStatistics,
      underperformsBaseline,
      highGhostRatio,
      windowSpread: +(windowSpread * 100).toFixed(2),
      signalsGenerated,
      signalsBlocked
    };
  }

  if (blockingLayer === "risk" || blockingLayer === "execution" || blockingLayer === "coordinator") {
    return {
      primaryFailureMode: "risk_pressure",
      blockingLayer,
      summary: `The strategy appears viable, but ${blockingLayer} constraints dominate the bottleneck: ${dominantReasons.join(", ") || "no dominant reason recorded"}.`,
      prescriptions: [
        "Tune the bottleneck layer first instead of rewriting the entry thesis.",
        "Use the next candidate batch to isolate whether risk, execution, or coordination is throttling the edge."
      ],
      dominantReasons: dominantReasons.length > 0 ? dominantReasons : topRejectReasons,
      feesAteProfits,
      fewTrades,
      tooFewTradesForStatistics,
      underperformsBaseline,
      highGhostRatio,
      windowSpread: +(windowSpread * 100).toFixed(2),
      signalsGenerated,
      signalsBlocked
    };
  }

  if (
    !underperformsBaseline &&
    totalClosedTrades >= 10
  ) {
    return {
      primaryFailureMode: "healthy_edge",
      blockingLayer,
      summary: `The candidate is beating baseline with ${totalClosedTrades} closed trades; the next step is to preserve the thesis while improving robustness and drawdown.`,
      prescriptions: [
        "Preserve the core entry logic and tune worst-window behavior, drawdown, or costs around it.",
        "Prefer robustness improvements over a full structural rewrite."
      ],
      dominantReasons: dominantReasons.length > 0 ? dominantReasons : topRejectReasons,
      feesAteProfits,
      fewTrades,
      tooFewTradesForStatistics,
      underperformsBaseline,
      highGhostRatio,
      windowSpread: +(windowSpread * 100).toFixed(2),
      signalsGenerated,
      signalsBlocked
    };
  }

  return {
    primaryFailureMode: "mixed",
    blockingLayer,
    summary: "The candidate is neither clearly broken nor clearly strong; inspect the dominant reject reasons before the next tuning pass.",
    prescriptions: [
      "Change one structural assumption at a time so the next evaluation isolates the main bottleneck.",
      "Use the dominant reject reasons to decide whether to relax filters, change exits, or rotate families."
    ],
    dominantReasons: dominantReasons.length > 0 ? dominantReasons : topRejectReasons,
    feesAteProfits,
    fewTrades,
    tooFewTradesForStatistics,
    underperformsBaseline,
    highGhostRatio,
    windowSpread: +(windowSpread * 100).toFixed(2),
    signalsGenerated,
    signalsBlocked
  };
}

export function buildEvaluationAnalysis(evaluation: CandidateBacktestEvaluation) {
  const s = evaluation.summary;
  const d = evaluation.diagnostics;
  const w = d.windows;
  const diagnosis = deriveEvaluationDiagnosis(evaluation);
  const buyAndHoldReturn = s.buyAndHoldReturn;
  const excessReturn = buyAndHoldReturn !== undefined ? s.netReturn - buyAndHoldReturn : undefined;

  return {
    candidateId: evaluation.candidate.candidateId,
    familyId: evaluation.candidate.familyId,
    parameters: evaluation.candidate.parameters,
    netReturn: +(s.netReturn * 100).toFixed(2),
    grossReturn: +(s.grossReturn * 100).toFixed(2),
    buyAndHoldReturn: buyAndHoldReturn !== undefined ? +(buyAndHoldReturn * 100).toFixed(2) : undefined,
    excessReturn: excessReturn !== undefined ? +(excessReturn * 100).toFixed(2) : undefined,
    maxDrawdown: +(s.maxDrawdown * 100).toFixed(2),
    tradeCount: s.tradeCount,
    totalClosedTrades: w.totalClosedTrades ?? s.tradeCount,
    feePaid: +s.feePaid.toFixed(4),
    winRate: +(s.winRate * 100).toFixed(1),
    positiveWindowRatio: w.positiveWindowRatio ?? 0,
    bestWindow: +(( w.bestWindowNetReturn ?? 0) * 100).toFixed(2),
    worstWindow: +((w.worstWindowNetReturn ?? 0) * 100).toFixed(2),
    windowCount: w.windowCount ?? 0,
    diagnosis
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
    topFailureModes: Record<string, number>;
    blockingLayers: Record<string, number>;
  }>();

  for (const iteration of history) {
    for (const evaluation of iteration.evaluations) {
      const current = byFamily.get(evaluation.candidate.familyId) ?? {
        evaluations: 0,
        tradeful: 0,
        positive: 0,
        bestNetReturn: Number.NEGATIVE_INFINITY,
        bestTradeCount: 0,
        topReasons: {},
        topFailureModes: {},
        blockingLayers: {}
      };
      const diagnosis = deriveEvaluationDiagnosis(evaluation);

      current.evaluations += 1;
      current.tradeful += evaluation.summary.tradeCount > 0 ? 1 : 0;
      current.positive += evaluation.summary.netReturn > 0 ? 1 : 0;
      current.bestNetReturn = Math.max(current.bestNetReturn, evaluation.summary.netReturn);
      current.bestTradeCount = Math.max(current.bestTradeCount, evaluation.summary.tradeCount);
      for (const [reason, count] of Object.entries(evaluation.diagnostics.reasons.strategy)) {
        current.topReasons[reason] = (current.topReasons[reason] ?? 0) + count;
      }
      current.topFailureModes[diagnosis.primaryFailureMode] =
        (current.topFailureModes[diagnosis.primaryFailureMode] ?? 0) + 1;
      current.blockingLayers[diagnosis.blockingLayer] =
        (current.blockingLayers[diagnosis.blockingLayer] ?? 0) + 1;
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
        .slice(0, 5),
      topFailureModes: Object.entries(value.topFailureModes)
        .sort((left, right) => right[1] - left[1])
        .slice(0, 4),
      topBlockingLayers: Object.entries(value.blockingLayers)
        .sort((left, right) => right[1] - left[1])
        .slice(0, 4)
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
  recentEvaluationAnalyses: params.history.slice(-2).flatMap((iteration) =>
    iteration.evaluations.map(buildEvaluationAnalysis)
  ),
  priorHistory: compactHistory(params.history)
})}

Task:
1. Think like an auto-research agent, not a human explainer.
2. Read recentEvaluationAnalyses[*].diagnosis before proposing the next batch.
3. Generate executable candidates only from the listed families.
4. Prefer diverse hypotheses and material logic changes over tiny parameter nudges.
5. If the evidence points to data or code debt instead of strategy debt, use preparation or codeTasks explicitly.

Return JSON only:
{
  "researchSummary": "short summary",
  "preparation": [],
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
      "requiredData": ["1h"],
      "implementationNotes": ["what code would need to change"],
      "composition": {
        "mode": "weighted_vote",
        "components": [
          {
            "familyId": "leader-pullback-state-machine",
            "weight": 1.0
          }
        ]
      }
    }
  ],
  "codeTasks": [
    {
      "title": "implement new family",
      "intent": "implement_strategy",
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
  latestEvaluationAnalyses: params.evaluations.map(buildEvaluationAnalysis),
  familyPerformanceSummary: compactFamilyPerformance(params.history),
  candidateLedgerSummary: compactCandidateLedger(params.history),
  candidateGenealogy: compactCandidateGenealogy(params.history),
  priorHistory: compactHistory(params.history)
})}

Task:
1. Decide whether to promote, keep searching, or stop because no edge is visible.
2. Base the decision on the structured JSON facts in this iteration, especially latestEvaluationAnalyses[*].diagnosis.
3. If searching should continue, propose the next executable candidate batch.
4. Favor robustness and credible trade count over one-off lucky returns.
5. Retire failed ideas explicitly when appropriate.

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
  previousDiagnosis?: { summary: string; observations: string[] };
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

${params.previousDiagnosis ? `
CRITICAL — Previous iteration diagnosis (you MUST address these issues):
- Summary: ${params.previousDiagnosis.summary}
- Issues found: ${params.previousDiagnosis.observations.join("; ")}
Your next candidates MUST fix these specific problems. Do NOT repeat the same mistakes.
` : ""}
Task:
1. Read recentEvaluations[*].diagnosis first. Use diagnosis.summary, prescriptions, topRejectReasons, and excessReturn to decide what to change.
2. Every next candidate must say in its thesis what failure it is trying to fix.
3. Prefer material changes to thesis, entry/exit logic, or regime controls over tiny numeric nudges.
4. If the evidence says there is no edge over buy-and-hold, rotate to a meaningfully different block idea instead of repeating the same shape.
5. Generate executable candidates from the listed block families only.

Return JSON only:
{
  "researchSummary": "short summary",
  "preparation": [],
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

Task:
1. Start from diagnosis.primaryFailureMode, diagnosis.summary, and diagnosis.prescriptions for each candidate.
2. In your summary, name the actual mechanism: no edge vs baseline, too few trades, cost drag, regime fragility, blocked execution, or genuine healthy edge.
3. If you continue searching, turn the diagnosis into concrete nextCandidates. Each next candidate must address a specific problem from this iteration.
4. Do not propose random nudges. Change only what the evidence justifies.
5. Promote only when the evidence shows positive return, acceptable robustness, and enough trades to matter.

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
  latestEvaluationAnalyses: params.evaluations.map(buildEvaluationAnalysis),
  familyPerformanceSummary: compactFamilyPerformance(params.history),
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
3. Use latestEvaluationAnalyses[*].diagnosis.summary and prescriptions to distinguish edge failure from coordination, risk, or execution bottlenecks.

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
