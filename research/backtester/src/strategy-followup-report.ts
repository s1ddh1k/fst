import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildScoredStrategyGrid } from "./parameter-grid.js";
import { getCandidateMarketsWithMinimumCandles } from "./db.js";
import { executeScoredWalkForwardBacktest, preloadMarketData } from "./scored-runner.js";
import type { GhostTradeHorizonSummary, ScoredBacktestResult } from "./types.js";

export const DEFAULT_STRATEGY_NAMES = [
  "relative-momentum-pullback",
  "leader-pullback-state-machine",
  "relative-breakout-rotation"
] as const;

export type FollowupStrategyName = (typeof DEFAULT_STRATEGY_NAMES)[number];

export type FollowupFoldRow = {
  foldIndex: number;
  trainStart: string;
  trainEnd: string;
  testStart: string;
  testEnd: string;
  trainReturn: number;
  testReturn: number;
  grossReturn: number;
  netReturn: number;
  executedTradeCount: number;
  signalCount: number;
  ghostSignalCount: number;
  turnover: number;
  feePaid: number;
  slippagePaid: number;
  bootstrapPassed: boolean;
  randomPassed: boolean;
  randomPercentile: number | null;
  ghostStudy: ScoredBacktestResult["ghostStudy"];
};

export type FollowupRow = {
  strategyName: FollowupStrategyName;
  parameters: Record<string, number>;
  windowCount: number;
  avgTrainReturn: number;
  avgTestReturn: number;
  medianTestReturn: number;
  executedTradeCount: number;
  signalCount: number;
  ghostSignalCount: number;
  avgTurnover: number;
  grossReturn: number;
  netReturn: number;
  feePaid: number;
  slippagePaid: number;
  bootstrapPassRate: number;
  randomPassRate: number;
  averageFoldTradeCount: number;
  neighborPositiveRate: number;
  passesSufficiency: boolean;
  passesPerformance: boolean;
  passesRobustness: boolean;
  promotionEligible: boolean;
  folds: FollowupFoldRow[];
  ghostStudy: {
    horizons: GhostTradeHorizonSummary[];
    bestNetHorizonBars: number | null;
  };
};

export type FollowupRecommendation = {
  recommendedStrategyName: string | null;
  parameters: Record<string, number> | null;
  rationale: string;
};

export type EntryVsExitDiagnosis = {
  verdict: "entry" | "exit" | "mixed";
  rationale: string;
  referenceHorizonBars: number | null;
};

export type StrategyFollowupReport = {
  generatedAt: string;
  config: {
    timeframe: string;
    universeName: string;
    marketLimit: number;
    candidatePoolSize: number;
    trainingDays: number;
    holdoutDays: number;
    stepDays: number;
    limit: number;
    minCandles: number;
    strategyNames: FollowupStrategyName[];
  };
  baselineDiagnosis: EntryVsExitDiagnosis;
  bestByStrategy: FollowupRow[];
  topOverall: FollowupRow[];
  recommendation: FollowupRecommendation;
  rows: FollowupRow[];
  artifacts: {
    markdownPath: string;
    jsonPath: string;
    summaryCsvPath: string;
    foldsCsvPath: string;
  };
};

function countCompletedTrades(result: ScoredBacktestResult): number {
  return result.trades.filter((trade) => trade.side === "SELL").length;
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? 0;
  }

  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : "0.00";
}

function strategySortScore(row: FollowupRow): number {
  const passes =
    Number(row.passesSufficiency) +
    Number(row.passesPerformance) +
    Number(row.passesRobustness);

  return (
    passes * 1_000_000 +
    row.avgTestReturn * 100_000 +
    row.medianTestReturn * 50_000 +
    row.executedTradeCount * 100 +
    row.signalCount
  );
}

function selectBestRows(rows: FollowupRow[]): FollowupRow[] {
  const byStrategy = new Map<string, FollowupRow>();

  for (const row of rows) {
    const current = byStrategy.get(row.strategyName);

    if (!current || strategySortScore(row) > strategySortScore(current)) {
      byStrategy.set(row.strategyName, row);
    }
  }

  return [...byStrategy.values()].sort((left, right) => strategySortScore(right) - strategySortScore(left));
}

