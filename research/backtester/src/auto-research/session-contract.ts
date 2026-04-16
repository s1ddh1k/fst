import type { ResearchJournal } from "./research-journal.js";
import type {
  AutoResearchRunConfig,
  AutoResearchRunOutcome,
  CandidateBacktestEvaluation,
  ProposalBatch,
  StrategyFamilyDefinition
} from "./types.js";
import type { AutoResearchStatus } from "./run-manager.js";

function pct(value: number | undefined): string {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "-";
  }

  return `${(value * 100).toFixed(2)}%`;
}

function int(value: number | undefined): string {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "-";
  }

  return String(Math.round(value));
}

function renderBulletList(items: string[], emptyText = "- none"): string {
  if (items.length === 0) {
    return emptyText;
  }

  return items.map((item) => `- ${item}`).join("\n");
}

function summarizeFamilies(families: StrategyFamilyDefinition[]): string[] {
  return families.map((family) => {
    const guardrails = family.guardrails.slice(0, 2).join("; ");
    return `${family.familyId} (${family.timeframe}) — ${family.title}${guardrails ? ` | ${guardrails}` : ""}`;
  });
}

function summarizePendingProposal(pendingProposal: ProposalBatch | undefined): string[] {
  if (!pendingProposal) {
    return [];
  }

  const lines: string[] = [];

  for (const action of pendingProposal.preparation.slice(0, 3)) {
    lines.push(`prep: ${action.kind}`);
  }

  for (const task of pendingProposal.codeTasks.slice(0, 3)) {
    lines.push(`code: ${task.title}`);
  }

  for (const candidate of pendingProposal.candidates.slice(0, 4)) {
    lines.push(`candidate: ${candidate.familyId} ${JSON.stringify(candidate.parameters)}`);
  }

  return lines;
}

function summarizeJournalEntries(journal: ResearchJournal | undefined, outcome?: "failure" | "partial" | "success"): string[] {
  if (!journal) {
    return [];
  }

  return journal.entries
    .filter((entry) => (outcome ? entry.outcome === outcome : true))
    .slice(-5)
    .reverse()
    .map((entry) => `${entry.ideaTitle} [${entry.outcome}] — ${entry.outcomeReason}`);
}

function buildObjective(config: AutoResearchRunConfig, families: StrategyFamilyDefinition[]): string {
  const familyLabel =
    families.length > 0
      ? families.map((family) => family.familyId).join(", ")
      : (config.strategyFamilyIds?.join(", ") ?? "unspecified families");

  return `Find promotable out-of-sample edge for ${config.universeName} on ${config.timeframe} using ${config.mode} evaluation, while keeping drawdown and trade quality inside the promotion gate. Current family focus: ${familyLabel}.`;
}

function buildPromotionGate(config: AutoResearchRunConfig): string[] {
  return [
    `min net return: ${pct(config.minNetReturnForPromotion)}`,
    `max drawdown: ${pct(config.maxDrawdownForPromotion)}`,
    `min trades: ${int(config.minTradesForPromotion)}`,
    `min positive window ratio: ${pct(config.minPositiveWindowRatioForPromotion)}`,
    `min worst window return: ${pct(config.minWorstWindowNetReturnForPromotion)}`,
    `min random percentile: ${typeof config.minRandomPercentileForPromotion === "number" ? config.minRandomPercentileForPromotion.toFixed(2) : "-"}`,
    `require bootstrap significance: ${config.requireBootstrapSignificanceForPromotion === true ? "yes" : "no"}`
  ];
}

