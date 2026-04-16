import type {
  CandidateProposal,
  NormalizedCandidateProposal,
  ProposalBatch
} from "./types.js";

export function stableParametersKey(parameters: Record<string, number>): string {
  return JSON.stringify(
    Object.keys(parameters)
      .sort((left, right) => left.localeCompare(right))
      .reduce<Record<string, number>>((result, key) => {
        result[key] = Number((parameters[key] ?? 0).toFixed(4));
        return result;
      }, {})
  );
}

export function candidateFingerprint(
  candidate: Pick<NormalizedCandidateProposal | CandidateProposal, "familyId" | "parameters">
): string {
  return `${candidate.familyId}:${stableParametersKey(candidate.parameters)}`;
}

export function buildHypothesisIdsFromProposal(params: {
  proposal: ProposalBatch;
  iteration: number;
}): string[] {
  const seen = new Set<string>();
  const hypothesisIds: string[] = [];

  for (const [index, candidate] of params.proposal.candidates.entries()) {
    const key = candidateFingerprint(candidate);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    hypothesisIds.push(`hyp-${String(params.iteration).padStart(2, "0")}-${String(index + 1).padStart(2, "0")}`);
  }

  if (hypothesisIds.length === 0) {
    for (const [index] of params.proposal.proposedFamilies.entries()) {
      hypothesisIds.push(`hyp-family-${String(params.iteration).padStart(2, "0")}-${String(index + 1).padStart(2, "0")}`);
    }
  }

  return hypothesisIds;
}
