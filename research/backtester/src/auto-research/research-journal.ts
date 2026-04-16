import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ReviewDecision } from "./types.js";

export type ResearchJournalEntry = {
  entryId: string;
  timestamp: string;
  category: "discovery" | "design" | "evaluation" | "observation";
  ideaTitle: string;
  thesis: string;
  outcome: "success" | "failure" | "partial" | "pending";
  outcomeReason: string;
  metrics?: {
    netReturn: number;
    tradeCount: number;
    maxDrawdown: number;
  };
  candidateId?: string;
  relatedCandidateIds?: string[];
  reviewVerdict?: ReviewDecision["verdict"];
  nextActionHint?: string;
  failureMode?: string;
  evidence?: string[];
  tags?: string[];
  lessonsLearned: string[];
  relatedFamilyIds: string[];
  iteration: number;
};

export type ResearchJournal = {
  entries: ResearchJournalEntry[];
  patterns: string[];
  antiPatterns: string[];
  updatedAt: string;
};

const JOURNAL_FILE = "research-journal.json";
const MAX_ENTRIES = 200;

export async function loadJournal(outputDir: string): Promise<ResearchJournal> {
  try {
    const content = await readFile(path.join(outputDir, JOURNAL_FILE), "utf8");
    const parsed = JSON.parse(content) as Partial<ResearchJournal>;
    return {
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      patterns: Array.isArray(parsed.patterns) ? parsed.patterns : [],
      antiPatterns: Array.isArray(parsed.antiPatterns) ? parsed.antiPatterns : [],
      updatedAt: parsed.updatedAt ?? new Date().toISOString()
    };
  } catch {
    return { entries: [], patterns: [], antiPatterns: [], updatedAt: new Date().toISOString() };
  }
}

export async function saveJournal(outputDir: string, journal: ResearchJournal): Promise<void> {
  // Trim to max entries (keep most recent)
  const trimmed: ResearchJournal = {
    ...journal,
    entries: journal.entries.slice(-MAX_ENTRIES),
    updatedAt: new Date().toISOString()
  };
  await writeFile(
    path.join(outputDir, JOURNAL_FILE),
    JSON.stringify(trimmed, null, 2)
  );
}

export async function appendJournalEntry(outputDir: string, entry: ResearchJournalEntry): Promise<void> {
  const journal = await loadJournal(outputDir);
  journal.entries.push(entry);
  await saveJournal(outputDir, journal);
}

export function buildJournalSummary(journal: ResearchJournal): {
  patterns: string[];
  antiPatterns: string[];
  recentEntries: string[];
} {
  const recent = journal.entries.slice(-10).map((e) => {
    const metrics = e.metrics ? ` net=${(e.metrics.netReturn * 100).toFixed(1)}% trades=${e.metrics.tradeCount}` : "";
    return `[${e.outcome}] ${e.ideaTitle}:${metrics} — ${e.outcomeReason}`;
  });

  return {
    patterns: journal.patterns,
    antiPatterns: journal.antiPatterns,
    recentEntries: recent
  };
}