function aggregateGhostStudy(windows: ScoredBacktestResult[]): FollowupRow["ghostStudy"] {
  const perHorizon = new Map<number, {
    sampleSize: number;
    weightedMedianMfe: number;
    weightedMedianMae: number;
    weightedMedianGrossReturn: number;
    weightedMedianNetReturn: number;
    weightedPositiveNetRate: number;
  }>();

  for (const window of windows) {
    for (const horizon of window.ghostStudy.horizonSummaries) {
      const entry = perHorizon.get(horizon.horizonBars) ?? {
        sampleSize: 0,
        weightedMedianMfe: 0,
        weightedMedianMae: 0,
        weightedMedianGrossReturn: 0,
        weightedMedianNetReturn: 0,
        weightedPositiveNetRate: 0
      };
      const weight = Math.max(horizon.sampleSize, 0);

      entry.sampleSize += weight;
      entry.weightedMedianMfe += horizon.medianMfe * weight;
      entry.weightedMedianMae += horizon.medianMae * weight;
      entry.weightedMedianGrossReturn += horizon.medianGrossReturn * weight;
      entry.weightedMedianNetReturn += horizon.medianNetReturn * weight;
      entry.weightedPositiveNetRate += horizon.positiveNetRate * weight;
      perHorizon.set(horizon.horizonBars, entry);
    }
  }

  const horizons = [...perHorizon.entries()]
    .map(([horizonBars, aggregate]) => ({
      horizonBars,
      sampleSize: aggregate.sampleSize,
      medianMfe:
        aggregate.sampleSize === 0 ? 0 : aggregate.weightedMedianMfe / aggregate.sampleSize,
      medianMae:
        aggregate.sampleSize === 0 ? 0 : aggregate.weightedMedianMae / aggregate.sampleSize,
      medianGrossReturn:
        aggregate.sampleSize === 0 ? 0 : aggregate.weightedMedianGrossReturn / aggregate.sampleSize,
      medianNetReturn:
        aggregate.sampleSize === 0 ? 0 : aggregate.weightedMedianNetReturn / aggregate.sampleSize,
      positiveNetRate:
        aggregate.sampleSize === 0 ? 0 : aggregate.weightedPositiveNetRate / aggregate.sampleSize
    }))
    .sort((left, right) => left.horizonBars - right.horizonBars);

  const bestNetHorizon = horizons
    .slice()
    .sort((left, right) => right.medianNetReturn - left.medianNetReturn)[0];

  return {
    horizons,
    bestNetHorizonBars: bestNetHorizon?.horizonBars ?? null
  };
}

function computeNeighborPositiveRate(row: FollowupRow, rows: FollowupRow[]): number {
  const neighbors = rows.filter((candidate) => {
    if (candidate.strategyName !== row.strategyName || candidate === row) {
      return false;
    }

    const keys = Object.keys(row.parameters);
    let differingKeys = 0;

    for (const key of keys) {
      if (candidate.parameters[key] !== row.parameters[key]) {
        differingKeys += 1;
      }
    }

    return differingKeys === 1;
  });

  if (neighbors.length === 0) {
    return 0;
  }

  return neighbors.filter((candidate) => candidate.avgTestReturn > 0).length / neighbors.length;
}

