import { candidateFingerprint } from "./proposal-utils.js";
import { calculateCandidateRiskAdjustedScore } from "./ranking.js";
import type {
  CandidateBacktestEvaluation,
  ResearchIterationRecord
} from "./types.js";

export type AutoResearchLeaderboardEntry = {
  iteration: number;
  candidateId: string;
  familyId: string;
  riskAdjustedScore: number;
  netReturn: number;
  maxDrawdown: number;
  tradeCount: number;
  buyAndHoldReturn?: number;
  excessReturn?: number;
  parameters: Record<string, number>;
};

export type AutoResearchCandidateLedgerEntry = {
  fingerprint: string;
  familyId: string;
  parameters: Record<string, number>;
  firstCandidateId: string;
  lastCandidateId: string;
  firstIteration: number;
  lastIteration: number;
  appearances: number;
  bestNetReturn: number;
  bestTradeCount: number;
  positiveAppearances: number;
  tradefulAppearances: number;
};

export type AutoResearchFamilySummaryEntry = {
  familyId: string;
  evaluations: number;
  uniqueCandidates: number;
  positiveEvaluations: number;
  tradefulEvaluations: number;
  bestNetReturn: number;
  bestTradeNetReturn?: number;
  bestTradeCount: number;
  totalTrades: number;
  lastIteration: number;
};

export type AutoResearchCandidateGenealogyEntry = {
  iteration: number;
  candidateId: string;
  familyId: string;
  origin: string;
  parentCandidateIds: string[];
  netReturn: number;
  tradeCount: number;
};

function buildLeaderboard(
  iterations: ResearchIterationRecord[],
  liveEvaluations: CandidateBacktestEvaluation[] = []
): AutoResearchLeaderboardEntry[] {
  const toEntry = (evaluation: CandidateBacktestEvaluation, iter: number): AutoResearchLeaderboardEntry => {
    const bh = evaluation.summary.buyAndHoldReturn;
    return {
      iteration: iter,
      candidateId: evaluation.candidate.candidateId,
      familyId: evaluation.candidate.familyId,
      riskAdjustedScore: calculateCandidateRiskAdjustedScore(evaluation),
      netReturn: evaluation.summary.netReturn,
      maxDrawdown: evaluation.summary.maxDrawdown,
      tradeCount: evaluation.summary.tradeCount,
      buyAndHoldReturn: bh,
      excessReturn: bh !== undefined ? evaluation.summary.netReturn - bh : undefined,
      parameters: evaluation.candidate.parameters
    };
  };

  return [
    ...iterations.flatMap((iteration) =>
      iteration.evaluations.map((evaluation) => toEntry(evaluation, iteration.iteration))
    ),
    ...liveEvaluations.map((evaluation) => toEntry(evaluation, iterations.length + 1))
  ].sort((left, right) => {
    if (right.riskAdjustedScore !== left.riskAdjustedScore) {
      return right.riskAdjustedScore - left.riskAdjustedScore;
    }

    if (right.netReturn !== left.netReturn) {
      return right.netReturn - left.netReturn;
    }

    if (left.maxDrawdown !== right.maxDrawdown) {
      return left.maxDrawdown - right.maxDrawdown;
    }

    return right.tradeCount - left.tradeCount;
  });
}

function buildUniqueLeaderboard(
  entries: AutoResearchLeaderboardEntry[]
): AutoResearchLeaderboardEntry[] {
  const bestByKey = new Map<string, AutoResearchLeaderboardEntry>();

  for (const entry of entries) {
    const key = candidateFingerprint(entry);
    if (!bestByKey.has(key)) {
      bestByKey.set(key, entry);
    }
  }

  return [...bestByKey.values()];
}

function buildCandidateLedger(
  iterations: ResearchIterationRecord[],
  liveEvaluations: CandidateBacktestEvaluation[] = []
): AutoResearchCandidateLedgerEntry[] {
  const ledger = new Map<string, AutoResearchCandidateLedgerEntry>();

  const register = (iteration: number, evaluation: CandidateBacktestEvaluation) => {
    const fingerprint = candidateFingerprint(evaluation.candidate);
    const existing = ledger.get(fingerprint);

    if (!existing) {
      ledger.set(fingerprint, {
        fingerprint,
        familyId: evaluation.candidate.familyId,
        parameters: evaluation.candidate.parameters,
        firstCandidateId: evaluation.candidate.candidateId,
        lastCandidateId: evaluation.candidate.candidateId,
        firstIteration: iteration,
        lastIteration: iteration,
        appearances: 1,
        bestNetReturn: evaluation.summary.netReturn,
        bestTradeCount: evaluation.summary.tradeCount,
        positiveAppearances: evaluation.summary.netReturn > 0 ? 1 : 0,
        tradefulAppearances: evaluation.summary.tradeCount > 0 ? 1 : 0
      });
      return;
    }

    existing.lastCandidateId = evaluation.candidate.candidateId;
    existing.lastIteration = iteration;
    existing.appearances += 1;
    existing.bestNetReturn = Math.max(existing.bestNetReturn, evaluation.summary.netReturn);
    existing.bestTradeCount = Math.max(existing.bestTradeCount, evaluation.summary.tradeCount);
    existing.positiveAppearances += evaluation.summary.netReturn > 0 ? 1 : 0;
    existing.tradefulAppearances += evaluation.summary.tradeCount > 0 ? 1 : 0;
  };

  for (const iteration of iterations) {
    for (const evaluation of iteration.evaluations) {
      register(iteration.iteration, evaluation);
    }
  }

  for (const evaluation of liveEvaluations) {
    register(iterations.length + 1, evaluation);
  }

  return [...ledger.values()].sort((left, right) => {
    if (right.bestNetReturn !== left.bestNetReturn) {
      return right.bestNetReturn - left.bestNetReturn;
    }

    if (right.bestTradeCount !== left.bestTradeCount) {
      return right.bestTradeCount - left.bestTradeCount;
    }

    return right.appearances - left.appearances;
  });
}

