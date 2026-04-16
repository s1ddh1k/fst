import { normalizeCandidateProposal } from "./catalog.js";
import { candidateFingerprint } from "./proposal-utils.js";
import type {
  AutoResearchRunConfig,
  ExperimentPlan,
  NormalizedCandidateProposal,
  ProposalBatch,
  StrategyFamilyDefinition
} from "./types.js";

export type PreparedExperimentKernel = {
  experimentPlan: ExperimentPlan;
  normalizedCandidates: NormalizedCandidateProposal[];
  diversifiedCandidates: NormalizedCandidateProposal[];
};

function selectDiversifiedCandidates(
  candidates: NormalizedCandidateProposal[],
  limit: number
): NormalizedCandidateProposal[] {
  if (candidates.length <= limit) {
    return candidates;
  }

  const selected: NormalizedCandidateProposal[] = [];
  const seenFamilies = new Set<string>();

  for (const candidate of candidates) {
    if (selected.length >= limit) {
      break;
    }
    if (seenFamilies.has(candidate.familyId)) {
      continue;
    }

    selected.push(candidate);
    seenFamilies.add(candidate.familyId);
  }

  if (selected.length >= limit) {
    return selected;
  }

  for (const candidate of candidates) {
    if (selected.length >= limit) {
      break;
    }
    if (selected.includes(candidate)) {
      continue;
    }

    selected.push(candidate);
  }

  return selected;
}

export function prepareExperimentKernel(params: {
  config: AutoResearchRunConfig;
  proposal: ProposalBatch;
  families: StrategyFamilyDefinition[];
  iteration: number;
  hiddenFamilyIds?: Iterable<string>;
  hypothesisIds?: string[];
}): PreparedExperimentKernel {
  const hiddenFamilyIds = new Set(params.hiddenFamilyIds ?? []);
  const seenFingerprints = new Set<string>();
  const normalizedCandidates = params.proposal.candidates
    .flatMap((proposal, index) => {
      try {
        const candidate = normalizeCandidateProposal(proposal, params.families, index);
        if (hiddenFamilyIds.has(candidate.familyId)) {
          return [];
        }

        const fingerprint = candidateFingerprint(candidate);
        if (seenFingerprints.has(fingerprint)) {
          return [];
        }

        seenFingerprints.add(fingerprint);
        return [candidate];
      } catch {
        return [];
      }
    });

  const diversifiedCandidates = selectDiversifiedCandidates(
    normalizedCandidates,
    params.config.candidatesPerIteration
  );

  if (diversifiedCandidates.length === 0) {
    throw new Error("Proposal did not contain any executable candidates.");
  }

  const experimentPlan: ExperimentPlan = {
    planId: `plan-${String(params.iteration).padStart(2, "0")}`,
    hypothesisId:
      params.hypothesisIds?.[0] ??
      `hyp-${String(params.iteration).padStart(2, "0")}-01`,
    mode: "candidate_batch",
    candidates: diversifiedCandidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      familyId: candidate.familyId,
      thesis: candidate.thesis,
      parameters: candidate.parameters,
      parentCandidateIds: candidate.parentCandidateIds,
      origin: candidate.origin,
      invalidationSignals: candidate.invalidationSignals
    })),
    preparation: params.proposal.preparation,
    validationCommands: [],
    budget: {
      candidateLimit: params.config.candidatesPerIteration,
      marketLimit: params.config.marketLimit,
      timeoutMs: params.config.llmTimeoutMs
    }
  };

  return {
    experimentPlan,
    normalizedCandidates,
    diversifiedCandidates
  };
}