function diagnoseEntryVsExit(row: FollowupRow): EntryVsExitDiagnosis {
  const reference =
    row.ghostStudy.horizons.find((horizon) => horizon.horizonBars === 12) ??
    row.ghostStudy.horizons[0];
  const bestGhostNet = Math.max(...row.ghostStudy.horizons.map((horizon) => horizon.medianNetReturn), 0);
  const bestGhostMfe = Math.max(...row.ghostStudy.horizons.map((horizon) => horizon.medianMfe), 0);

  if (row.ghostSignalCount < 25 || bestGhostNet <= 0) {
    return {
      verdict: "entry",
      referenceHorizonBars: reference?.horizonBars ?? null,
      rationale:
        "Ghost BUY signals themselves are sparse or remain net-negative after cost across forward horizons, so the baseline failure is primarily an entry-quality and entry-frequency problem."
    };
  }

  if (bestGhostMfe > 0.01 && row.avgTestReturn <= 0) {
    return {
      verdict: "exit",
      referenceHorizonBars: reference?.horizonBars ?? null,
      rationale:
        "Ghost signals show positive forward excursion, but realized OOS return stays negative. That points to exit and trade management leaving too much edge on the table."
    };
  }

  return {
    verdict: "mixed",
    referenceHorizonBars: reference?.horizonBars ?? null,
    rationale:
      "Ghost studies and realized OOS returns both look weak. Entry scarcity is still the larger issue, but exit quality is not clean enough to rule out a mixed failure."
  };
}

function chooseRecommendation(rows: FollowupRow[]): FollowupRecommendation {
  const eligible = rows
    .filter((row) => row.promotionEligible)
    .sort((left, right) => strategySortScore(right) - strategySortScore(left));

  if (eligible.length === 0) {
    return {
      recommendedStrategyName: null,
      parameters: null,
      rationale:
        "No strategy cleared sufficiency, performance, and robustness together. The correct production decision is to reject all candidates for now."
    };
  }

  const winner = eligible[0];
  return {
    recommendedStrategyName: winner.strategyName,
    parameters: winner.parameters,
    rationale:
      "This row is the strongest candidate that clears sufficiency, performance, and robustness under the same walk-forward framework."
  };
}

function toSummaryCsv(rows: FollowupRow[]): string {
  const headers = [
    "strategyName",
    "parameters",
    "windowCount",
    "avgTrainReturn",
    "avgTestReturn",
    "medianTestReturn",
    "executedTradeCount",
    "signalCount",
    "ghostSignalCount",
    "avgTurnover",
    "grossReturn",
    "netReturn",
    "feePaid",
    "slippagePaid",
    "bootstrapPassRate",
    "randomPassRate",
    "averageFoldTradeCount",
    "neighborPositiveRate",
    "passesSufficiency",
    "passesPerformance",
    "passesRobustness",
    "promotionEligible"
  ];

  const escape = (value: string) => `"${value.replaceAll("\"", "\"\"")}"`;
  const lines = [headers.join(",")];

  for (const row of rows) {
    lines.push([
      escape(row.strategyName),
      escape(JSON.stringify(row.parameters)),
      String(row.windowCount),
      String(row.avgTrainReturn),
      String(row.avgTestReturn),
      String(row.medianTestReturn),
      String(row.executedTradeCount),
      String(row.signalCount),
      String(row.ghostSignalCount),
      String(row.avgTurnover),
      String(row.grossReturn),
      String(row.netReturn),
      String(row.feePaid),
      String(row.slippagePaid),
      String(row.bootstrapPassRate),
      String(row.randomPassRate),
      String(row.averageFoldTradeCount),
      String(row.neighborPositiveRate),
      String(row.passesSufficiency),
      String(row.passesPerformance),
      String(row.passesRobustness),
      String(row.promotionEligible)
    ].join(","));
  }

  return lines.join("\n");
}

function toFoldsCsv(rows: FollowupRow[]): string {
  const headers = [
    "strategyName",
    "parameters",
    "foldIndex",
    "trainStart",
    "trainEnd",
    "testStart",
    "testEnd",
    "trainReturn",
    "testReturn",
    "grossReturn",
    "netReturn",
    "executedTradeCount",
    "signalCount",
    "ghostSignalCount",
    "turnover",
    "feePaid",
    "slippagePaid",
    "bootstrapPassed",
    "randomPassed",
    "randomPercentile"
  ];
  const escape = (value: string) => `"${value.replaceAll("\"", "\"\"")}"`;
  const lines = [headers.join(",")];

  for (const row of rows) {
    for (const fold of row.folds) {
      lines.push([
        escape(row.strategyName),
        escape(JSON.stringify(row.parameters)),
        String(fold.foldIndex),
        escape(fold.trainStart),
        escape(fold.trainEnd),
        escape(fold.testStart),
        escape(fold.testEnd),
        String(fold.trainReturn),
        String(fold.testReturn),
        String(fold.grossReturn),
        String(fold.netReturn),
        String(fold.executedTradeCount),
        String(fold.signalCount),
        String(fold.ghostSignalCount),
        String(fold.turnover),
        String(fold.feePaid),
        String(fold.slippagePaid),
        String(fold.bootstrapPassed),
        String(fold.randomPassed),
        String(fold.randomPercentile ?? "")
      ].join(","));
    }
  }

  return lines.join("\n");
}