function buildFamilySummary(
  ledger: AutoResearchCandidateLedgerEntry[]
): AutoResearchFamilySummaryEntry[] {
  const byFamily = new Map<string, AutoResearchFamilySummaryEntry>();

  for (const entry of ledger) {
    const current = byFamily.get(entry.familyId) ?? {
      familyId: entry.familyId,
      evaluations: 0,
      uniqueCandidates: 0,
      positiveEvaluations: 0,
      tradefulEvaluations: 0,
      bestNetReturn: Number.NEGATIVE_INFINITY,
      bestTradeNetReturn: undefined,
      bestTradeCount: 0,
      totalTrades: 0,
      lastIteration: 0
    };

    current.evaluations += entry.appearances;
    current.uniqueCandidates += 1;
    current.positiveEvaluations += entry.positiveAppearances;
    current.tradefulEvaluations += entry.tradefulAppearances;
    current.bestNetReturn = Math.max(current.bestNetReturn, entry.bestNetReturn);
    if (entry.bestTradeCount > 0) {
      current.bestTradeCount = Math.max(current.bestTradeCount, entry.bestTradeCount);
      current.bestTradeNetReturn =
        typeof current.bestTradeNetReturn === "number"
          ? Math.max(current.bestTradeNetReturn, entry.bestNetReturn)
          : entry.bestNetReturn;
    }
    current.totalTrades += entry.bestTradeCount;
    current.lastIteration = Math.max(current.lastIteration, entry.lastIteration);
    byFamily.set(entry.familyId, current);
  }

  return [...byFamily.values()].sort((left, right) => {
    if (right.bestNetReturn !== left.bestNetReturn) {
      return right.bestNetReturn - left.bestNetReturn;
    }

    if (right.tradefulEvaluations !== left.tradefulEvaluations) {
      return right.tradefulEvaluations - left.tradefulEvaluations;
    }

    return right.evaluations - left.evaluations;
  });
}

function buildCandidateGenealogy(
  iterations: ResearchIterationRecord[],
  liveEvaluations: CandidateBacktestEvaluation[] = []
): AutoResearchCandidateGenealogyEntry[] {
  const entries: AutoResearchCandidateGenealogyEntry[] = [];

  const appendEntry = (iteration: number, evaluation: CandidateBacktestEvaluation) => {
    entries.push({
      iteration,
      candidateId: evaluation.candidate.candidateId,
      familyId: evaluation.candidate.familyId,
      origin: evaluation.candidate.origin ?? "llm",
      parentCandidateIds: [...(evaluation.candidate.parentCandidateIds ?? [])],
      netReturn: evaluation.summary.netReturn,
      tradeCount: evaluation.summary.tradeCount
    });
  };

  for (const iteration of iterations) {
    for (const evaluation of iteration.evaluations) {
      appendEntry(iteration.iteration, evaluation);
    }
  }

  for (const evaluation of liveEvaluations) {
    appendEntry(iterations.length + 1, evaluation);
  }

  return entries.sort((left, right) => {
    if (right.iteration !== left.iteration) {
      return right.iteration - left.iteration;
    }

    return right.netReturn - left.netReturn;
  });
}

export function buildAutoResearchArtifactSummaries(params: {
  iterations: ResearchIterationRecord[];
  liveEvaluations?: CandidateBacktestEvaluation[];
}): {
  rawLeaderboard: AutoResearchLeaderboardEntry[];
  leaderboard: AutoResearchLeaderboardEntry[];
  candidateLedger: AutoResearchCandidateLedgerEntry[];
  familySummary: AutoResearchFamilySummaryEntry[];
  candidateGenealogy: AutoResearchCandidateGenealogyEntry[];
} {
  const rawLeaderboard = buildLeaderboard(params.iterations, params.liveEvaluations);
  const leaderboard = buildUniqueLeaderboard(rawLeaderboard);
  const candidateLedger = buildCandidateLedger(params.iterations, params.liveEvaluations);
  const familySummary = buildFamilySummary(candidateLedger);
  const candidateGenealogy = buildCandidateGenealogy(params.iterations, params.liveEvaluations);

  return {
    rawLeaderboard,
    leaderboard,
    candidateLedger,
    familySummary,
    candidateGenealogy
  };
}