export function createEvaluationEntry(params: {
  iteration: number;
  familyId: string;
  title: string;
  thesis: string;
  netReturn: number;
  tradeCount: number;
  maxDrawdown: number;
  promoted: boolean;
  candidateId?: string;
  reviewVerdict?: ReviewDecision["verdict"];
  nextActionHint?: string;
  observations?: string[];
}): ResearchJournalEntry {
  const {
    iteration,
    familyId,
    title,
    thesis,
    netReturn,
    tradeCount,
    maxDrawdown,
    promoted,
    candidateId,
    reviewVerdict,
    nextActionHint,
    observations
  } = params;

  const outcome: ResearchJournalEntry["outcome"] =
    promoted ? "success" :
    tradeCount === 0 ? "failure" :
    netReturn > 0 ? "partial" : "failure";

  const outcomeReason =
    promoted ? `Promoted with net=${(netReturn * 100).toFixed(2)}%` :
    tradeCount === 0 ? "Zero trades generated" :
    reviewVerdict === "stop_no_edge" && netReturn > 0 ? `Positive but blocked by promotion gate: net=${(netReturn * 100).toFixed(2)}%` :
    reviewVerdict === "keep_searching" && netReturn > 0 ? `Positive but not yet differentiated: net=${(netReturn * 100).toFixed(2)}%` :
    netReturn > 0 ? `Positive but below promotion threshold: net=${(netReturn * 100).toFixed(2)}%` :
    `Negative return: net=${(netReturn * 100).toFixed(2)}%`;

  const lessonsLearned: string[] = [];
  if (tradeCount === 0) lessonsLearned.push("Strategy generated no trades — check signal conditions");
  if (tradeCount > 0 && netReturn < -0.05) lessonsLearned.push("Large losses — consider tighter stop-loss or regime filter");
  if (maxDrawdown > 0.2) lessonsLearned.push("High drawdown — position sizing or risk management needed");
  if (netReturn > 0 && netReturn < 0.02) lessonsLearned.push("Marginal edge — may not survive transaction costs at higher frequency");
  if (reviewVerdict === "stop_no_edge" && netReturn > 0) {
    lessonsLearned.push("Positive holdout result was still not strong enough to clear the promotion gate");
  }
  if (nextActionHint) {
    lessonsLearned.push(nextActionHint);
  }

  const evidence = [
    `net=${(netReturn * 100).toFixed(2)}%`,
    `trades=${tradeCount}`,
    `maxDrawdown=${(maxDrawdown * 100).toFixed(2)}%`,
    ...(reviewVerdict ? [`review=${reviewVerdict}`] : []),
    ...(observations ?? []).slice(0, 3)
  ];

  const failureMode =
    promoted ? undefined :
    tradeCount === 0 ? "zero_trades" :
    reviewVerdict === "stop_no_edge" && netReturn > 0 ? "promotion_blocked" :
    netReturn > 0 ? "insufficient_edge" :
    "negative_return";

  return {
    entryId: `eval-${familyId}-${iteration}-${Date.now()}`,
    timestamp: new Date().toISOString(),
    category: "evaluation",
    ideaTitle: title,
    thesis,
    outcome,
    outcomeReason,
    metrics: { netReturn, tradeCount, maxDrawdown },
    candidateId,
    relatedCandidateIds: candidateId ? [candidateId] : undefined,
    reviewVerdict,
    nextActionHint,
    failureMode,
    evidence,
    tags: [
      "evaluation",
      promoted ? "promoted" : "not-promoted",
      reviewVerdict ?? "review-unknown"
    ],
    lessonsLearned,
    relatedFamilyIds: [familyId],
    iteration
  };
}

export function createObservationEntry(params: {
  iteration: number;
  title: string;
  thesis: string;
  outcome: ResearchJournalEntry["outcome"];
  outcomeReason: string;
  relatedFamilyIds?: string[];
  relatedCandidateIds?: string[];
  candidateId?: string;
  reviewVerdict?: ReviewDecision["verdict"];
  nextActionHint?: string;
  failureMode?: string;
  evidence?: string[];
  tags?: string[];
  lessonsLearned?: string[];
}): ResearchJournalEntry {
  const lessonsLearned = [...(params.lessonsLearned ?? [])];
  if (params.nextActionHint) {
    lessonsLearned.push(params.nextActionHint);
  }

  return {
    entryId: `obs-${params.iteration}-${Date.now()}`,
    timestamp: new Date().toISOString(),
    category: "observation",
    ideaTitle: params.title,
    thesis: params.thesis,
    outcome: params.outcome,
    outcomeReason: params.outcomeReason,
    candidateId: params.candidateId,
    relatedCandidateIds: params.relatedCandidateIds,
    reviewVerdict: params.reviewVerdict,
    nextActionHint: params.nextActionHint,
    failureMode: params.failureMode,
    evidence: params.evidence,
    tags: params.tags,
    lessonsLearned,
    relatedFamilyIds: params.relatedFamilyIds ?? [],
    iteration: params.iteration
  };
}
