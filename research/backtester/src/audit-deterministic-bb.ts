import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareCandidateEvaluations } from "./auto-research/ranking.js";
import type { CandidateBacktestEvaluation } from "./auto-research/types.js";
import type {
  DeterministicBbResearchReport,
  DeterministicBbResearchStatus,
  FamilyKey,
  FamilyReport
} from "./tune-bb-blocks.js";

type AuditSeverity = "error" | "warning";

type AuditIssue = {
  severity: AuditSeverity;
  code: string;
  message: string;
  filePath?: string;
  familyKey?: FamilyKey;
  candidateId?: string;
};

export type DeterministicBbAuditReport = {
  generatedAt: string;
  outputDir: string;
  ok: boolean;
  errors: AuditIssue[];
  warnings: AuditIssue[];
  summary: {
    familyCount: number;
    validatedBlockCount: number;
    overallLeaderboardCount: number;
    topSeedCount: number;
  };
};

type AuditOptions = {
  allowNonCompletedStatus?: boolean;
};

function pushIssue(
  issues: AuditIssue[],
  severity: AuditSeverity,
  code: string,
  message: string,
  filePath?: string,
  extras: Omit<AuditIssue, "severity" | "code" | "message" | "filePath"> = {}
): void {
  issues.push({ severity, code, message, filePath, ...extras });
}

async function readJsonFile<T>(filePath: string, issues: AuditIssue[]): Promise<T | null> {
  if (!fs.existsSync(filePath)) {
    pushIssue(issues, "error", "missing_file", `Missing required file: ${filePath}`, filePath);
    return null;
  }
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    pushIssue(
      issues,
      "error",
      "invalid_json",
      `Failed to parse JSON file: ${filePath} (${error instanceof Error ? error.message : String(error)})`,
      filePath
    );
    return null;
  }
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function measurementFromSummary(summary: Record<string, unknown>) {
  return {
    candidateId: summary.candidateId,
    familyId: summary.familyId,
    parameters: summary.parameters,
    totalReturn: summary.totalReturn,
    grossReturn: summary.grossReturn,
    netReturn: summary.netReturn,
    maxDrawdown: summary.maxDrawdown,
    tradeCount: summary.tradeCount,
    feePaid: summary.feePaid,
    slippagePaid: summary.slippagePaid,
    totalCostsPaid: summary.totalCostsPaid,
    positiveWindowRatio: summary.positiveWindowRatio ?? null,
    bestWindowNetReturn: summary.bestWindowNetReturn ?? null,
    worstWindowNetReturn: summary.worstWindowNetReturn ?? null,
    randomPercentile: summary.randomPercentile ?? null,
    bootstrapSignificant: summary.bootstrapSignificant ?? null
  };
}

function measurementFromEvaluation(evaluation: CandidateBacktestEvaluation) {
  return {
    candidateId: evaluation.candidate.candidateId,
    familyId: evaluation.candidate.familyId,
    parameters: evaluation.candidate.parameters,
    totalReturn: evaluation.summary.totalReturn,
    grossReturn: evaluation.summary.grossReturn,
    netReturn: evaluation.summary.netReturn,
    maxDrawdown: evaluation.summary.maxDrawdown,
    tradeCount: evaluation.summary.tradeCount,
    feePaid: evaluation.summary.feePaid,
    slippagePaid: evaluation.summary.slippagePaid,
    totalCostsPaid: evaluation.summary.feePaid + evaluation.summary.slippagePaid,
    positiveWindowRatio: evaluation.diagnostics.windows.positiveWindowRatio ?? null,
    bestWindowNetReturn: evaluation.diagnostics.windows.bestWindowNetReturn ?? null,
    worstWindowNetReturn: evaluation.diagnostics.windows.worstWindowNetReturn ?? null,
    randomPercentile:
      evaluation.summary.randomPercentile ??
      evaluation.diagnostics.robustness.randomPercentile ??
      null,
    bootstrapSignificant:
      evaluation.summary.bootstrapSignificant ??
      evaluation.diagnostics.robustness.bootstrapSignificant ??
      null
  };
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tempPath, filePath);
}

