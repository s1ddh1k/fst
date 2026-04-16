import type { ResearchLlmClient } from "./llm-adapter.js";
import { buildHypothesisIdsFromProposal } from "./proposal-utils.js";
import type {
  AutoResearchRunConfig,
  ProposalBatch,
  ResearchIterationRecord,
  StrategyFamilyDefinition,
  ValidatedBlockCatalog
} from "./types.js";

export type HypothesisProposalSource = "resume" | "llm";

export type GeneratedHypothesisProposal = {
  proposal: ProposalBatch;
  hypothesisIds: string[];
  source: HypothesisProposalSource;
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

export async function generateHypothesisProposal(params: {
  llmClient: ResearchLlmClient;
  config: AutoResearchRunConfig;
  families: StrategyFamilyDefinition[];
  marketCodes: string[];
  history: ResearchIterationRecord[];
  iteration: number;
  nextProposal?: ProposalBatch;
  blockCatalog?: ValidatedBlockCatalog;
}): Promise<GeneratedHypothesisProposal> {
  if (params.nextProposal) {
    return {
      proposal: params.nextProposal,
      hypothesisIds: buildHypothesisIdsFromProposal({
        proposal: params.nextProposal,
        iteration: params.iteration
      }),
      source: "resume"
    };
  }

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
    hypothesisIds: buildHypothesisIdsFromProposal({
      proposal,
      iteration: params.iteration
    }),
    source: "llm"
  };
}