function buildBestCandidateLines(bestCandidate: CandidateBacktestEvaluation | undefined): string[] {
  if (!bestCandidate) {
    return [];
  }

  const windows = bestCandidate.diagnostics.windows;
  const crossChecks = bestCandidate.diagnostics.crossChecks
    .map((item) =>
      item.status === "completed"
        ? `${item.mode} ${pct(item.netReturn)} trades=${item.tradeCount}`
        : `${item.mode} failed (${item.failureMessage ?? "unknown"})`
    )
    .slice(0, 3);

  return [
    `candidate: ${bestCandidate.candidate.candidateId}`,
    `family: ${bestCandidate.candidate.familyId}`,
    `parameters: ${JSON.stringify(bestCandidate.candidate.parameters)}`,
    `net return: ${pct(bestCandidate.summary.netReturn)}`,
    `max drawdown: ${pct(bestCandidate.summary.maxDrawdown)}`,
    `trade count: ${bestCandidate.summary.tradeCount}`,
    `buy-and-hold: ${pct(bestCandidate.summary.buyAndHoldReturn)}`,
    `positive window ratio: ${pct(windows?.positiveWindowRatio)}`,
    ...crossChecks.map((item) => `cross-check: ${item}`)
  ];
}

export function renderSessionContractMarkdown(params: {
  generatedAt: string;
  config: AutoResearchRunConfig;
  outcome: AutoResearchRunOutcome;
  outcomeReason?: string;
  families: StrategyFamilyDefinition[];
  iterations: number;
  bestCandidate?: CandidateBacktestEvaluation;
  pendingProposal?: ProposalBatch;
  status?: AutoResearchStatus;
  journal?: ResearchJournal;
}): string {
  const patterns = params.journal?.patterns ?? [];
  const antiPatterns = params.journal?.antiPatterns ?? [];
  const pendingItems = summarizePendingProposal(params.pendingProposal);
  const bestCandidateLines = buildBestCandidateLines(params.bestCandidate);

  return [
    "# Auto Research Session",
    "",
    `Generated: ${params.generatedAt}`,
    "",
    "## Objective",
    buildObjective(params.config, params.families),
    "",
    "## Current Status",
    renderBulletList([
      `phase: ${params.status?.phase ?? params.outcome}`,
      `outcome: ${params.outcome}`,
      ...(params.outcomeReason ? [`outcome reason: ${params.outcomeReason}`] : []),
      `iteration progress: ${params.iterations}/${params.config.iterations}`,
      `parallelism: ${params.config.parallelism ?? 1}`,
      `code mutation: ${params.config.allowCodeMutation ? "enabled" : "disabled"}`,
      `feature cache build: ${params.config.allowFeatureCacheBuild ? "enabled" : "disabled"}`,
      `data collection: ${params.config.allowDataCollection ? "enabled" : "disabled"}`
    ]),
    "",
    "## Metrics",
    renderBulletList([
      "primary: promotion-gated out-of-sample edge",
      "secondary: net return, max drawdown, total trades, positive window ratio, random percentile, bootstrap significance, buy-and-hold excess return"
    ]),
    "",
    "## Run Contract",
    renderBulletList([
      `universe: ${params.config.universeName}`,
      `timeframe: ${params.config.timeframe}`,
      `mode: ${params.config.mode}`,
      `market limit: ${params.config.marketLimit}`,
      `candle limit: ${params.config.limit}`,
      `holdout days: ${params.config.holdoutDays}`,
      `training days: ${params.config.trainingDays ?? "-"}`,
      `step days: ${params.config.stepDays ?? "-"}`,
      `candidates per iteration: ${params.config.candidatesPerIteration}`,
      `continuous mode: ${params.config.continuousMode === true ? "yes" : "no"}`
    ]),
    "",
    "## Promotion Gate",
    renderBulletList(buildPromotionGate(params.config)),
    "",
    "## Active Families",
    renderBulletList(summarizeFamilies(params.families)),
    "",
    "## Current Best",
    renderBulletList(bestCandidateLines),
    "",
    "## Pending Next Batch",
    renderBulletList(pendingItems),
    "",
    "## Research Memory",
    "### Patterns",
    renderBulletList(patterns),
    "",
    "### Anti-Patterns",
    renderBulletList(antiPatterns),
    "",
    "### Recent Failures",
    renderBulletList(summarizeJournalEntries(params.journal, "failure")),
    "",
    "### Recent Partials",
    renderBulletList(summarizeJournalEntries(params.journal, "partial")),
    "",
    "### Recent Wins",
    renderBulletList(summarizeJournalEntries(params.journal, "success"))
  ].join("\n");
}
