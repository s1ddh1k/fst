import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildAutoResearchArtifactSummaries } from "./auto-research/artifact-summaries.js";
import {
  loadRunState,
  toReport,
  type AutoResearchRunState
} from "./auto-research/run-manager.js";
import type {
  AutoResearchArtifactAudit
} from "./auto-research/types.js";

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

function buildExpectedArtifacts(state: AutoResearchRunState) {
  const {
    rawLeaderboard,
    leaderboard,
    candidateLedger,
    familySummary,
    candidateGenealogy
  } = buildAutoResearchArtifactSummaries({
    iterations: state.iterations
  });
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
      state.iterations.map(async (_record, index) => {
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
