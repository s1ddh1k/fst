import type { ResearchLlmClient } from "./llm-adapter.js";
import { candidateFingerprint } from "./proposal-utils.js";
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

export function ensureReviewDecisionReferencesEvaluatedCandidates(params: {
  review: ReviewDecision;
  evaluations: CandidateBacktestEvaluation[];
  iteration: number;
}): ReviewDecision {
  if (params.review.verdict !== "promote_candidate") {
    return params.review;
  }

  if (!params.review.promotedCandidateId) {
    throw new Error(
      `LLM review returned promote_candidate without a promotedCandidateId for iteration ${params.iteration}.`
    );
  }

  const promotedExists = params.evaluations.some(
    (evaluation) => evaluation.candidate.candidateId === params.review.promotedCandidateId
  );
  if (promotedExists) {
    return params.review;
  }

  throw new Error(
    `LLM review promoted unknown candidate ${params.review.promotedCandidateId} for iteration ${params.iteration}.`
  );
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
}): Promise<ReviewedIterationResult> {
  let review: ReviewDecision | undefined;
  const reviewProposal = toReviewProposalBatch(params.proposal, params.evaluations);
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

  review = ensureReviewDecisionReferencesEvaluatedCandidates({
    review,
    evaluations: params.evaluations,
    iteration: params.iteration
  });
  review = ensureNextCandidatesForKeepSearching({
    review,
    limit: params.config.candidatesPerIteration,
    iteration: params.iteration
  });

  return {
    review
  };
}