function expectedFamilyFilePaths(outputDir: string, familyKey: FamilyKey): Record<string, string> {
  const familyDir = path.join(outputDir, familyKey);
  return {
    familyDir,
    report: path.join(familyDir, "report.json"),
    leaderboard: path.join(familyDir, "leaderboard.json"),
    holdoutLeaderboard: path.join(familyDir, "holdout-leaderboard.json"),
    topSeeds: path.join(familyDir, "top-seeds.json"),
    walkForwardEvaluations: path.join(familyDir, "walk-forward-evaluations.json"),
    promotion: path.join(familyDir, "promotion.json"),
    feeDrag: path.join(familyDir, "fee-drag.json"),
    regimeDiagnostics: path.join(familyDir, "regime-diagnostics.json")
  };
}

async function readWalkForwardRawEvaluations(familyDir: string, issues: AuditIssue[]): Promise<CandidateBacktestEvaluation[]> {
  const rawDir = path.join(familyDir, "walk-forward-raw");
  if (!fs.existsSync(rawDir)) {
    return [];
  }

  const entries = fs.readdirSync(rawDir).filter((name) => name.endsWith(".json")).sort();
  const evaluations: CandidateBacktestEvaluation[] = [];
  for (const entry of entries) {
    const filePath = path.join(rawDir, entry);
    const evaluation = await readJsonFile<CandidateBacktestEvaluation>(filePath, issues);
    if (evaluation) {
      evaluations.push(evaluation);
    }
  }
  return evaluations;
}

async function readHoldoutRawEvaluations(
  familyDir: string,
  generation: number,
  issues: AuditIssue[]
): Promise<CandidateBacktestEvaluation[]> {
  const rawDir = path.join(familyDir, "holdout-raw", `generation-${String(generation).padStart(2, "0")}`);
  if (!fs.existsSync(rawDir)) {
    return [];
  }

  const entries = fs.readdirSync(rawDir).filter((name) => name.endsWith(".json")).sort();
  const evaluations: CandidateBacktestEvaluation[] = [];
  for (const entry of entries) {
    const filePath = path.join(rawDir, entry);
    const evaluation = await readJsonFile<CandidateBacktestEvaluation>(filePath, issues);
    if (evaluation) {
      evaluations.push(evaluation);
    }
  }
  return evaluations;
}

function validateFamilyCounts(
  familyReport: FamilyReport,
  issues: AuditIssue[],
  filePath: string,
  familyKey: FamilyKey
): void {
  if (!familyReport.failureCounts) {
    pushIssue(
      issues,
      "error",
      "family_missing_failure_counts",
      "Family report is missing failureCounts and cannot be fully audited.",
      filePath,
      { familyKey }
    );
    return;
  }
  if (
    typeof familyReport.holdoutAttemptedCount !== "number" ||
    typeof familyReport.holdoutSucceededCount !== "number" ||
    typeof familyReport.walkForwardAttemptedCount !== "number" ||
    typeof familyReport.walkForwardSucceededCount !== "number"
  ) {
    pushIssue(
      issues,
      "error",
      "family_missing_accounting_fields",
      "Family report is missing explicit attempted/succeeded accounting fields and cannot be fully audited.",
      filePath,
      { familyKey }
    );
    return;
  }

  if (familyReport.evaluatedCandidateCount !== familyReport.holdoutAttemptedCount) {
    pushIssue(
      issues,
      "error",
      "family_evaluated_count_mismatch",
      `evaluatedCandidateCount (${familyReport.evaluatedCandidateCount}) must equal holdoutAttemptedCount (${familyReport.holdoutAttemptedCount})`,
      filePath,
      { familyKey }
    );
  }

  if (familyReport.holdoutAttemptedCount !== familyReport.holdoutSucceededCount + familyReport.failureCounts.holdout) {
    pushIssue(
      issues,
      "error",
      "family_holdout_accounting_mismatch",
      `holdoutAttemptedCount (${familyReport.holdoutAttemptedCount}) must equal successes + failures (${familyReport.holdoutSucceededCount} + ${familyReport.failureCounts.holdout})`,
      filePath,
      { familyKey }
    );
  }

  if (
    familyReport.walkForwardAttemptedCount !==
    familyReport.walkForwardSucceededCount + familyReport.failureCounts.walkForward
  ) {
    pushIssue(
      issues,
      "error",
      "family_walk_forward_accounting_mismatch",
      `walkForwardAttemptedCount (${familyReport.walkForwardAttemptedCount}) must equal successes + failures (${familyReport.walkForwardSucceededCount} + ${familyReport.failureCounts.walkForward})`,
      filePath,
      { familyKey }
    );
  }

  if (familyReport.walkForwardTop.length > familyReport.walkForwardSucceededCount) {
    pushIssue(
      issues,
      "error",
      "family_walk_forward_top_overflow",
      `walkForwardTop length (${familyReport.walkForwardTop.length}) exceeds walkForwardSucceededCount (${familyReport.walkForwardSucceededCount})`,
      filePath,
      { familyKey }
    );
  }

  if (familyReport.topSeedsSource === "holdout-fallback" && familyReport.walkForwardSucceededCount > 0) {
    pushIssue(
      issues,
      "error",
      "family_top_seed_source_mismatch",
      "topSeedsSource is holdout-fallback despite successful walk-forward evaluations.",
      filePath,
      { familyKey }
    );
  }
}

