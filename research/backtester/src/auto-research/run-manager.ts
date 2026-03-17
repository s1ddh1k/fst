import { appendFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AutoResearchRunConfig,
  AutoResearchRunReport,
  CandidateBacktestEvaluation,
  CatalogEntryRecord,
  ProposalBatch,
  ResearchIterationRecord,
  StrategyFamilyDefinition
} from "./types.js";

export type AutoResearchRunState = {
  generatedAt: string;
  config: AutoResearchRunConfig;
  families: StrategyFamilyDefinition[];
  catalog: CatalogEntryRecord[];
  marketCodes: string[];
  iterations: ResearchIterationRecord[];
  bestCandidate?: CandidateBacktestEvaluation;
  pendingProposal?: ProposalBatch;
  noTradeIterations: number;
};

type RunLockPayload = {
  pid: number;
  createdAt: string;
};

export type AutoResearchStatus = {
  updatedAt: string;
  phase:
    | "starting"
    | "proposal"
    | "preparation"
    | "code-mutation"
    | "validation"
    | "evaluation"
    | "review"
    | "completed";
  iteration: number;
  totalIterations: number;
  message: string;
  completedCandidates?: number;
  candidateTotal?: number;
  bestCandidateId?: string;
  bestNetReturn?: number;
};

function reviveDates<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => reviveDates(item)) as T;
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const record = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === "string" && /^\d{4}-\d{2}-\d{2}T/.test(entry)) {
      next[key] = new Date(entry);
      continue;
    }

    next[key] = reviveDates(entry);
  }

  return next as T;
}

function isProcessAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function compareEvaluations(left: CandidateBacktestEvaluation, right: CandidateBacktestEvaluation): number {
  if (left.status !== right.status) {
    return left.status === "failed" ? 1 : -1;
  }

  if (right.summary.netReturn !== left.summary.netReturn) {
    return right.summary.netReturn - left.summary.netReturn;
  }

  if (left.summary.maxDrawdown !== right.summary.maxDrawdown) {
    return left.summary.maxDrawdown - right.summary.maxDrawdown;
  }

  return right.summary.tradeCount - left.summary.tradeCount;
}

function selectBestTradeCandidate(iterations: ResearchIterationRecord[]): CandidateBacktestEvaluation | undefined {
  return iterations
    .flatMap((iteration) => iteration.evaluations)
    .filter((evaluation) => evaluation.status === "completed" && evaluation.summary.tradeCount > 0)
    .sort(compareEvaluations)[0];
}

export async function loadRunState(outputDir: string): Promise<AutoResearchRunState | undefined> {
  try {
    const raw = await readFile(path.join(outputDir, "run-state.json"), "utf8");
    return reviveDates(JSON.parse(raw)) as AutoResearchRunState;
  } catch {
    return undefined;
  }
}

export async function acquireRunLock(outputDir: string): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  const lockPath = path.join(outputDir, "run.lock.json");
  const payload: RunLockPayload = {
    pid: process.pid,
    createdAt: new Date().toISOString()
  };

  try {
    await writeFile(lockPath, `${JSON.stringify(payload, null, 2)}\n`, { flag: "wx" });
    return;
  } catch {
    try {
      const existing = JSON.parse(await readFile(lockPath, "utf8")) as RunLockPayload;
      if (!isProcessAlive(existing.pid)) {
        await unlink(lockPath);
        await writeFile(lockPath, `${JSON.stringify(payload, null, 2)}\n`, { flag: "wx" });
        return;
      }

      throw new Error(`Auto research run already active for ${outputDir} (pid=${existing.pid}).`);
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }

      throw new Error(`Auto research run already active for ${outputDir}.`);
    }
  }
}

export async function releaseRunLock(outputDir: string): Promise<void> {
  try {
    await unlink(path.join(outputDir, "run.lock.json"));
  } catch {
    // ignore missing lock cleanup
  }
}

export async function saveRunState(outputDir: string, state: AutoResearchRunState): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, "run-state.json"), `${JSON.stringify(state, null, 2)}\n`);
}

export async function saveRunStatus(outputDir: string, status: AutoResearchStatus): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, "status.json"), `${JSON.stringify(status, null, 2)}\n`);
}

export async function appendRunLog(outputDir: string, message: string): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  await appendFile(path.join(outputDir, "run.log"), `[${new Date().toISOString()}] ${message}\n`);
}

export async function saveLeaderboard(
  outputDir: string,
  leaderboard: Array<{
    iteration: number;
    candidateId: string;
    familyId: string;
    netReturn: number;
    maxDrawdown: number;
    tradeCount: number;
  }>,
  fileName = "leaderboard.json"
): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, fileName), `${JSON.stringify(leaderboard, null, 2)}\n`);
}

export function toReport(state: AutoResearchRunState): AutoResearchRunReport {
  return {
    generatedAt: state.generatedAt,
    config: state.config,
    families: state.families,
    catalog: state.catalog,
    marketCodes: state.marketCodes,
    iterations: state.iterations,
    bestCandidate: state.bestCandidate,
    bestTradeCandidate: selectBestTradeCandidate(state.iterations)
  };
}