function formatMarkdownTable(rows: FollowupRow[]): string {
  const header = [
    "Strategy",
    "Params",
    "Avg Test",
    "Median Test",
    "Exec Trades",
    "Signals",
    "Ghost",
    "Boot",
    "Rand",
    "Eligible"
  ];
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`
  ];

  for (const row of rows) {
    lines.push(
      `| ${row.strategyName} | \`${JSON.stringify(row.parameters)}\` | ${formatPercent(row.avgTestReturn)} | ${formatPercent(row.medianTestReturn)} | ${row.executedTradeCount} | ${row.signalCount} | ${row.ghostSignalCount} | ${formatPercent(row.bootstrapPassRate)} | ${formatPercent(row.randomPassRate)} | ${row.promotionEligible ? "yes" : "no"} |`
    );
  }

  return lines.join("\n");
}

function renderMarkdown(report: StrategyFollowupReport): string {
  const recommendationLabel = report.recommendation.recommendedStrategyName ?? "none";
  const recommendationParams = report.recommendation.parameters
    ? ` \`${JSON.stringify(report.recommendation.parameters)}\``
    : "";
  const bestRows = formatMarkdownTable(report.bestByStrategy);
  const topRows = formatMarkdownTable(report.topOverall);

  return [
    "# Strategy Follow-up Report",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Config",
    "",
    `- timeframe: \`${report.config.timeframe}\``,
    `- universe: \`${report.config.universeName}\``,
    `- marketLimit: ${report.config.marketLimit}`,
    `- candidatePoolSize: ${report.config.candidatePoolSize}`,
    `- trainingDays: ${report.config.trainingDays}`,
    `- holdoutDays: ${report.config.holdoutDays}`,
    `- stepDays: ${report.config.stepDays}`,
    `- minCandles: ${report.config.minCandles}`,
    "",
    "## Entry Vs Exit Conclusion",
    "",
    `Baseline verdict: **${report.baselineDiagnosis.verdict}**`,
    "",
    report.baselineDiagnosis.rationale,
    "",
    "## Recommendation",
    "",
    `Production candidate: **${recommendationLabel}**${recommendationParams}`,
    "",
    report.recommendation.rationale,
    "",
    "## Best By Strategy",
    "",
    bestRows,
    "",
    "## Top Overall",
    "",
    topRows,
    "",
    "## Notes",
    "",
    "- `executedTradeCount` counts completed OOS trades (filled exits / round trips) in the walk-forward windows.",
    "- `signalCount` counts coordinator-selected BUY intents in OOS windows.",
    "- `ghostSignalCount` counts raw BUY candidates before execution constraints, studied with next-bar-open references.",
    "- `bootstrapPassRate` and `randomPassRate` are fold-level pass ratios across the walk-forward windows."
  ].join("\n");
}

function resolveArtifactPaths(repoRoot: string, artifactLabel?: string): StrategyFollowupReport["artifacts"] {
  const suffix = artifactLabel ? `-${artifactLabel}` : "";
  const outputDir = path.join(repoRoot, "research", "backtester", "output");

  return {
    markdownPath: path.join(repoRoot, "docs", `strategy-followup-report${suffix}.md`),
    jsonPath: path.join(outputDir, `strategy-followup-report${suffix}.json`),
    summaryCsvPath: path.join(outputDir, `strategy-followup-summary${suffix}.csv`),
    foldsCsvPath: path.join(outputDir, `strategy-followup-folds${suffix}.csv`)
  };
}

