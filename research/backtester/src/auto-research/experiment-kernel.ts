import {
  augmentProposalBatchWithEngineCandidates,
  buildExperimentPlan,
  compileCandidateBatch
} from "./experiment-compiler.js";
import type {
  AutoResearchRunConfig,
  ExperimentPlan,
  NormalizedCandidateProposal,
  ProposalBatch,
  ResearchHypothesis,
  ResearchIterationRecord,
  StrategyFamilyDefinition
} from "./types.js";

export type PreparedExperimentKernel = {
  proposal: ProposalBatch;
  experimentPlan: ExperimentPlan;
  normalizedCandidates: NormalizedCandidateProposal[];
  diversifiedCandidates: NormalizedCandidateProposal[];
};

export async function prepareExperimentKernel(params: {
  config: AutoResearchRunConfig;
  proposal: ProposalBatch;
  families: StrategyFamilyDefinition[];
  history: ResearchIterationRecord[];
  iteration: number;
  hiddenFamilyIds?: Iterable<string>;
  hypotheses?: ResearchHypothesis[];
}): Promise<PreparedExperimentKernel> {
  const augmentedProposal = await augmentProposalBatchWithEngineCandidates({
    proposal: params.proposal,
    config: params.config,
    families: params.families,
    history: params.history,
    iteration: params.iteration,
    hiddenFamilyIds: params.hiddenFamilyIds
  });
  const experimentPlan = buildExperimentPlan({
    config: params.config,
    proposal: augmentedProposal,
    families: params.families,
    history: params.history,
    iteration: params.iteration,
    hiddenFamilyIds: params.hiddenFamilyIds,
    hypotheses: params.hypotheses
  });
  const normalizedCandidates = compileCandidateBatch({
    proposal: augmentedProposal,
    families: params.families,
    history: params.history,
    iteration: params.iteration,
    limit: params.config.candidatesPerIteration,
    minDistance: params.config.candidateDiversificationMinDistance,
    hiddenFamilyIds: params.hiddenFamilyIds
  });
  const hiddenFamilyIds = new Set(params.hiddenFamilyIds ?? []);
  const diversifiedCandidates = normalizedCandidates
    .filter((candidate) => !hiddenFamilyIds.has(candidate.familyId))
    .slice(0, params.config.candidatesPerIteration);

  return {
    proposal: augmentedProposal,
    experimentPlan,
    normalizedCandidates,
    diversifiedCandidates
  };
}
