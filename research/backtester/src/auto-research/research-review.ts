import type { ResearchLlmClient } from "./llm-adapter.js";
import {
  buildDeterministicContinuationProposal,
  candidateFingerprint
} from "./experiment-compiler.js";
import {
  compareCandidateEvaluations,
  passesPromotionGate
} from "./ranking.js";
import type {
  AutoResearchRunConfig,
  CandidateBacktestEvaluation,
  CandidateProposal,
  ProposalBatch,
  ResearchIterationRecord,
  ReviewDecision,
  StrategyFamilyDefinition,
  ValidatedBlockCatalog
} from "./types.js";

export type ReviewedIterationResult = {
  review: ReviewDecision;
  reviewFailureMessage?: string;
  usedObjectiveGovernance: boolean;
};

function withTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined, label: string): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) {
    return promise;
  }

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export function appendReviewObservation(review: ReviewDecision, observation: string): ReviewDecision {
  return {
    ...review,
    observations: [...review.observations, observation]
  };
}

function promotionGateConfig(config: AutoResearchRunConfig) {
  return {
    minTrades: config.minTradesForPromotion,
    minNetReturn: config.minNetReturnForPromotion,
    maxDrawdown: config.maxDrawdownForPromotion,
    minPositiveWindowRatio: config.minPositiveWindowRatioForPromotion,
    minWorstWindowNetReturn: config.minWorstWindowNetReturnForPromotion,
    minRandomPercentile: config.minRandomPercentileForPromotion,
    requireBootstrapSignificance: config.requireBootstrapSignificanceForPromotion
  };
}

function findTopPromotableEvaluation(
  evaluations: CandidateBacktestEvaluation[],
  config: AutoResearchRunConfig
): CandidateBacktestEvaluation | undefined {
  const gateConfig = promotionGateConfig(config);
  return evaluations.find((evaluation) => passesPromotionGate(evaluation, gateConfig));
}

export function governReviewDecision(params: {
  review: ReviewDecision;
  evaluations: CandidateBacktestEvaluation[];
  config: AutoResearchRunConfig;
  iteration: number;
  familyStagnationStreak?: Map<string, number>;
  familyIterationCounts?: Map<string, number>;
}): ReviewDecision {
  const { review, evaluations, config, iteration } = params;
  const isContinuousMode = config.continuousMode === true;
  const isFinalIteration = !isContinuousMode && iteration >= config.iterations;

  // Anti self-bias: force stop when stagnation is severe and no candidate passes gate
  if (
    review.verdict === "keep_searching" &&
    params.familyStagnationStreak &&
    params.familyStagnationStreak.size > 0
  ) {
    const stagnationThreshold = config.stagnationRetireThreshold ?? 8;
    const evaluatedFamilies = new Set(evaluations.map((e) => e.candidate.familyId));
    const allStagnant = [...evaluatedFamilies].every(
      (fid) => (params.familyStagnationStreak!.get(fid) ?? 0) >= stagnationThreshold
    );
    const topPromotable = findTopPromotableEvaluation(evaluations, config);

    if (allStagnant && !topPromotable) {
      return appendReviewObservation(
        {
          ...review,
          verdict: "stop_no_edge",
          promotedCandidateId: undefined,
          nextCandidates: [],
          summary: `${review.summary} Anti self-bias: all evaluated families stagnant for ${stagnationThreshold}+ iterations with no promotable candidate.`.trim()
        },
        `Anti self-bias override: forced stop_no_edge due to universal stagnation across ${evaluatedFamilies.size} families.`
      );
    }

    // Force stop on families with negative returns after half their budget
    if (params.familyIterationCounts) {
      const budget = config.familyIterationBudget ?? 20;
      const halfBudget = Math.floor(budget / 2);
      for (const fid of evaluatedFamilies) {
        const iterCount = params.familyIterationCounts.get(fid) ?? 0;
        if (iterCount >= halfBudget) {
          const familyEvals = evaluations.filter((e) => e.candidate.familyId === fid);
          const bestReturn = Math.max(...familyEvals.map((e) => e.summary.netReturn));
          if (bestReturn < 0) {
            return appendReviewObservation(
              {
                ...review,
                verdict: "stop_no_edge",
                promotedCandidateId: undefined,
                nextCandidates: [],
                summary: `${review.summary} Anti self-bias: family ${fid} negative after half budget.`.trim()
              },
              `Anti self-bias override: family ${fid} still negative (best=${(bestReturn * 100).toFixed(2)}%) after ${iterCount} iterations (half-budget=${halfBudget}). Forced stop.`
            );
          }
        }
      }
    }
  }
  const topPromotable = findTopPromotableEvaluation(evaluations, config);
  const requestedPromoted = review.promotedCandidateId
    ? evaluations.find((item) => item.candidate.candidateId === review.promotedCandidateId)
    : undefined;
  const requestedPromotedPassesGate = requestedPromoted
    ? passesPromotionGate(requestedPromoted, promotionGateConfig(config))
    : false;

  if (review.verdict === "promote_candidate" && topPromotable) {
    if (
      review.promotedCandidateId === topPromotable.candidate.candidateId &&
      requestedPromotedPassesGate
    ) {
      return review;
    }

    const observation =
      review.promotedCandidateId && requestedPromoted
        ? `Review promoted ${review.promotedCandidateId}, but objective governance selected ${topPromotable.candidate.candidateId}.`
        : `Review promotion was incomplete; objective governance selected ${topPromotable.candidate.candidateId}.`;

    return appendReviewObservation(
      {
        ...review,
        verdict: "promote_candidate",
        promotedCandidateId: topPromotable.candidate.candidateId,
        summary: `${review.summary} Objective governance promoted ${topPromotable.candidate.candidateId}.`.trim()
      },
      observation
    );
  }

  if (
    topPromotable &&
    (
      review.verdict === "stop_no_edge" ||
      (review.verdict === "keep_searching" && isFinalIteration)
    )
  ) {
    const reason = review.verdict === "stop_no_edge"
      ? `Review returned stop_no_edge, but objective governance promoted ${topPromotable.candidate.candidateId}.`
      : `Final iteration kept searching, but objective governance promoted ${topPromotable.candidate.candidateId}.`;

    return appendReviewObservation(
      {
        ...review,
        verdict: "promote_candidate",
        promotedCandidateId: topPromotable.candidate.candidateId,
        summary: `${review.summary} ${reason}`.trim()
      },
      reason
    );
  }

  if (review.verdict === "promote_candidate" && !requestedPromotedPassesGate) {
    const nextVerdict = isFinalIteration ? "stop_no_edge" : "keep_searching";
    const reason = review.promotedCandidateId
      ? `Promotion gate blocked ${review.promotedCandidateId}; switching verdict to ${nextVerdict}.`
      : `Review did not provide a valid promoted candidate; switching verdict to ${nextVerdict}.`;

    return appendReviewObservation(
      {
        ...review,
        verdict: nextVerdict,
        promotedCandidateId: undefined,
        summary: `${review.summary} ${reason}`.trim()
      },
      reason
    );
  }

  return review;
}

