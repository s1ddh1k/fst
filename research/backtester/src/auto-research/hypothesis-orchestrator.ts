import type { ResearchLlmClient } from "./llm-adapter.js";
import {
  buildArtifactSeedCandidates,
  buildDeterministicContinuationProposal,
  buildHypothesesFromProposal,
  candidateFingerprint,
  midpointParameters
} from "./experiment-compiler.js";
import type {
  AutoResearchRunConfig,
  CandidateProposal,
  ProposalBatch,
  ResearchHypothesis,
  ResearchIterationRecord,
  StrategyFamilyDefinition,
  ValidatedBlockCatalog
} from "./types.js";

export type HypothesisProposalSource =
  | "resume"
  | "llm"
  | "objective_continuation"
  | "objective_seed";

export type GeneratedHypothesisProposal = {
  proposal: ProposalBatch;
  hypotheses: ResearchHypothesis[];
  source: HypothesisProposalSource;
  note?: string;
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

function dedupeCandidates(candidates: CandidateProposal[]): CandidateProposal[] {
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

async function buildObjectiveSeedProposal(params: {
  config: AutoResearchRunConfig;
  families: StrategyFamilyDefinition[];
  history: ResearchIterationRecord[];
  marketCodes: string[];
  iteration: number;
  hiddenFamilyIds?: Iterable<string>;
  note?: string;
}): Promise<ProposalBatch> {
  if (params.history.length > 0) {
    const latestEvaluations = params.history[params.history.length - 1]?.evaluations ?? [];
    if (latestEvaluations.length > 0) {
      return buildDeterministicContinuationProposal({
        evaluations: latestEvaluations,
        families: params.families,
        history: params.history,
        iteration: params.iteration - 1,
        candidateLimit: params.config.candidatesPerIteration,
        summary:
          params.note ??
          "Objective continuation replaced an unavailable LLM proposal."
      });
    }
  }

  const hiddenFamilyIds = new Set(params.hiddenFamilyIds ?? []);
  const representedFamilies = new Set<string>();
  const usedFingerprints = new Set<string>(
    params.history.flatMap((iteration) =>
      iteration.evaluations.map((evaluation) => candidateFingerprint(evaluation.candidate))
    )
  );
  const candidates: CandidateProposal[] = await buildArtifactSeedCandidates({
    config: params.config,
    families: params.families,
    hiddenFamilyIds,
    usedFingerprints,
    iteration: params.iteration
  });

  for (const candidate of candidates) {
    representedFamilies.add(candidate.familyId);
  }

  const eligibleFamilies = params.families.filter((family) => !hiddenFamilyIds.has(family.familyId));
  for (const family of eligibleFamilies) {
    if (candidates.length >= params.config.candidatesPerIteration) {
      break;
    }
    if (representedFamilies.has(family.familyId)) {
      continue;
    }

    const seedCandidate: CandidateProposal = {
      candidateId: `${family.familyId}-objective-seed-${String(params.iteration).padStart(2, "0")}-${String(candidates.length + 1).padStart(2, "0")}`,
      familyId: family.familyId,
      thesis: `Objective seed candidate for ${family.familyId}.`,
      parameters: midpointParameters(family),
      origin: "engine_seed",
      invalidationSignals: [
        "objective seed fails to create a tradeable branch",
        "drawdown exceeds acceptable bounds",
        "edge does not survive walk-forward validation"
      ]
    };

    const fingerprint = candidateFingerprint(seedCandidate);
    if (usedFingerprints.has(fingerprint)) {
      continue;
    }

    usedFingerprints.add(fingerprint);
    representedFamilies.add(family.familyId);
    candidates.push(seedCandidate);
  }

  const dedupedCandidates = dedupeCandidates(candidates).slice(0, params.config.candidatesPerIteration);

  return {
    researchSummary:
      params.note ??
      `Objective seed proposal compiled for ${params.marketCodes.length} markets because the LLM proposal path was unavailable.`,
    preparation: [],
    proposedFamilies: [],
    codeTasks: [],
    candidates: dedupedCandidates
  };
}

export async function generateHypothesisProposal(params: {
  llmClient: ResearchLlmClient;
  config: AutoResearchRunConfig;
  families: StrategyFamilyDefinition[];
  marketCodes: string[];
  history: ResearchIterationRecord[];
  iteration: number;
  nextProposal?: ProposalBatch;
  blockCatalog?: ValidatedBlockCatalog;
  hiddenFamilyIds?: Iterable<string>;
}): Promise<GeneratedHypothesisProposal> {
  if (params.nextProposal) {
    return {
      proposal: params.nextProposal,
      hypotheses: buildHypothesesFromProposal({
        proposal: params.nextProposal,
        iteration: params.iteration
      }),
      source: "resume"
    };
  }

  try {
    const proposal = await withTimeout(
      params.llmClient.proposeCandidates({
        config: params.config,
        families: params.families,
        marketCodes: params.marketCodes,
        history: params.history,
        blockCatalog: params.blockCatalog
      }),
      params.config.llmTimeoutMs,
      "auto-research proposal"
    );

    return {
      proposal,
      hypotheses: buildHypothesesFromProposal({
        proposal,
        iteration: params.iteration
      }),
      source: "llm"
    };
  } catch (error) {
    if (params.config.loopVersion !== "v2") {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    const proposal = await buildObjectiveSeedProposal({
      config: params.config,
      families: params.families,
      history: params.history,
      marketCodes: params.marketCodes,
      iteration: params.iteration,
      hiddenFamilyIds: params.hiddenFamilyIds,
      note: `Objective seed proposal continued after proposal failure: ${message}`
    });

    return {
      proposal,
      hypotheses: buildHypothesesFromProposal({
        proposal,
        iteration: params.iteration
      }),
      source: params.history.length > 0 ? "objective_continuation" : "objective_seed",
      note: message
    };
  }
}