export async function finalizeStrategyFollowupReport(params: {
  rows: FollowupRow[];
  config: StrategyFollowupReport["config"];
  artifactLabel?: string;
}): Promise<StrategyFollowupReport> {
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const artifacts = resolveArtifactPaths(repoRoot, params.artifactLabel);
  const rows = params.rows
    .slice()
    .sort((left, right) => strategySortScore(right) - strategySortScore(left));
  const bestByStrategy = selectBestRows(rows);
  const baselineBest =
    bestByStrategy.find((row) => row.strategyName === "relative-momentum-pullback") ?? rows[0];
  const report: StrategyFollowupReport = {
    generatedAt: new Date().toISOString(),
    config: params.config,
    baselineDiagnosis: diagnoseEntryVsExit(baselineBest),
    bestByStrategy,
    topOverall: rows.slice(0, 10),
    recommendation: chooseRecommendation(rows),
    rows,
    artifacts
  };

  await mkdir(path.dirname(artifacts.jsonPath), { recursive: true });
  await writeFile(artifacts.jsonPath, JSON.stringify(report, null, 2));
  await writeFile(artifacts.summaryCsvPath, toSummaryCsv(rows));
  await writeFile(artifacts.foldsCsvPath, toFoldsCsv(rows));
  await writeFile(artifacts.markdownPath, renderMarkdown(report));

  return report;
}