function dedupeCandidateProposals(candidates: CandidateProposal[]): CandidateProposal[] {
  const seen = new Set<string>();

  return candidates.filter((candidate) => {
    const key = candidateFingerprint(candidate);
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

export function ensureNextCandidatesForKeepSearching(params: {
  review: ReviewDecision;
  limit: number;
  iteration: number;
}): ReviewDecision {
  if (params.review.verdict !== "keep_searching") {
    return params.review;
  }

  const uniqueReviewCandidates = dedupeCandidateProposals(params.review.nextCandidates).slice(0, params.limit);
  if (uniqueReviewCandidates.length === 0) {
    throw new Error(
      `LLM review returned keep_searching without any unique next candidates for iteration ${params.iteration}.`
    );
  }

  const nextCandidates = [...uniqueReviewCandidates];
  const candidateListsMatch =
    nextCandidates.length === params.review.nextCandidates.length &&
    nextCandidates.every(
      (candidate, index) =>
        candidateFingerprint(candidate) === candidateFingerprint(params.review.nextCandidates[index]!)
    );

  if (candidateListsMatch) {
    return params.review;
  }

  let nextReview: ReviewDecision = {
    ...params.review,
    nextCandidates
  };

  if (uniqueReviewCandidates.length < params.review.nextCandidates.length) {
    nextReview = appendReviewObservation(
      nextReview,
      `Review keep_searching candidates were deduped from ${params.review.nextCandidates.length} to ${uniqueReviewCandidates.length}.`
    );
  }

  if (nextCandidates.length < params.review.nextCandidates.length) {
    nextReview = appendReviewObservation(
      nextReview,
      `Review keep_searching candidates were trimmed to the configured candidate limit of ${params.limit}.`
    );
  }

  return nextReview;
}

export function toReviewProposalBatch(
  proposal: ProposalBatch,
  evaluations: CandidateBacktestEvaluation[]
): ProposalBatch {
  return {
    ...proposal,
    candidates: evaluations.map((evaluation) => ({
      candidateId: evaluation.candidate.candidateId,
      familyId: evaluation.candidate.familyId,
      thesis: evaluation.candidate.thesis,
      parameters: evaluation.candidate.parameters,
      invalidationSignals: evaluation.candidate.invalidationSignals,
      parentCandidateIds: evaluation.candidate.parentCandidateIds,
      origin: evaluation.candidate.origin
    }))
  };
}

function buildObjectiveReview(params: {
  config: AutoResearchRunConfig;
  families: StrategyFamilyDefinition[];
  history: ResearchIterationRecord[];
  iteration: number;
  evaluations: CandidateBacktestEvaluation[];
  summary: string;
}): ReviewDecision {
  const sortedEvaluations = [...params.evaluations].sort(compareCandidateEvaluations);
  const continuation = buildDeterministicContinuationProposal({
    evaluations: sortedEvaluations,
    families: params.families,
    history: params.history,
    iteration: params.iteration,
    candidateLimit: params.config.candidatesPerIteration,
    summary: params.summary
  });

  const isContinuousMode = params.config.continuousMode === true;
  const isFinalIteration = !isContinuousMode && params.iteration >= params.config.iterations;

  return {
    summary: params.summary,
    verdict: isFinalIteration ? "stop_no_edge" : "keep_searching",
    promotedCandidateId: undefined,
    nextPreparation: continuation.preparation,
    proposedFamilies: [],
    codeTasks: [],
    nextCandidates: isFinalIteration ? [] : continuation.candidates,
    retireCandidateIds: [],
    observations: [
      "Objective governance review was used because the LLM review path did not return a valid response."
    ]
  };
}

export async function generateIterationReview(params: {
  llmClient: ResearchLlmClient;
  config: AutoResearchRunConfig;
  families: StrategyFamilyDefinition[];
  history: ResearchIterationRecord[];
  proposal: ProposalBatch;
  evaluations: CandidateBacktestEvaluation[];
  preparationResults: Array<{
    action: ProposalBatch["preparation"][number];
    status: "executed" | "skipped" | "failed";
    detail: string;
  }>;
  codeMutationResults: Array<{
    taskId: string;
    familyId?: string;
    strategyName?: string;
    title: string;
    status: "planned" | "executed" | "failed" | "skipped";
    detail: string;
  }>;
  validationResults: Array<{
    command: string;
    status: "passed" | "failed" | "skipped";
    detail: string;
  }>;
  iteration: number;
  blockCatalog?: ValidatedBlockCatalog;
  familyStagnationStreak?: Map<string, number>;
  familyIterationCounts?: Map<string, number>;
}): Promise<ReviewedIterationResult> {
  let review: ReviewDecision | undefined;
  let reviewFailureMessage: string | undefined;
  let usedObjectiveGovernance = false;
  const reviewProposal = toReviewProposalBatch(params.proposal, params.evaluations);

  try {
    review = await withTimeout(
      params.llmClient.reviewIteration({
        config: params.config,
        families: params.families,
        history: params.history,
        latestProposal: reviewProposal,
        preparationResults: params.preparationResults,
        codeMutationResults: params.codeMutationResults,
        validationResults: params.validationResults,
        evaluations: params.evaluations,
        blockCatalog: params.blockCatalog
      }),
      params.config.llmTimeoutMs,
      "auto-research review"
    );
  } catch (error) {
    reviewFailureMessage = error instanceof Error ? error.message : String(error);
  }

  if (!review && params.config.loopVersion === "v2") {
    usedObjectiveGovernance = true;
    review = buildObjectiveReview({
      config: params.config,
      families: params.families,
      history: params.history,
      iteration: params.iteration,
      evaluations: params.evaluations,
      summary: reviewFailureMessage
        ? `Objective governance continued after review failure: ${reviewFailureMessage}`
        : "Objective governance continued without an LLM review."
    });
  }

  if (!review) {
    throw new Error(reviewFailureMessage ?? `Missing review for iteration ${params.iteration}.`);
  }

  try {
    review = governReviewDecision({
      review,
      evaluations: params.evaluations,
      config: params.config,
      iteration: params.iteration,
      familyStagnationStreak: params.familyStagnationStreak,
      familyIterationCounts: params.familyIterationCounts
    });
    review = ensureNextCandidatesForKeepSearching({
      review,
      limit: params.config.candidatesPerIteration,
      iteration: params.iteration
    });
  } catch (error) {
    if (params.config.loopVersion !== "v2") {
      throw error;
    }

    usedObjectiveGovernance = true;
    const message = error instanceof Error ? error.message : String(error);
    review = appendReviewObservation(
      buildObjectiveReview({
        config: params.config,
        families: params.families,
        history: params.history,
        iteration: params.iteration,
        evaluations: params.evaluations,
        summary: review.summary
      }),
      `Objective compiler supplied a deterministic next batch because review continuation was invalid: ${message}`
    );
  }

  return {
    review,
    reviewFailureMessage,
    usedObjectiveGovernance
  };
}
