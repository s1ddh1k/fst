import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { candidateFingerprint } from "./auto-research/experiment-compiler.js";
import { calculateCandidateRiskAdjustedScore } from "./auto-research/ranking.js";
import {
  loadRunState,
  toReport,
  type AutoResearchRunState
} from "./auto-research/run-manager.js";
import type {
  AutoResearchArtifactAudit,
  CandidateBacktestEvaluation,
  ResearchIterationRecord
} from "./auto-research/types.js";

type LeaderboardEntry = {
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

type CandidateLedgerEntry = {
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

type FamilySummaryEntry = {
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

type CandidateGenealogyEntry = {
  iteration: number;
  candidateId: string;
  familyId: string;
  origin: string;
  parentCandidateIds: string[];
  netReturn: number;
  tradeCount: number;
};

function stableStringify(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tempPath, filePath);
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

function buildLeaderboard(
  iterations: ResearchIterationRecord[],
  liveEvaluations: CandidateBacktestEvaluation[] = []
): LeaderboardEntry[] {
  return [
    ...iterations.flatMap((iteration) =>
      iteration.evaluations.map((evaluation) => {
        const bh = evaluation.summary.buyAndHoldReturn;
        return {
          iteration: iteration.iteration,
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
      })
    ),
    ...liveEvaluations.map((evaluation) => {
      const bh = evaluation.summary.buyAndHoldReturn;
      return {
        iteration: iterations.length + 1,
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
    })
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

function buildUniqueLeaderboard(entries: LeaderboardEntry[]): LeaderboardEntry[] {
  const bestByKey = new Map<string, LeaderboardEntry>();

  for (const entry of entries) {
    const key = candidateFingerprint(entry);
    if (!bestByKey.has(key)) {
      bestByKey.set(key, entry);
    }
  }

  return [...bestByKey.values()];
}

function buildCandidateLedger(iterations: ResearchIterationRecord[]): CandidateLedgerEntry[] {
  const ledger = new Map<string, CandidateLedgerEntry>();

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

function buildFamilySummary(ledger: CandidateLedgerEntry[]): FamilySummaryEntry[] {
  const byFamily = new Map<string, FamilySummaryEntry>();

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

function buildCandidateGenealogy(iterations: ResearchIterationRecord[]): CandidateGenealogyEntry[] {
  const rows: CandidateGenealogyEntry[] = [];

  for (const iteration of iterations) {
    for (const evaluation of iteration.evaluations) {
      rows.push({
        iteration: iteration.iteration,
        candidateId: evaluation.candidate.candidateId,
        familyId: evaluation.candidate.familyId,
        origin: evaluation.candidate.origin ?? "llm",
        parentCandidateIds: evaluation.candidate.parentCandidateIds ?? [],
        netReturn: evaluation.summary.netReturn,
        tradeCount: evaluation.summary.tradeCount
      });
    }
  }

  return rows.sort((left, right) => {
    if (right.iteration !== left.iteration) {
      return right.iteration - left.iteration;
    }

    return right.netReturn - left.netReturn;
  });
}

function buildExpectedArtifacts(state: AutoResearchRunState) {
  const rawLeaderboard = buildLeaderboard(state.iterations);
  const leaderboard = buildUniqueLeaderboard(rawLeaderboard);
  const candidateLedger = buildCandidateLedger(state.iterations);
  const familySummary = buildFamilySummary(candidateLedger);
  const candidateGenealogy = buildCandidateGenealogy(state.iterations);
  const report = toReport(state);

  return {
    report,
    rawLeaderboard,
    leaderboard,
    candidateLedger,
    familySummary,
    candidateGenealogy
  };
}

function allChecksPass(checks: AutoResearchArtifactAudit["checks"]): boolean {
  return Object.values(checks).every(Boolean);
}

export async function auditAutoResearchArtifacts(outputDir: string): Promise<AutoResearchArtifactAudit> {
  const reportPath = path.join(outputDir, "artifact-audit.json");
  const state = await loadRunState(outputDir);

  if (!state) {
    return {
      ok: false,
      auditedAt: new Date().toISOString(),
      reportPath,
      failureReason: "run-state.json missing or unreadable",
      checks: {
        runStateMatchesReport: false,
        statusMatchesState: false,
        iterationArtifactsMatchState: false,
        leaderboardMatchesState: false,
        rawLeaderboardMatchesState: false,
        candidateLedgerMatchesState: false,
        familySummaryMatchesState: false,
        candidateGenealogyMatchesState: false,
        blockCatalogReadable: false,
        runLockCleared: false
      }
    };
  }

  const expected = buildExpectedArtifacts(state);
  let runStateMatchesReport = false;
  let statusMatchesState = false;
  let iterationArtifactsMatchState = false;
  let leaderboardMatchesState = false;
  let rawLeaderboardMatchesState = false;
  let candidateLedgerMatchesState = false;
  let familySummaryMatchesState = false;
  let candidateGenealogyMatchesState = false;
  let blockCatalogReadable = state.config.researchStage !== "block";
  let runLockCleared = false;
  let failureReason: string | undefined;

  try {
    const report = await readJson(path.join(outputDir, "report.json"));
    runStateMatchesReport = stableStringify(report) === stableStringify(expected.report);
    if (!runStateMatchesReport) {
      failureReason = "report.json does not match run-state.json";
    }

    const status = await readJson(path.join(outputDir, "status.json"));
    statusMatchesState = Boolean(
      status &&
      typeof status === "object" &&
      (status as { iteration?: number }).iteration === state.iterations.length &&
      (status as { totalIterations?: number }).totalIterations === state.config.iterations
    );
    if (!statusMatchesState && !failureReason) {
      failureReason = "status.json does not match terminal run-state counters";
    }

    const persistedLeaderboard = await readJson(path.join(outputDir, "leaderboard.json"));
    leaderboardMatchesState = stableStringify(persistedLeaderboard) === stableStringify(expected.leaderboard);
    if (!leaderboardMatchesState && !failureReason) {
      failureReason = "leaderboard.json does not match iteration state";
    }

    const persistedRawLeaderboard = await readJson(path.join(outputDir, "leaderboard.raw.json"));
    rawLeaderboardMatchesState =
      stableStringify(persistedRawLeaderboard) === stableStringify(expected.rawLeaderboard);
    if (!rawLeaderboardMatchesState && !failureReason) {
      failureReason = "leaderboard.raw.json does not match iteration state";
    }

    const persistedLedger = await readJson(path.join(outputDir, "candidate-ledger.json"));
    candidateLedgerMatchesState =
      stableStringify(persistedLedger) === stableStringify(expected.candidateLedger);
    if (!candidateLedgerMatchesState && !failureReason) {
      failureReason = "candidate-ledger.json does not match iteration state";
    }

    const persistedFamilySummary = await readJson(path.join(outputDir, "family-summary.json"));
    familySummaryMatchesState =
      stableStringify(persistedFamilySummary) === stableStringify(expected.familySummary);
    if (!familySummaryMatchesState && !failureReason) {
      failureReason = "family-summary.json does not match candidate ledger";
    }

    const persistedGenealogy = await readJson(path.join(outputDir, "candidate-genealogy.json"));
    candidateGenealogyMatchesState =
      stableStringify(persistedGenealogy) === stableStringify(expected.candidateGenealogy);
    if (!candidateGenealogyMatchesState && !failureReason) {
      failureReason = "candidate-genealogy.json does not match iteration state";
    }

    const persistedIterations = await Promise.all(
      state.iterations.map(async (record, index) => {
        const filePath = path.join(outputDir, `iteration-${String(index + 1).padStart(2, "0")}.json`);
        return await readJson(filePath);
      })
    );
    iterationArtifactsMatchState =
      stableStringify(persistedIterations) === stableStringify(state.iterations);
    if (!iterationArtifactsMatchState && !failureReason) {
      failureReason = "iteration artifacts do not match run-state iterations";
    }

    if (state.config.researchStage === "block") {
      await readJson(path.join(outputDir, "validated-blocks.json"));
      blockCatalogReadable = true;
    }

    try {
      await readFile(path.join(outputDir, "run.lock.json"), "utf8");
      runLockCleared = false;
      if (!failureReason) {
        failureReason = "run.lock.json still exists";
      }
    } catch {
      runLockCleared = true;
    }
  } catch (error) {
    if (!failureReason) {
      failureReason = error instanceof Error ? error.message : String(error);
    }
  }

  const checks = {
    runStateMatchesReport,
    statusMatchesState,
    iterationArtifactsMatchState,
    leaderboardMatchesState,
    rawLeaderboardMatchesState,
    candidateLedgerMatchesState,
    familySummaryMatchesState,
    candidateGenealogyMatchesState,
    blockCatalogReadable,
    runLockCleared
  };

  return {
    ok: allChecksPass(checks),
    auditedAt: new Date().toISOString(),
    reportPath,
    failureReason,
    checks
  };
}

export async function writeAutoResearchArtifactAudit(outputDir: string): Promise<AutoResearchArtifactAudit> {
  const audit = await auditAutoResearchArtifacts(outputDir);
  await writeJsonAtomic(path.join(outputDir, "artifact-audit.json"), audit);
  return audit;
}

function parseOutputDir(argv: string[]): string {
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === "--output-dir") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("--output-dir requires a value");
      }
      return path.resolve(next);
    }
  }

  throw new Error("--output-dir is required");
}

async function main() {
  try {
    const outputDir = parseOutputDir(process.argv.slice(2));
    const audit = await writeAutoResearchArtifactAudit(outputDir);
    process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
    process.exitCode = audit.ok ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