export async function generateStrategyFollowupReport(params: {
  timeframe: string;
  universeName: string;
  marketLimit: number;
  holdoutDays: number;
  trainingDays: number;
  stepDays: number;
  limit: number;
  minCandles: number;
  strategyNames?: FollowupStrategyName[];
  artifactLabel?: string;
}): Promise<StrategyFollowupReport> {
  const strategyNames = params.strategyNames ?? [...DEFAULT_STRATEGY_NAMES];
  const markets = await getCandidateMarketsWithMinimumCandles({
    timeframe: params.timeframe,
    minCandles: params.minCandles
  });
  const marketCodes = markets.map((market) => market.marketCode);

  if (marketCodes.length === 0) {
    throw new Error("No candidate markets available for follow-up report");
  }

  const preloaded = await preloadMarketData({
    marketCode: `UNIVERSE:${params.universeName}`,
    timeframe: params.timeframe,
    limit: params.limit,
    holdoutDays: params.holdoutDays,
    universeName: params.universeName,
    universeMarketCodes: marketCodes,
    minCandles: params.minCandles
  });
  const rows: FollowupRow[] = [];
  const strategies = strategyNames.flatMap((strategyName) =>
    buildScoredStrategyGrid(strategyName).map((strategy) => ({
      strategyName,
      strategy
    }))
  );

  for (const [index, { strategyName, strategy }] of strategies.entries()) {
    const pct = (((index + 1) / strategies.length) * 100).toFixed(1);
    console.log(
      `[followup ${index + 1}/${strategies.length}] (${pct}%) ${strategyName} ${JSON.stringify(strategy.parameters)}`
    );

    const summary = await executeScoredWalkForwardBacktest({
      marketCode: `UNIVERSE:${params.universeName}`,
      timeframe: params.timeframe,
      limit: params.limit,
      holdoutDays: params.holdoutDays,
      trainingDays: params.trainingDays,
      stepDays: params.stepDays,
      strategy,
      universeName: params.universeName,
      universeMarketCodes: marketCodes,
      universeConfig: {
        topN: params.marketLimit
      },
      runBootstrap: true,
      runRandomBenchmark: true,
      preloaded
    });
    const ghostStudy = aggregateGhostStudy(summary.scoredWindows);
    const folds = summary.scoredWindows.map((window, windowIndex) => {
      const ranges = summary.windows[windowIndex];

      return {
        foldIndex: windowIndex + 1,
        trainStart: ranges.trainRange.start.toISOString(),
        trainEnd: ranges.trainRange.end.toISOString(),
        testStart: ranges.testRange.start.toISOString(),
        testEnd: ranges.testRange.end.toISOString(),
        trainReturn: ranges.train.totalReturn,
        testReturn: ranges.test.totalReturn,
        grossReturn: window.metrics.grossReturn,
        netReturn: window.metrics.netReturn,
        executedTradeCount: countCompletedTrades(window),
        signalCount: window.signalCount,
        ghostSignalCount: window.ghostSignalCount,
        turnover: window.metrics.turnover,
        feePaid: window.metrics.feePaid,
        slippagePaid: window.metrics.slippagePaid,
        bootstrapPassed: window.bootstrap?.isSignificant ?? false,
        randomPassed: (window.randomBenchmark?.percentileVsRandom ?? 0) >= 0.9,
        randomPercentile: window.randomBenchmark?.percentileVsRandom ?? null,
        ghostStudy: window.ghostStudy
      };
    });

    rows.push({
      strategyName,
      parameters: strategy.parameters,
      windowCount: summary.windowCount,
      avgTrainReturn: summary.averageTrainReturn,
      avgTestReturn: summary.averageTestReturn,
      medianTestReturn: median(summary.scoredWindows.map((window) => window.metrics.totalReturn)),
      executedTradeCount: folds.reduce((sum, fold) => sum + fold.executedTradeCount, 0),
      signalCount: summary.scoredWindows.reduce((sum, window) => sum + window.signalCount, 0),
      ghostSignalCount: summary.scoredWindows.reduce(
        (sum, window) => sum + window.ghostSignalCount,
        0
      ),
      avgTurnover: average(summary.scoredWindows.map((window) => window.metrics.turnover)),
      grossReturn: average(summary.scoredWindows.map((window) => window.metrics.grossReturn)),
      netReturn: average(summary.scoredWindows.map((window) => window.metrics.netReturn)),
      feePaid: summary.scoredWindows.reduce((sum, window) => sum + window.metrics.feePaid, 0),
      slippagePaid: summary.scoredWindows.reduce(
        (sum, window) => sum + window.metrics.slippagePaid,
        0
      ),
      bootstrapPassRate:
        summary.scoredWindows.length === 0
          ? 0
          : summary.scoredWindows.filter((window) => window.bootstrap?.isSignificant).length /
            summary.scoredWindows.length,
      randomPassRate:
        summary.scoredWindows.length === 0
          ? 0
          : summary.scoredWindows.filter(
              (window) => (window.randomBenchmark?.percentileVsRandom ?? 0) >= 0.9
            ).length / summary.scoredWindows.length,
      averageFoldTradeCount:
        folds.length === 0 ? 0 : folds.reduce((sum, fold) => sum + fold.executedTradeCount, 0) / folds.length,
      neighborPositiveRate: 0,
      passesSufficiency: false,
      passesPerformance: false,
      passesRobustness: false,
      promotionEligible: false,
      folds,
      ghostStudy
    });
  }

  for (const row of rows) {
    row.neighborPositiveRate = computeNeighborPositiveRate(row, rows);
    row.passesSufficiency =
      row.executedTradeCount >= 25 &&
      row.averageFoldTradeCount >= 1.5 &&
      row.averageFoldTradeCount <= 6;
    row.passesPerformance = row.avgTestReturn > 0 && row.medianTestReturn > 0;
    row.passesRobustness =
      row.bootstrapPassRate >= 0.6 &&
      row.randomPassRate >= 0.6 &&
      row.neighborPositiveRate >= 0.5;
    row.promotionEligible =
      row.passesSufficiency && row.passesPerformance && row.passesRobustness;
  }

  return finalizeStrategyFollowupReport({
    rows,
    config: {
      timeframe: params.timeframe,
      universeName: params.universeName,
      marketLimit: params.marketLimit,
      candidatePoolSize: marketCodes.length,
      trainingDays: params.trainingDays,
      holdoutDays: params.holdoutDays,
      stepDays: params.stepDays,
      limit: params.limit,
      minCandles: params.minCandles,
      strategyNames
    },
    artifactLabel: params.artifactLabel
  });
}