function validateGenerationSummaries(
  outputDir: string,
  familyKey: FamilyKey,
  familyReport: FamilyReport,
  generationFiles: Array<{
    generation: number;
    path: string;
    rows: unknown[] | null;
    rawEvaluations: CandidateBacktestEvaluation[];
  }>,
  issues: AuditIssue[]
): void {
  if (generationFiles.length !== familyReport.generationSummaries.length) {
    pushIssue(
      issues,
      "error",
      "generation_file_count_mismatch",
      `Found ${generationFiles.length} generation files but report lists ${familyReport.generationSummaries.length} summaries for ${familyKey}`,
      path.join(outputDir, familyKey)
    );
  }

  for (const summary of familyReport.generationSummaries) {
    const generationPath = path.join(
      outputDir,
      familyKey,
      `generation-${String(summary.generation).padStart(2, "0")}-holdout.json`
    );
    const generationFile = generationFiles.find((entry) => entry.path === generationPath);
    const rows = generationFile?.rows;
    if (!rows) {
      continue;
    }
    if (rows.length !== summary.candidateCount) {
      pushIssue(
        issues,
        "error",
        "generation_candidate_count_mismatch",
        `Generation ${summary.generation} candidateCount (${summary.candidateCount}) does not match file length (${rows.length}) for ${familyKey}`,
        generationPath
      );
    }
    const first = rows[0] as { candidateId?: unknown; netReturn?: unknown; riskAdjustedScore?: unknown } | undefined;
    if (summary.bestCandidateId && first?.candidateId !== summary.bestCandidateId) {
      pushIssue(
        issues,
        "error",
        "generation_best_candidate_mismatch",
        `Generation ${summary.generation} bestCandidateId (${summary.bestCandidateId}) does not match file head (${String(first?.candidateId)}) for ${familyKey}`,
        generationPath
      );
    }
    if (typeof summary.bestNetReturn === "number" && first && first.netReturn !== summary.bestNetReturn) {
      pushIssue(
        issues,
        "error",
        "generation_best_return_mismatch",
        `Generation ${summary.generation} bestNetReturn (${summary.bestNetReturn}) does not match file head (${String(first.netReturn)}) for ${familyKey}`,
        generationPath
      );
    }
    if (
      typeof summary.bestRiskAdjustedScore === "number" &&
      first &&
      first.riskAdjustedScore !== summary.bestRiskAdjustedScore
    ) {
      pushIssue(
        issues,
        "error",
        "generation_best_score_mismatch",
        `Generation ${summary.generation} bestRiskAdjustedScore (${summary.bestRiskAdjustedScore}) does not match file head (${String(first.riskAdjustedScore)}) for ${familyKey}`,
        generationPath
      );
    }

    const sortedRaw = generationFile.rawEvaluations.slice().sort(compareCandidateEvaluations);
    if (sortedRaw.length !== rows.length) {
      pushIssue(
        issues,
        "error",
        "generation_raw_count_mismatch",
        `Generation ${summary.generation} raw holdout count (${sortedRaw.length}) does not match summary row count (${rows.length}) for ${familyKey}`,
        generationPath,
        { familyKey }
      );
      continue;
    }

    const rawIds = sortedRaw.map((evaluation) => evaluation.candidate.candidateId);
    const rowIds = rows
      .map((row) => (row && typeof row === "object" ? (row as { candidateId?: unknown }).candidateId : undefined))
      .filter((candidateId): candidateId is string => typeof candidateId === "string");
    if (!jsonEqual(rawIds, rowIds)) {
      pushIssue(
        issues,
        "error",
        "generation_raw_order_mismatch",
        `Generation ${summary.generation} raw holdout ordering does not match ${path.basename(generationPath)} for ${familyKey}`,
        generationPath,
        { familyKey }
      );
    }

    for (const [rowIndex, row] of rows.entries()) {
      if (!row || typeof row !== "object") {
        continue;
      }
      const raw = sortedRaw[rowIndex];
      if (!raw) {
        break;
      }
      if (!jsonEqual(measurementFromSummary(row as Record<string, unknown>), measurementFromEvaluation(raw))) {
        pushIssue(
          issues,
          "error",
          "generation_raw_metric_mismatch",
          `Generation ${summary.generation} holdout summary does not match raw evaluation for ${raw.candidate.candidateId} in ${familyKey}`,
          generationPath,
          { familyKey, candidateId: raw.candidate.candidateId }
        );
      }
    }
  }
}

export async function auditDeterministicBbArtifacts(
  outputDir: string,
  options: AuditOptions = {}
): Promise<DeterministicBbAuditReport> {
  const issues: AuditIssue[] = [];
  const warnings: AuditIssue[] = [];
  const reportPath = path.join(outputDir, "report.json");
  const statusPath = path.join(outputDir, "status.json");
  const leaderboardPath = path.join(outputDir, "leaderboard.json");
  const topSeedsPath = path.join(outputDir, "top-seeds.json");
  const familySummaryPath = path.join(outputDir, "family-summary.json");
  const validatedBlocksPath = path.join(outputDir, "validated-blocks.json");

  const report = await readJsonFile<DeterministicBbResearchReport>(reportPath, issues);
  const status = await readJsonFile<DeterministicBbResearchStatus>(statusPath, issues);
  const leaderboard = await readJsonFile<unknown[]>(leaderboardPath, issues);
  const topSeeds = await readJsonFile<unknown[]>(topSeedsPath, issues);
  const familySummary = await readJsonFile<unknown[]>(familySummaryPath, issues);
  const validatedBlocks = await readJsonFile<{ blocks?: unknown[] }>(validatedBlocksPath, issues);

  if (!report) {
    return {
      generatedAt: new Date().toISOString(),
      outputDir,
      ok: false,
      errors: issues,
      warnings,
      summary: {
        familyCount: 0,
        validatedBlockCount: 0,
        overallLeaderboardCount: 0,
        topSeedCount: 0
      }
    };
  }

  if (report.outputDir !== outputDir) {
    pushIssue(
      issues,
      "error",
      "report_output_dir_mismatch",
      `report.outputDir (${report.outputDir}) does not match audited outputDir (${outputDir})`,
      reportPath
    );
  }
  if (report.reportPath !== reportPath) {
    pushIssue(
      issues,
      "error",
      "report_path_mismatch",
      `report.reportPath (${report.reportPath}) does not match ${reportPath}`,
      reportPath
    );
  }

  if (status && !options.allowNonCompletedStatus) {
    if (status.phase !== "completed") {
      pushIssue(
        warnings,
        "warning",
        "status_not_completed",
        `status.json phase is ${status.phase}, not completed`,
        statusPath
      );
    }
  }

  if (leaderboard && !jsonEqual(leaderboard, report.overallLeaderboard)) {
    pushIssue(issues, "error", "root_leaderboard_mismatch", "leaderboard.json does not match report.overallLeaderboard", leaderboardPath);
  }
  if (topSeeds && !jsonEqual(topSeeds, report.topSeeds)) {
    pushIssue(issues, "error", "root_top_seeds_mismatch", "top-seeds.json does not match report.topSeeds", topSeedsPath);
  }

  const expectedFamilySummary = report.config.familyKeys.map((familyKey) => report.families[familyKey] ?? null);
  if (familySummary && !jsonEqual(familySummary, expectedFamilySummary)) {
    pushIssue(
      issues,
      "error",
      "family_summary_mismatch",
      "family-summary.json does not match the family reports embedded in report.json",
      familySummaryPath
    );
  }

  const validatedBlockList = validatedBlocks?.blocks ?? [];
  if (report.validatedBlockCount !== validatedBlockList.length) {
    pushIssue(
      issues,
      "error",
      "validated_block_count_mismatch",
      `report.validatedBlockCount (${report.validatedBlockCount}) does not match validated-blocks.json count (${validatedBlockList.length})`,
      validatedBlocksPath
    );
  }

  const allWalkForwardCandidateIds = new Set<string>();
  const allWalkForwardEvaluations: CandidateBacktestEvaluation[] = [];
  const familyTopSeedSources = new Map<string, FamilyReport["topSeedsSource"]>();
  for (const familyKey of report.config.familyKeys) {
    const embeddedFamily = report.families[familyKey];
    const filePaths = expectedFamilyFilePaths(outputDir, familyKey);
    if (!embeddedFamily) {
      pushIssue(issues, "error", "missing_family_report", `report.json is missing family report for ${familyKey}`, reportPath);
      continue;
    }

    const familyReport = await readJsonFile<FamilyReport>(filePaths.report, issues);
    const familyLeaderboard = await readJsonFile<unknown[]>(filePaths.leaderboard, issues);
    const holdoutLeaderboard = await readJsonFile<unknown[]>(filePaths.holdoutLeaderboard, issues);
    const familyTopSeeds = await readJsonFile<unknown[]>(filePaths.topSeeds, issues);
    const walkForwardEvaluations = await readJsonFile<unknown[]>(filePaths.walkForwardEvaluations, issues);
    const promotion = await readJsonFile<unknown>(filePaths.promotion, issues);
    const feeDrag = await readJsonFile<unknown>(filePaths.feeDrag, issues);
    const regimeDiagnostics = await readJsonFile<unknown>(filePaths.regimeDiagnostics, issues);
    const rawWalkForwardEvaluations = await readWalkForwardRawEvaluations(filePaths.familyDir, issues);
    const rawWalkForwardById = new Map(rawWalkForwardEvaluations.map((evaluation) => [evaluation.candidate.candidateId, evaluation]));

    if (familyReport && !jsonEqual(familyReport, embeddedFamily)) {
      pushIssue(
        issues,
        "error",
        "embedded_family_report_mismatch",
        `report.json embedded family report does not match ${filePaths.report}`,
        filePaths.report,
        { familyKey }
      );
    }

    if (familyReport) {
      validateFamilyCounts(familyReport, issues, filePaths.report, familyKey);
      for (const seed of familyReport.topSeeds) {
        familyTopSeedSources.set(seed.candidateId, familyReport.topSeedsSource);
      }
    }

    if (familyLeaderboard && !jsonEqual(familyLeaderboard, embeddedFamily.walkForwardTop)) {
      pushIssue(
        issues,
        "error",
        "family_leaderboard_mismatch",
        `leaderboard.json does not match walkForwardTop for ${familyKey}`,
        filePaths.leaderboard,
        { familyKey }
      );
    }
    if (holdoutLeaderboard && !jsonEqual(holdoutLeaderboard, embeddedFamily.holdoutTop)) {
      pushIssue(
        issues,
        "error",
        "family_holdout_leaderboard_mismatch",
        `holdout-leaderboard.json does not match holdoutTop for ${familyKey}`,
        filePaths.holdoutLeaderboard,
        { familyKey }
      );
    }
    if (familyTopSeeds && !jsonEqual(familyTopSeeds, embeddedFamily.topSeeds)) {
      pushIssue(
        issues,
        "error",
        "family_top_seeds_mismatch",
        `top-seeds.json does not match topSeeds for ${familyKey}`,
        filePaths.topSeeds,
        { familyKey }
      );
    }
    if (promotion && !jsonEqual(promotion, embeddedFamily.promotion)) {
      pushIssue(
        issues,
        "error",
        "family_promotion_mismatch",
        `promotion.json does not match promotion section for ${familyKey}`,
        filePaths.promotion,
        { familyKey }
      );
    }
    if (feeDrag && !jsonEqual(feeDrag, embeddedFamily.feeDrag)) {
      pushIssue(
        issues,
        "error",
        "family_fee_drag_mismatch",
        `fee-drag.json does not match feeDrag section for ${familyKey}`,
        filePaths.feeDrag,
        { familyKey }
      );
    }
    if (regimeDiagnostics && !jsonEqual(regimeDiagnostics, embeddedFamily.regimeDiagnostics)) {
      pushIssue(
        issues,
        "error",
        "family_regime_diagnostics_mismatch",
        `regime-diagnostics.json does not match regimeDiagnostics section for ${familyKey}`,
        filePaths.regimeDiagnostics,
        { familyKey }
      );
    }
    if (walkForwardEvaluations) {
      const expectedWalkForwardPrefix = walkForwardEvaluations.slice(0, embeddedFamily.walkForwardTop.length);
      if (!jsonEqual(expectedWalkForwardPrefix, embeddedFamily.walkForwardTop)) {
        pushIssue(
          issues,
          "error",
          "family_walk_forward_prefix_mismatch",
          `walk-forward-evaluations.json head does not match walkForwardTop for ${familyKey}`,
          filePaths.walkForwardEvaluations,
          { familyKey }
        );
      }
      if (
        typeof embeddedFamily.walkForwardSucceededCount === "number" &&
        walkForwardEvaluations.length !== embeddedFamily.walkForwardSucceededCount
      ) {
        pushIssue(
          issues,
          "error",
          "family_walk_forward_count_mismatch",
          `walk-forward-evaluations.json length (${walkForwardEvaluations.length}) does not match walkForwardSucceededCount (${embeddedFamily.walkForwardSucceededCount}) for ${familyKey}`,
          filePaths.walkForwardEvaluations,
          { familyKey }
        );
      }
      for (const item of walkForwardEvaluations as Array<{ candidateId?: string }>) {
        if (item?.candidateId) {
          allWalkForwardCandidateIds.add(item.candidateId);
        }
      }
    }
    if (rawWalkForwardEvaluations.length !== embeddedFamily.walkForwardSucceededCount) {
      pushIssue(
        issues,
        "error",
        "raw_walk_forward_count_mismatch",
        `walk-forward-raw count (${rawWalkForwardEvaluations.length}) does not match walkForwardSucceededCount (${embeddedFamily.walkForwardSucceededCount}) for ${familyKey}`,
        path.join(filePaths.familyDir, "walk-forward-raw"),
        { familyKey }
      );
    }
    const sortedRawWalkForward = rawWalkForwardEvaluations.slice().sort(compareCandidateEvaluations);
    allWalkForwardEvaluations.push(...sortedRawWalkForward);
    if (walkForwardEvaluations) {
      const rawIds = sortedRawWalkForward.map((evaluation) => evaluation.candidate.candidateId);
      const summaryIds = walkForwardEvaluations.map((item) => (item as { candidateId?: string }).candidateId).filter(Boolean);
      if (!jsonEqual(rawIds, summaryIds)) {
        pushIssue(
          issues,
          "error",
          "raw_walk_forward_order_mismatch",
          `walk-forward-raw ordering does not match walk-forward-evaluations.json for ${familyKey}`,
          filePaths.walkForwardEvaluations,
          { familyKey }
        );
      }
      for (const summaryItem of walkForwardEvaluations as Array<Record<string, unknown>>) {
        const candidateId = typeof summaryItem.candidateId === "string" ? summaryItem.candidateId : undefined;
        if (!candidateId) {
          continue;
        }
        const raw = rawWalkForwardById.get(candidateId);
        if (!raw) {
          pushIssue(
            issues,
            "error",
            "raw_walk_forward_missing_candidate",
            `walk-forward-raw is missing ${candidateId} for ${familyKey}`,
            path.join(filePaths.familyDir, "walk-forward-raw"),
            { familyKey, candidateId }
          );
          continue;
        }
        if (raw.status !== "completed") {
          pushIssue(
            issues,
            "error",
            "raw_walk_forward_failed_status",
            `walk-forward-raw contains non-completed evaluation ${candidateId} (${raw.status}) for ${familyKey}`,
            path.join(filePaths.familyDir, "walk-forward-raw", `${candidateId}.json`),
            { familyKey, candidateId }
          );
        }
        if (!jsonEqual(measurementFromSummary(summaryItem), measurementFromEvaluation(raw))) {
          pushIssue(
            issues,
            "error",
            "raw_walk_forward_metric_mismatch",
            `walk-forward-evaluations.json metrics do not match raw evaluation for ${candidateId} in ${familyKey}`,
            filePaths.walkForwardEvaluations,
            { familyKey, candidateId }
          );
        }
      }
    }

    const generationFiles = familyReport
      ? await Promise.all(
          familyReport.generationSummaries.map(async (summary) => {
            const generationPath = path.join(
              outputDir,
              familyKey,
              `generation-${String(summary.generation).padStart(2, "0")}-holdout.json`
            );
            return {
              generation: summary.generation,
              path: generationPath,
              rows: await readJsonFile<unknown[]>(generationPath, issues),
              rawEvaluations: await readHoldoutRawEvaluations(filePaths.familyDir, summary.generation, issues)
            };
          })
        )
      : [];
    if (familyReport) {
      validateGenerationSummaries(outputDir, familyKey, familyReport, generationFiles, issues);
      if (familyReport.promotion.promoted) {
        if (!familyReport.promotion.blockId) {
          pushIssue(
            issues,
            "error",
            "promotion_missing_block_id",
            `Promoted family ${familyKey} is missing blockId`,
            filePaths.promotion
          );
        } else if (
          !validatedBlockList.some((block) => (block as { blockId?: unknown }).blockId === familyReport.promotion.blockId)
        ) {
          pushIssue(
            issues,
            "error",
            "promotion_block_missing_from_catalog",
            `Promoted blockId ${familyReport.promotion.blockId} for ${familyKey} is absent from validated-blocks.json`,
            validatedBlocksPath
          );
        }
        if (familyReport.promotion.candidateId && !allWalkForwardCandidateIds.has(familyReport.promotion.candidateId)) {
          pushIssue(
            issues,
            "error",
            "promotion_candidate_missing_from_walk_forward",
            `Promoted candidate ${familyReport.promotion.candidateId} for ${familyKey} is absent from walk-forward evaluations`,
            filePaths.walkForwardEvaluations
          );
        }
      }
    }
  }

  for (const item of report.overallLeaderboard) {
    if (!allWalkForwardCandidateIds.has(item.candidateId)) {
      pushIssue(
        issues,
        "error",
        "overall_leaderboard_candidate_missing",
        `Overall leaderboard candidate ${item.candidateId} is missing from family walk-forward-evaluations.json files`,
        leaderboardPath
      );
    }
  }

  const expectedOverallLeaderboard = allWalkForwardEvaluations
    .slice()
    .sort(compareCandidateEvaluations)
    .slice(0, report.overallLeaderboard.length)
    .map((evaluation) => measurementFromEvaluation(evaluation));
  const actualOverallLeaderboard = report.overallLeaderboard.map((item) =>
    measurementFromSummary(item as unknown as Record<string, unknown>)
  );
  if (!jsonEqual(actualOverallLeaderboard, expectedOverallLeaderboard)) {
    pushIssue(
      issues,
      "error",
      "overall_leaderboard_metric_mismatch",
      "report.overallLeaderboard does not match the sorted raw walk-forward evaluations.",
      leaderboardPath
    );
  }

  for (const item of report.topSeeds) {
    if (!familyTopSeedSources.has(item.candidateId)) {
      pushIssue(
        issues,
        "error",
        "root_top_seed_untraceable",
        `Root top seed ${item.candidateId} is not traceable to any family topSeeds list.`,
        topSeedsPath,
        { candidateId: item.candidateId }
      );
      continue;
    }
    if (!allWalkForwardCandidateIds.has(item.candidateId) && familyTopSeedSources.get(item.candidateId) !== "holdout-fallback") {
      pushIssue(
        issues,
        "error",
        "root_top_seed_missing_oos",
        `Root top seed ${item.candidateId} is absent from walk-forward results without holdout-fallback provenance.`,
        topSeedsPath,
        { candidateId: item.candidateId }
      );
    }
    if (familyTopSeedSources.get(item.candidateId) === "holdout-fallback") {
      pushIssue(
        warnings,
        "warning",
        "root_top_seed_holdout_fallback",
        `Root top seed ${item.candidateId} comes from holdout fallback and is not OOS-validated.`,
        topSeedsPath,
        { candidateId: item.candidateId }
      );
    }
  }

  const expectedRootTopSeeds = report.config.familyKeys
    .flatMap((familyKey) => report.families[familyKey]?.topSeeds ?? [])
    .sort((left, right) => right.riskAdjustedScore - left.riskAdjustedScore)
    .slice(0, report.topSeeds.length)
    .map((item) => measurementFromSummary(item as unknown as Record<string, unknown>));
  const actualRootTopSeeds = report.topSeeds.map((item) =>
    measurementFromSummary(item as unknown as Record<string, unknown>)
  );
  if (!jsonEqual(actualRootTopSeeds, expectedRootTopSeeds)) {
    pushIssue(
      issues,
      "error",
      "root_top_seed_aggregation_mismatch",
      "report.topSeeds does not match the aggregation of family topSeeds.",
      topSeedsPath
    );
  }

  const errors = issues.filter((issue) => issue.severity === "error");
  return {
    generatedAt: new Date().toISOString(),
    outputDir,
    ok: errors.length === 0,
    errors,
    warnings,
    summary: {
      familyCount: report.config.familyKeys.length,
      validatedBlockCount: validatedBlockList.length,
      overallLeaderboardCount: report.overallLeaderboard.length,
      topSeedCount: report.topSeeds.length
    }
  };
}

export async function writeDeterministicBbAuditReport(outputDir: string, audit: DeterministicBbAuditReport): Promise<string> {
  const auditPath = path.join(outputDir, "audit.json");
  await writeJsonAtomic(auditPath, audit);
  return auditPath;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outputDirIndex = args.indexOf("--output-dir");
  if (outputDirIndex === -1 || !args[outputDirIndex + 1]) {
    throw new Error("Expected --output-dir <path>");
  }
  const outputDir = path.resolve(args[outputDirIndex + 1]);
  const audit = await auditDeterministicBbArtifacts(outputDir);
  const auditPath = await writeDeterministicBbAuditReport(outputDir, audit);
  console.log(JSON.stringify({ outputDir, auditPath, ok: audit.ok, errors: audit.errors.length, warnings: audit.warnings.length }, null, 2));
  if (!audit.ok) {
    process.exitCode = 1;
  }
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMain) {
  await main();
}
