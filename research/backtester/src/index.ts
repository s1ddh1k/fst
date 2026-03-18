import {
  closeDb,
  getCandidateMarketsWithMinimumCandles,
  getSelectedUniverseMarketsWithMinimumCandles,
  loadCandlesForMarkets,
  replaceStrategyRegimes
} from "./db.js";
import { buildMarketFeaturePipeline } from "./market-feature-pipeline.js";
import { buildStrategyGrid, buildScoredStrategyGrid } from "./parameter-grid.js";
import { buildTwoStrategyPortfolios } from "./portfolio-grid.js";
import { runPortfolioBacktest } from "./portfolio.js";
import { runUniversePortfolioBacktest } from "./universe-portfolio.js";
import { createCrossSectionalMultiFactorAlphaModel } from "./universe-alpha-model.js";
import {
  formatComparisonTable,
  formatPortfolioRankingTable,
  formatRankingTable,
  formatWalkForwardRankingTable
} from "./report.js";
import { executeHoldoutBacktest, executeWalkForwardBacktest } from "./runner.js";
import { executeScoredHoldoutBacktest, executeScoredWalkForwardBacktest, preloadMarketData } from "./scored-runner.js";
import { generateStrategyFollowupReport } from "./strategy-followup-report.js";
import { createStrategyByName, listStrategyNames, createScoredStrategyByName, listScoredStrategyNames } from "./strategy-registry.js";
import { loadCandles } from "./db.js";
import { splitTrainTestByDays } from "./validation.js";
import {
  type MultiStrategyPreset,
  buildMultiStrategyPresets,
  createBreakoutRotationStrategy,
  createMicroBreakoutStrategy,
  createRelativeStrengthRotationStrategy,
  formatMultiStrategyComparisonTable,
  formatMultiStrategyReport,
  runMultiStrategyBacktest
} from "./multi-strategy/index.js";
import {
  CliResearchLlmClient,
  DEFAULT_MIN_NET_RETURN_FOR_PROMOTION,
  calculateAutoResearchMinimumLimit,
  createAutoResearchOrchestrator
} from "./auto-research/index.js";
import type { Candle } from "./types.js";
import { resolveWorkspaceRelativePath } from "./workspace-path.js";

function getOption(args: string[], key: string): string | undefined {
  const index = args.indexOf(key);
  return index === -1 ? undefined : args[index + 1];
}

function candlesPerDay(timeframe: string): number {
  switch (timeframe) {
    case "1m":
      return 24 * 60;
    case "5m":
      return 24 * 12;
    case "1h":
      return 24;
    case "1d":
      return 1;
    default:
      return 1;
  }
}

function resolveRequiredLimit(params: {
  timeframe: string;
  requestedLimit: number;
  holdoutDays: number;
  trainingDays: number;
  stepDays: number;
  walkForwardMode: boolean;
}): number {
  const perDay = candlesPerDay(params.timeframe);
  const baseDays = params.walkForwardMode
    ? params.trainingDays + params.holdoutDays + params.stepDays
    : params.holdoutDays * 2;
  const buffered = Math.ceil(baseDays * perDay * 1.1);

  return Math.max(params.requestedLimit, buffered);
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function createStrategyCandidate(params: {
  strategyName: string;
  parametersJson?: string;
}): ReturnType<typeof createStrategyByName> {
  if (!params.parametersJson) {
    return createStrategyByName(params.strategyName);
  }

  return createStrategyByName(
    params.strategyName,
    parseJson<Record<string, number>>(params.parametersJson)
  );
}

function buildMarketFeatureConfig(params: {
  strategyName: string;
  parametersJson?: string;
  benchmarkMarketCode?: string;
}) {
  const strategy = createStrategyCandidate({
    strategyName: params.strategyName,
    parametersJson: params.parametersJson
  });

  if (!strategy.contextConfig) {
    return undefined;
  }

  return strategy.contextConfig;
}

function filterUniverseCandlesByRange(
  universeCandlesByMarket: Record<string, Awaited<ReturnType<typeof loadCandles>>>,
  range: { start: Date; end: Date }
): Record<string, Awaited<ReturnType<typeof loadCandles>>> {
  return Object.fromEntries(
    Object.entries(universeCandlesByMarket).map(([marketCode, candles]) => [
      marketCode,
      candles.filter(
        (candle) => candle.candleTimeUtc >= range.start && candle.candleTimeUtc <= range.end
      )
    ])
  );
}

function buildPortfolioLabel(
  portfolio: Array<{
    strategy: { name: string; parameters: Record<string, number> };
    weight: number;
  }>
): string {
  return portfolio
    .map((item) => `${item.strategy.name}${JSON.stringify(item.strategy.parameters)}@${item.weight}`)
    .join(" + ");
}

function parsePortfolioLabel(label: string): {
  strategyNames: string[];
  parameters: Array<Record<string, number>>;
  weights: number[];
} {
  const items = label.split(" + ");

  return {
    strategyNames: items.map((item) => item.slice(0, item.indexOf("{"))),
    parameters: items.map((item) => {
      const start = item.indexOf("{");
      const end = item.lastIndexOf("}@");
      return parseJson<Record<string, number>>(item.slice(start, end + 1));
    }),
    weights: items.map((item) => Number.parseFloat(item.slice(item.lastIndexOf("@") + 1)))
  };
}

function mergeDateBounds(
  current: { start: Date; end: Date } | undefined,
  next: { start: Date; end: Date }
): { start: Date; end: Date } {
  if (!current) {
    return {
      start: next.start,
      end: next.end
    };
  }

  return {
    start: next.start < current.start ? next.start : current.start,
    end: next.end > current.end ? next.end : current.end
  };
}

function chooseReferenceMarketCode(
  universeCandlesByMarket: Record<string, Awaited<ReturnType<typeof loadCandles>>>
): string | undefined {
  return Object.entries(universeCandlesByMarket)
    .slice()
    .sort((left, right) => {
      const byLength = right[1].length - left[1].length;

      if (byLength !== 0) {
        return byLength;
      }

      const leftLast = left[1][left[1].length - 1]?.candleTimeUtc.getTime() ?? 0;
      const rightLast = right[1][right[1].length - 1]?.candleTimeUtc.getTime() ?? 0;
      return rightLast - leftLast;
    })[0]?.[0];
}

function floorTo15m(time: Date): Date {
  const ms = 15 * 60_000;
  return new Date(Math.floor(time.getTime() / ms) * ms);
}

function aggregate5mCandlesTo15m(candlesByMarket: Record<string, Candle[]>): Record<string, Candle[]> {
  return Object.fromEntries(
    Object.entries(candlesByMarket).map(([marketCode, candles]) => {
      const buckets = new Map<number, Candle[]>();

      for (const candle of candles) {
        const bucket = floorTo15m(candle.candleTimeUtc).getTime();
        const existing = buckets.get(bucket) ?? [];
        existing.push(candle);
        buckets.set(bucket, existing);
      }

      const aggregated = Array.from(buckets.entries())
        .sort((left, right) => left[0] - right[0])
        .map(([, bucketCandles]) => {
          const sorted = bucketCandles
            .slice()
            .sort((left, right) => left.candleTimeUtc.getTime() - right.candleTimeUtc.getTime());
          const first = sorted[0];
          const last = sorted[sorted.length - 1];
          const volume = sorted.reduce((sum, candle) => sum + candle.volume, 0);
          const quoteVolume = sorted.reduce(
            (sum, candle) => sum + (candle.quoteVolume ?? candle.closePrice * candle.volume),
            0
          );

          return {
            marketCode,
            timeframe: "15m",
            candleTimeUtc: floorTo15m(first.candleTimeUtc),
            openPrice: first.openPrice,
            highPrice: Math.max(...sorted.map((candle) => candle.highPrice)),
            lowPrice: Math.min(...sorted.map((candle) => candle.lowPrice)),
            closePrice: last.closePrice,
            volume,
            quoteVolume,
            isSynthetic: sorted.every((candle) => candle.isSynthetic ?? false)
          } satisfies Candle;
        });

      return [marketCode, aggregated];
    })
  );
}

async function main(): Promise<void> {
  const marketCode = getOption(process.argv, "--market") ?? "KRW-BTC";
  const timeframe = getOption(process.argv, "--timeframe") ?? "1d";
  const requestedLimit = Number.parseInt(getOption(process.argv, "--limit") ?? "500", 10);
  const holdoutDays = Number.parseInt(getOption(process.argv, "--holdout-days") ?? "365", 10);
  const strategyName = getOption(process.argv, "--strategy") ?? "moving-average-cross";
  const universeName = getOption(process.argv, "--universe") ?? "krw-top";
  const marketLimit = Number.parseInt(getOption(process.argv, "--market-limit") ?? "5", 10);
  const compareAll = process.argv.includes("--compare-all");
  const compareUniverse = process.argv.includes("--compare-universe");
  const sweep = process.argv.includes("--sweep");
  const sweepAll = process.argv.includes("--sweep-all");
  const walkForwardSweep = process.argv.includes("--walk-forward-sweep");
  const baselineEvaluate = process.argv.includes("--baseline-evaluate");
  const buildMarketFeatures = process.argv.includes("--build-market-features");
  const universeCrossSectional = process.argv.includes("--universe-cross-sectional");
  const candidateSweep = process.argv.includes("--candidate-sweep");
  const candidateWalkForward = process.argv.includes("--candidate-walk-forward");
  const paperCandidates = process.argv.includes("--paper-candidates");
  const portfolioSweep = process.argv.includes("--portfolio-sweep");
  const saveRegime = process.argv.includes("--save-regime");
  const scoredBaseline = process.argv.includes("--scored-baseline");
  const scoredSweep = process.argv.includes("--scored-sweep");
  const scoredWalkForward = process.argv.includes("--scored-walk-forward");
  const strategyFollowupReport = process.argv.includes("--strategy-followup-report");
  const multiStrategyReport = process.argv.includes("--multi-strategy-report");
  const multiStrategySweep = process.argv.includes("--multi-strategy-sweep");
  const autoResearch = process.argv.includes("--auto-research");
  const multiStrategyPreset = getOption(process.argv, "--multi-strategy-preset");
  const autoResearchFamilies = process.argv
    .flatMap((value, index, args) => (value === "--auto-research-family" ? [args[index + 1]] : []))
    .filter((value): value is string => Boolean(value));
  const autoResearchMode = getOption(process.argv, "--auto-research-mode") === "holdout"
    ? "holdout"
    : "walk-forward";
  const autoResearchIterations = Number.parseInt(getOption(process.argv, "--auto-research-iterations") ?? "3", 10);
  const autoResearchCandidates = Number.parseInt(getOption(process.argv, "--auto-research-candidates") ?? "3", 10);
  const autoResearchParallelism = Number.parseInt(
    getOption(process.argv, "--auto-research-parallelism") ?? String(Math.max(1, autoResearchCandidates)),
    10
  );
  const llmProvider = getOption(process.argv, "--llm-provider") ?? "codex";
  const llmModel = getOption(process.argv, "--llm-model");
  const autoResearchLlmTimeoutMs = Number.parseInt(
    getOption(process.argv, "--auto-research-llm-timeout-ms") ?? "300000",
    10
  );
  const autoResearchOutput =
    getOption(process.argv, "--auto-research-output") ??
    `research/backtester/artifacts/auto-research/${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const resolvedAutoResearchOutput = resolveWorkspaceRelativePath(autoResearchOutput, process.cwd());
  const autoResearchResume = getOption(process.argv, "--auto-research-resume");
  const autoResearchAllowDataCollection = process.argv.includes("--auto-research-allow-data-collection");
  const autoResearchAllowFeatureCache = process.argv.includes("--auto-research-allow-feature-cache");
  const autoResearchAllowCodeMutation = process.argv.includes("--auto-research-allow-code-mutation");
  const autoResearchMinTradesOption = getOption(process.argv, "--auto-research-min-trades");
  const autoResearchMinTrades = autoResearchMinTradesOption
    ? Number.parseInt(autoResearchMinTradesOption, 10)
    : undefined;
  const autoResearchMinNetReturnOption = getOption(process.argv, "--auto-research-min-net-return");
  const autoResearchMinNetReturn = autoResearchMinNetReturnOption
    ? Number.parseFloat(autoResearchMinNetReturnOption)
    : DEFAULT_MIN_NET_RETURN_FOR_PROMOTION;
  const autoResearchMaxDrawdownOption = getOption(process.argv, "--auto-research-max-drawdown");
  const autoResearchMaxDrawdown = autoResearchMaxDrawdownOption
    ? Number.parseFloat(autoResearchMaxDrawdownOption)
    : 0.35;
  const autoResearchMinPositiveWindowRatioOption = getOption(
    process.argv,
    "--auto-research-min-positive-window-ratio"
  );
  const autoResearchMinPositiveWindowRatio = autoResearchMinPositiveWindowRatioOption
    ? Number.parseFloat(autoResearchMinPositiveWindowRatioOption)
    : undefined;
  const autoResearchMinRandomPercentileOption = getOption(
    process.argv,
    "--auto-research-min-random-percentile"
  );
  const autoResearchMinRandomPercentile = autoResearchMinRandomPercentileOption
    ? Number.parseFloat(autoResearchMinRandomPercentileOption)
    : 0.5;
  const autoResearchRequireBootstrapSignificance = process.argv.includes(
    "--auto-research-require-bootstrap-significance"
  );
  const autoResearchMaxNoTradeIterationsOption = getOption(process.argv, "--auto-research-max-no-trade-iterations");
  const autoResearchMaxNoTradeIterations = autoResearchMaxNoTradeIterationsOption
    ? Number.parseInt(autoResearchMaxNoTradeIterationsOption, 10)
    : undefined;
  const parametersJson = getOption(process.argv, "--parameters-json");
  const benchmarkMarketCode = getOption(process.argv, "--benchmark-market");
  const maxPositions = Number.parseInt(getOption(process.argv, "--max-positions") ?? "5", 10);
  const rebalanceBars = Number.parseInt(getOption(process.argv, "--rebalance-bars") ?? "1", 10);
  const minScore = Number.parseFloat(getOption(process.argv, "--min-score") ?? "0");
  const trainingDays = Number.parseInt(
    getOption(process.argv, "--training-days") ?? String(holdoutDays * 2),
    10
  );
  const stepDays = Number.parseInt(getOption(process.argv, "--step-days") ?? String(holdoutDays), 10);
  const minMarkets = Number.parseInt(getOption(process.argv, "--min-markets") ?? "2", 10);
  const minTrades = Number.parseFloat(getOption(process.argv, "--min-trades") ?? "1");
  const requestedMinCandles = getOption(process.argv, "--min-candles");
  const defaultLimit = resolveRequiredLimit({
    timeframe,
    requestedLimit,
    holdoutDays,
    trainingDays,
    stepDays,
    walkForwardMode:
      walkForwardSweep || scoredWalkForward || candidateWalkForward || strategyFollowupReport
  });
  const autoResearchLimit = Math.max(
    requestedLimit,
    calculateAutoResearchMinimumLimit({
      timeframe: "1h",
      holdoutDays,
      trainingDays,
      stepDays,
      mode: autoResearchMode
    })
  );
  const limit = autoResearch ? autoResearchLimit : defaultLimit;
  const minCandles = Number.parseInt(
    requestedMinCandles ?? String(Math.max(150, limit)),
    10
  );

  try {
    if (autoResearch) {
      const llmClient = new CliResearchLlmClient({
        provider: llmProvider,
        model: llmModel,
        cwd: process.cwd()
      });
      const orchestrator = createAutoResearchOrchestrator({ llmClient });
      const report = await orchestrator.run({
        strategyFamilyIds: autoResearchFamilies,
        universeName,
        timeframe: "1h",
        marketLimit,
        limit,
        holdoutDays,
        trainingDays,
        stepDays,
        iterations: Math.max(1, autoResearchIterations),
        candidatesPerIteration: Math.max(1, autoResearchCandidates),
        parallelism: Math.max(1, autoResearchParallelism),
        mode: autoResearchMode,
        llmProvider,
        llmModel,
        llmTimeoutMs: Math.max(0, autoResearchLlmTimeoutMs),
        outputDir: resolvedAutoResearchOutput,
        resumeFrom: autoResearchResume,
        allowDataCollection: autoResearchAllowDataCollection,
        allowFeatureCacheBuild: autoResearchAllowFeatureCache,
        allowCodeMutation: autoResearchAllowCodeMutation,
        minTradesForPromotion:
          typeof autoResearchMinTrades === "number" ? Math.max(0, autoResearchMinTrades) : undefined,
        minNetReturnForPromotion: autoResearchMinNetReturn,
        maxDrawdownForPromotion:
          Number.isFinite(autoResearchMaxDrawdown) ? Math.max(0, autoResearchMaxDrawdown) : undefined,
        minPositiveWindowRatioForPromotion:
          typeof autoResearchMinPositiveWindowRatio === "number"
            ? Math.max(0, Math.min(1, autoResearchMinPositiveWindowRatio))
            : undefined,
        minRandomPercentileForPromotion:
          Number.isFinite(autoResearchMinRandomPercentile)
            ? Math.max(0, Math.min(1, autoResearchMinRandomPercentile))
            : undefined,
        requireBootstrapSignificanceForPromotion: autoResearchRequireBootstrapSignificance,
        maxNoTradeIterations:
          typeof autoResearchMaxNoTradeIterations === "number"
            ? Math.max(0, autoResearchMaxNoTradeIterations)
            : undefined
      });

      console.log(JSON.stringify(report, null, 2));
      return;
    }

    if (multiStrategyReport || multiStrategySweep) {
      const decisionMinCandles = Math.max(minCandles, 120);
      const selectedMarkets =
        await getSelectedUniverseMarketsWithMinimumCandles({
          universeName,
          timeframe: "5m",
          minCandles: decisionMinCandles,
          limit: marketLimit
        });
      const marketCodes = selectedMarkets.map((item) => item.marketCode);

      if (marketCodes.length === 0) {
        throw new Error(`No markets available for ${universeName} multi-strategy report`);
      }

      const availablePresets: MultiStrategyPreset[] = multiStrategySweep
        ? buildMultiStrategyPresets()
        : [
            {
              label: "balanced",
              sleeves: [
                { sleeveId: "trend", capitalBudgetPct: 0.4, maxOpenPositions: 2, maxSinglePositionPct: 0.5, priority: 9 },
                { sleeveId: "breakout", capitalBudgetPct: 0.35, maxOpenPositions: 2, maxSinglePositionPct: 0.5, priority: 7 },
                { sleeveId: "micro", capitalBudgetPct: 0.2, maxOpenPositions: 1, maxSinglePositionPct: 1, priority: 5 }
              ],
              strategies: [
                createRelativeStrengthRotationStrategy(),
                createBreakoutRotationStrategy(),
                createMicroBreakoutStrategy()
              ]
            }
          ];
      const presets = multiStrategyPreset
        ? availablePresets.filter((preset) => preset.label === multiStrategyPreset)
        : availablePresets;

      if (presets.length === 0) {
        throw new Error(`Unknown multi-strategy preset: ${multiStrategyPreset}`);
      }

      const needsDecision1h = presets.some((preset) =>
        preset.strategies.some((strategy) => strategy.decisionTimeframe === "1h")
      );
      const needsDecision15m = presets.some((preset) =>
        preset.strategies.some((strategy) => strategy.decisionTimeframe === "15m")
      );
      const needs5m = presets.some((preset) =>
        preset.strategies.some(
          (strategy) => strategy.decisionTimeframe === "5m" || strategy.executionTimeframe === "5m"
        )
      ) || needsDecision15m;
      const needs1m = presets.some((preset) =>
        preset.strategies.some(
          (strategy) => strategy.decisionTimeframe === "1m" || strategy.executionTimeframe === "1m"
        )
      );

      const [candles1h, candles5m, candles1m] = await Promise.all([
        needsDecision1h ? loadCandlesForMarkets({ marketCodes, timeframe: "1h", limit }) : Promise.resolve({}),
        needs5m ? loadCandlesForMarkets({ marketCodes, timeframe: "5m", limit }) : Promise.resolve({}),
        needs1m ? loadCandlesForMarkets({ marketCodes, timeframe: "1m", limit }) : Promise.resolve({})
      ]);
      const candles15m = needsDecision15m ? aggregate5mCandlesTo15m(candles5m) : {};

      const results = presets.map((preset) => ({
        label: preset.label,
        result: runMultiStrategyBacktest({
          universeName,
          initialCapital: 1_000_000,
          sleeves: preset.sleeves,
          strategies: preset.strategies,
          decisionCandles: {
            "1h": candles1h,
            "15m": candles15m,
            "5m": candles5m,
            "1m": candles1m
          },
          executionCandles: {
            "5m": candles5m,
            "1m": candles1m
          },
          universeConfig: {
            topN: Math.min(12, marketCodes.length),
            lookbackBars: 30,
            refreshEveryBars: 4
          }
        })
      }));

      console.log(
        JSON.stringify(
          {
            universeName,
            marketCodes,
            presets: results.map(({ label, result }) => ({
              label,
              metrics: result.metrics,
              strategyMetrics: result.strategyMetrics,
              sleeveMetrics: result.sleeveMetrics,
              funnel: result.funnel,
              ghostSummary: result.ghostSummary,
              report: formatMultiStrategyReport(result)
            })),
            comparison: formatMultiStrategyComparisonTable(
              results.map(({ label, result }) => ({
                label,
                netReturn: result.metrics.netReturn,
                maxDrawdown: result.metrics.maxDrawdown,
                turnover: result.metrics.turnover,
                winRate: result.metrics.winRate,
                blockedSignals: result.metrics.blockedSignalCount
              }))
            )
          },
          null,
          2
        )
      );

      return;
    }

    if (strategyFollowupReport) {
      const requestedSingleStrategy = listScoredStrategyNames().includes(strategyName)
        ? [strategyName as import("./strategy-followup-report.js").FollowupStrategyName]
        : undefined;
      const report = await generateStrategyFollowupReport({
        timeframe,
        limit,
        holdoutDays,
        trainingDays,
        stepDays,
        universeName,
        marketLimit,
        minCandles,
        strategyNames: requestedSingleStrategy,
        artifactLabel:
          requestedSingleStrategy && requestedSingleStrategy.length === 1
            ? requestedSingleStrategy[0]
            : undefined
      });

      console.log(
        JSON.stringify(
          {
            generatedAt: report.generatedAt,
            baselineDiagnosis: report.baselineDiagnosis,
            recommendation: report.recommendation,
            bestRows: report.bestByStrategy.map((strategy) => ({
              strategyName: strategy.strategyName,
              parameters: strategy.parameters,
              avgTestReturn: strategy.avgTestReturn,
              medianTestReturn: strategy.medianTestReturn,
              executedTradeCount: strategy.executedTradeCount,
              signalCount: strategy.signalCount,
              ghostSignalCount: strategy.ghostSignalCount,
              bootstrapPassRate: strategy.bootstrapPassRate,
              randomPassRate: strategy.randomPassRate,
              promotionEligible: strategy.promotionEligible
            })),
            artifacts: report.artifacts
          },
          null,
          2
        )
      );
      return;
    }

    if (scoredBaseline || scoredSweep || scoredWalkForward) {
      const markets = await getCandidateMarketsWithMinimumCandles({
        timeframe,
        minCandles
      });
      const marketCodes = markets.map((m) => m.marketCode);
      const scoredStrategyNames = sweepAll ? listScoredStrategyNames() : [strategyName];

      if (scoredBaseline) {
        const strategy = createScoredStrategyByName(strategyName, parametersJson ? parseJson(parametersJson) : undefined);

        const result = await executeScoredHoldoutBacktest({
          marketCode: `UNIVERSE:${universeName}`,
          timeframe,
          limit,
          holdoutDays,
          strategy,
          universeName,
          universeMarketCodes: marketCodes,
          universeConfig: {
            topN: marketLimit
          },
          runBootstrap: true,
          runRandomBenchmark: true
        });

        console.log(JSON.stringify({
          universe: universeName,
          candidateMarkets: marketCodes.length,
          activeUniverseSize: marketLimit,
          train: result.train.totalReturn,
          test: result.test.totalReturn,
          testDrawdown: result.test.maxDrawdown,
          signalCount: result.scoredTest.signalCount,
          ghostSignalCount: result.scoredTest.ghostSignalCount,
          turnover: result.test.turnover,
          avgHoldBars: result.test.avgHoldBars,
          feePaid: result.test.feePaid,
          slippagePaid: result.test.slippagePaid,
          rejectedOrdersCount: result.test.rejectedOrdersCount,
          cooldownSkipsCount: result.test.cooldownSkipsCount,
          avgWeight: result.scoredTest.averagePositionWeight,
          circuitBreaker: result.scoredTest.circuitBreakerTriggered,
          bootstrap: result.scoredTest.bootstrap,
          randomBenchmark: result.scoredTest.randomBenchmark
        }, null, 2));

        return;
      }

      if (scoredSweep || scoredWalkForward) {
        const strategies = scoredStrategyNames.flatMap((name) => buildScoredStrategyGrid(name));
        let trainBounds: { start: Date; end: Date } | undefined;
        let testBounds: { start: Date; end: Date } | undefined;

        const grouped = new Map<string, {
          strategyName: string;
          parameters: string;
          universeCount: number;
          trainTotal: number;
          testTotal: number;
          drawdownTotal: number;
          tradeCountTotal: number;
          bootstrapPassCount: number;
          randomPassCount: number;
          turnoverTotal: number;
        }>();

        let preloaded: Awaited<ReturnType<typeof preloadMarketData>> | undefined;
        if (scoredSweep || scoredWalkForward) {
          console.log(`[preload] universe=${universeName} — loading candidate candles...`);
          preloaded = await preloadMarketData({
            marketCode: `UNIVERSE:${universeName}`,
            timeframe,
            limit,
            holdoutDays,
            universeName,
            universeMarketCodes: marketCodes,
            config: strategies[0]?.contextConfig
          });
          console.log(`[preload] universe=${universeName} — done (${preloaded.marketCodes.length} candidate markets)`);
        }

        const totalJobs = strategies.length;

        for (const [index, strategy] of strategies.entries()) {
          const pct = (((index + 1) / totalJobs) * 100).toFixed(1);
          const strategyParams = JSON.stringify(strategy.parameters);
          console.log(`[${index + 1}/${totalJobs}] (${pct}%) ${strategy.name} ${strategyParams}`);

          const summary = scoredWalkForward
            ? await executeScoredWalkForwardBacktest({
                marketCode: `UNIVERSE:${universeName}`,
                timeframe,
                limit,
                holdoutDays,
                trainingDays,
                stepDays,
                strategy,
                universeName,
                universeMarketCodes: marketCodes,
                universeConfig: {
                  topN: marketLimit
                },
                runBootstrap: true,
                runRandomBenchmark: true,
                preloaded
              })
            : await executeScoredHoldoutBacktest({
                marketCode: `UNIVERSE:${universeName}`,
                timeframe,
                limit,
                holdoutDays,
                strategy,
                universeName,
                universeMarketCodes: marketCodes,
                universeConfig: {
                  topN: marketLimit
                },
                runBootstrap: true,
                runRandomBenchmark: true,
                preloaded
              });

          const params = JSON.stringify(strategy.parameters);
          const key = `${strategy.name}:${params}`;
          const current = grouped.get(key) ?? {
            strategyName: strategy.name,
            parameters: params,
            universeCount: 0,
            trainTotal: 0,
            testTotal: 0,
            drawdownTotal: 0,
            tradeCountTotal: 0,
            bootstrapPassCount: 0,
            randomPassCount: 0,
            turnoverTotal: 0
          };

          if (scoredWalkForward) {
            const wf = summary as Awaited<ReturnType<typeof executeScoredWalkForwardBacktest>>;
            current.universeCount += 1;
            current.trainTotal += wf.averageTrainReturn;
            current.testTotal += wf.averageTestReturn;
            current.drawdownTotal += wf.averageTestDrawdown;
            current.tradeCountTotal += wf.averageTestTradeCount;
            current.turnoverTotal += wf.scoredWindows.reduce(
              (sum, window) => sum + window.metrics.turnover,
              0
            ) / Math.max(wf.scoredWindows.length, 1);
            for (const window of wf.scoredWindows) {
              if (window.bootstrap?.isSignificant) current.bootstrapPassCount += 1;
              if ((window.randomBenchmark?.percentileVsRandom ?? 0) >= 0.9) current.randomPassCount += 1;
            }
            for (const window of wf.windows) {
              trainBounds = mergeDateBounds(trainBounds, window.trainRange);
              testBounds = mergeDateBounds(testBounds, window.testRange);
            }
          } else {
            const ho = summary as Awaited<ReturnType<typeof executeScoredHoldoutBacktest>>;
            current.universeCount += 1;
            current.trainTotal += ho.train.totalReturn;
            current.testTotal += ho.test.totalReturn;
            current.drawdownTotal += ho.test.maxDrawdown;
            current.tradeCountTotal += ho.test.tradeCount;
            current.turnoverTotal += ho.test.turnover;
            if (ho.scoredTest.bootstrap?.isSignificant) current.bootstrapPassCount += 1;
            if ((ho.scoredTest.randomBenchmark?.percentileVsRandom ?? 0) >= 0.9) current.randomPassCount += 1;
            trainBounds = mergeDateBounds(trainBounds, ho.trainRange);
            testBounds = mergeDateBounds(testBounds, ho.testRange);
          }

          grouped.set(key, current);
        }

        const rows = [...grouped.values()]
          .filter((value) => value.universeCount >= 1)
          .map((v) => ({
            strategyName: v.strategyName,
            parameters: v.parameters,
            marketCount: marketLimit,
            avgTrainReturn: v.trainTotal / v.universeCount,
            avgTestReturn: v.testTotal / v.universeCount,
            avgTestDrawdown: v.drawdownTotal / v.universeCount,
            avgTestTradeCount: v.tradeCountTotal / v.universeCount,
            avgTurnover: v.turnoverTotal / v.universeCount,
            bootstrapPassRate: v.bootstrapPassCount === 0 ? 0 : v.bootstrapPassCount / Math.max(v.universeCount, 1),
            randomPassRate: v.randomPassCount === 0 ? 0 : v.randomPassCount / Math.max(v.universeCount, 1)
          }))
          .sort((a, b) => b.avgTestReturn - a.avgTestReturn);

        if (saveRegime || paperCandidates) {
          const regimeRows = rows
            .filter((r) => r.bootstrapPassRate > 0 || r.randomPassRate > 0)
            .slice(0, 10)
            .map((r, i) => ({
              strategyType: "universe_scored",
              strategyNames: [r.strategyName],
              parameters: {
                strategyParameters: parseJson<Record<string, number>>(r.parameters),
                bootstrapPassRate: r.bootstrapPassRate,
                randomPassRate: r.randomPassRate,
                avgTestTradeCount: r.avgTestTradeCount,
                avgTurnover: r.avgTurnover,
                activeUniverseSize: marketLimit
              },
              weights: [],
              marketCount: r.marketCount,
              avgTrainReturn: r.avgTrainReturn,
              avgTestReturn: r.avgTestReturn,
              avgTestDrawdown: r.avgTestDrawdown,
              rank: i + 1
            }));

          const regimeName = paperCandidates
            ? "paper-trading-candidate"
            : scoredWalkForward
              ? "scored-walk-forward-recommendation"
              : "scored-holdout-recommendation";

          await replaceStrategyRegimes({
            regimeName,
            universeName,
            timeframe,
            holdoutDays,
            metadata: {
              sourceLabel: scoredWalkForward ? "scored-walk-forward" : "scored-holdout-sweep",
              trainingDays,
              stepDays,
              minMarkets,
              candidatePoolSize: rows.length,
              bestStrategyName: rows[0]?.strategyName,
              trainStartAt: trainBounds?.start,
              trainEndAt: trainBounds?.end,
              testStartAt: testBounds?.start,
              testEndAt: testBounds?.end
            },
            rows: regimeRows
          });
        }

        console.log(JSON.stringify(rows, null, 2));
        return;
      }
    }

    if (buildMarketFeatures) {
      const summary = await buildMarketFeaturePipeline({
        universeName,
        timeframe,
        limit,
        minCandles,
        marketLimit,
        config: buildMarketFeatureConfig({
          strategyName,
          parametersJson,
          benchmarkMarketCode
        })
      });

      console.log(JSON.stringify(summary, null, 2));
      return;
    }

    if (universeCrossSectional) {
      const markets = await getSelectedUniverseMarketsWithMinimumCandles({
        universeName,
        timeframe,
        minCandles,
        limit: marketLimit
      });
      const marketCodes = markets.map((item) => item.marketCode);

      if (marketCodes.length === 0) {
        throw new Error("No universe markets available for cross-sectional backtest");
      }

      const alphaParameters = parametersJson
        ? parseJson<Record<string, number>>(parametersJson)
        : undefined;
      const alphaModel = createCrossSectionalMultiFactorAlphaModel(alphaParameters);
      const universeCandlesByMarket = await loadCandlesForMarkets({
        marketCodes,
        timeframe,
        limit
      });
      const referenceMarketCode = chooseReferenceMarketCode(universeCandlesByMarket);
      const referenceCandles =
        referenceMarketCode === undefined ? [] : universeCandlesByMarket[referenceMarketCode] ?? [];

      if (referenceCandles.length < 2) {
        throw new Error("Not enough reference candles for cross-sectional backtest");
      }

      const { trainRange, testRange } = splitTrainTestByDays(referenceCandles, holdoutDays);
      const trainResult = runUniversePortfolioBacktest({
        strategyName: alphaModel.name,
        universeName,
        timeframe,
        marketCodes,
        universeCandlesByMarket: filterUniverseCandlesByRange(universeCandlesByMarket, trainRange),
        alphaModel,
        referenceMarketCode,
        maxPositions,
        minScore,
        rebalanceEveryBars: rebalanceBars
      });
      const testResult = runUniversePortfolioBacktest({
        strategyName: alphaModel.name,
        universeName,
        timeframe,
        marketCodes,
        universeCandlesByMarket: filterUniverseCandlesByRange(universeCandlesByMarket, testRange),
        alphaModel,
        referenceMarketCode,
        maxPositions,
        minScore,
        rebalanceEveryBars: rebalanceBars
      });

      if (saveRegime || paperCandidates) {
        const row = {
          strategyType: "universe_portfolio",
          strategyNames: [alphaModel.name],
          parameters: {
            alphaModelName: alphaModel.name,
            alphaParameters: alphaModel.parameters,
            portfolioParameters: {
              maxPositions,
              rebalanceBars,
              minScore,
              marketLimit
            },
            holdoutDays
          },
          weights: [],
          marketCount: marketCodes.length,
          avgTrainReturn: trainResult.metrics.totalReturn,
          avgTestReturn: testResult.metrics.totalReturn,
          avgTestDrawdown: testResult.metrics.maxDrawdown,
          rank: 1
        };

        if (saveRegime) {
          await replaceStrategyRegimes({
            regimeName: "universe-portfolio-recommendation",
            universeName,
            timeframe,
            holdoutDays,
            metadata: {
              sourceLabel: "universe-cross-sectional",
              minMarkets: maxPositions,
              candidatePoolSize: 1,
              bestStrategyName: alphaModel.name,
              trainStartAt: trainRange.start,
              trainEndAt: trainRange.end,
              testStartAt: testRange.start,
              testEndAt: testRange.end
            },
            rows: [row]
          });
        }

        if (paperCandidates) {
          await replaceStrategyRegimes({
            regimeName: "paper-trading-candidate",
            universeName,
            timeframe,
            holdoutDays,
            metadata: {
              sourceLabel: "universe-cross-sectional-paper",
              minMarkets: maxPositions,
              candidatePoolSize: 1,
              bestStrategyName: alphaModel.name,
              trainStartAt: trainRange.start,
              trainEndAt: trainRange.end,
              testStartAt: testRange.start,
              testEndAt: testRange.end
            },
            rows: [row]
          });
        }
      }

      console.log(
        JSON.stringify(
          {
            strategyName: alphaModel.name,
            parameters: alphaModel.parameters,
            universeName,
            timeframe,
            marketCount: marketCodes.length,
            trainRange,
            testRange,
            train: trainResult.metrics,
            test: testResult.metrics,
            latestSelections: testResult.selectedHistory.slice(-5)
          },
          null,
          2
        )
      );
      return;
    }

    if (baselineEvaluate) {
      const strategy = createStrategyCandidate({
        strategyName,
        parametersJson
      });
      const markets = await getSelectedUniverseMarketsWithMinimumCandles({
        universeName,
        timeframe,
        minCandles,
        limit: marketLimit
      });
      const holdoutRows = [];
      const walkForwardSummaries = [];

      for (const { marketCode: selectedMarketCode } of markets) {
        try {
          const holdout = await executeHoldoutBacktest({
            marketCode: selectedMarketCode,
            timeframe,
            limit,
            holdoutDays,
            strategy,
            universeName,
            universeMarketCodes: markets.map((item) => item.marketCode)
          });
          holdoutRows.push({
            strategyName: holdout.strategyName,
            marketCode: holdout.marketCode,
            trainReturn: holdout.train.totalReturn,
            testReturn: holdout.test.totalReturn,
            testDrawdown: holdout.test.maxDrawdown,
            testWinRate: holdout.test.winRate,
            testTradeCount: holdout.test.tradeCount
          });
        } catch {
          continue;
        }

        try {
          walkForwardSummaries.push(
            await executeWalkForwardBacktest({
              marketCode: selectedMarketCode,
              timeframe,
              limit,
              holdoutDays,
              trainingDays,
              stepDays,
              strategy,
              universeName,
              universeMarketCodes: markets.map((item) => item.marketCode)
            })
          );
        } catch {
          continue;
        }
      }

      const walkForwardRows =
        walkForwardSummaries.length === 0
          ? []
          : [
              {
                strategyName: strategy.name,
                parameters: JSON.stringify(strategy.parameters),
                marketCount: walkForwardSummaries.length,
                averageWindows:
                  walkForwardSummaries.reduce((sum, item) => sum + item.windowCount, 0) /
                  walkForwardSummaries.length,
                avgTrainReturn:
                  walkForwardSummaries.reduce((sum, item) => sum + item.averageTrainReturn, 0) /
                  walkForwardSummaries.length,
                avgTestReturn:
                  walkForwardSummaries.reduce((sum, item) => sum + item.averageTestReturn, 0) /
                  walkForwardSummaries.length,
                avgTestDrawdown:
                  walkForwardSummaries.reduce((sum, item) => sum + item.averageTestDrawdown, 0) /
                  walkForwardSummaries.length,
                avgTestTradeCount:
                  walkForwardSummaries.reduce((sum, item) => sum + item.averageTestTradeCount, 0) /
                  walkForwardSummaries.length
              }
            ];

      console.log("BASELINE HOLDOUT");
      console.log(formatComparisonTable(holdoutRows));
      console.log("");
      console.log("BASELINE WALK_FORWARD");
      console.log(formatWalkForwardRankingTable(walkForwardRows));
      return;
    }

    if (walkForwardSweep || candidateWalkForward) {
      const markets = await getSelectedUniverseMarketsWithMinimumCandles({
        universeName,
        timeframe,
        minCandles,
        limit: marketLimit
      });
      const marketCodes = markets.map((item) => item.marketCode);
      const strategyNames = sweepAll ? listStrategyNames() : [strategyName];
      const strategies = strategyNames.flatMap((name) => buildStrategyGrid(name));
      const summaries = [];
      let trainBounds: { start: Date; end: Date } | undefined;
      let testBounds: { start: Date; end: Date } | undefined;

      for (const strategy of strategies) {
        for (const market of marketCodes) {
          try {
            const summary = await executeWalkForwardBacktest({
              marketCode: market,
              timeframe,
              limit,
              holdoutDays,
              trainingDays,
              stepDays,
              strategy,
              universeName,
              universeMarketCodes: marketCodes
            });
            summaries.push(summary);
            for (const window of summary.windows) {
              trainBounds = mergeDateBounds(trainBounds, window.trainRange);
              testBounds = mergeDateBounds(testBounds, window.testRange);
            }
          } catch {
            continue;
          }
        }
      }

      const grouped = new Map<
        string,
        {
          strategyName: string;
          parameters: string;
          marketCount: number;
          totalWindows: number;
          trainTotal: number;
          testTotal: number;
          drawdownTotal: number;
          tradeCountTotal: number;
        }
      >();

      for (const summary of summaries) {
        const parameters = JSON.stringify(summary.parameters);
        const key = `${summary.strategyName}:${parameters}`;
        const current = grouped.get(key) ?? {
          strategyName: summary.strategyName,
          parameters,
          marketCount: 0,
          totalWindows: 0,
          trainTotal: 0,
          testTotal: 0,
          drawdownTotal: 0,
          tradeCountTotal: 0
        };

        current.marketCount += 1;
        current.totalWindows += summary.windowCount;
        current.trainTotal += summary.averageTrainReturn;
        current.testTotal += summary.averageTestReturn;
        current.drawdownTotal += summary.averageTestDrawdown;
        current.tradeCountTotal += summary.averageTestTradeCount;
        grouped.set(key, current);
      }

      const rows = [...grouped.values()]
        .map((value) => ({
          strategyName: value.strategyName,
          parameters: value.parameters,
          marketCount: value.marketCount,
          averageWindows: value.totalWindows / value.marketCount,
          avgTrainReturn: value.trainTotal / value.marketCount,
          avgTestReturn: value.testTotal / value.marketCount,
          avgTestDrawdown: value.drawdownTotal / value.marketCount,
          avgTestTradeCount: value.tradeCountTotal / value.marketCount
        }))
        .filter((value) => value.marketCount >= minMarkets)
        .sort((left, right) => right.avgTestReturn - left.avgTestReturn);

      if (walkForwardSweep || candidateWalkForward || saveRegime) {
        await replaceStrategyRegimes({
          regimeName: candidateWalkForward
            ? "candidate-walk-forward-recommendation"
            : "walk-forward-recommendation",
          universeName,
          timeframe,
          holdoutDays,
          metadata: {
            sourceLabel: candidateWalkForward ? "candidate-walk-forward" : "walk-forward-sweep",
            trainingDays,
            stepDays,
            minMarkets,
            candidatePoolSize: rows.length,
            bestStrategyName: rows[0]?.strategyName,
            trainStartAt: trainBounds?.start,
            trainEndAt: trainBounds?.end,
            testStartAt: testBounds?.start,
            testEndAt: testBounds?.end
          },
          rows: rows.slice(0, 10).map((row, index) => ({
            strategyType: "single",
              strategyNames: [row.strategyName],
              parameters: {
                strategyParameters: parseJson<Record<string, number>>(row.parameters),
                trainingDays,
                holdoutDays,
                stepDays,
                averageWindows: row.averageWindows,
                averageTestTradeCount: row.avgTestTradeCount
              },
              weights: [],
              marketCount: row.marketCount,
              avgTrainReturn: row.avgTrainReturn,
              avgTestReturn: row.avgTestReturn,
              avgTestDrawdown: row.avgTestDrawdown,
              rank: index + 1
            }))
        });
      }

      if (paperCandidates) {
        const candidateRows = rows
          .filter((row) => row.avgTestTradeCount >= minTrades)
          .slice(0, 10)
          .map((row, index) => ({
            strategyType: "single",
            strategyNames: [row.strategyName],
            parameters: {
              strategyParameters: parseJson<Record<string, number>>(row.parameters),
              trainingDays,
              holdoutDays,
              stepDays,
              averageWindows: row.averageWindows,
              averageTestTradeCount: row.avgTestTradeCount
            },
            weights: [],
            marketCount: row.marketCount,
            avgTrainReturn: row.avgTrainReturn,
            avgTestReturn: row.avgTestReturn,
            avgTestDrawdown: row.avgTestDrawdown,
            rank: index + 1
          }));

        await replaceStrategyRegimes({
          regimeName: "paper-trading-candidate",
          universeName,
          timeframe,
          holdoutDays,
          metadata: {
            sourceLabel: "walk-forward-paper-candidates",
            trainingDays,
            stepDays,
            minMarkets,
            minTrades,
            candidatePoolSize: candidateRows.length,
            bestStrategyName: candidateRows[0]?.strategyNames[0],
            trainStartAt: trainBounds?.start,
            trainEndAt: trainBounds?.end,
            testStartAt: testBounds?.start,
            testEndAt: testBounds?.end
          },
          rows: candidateRows
        });
      }

      console.log(formatWalkForwardRankingTable(rows));
      return;
    }

    if (portfolioSweep) {
      const markets = await getSelectedUniverseMarketsWithMinimumCandles({
        universeName,
        timeframe,
        minCandles,
        limit: marketLimit
      });
      const portfolios = buildTwoStrategyPortfolios();
      let trainBounds: { start: Date; end: Date } | undefined;
      let testBounds: { start: Date; end: Date } | undefined;
      const grouped = new Map<
        string,
        { strategies: string; markets: number; trainTotal: number; testTotal: number; drawdownTotal: number }
      >();

      for (const portfolio of portfolios) {
        const strategyLabel = buildPortfolioLabel(portfolio);

        for (const { marketCode } of markets) {
          try {
            const candles = await loadCandles({
              marketCode,
              timeframe,
              limit
            });
            const { trainRange, testRange } = splitTrainTestByDays(candles, holdoutDays);
            trainBounds = mergeDateBounds(trainBounds, trainRange);
            testBounds = mergeDateBounds(testBounds, testRange);
            const trainCandles = await loadCandles({
              marketCode,
              timeframe,
              range: trainRange,
              limit
            });
            const testCandles = await loadCandles({
              marketCode,
              timeframe,
              range: testRange,
              limit
            });

            const summary = runPortfolioBacktest({
              marketCode,
              timeframe,
              holdoutDays,
              trainCandles,
              testCandles,
              weightedStrategies: portfolio
            });

            const current = grouped.get(strategyLabel) ?? {
              strategies: strategyLabel,
              markets: 0,
              trainTotal: 0,
              testTotal: 0,
              drawdownTotal: 0
            };

            current.markets += 1;
            current.trainTotal += summary.train.totalReturn;
            current.testTotal += summary.test.totalReturn;
            current.drawdownTotal += summary.test.maxDrawdown;
            grouped.set(strategyLabel, current);
          } catch {
            continue;
          }
        }
      }

      const rows = [...grouped.values()]
        .filter((value) => value.markets > 0)
        .map((value) => ({
          strategies: value.strategies,
          markets: value.markets,
          avgTrainReturn: value.trainTotal / value.markets,
          avgTestReturn: value.testTotal / value.markets,
          avgTestDrawdown: value.drawdownTotal / value.markets
        }))
        .filter((value) => value.markets >= minMarkets)
        .sort((left, right) => right.avgTestReturn - left.avgTestReturn);

      await replaceStrategyRegimes({
        regimeName: "portfolio-recommendation",
        universeName,
        timeframe,
        holdoutDays,
        metadata: {
          sourceLabel: "portfolio-sweep",
          minMarkets,
          candidatePoolSize: rows.length,
          bestStrategyName: rows[0]?.strategies,
          trainStartAt: trainBounds?.start,
          trainEndAt: trainBounds?.end,
          testStartAt: testBounds?.start,
          testEndAt: testBounds?.end
        },
        rows: rows.slice(0, 10).map((row, index) => {
          const parsed = parsePortfolioLabel(row.strategies);

          return {
            strategyType: "portfolio",
            strategyNames: parsed.strategyNames,
            parameters: parsed.parameters,
            weights: parsed.weights,
            marketCount: row.markets,
            avgTrainReturn: row.avgTrainReturn,
            avgTestReturn: row.avgTestReturn,
            avgTestDrawdown: row.avgTestDrawdown,
            rank: index + 1
          };
        })
      });

      console.log(formatPortfolioRankingTable(rows));
      return;
    }

    if (sweep || sweepAll || candidateSweep) {
      const markets = await getSelectedUniverseMarketsWithMinimumCandles({
        universeName,
        timeframe,
        minCandles,
        limit: marketLimit
      });
      const marketCodes = markets.map((item) => item.marketCode);
      const strategyNames = sweepAll ? listStrategyNames() : [strategyName];
      const strategies = strategyNames.flatMap((name) => buildStrategyGrid(name));
      const summaries = [];
      let trainBounds: { start: Date; end: Date } | undefined;
      let testBounds: { start: Date; end: Date } | undefined;

      for (const strategy of strategies) {
        for (const market of marketCodes) {
          try {
            const summary = await executeHoldoutBacktest({
              marketCode: market,
              timeframe,
              limit,
              holdoutDays,
              strategy,
              universeName,
              universeMarketCodes: marketCodes
            });
            summaries.push(summary);
            trainBounds = mergeDateBounds(trainBounds, summary.trainRange);
            testBounds = mergeDateBounds(testBounds, summary.testRange);
          } catch {
            continue;
          }
        }
      }

      const grouped = new Map<
        string,
        {
          strategyName: string;
          parameters: string;
          marketCount: number;
          trainTotal: number;
          testTotal: number;
          drawdownTotal: number;
        }
      >();

      for (const summary of summaries) {
        const parameters = JSON.stringify(summary.parameters);
        const key = `${summary.strategyName}:${parameters}`;
        const current = grouped.get(key) ?? {
          strategyName: summary.strategyName,
          parameters,
          marketCount: 0,
          trainTotal: 0,
          testTotal: 0,
          drawdownTotal: 0
        };

        current.marketCount += 1;
        current.trainTotal += summary.train.totalReturn;
        current.testTotal += summary.test.totalReturn;
        current.drawdownTotal += summary.test.maxDrawdown;
        grouped.set(key, current);
      }

      const rankingRows = [...grouped.values()]
        .map((value) => ({
          strategyName: value.strategyName,
          parameters: value.parameters,
          marketCount: value.marketCount,
          avgTrainReturn: value.trainTotal / value.marketCount,
          avgTestReturn: value.testTotal / value.marketCount,
          avgTestDrawdown: value.drawdownTotal / value.marketCount
        }))
        .filter((value) => value.marketCount >= minMarkets)
        .sort((left, right) => right.avgTestReturn - left.avgTestReturn);

      if (sweep || sweepAll || candidateSweep || saveRegime) {
        await replaceStrategyRegimes({
          regimeName: candidateSweep ? "candidate-holdout-recommendation" : "strategy-recommendation",
          universeName,
          timeframe,
          holdoutDays,
          metadata: {
            sourceLabel: candidateSweep
              ? "candidate-holdout-sweep"
              : sweepAll
                ? "holdout-sweep-all"
                : "holdout-sweep",
            minMarkets,
            candidatePoolSize: rankingRows.length,
            bestStrategyName: rankingRows[0]?.strategyName,
            trainStartAt: trainBounds?.start,
            trainEndAt: trainBounds?.end,
            testStartAt: testBounds?.start,
            testEndAt: testBounds?.end
          },
          rows: rankingRows.slice(0, 10).map((row, index) => ({
            strategyType: "single",
            strategyNames: [row.strategyName],
            parameters: parseJson<Record<string, number>>(row.parameters),
            weights: [],
            marketCount: row.marketCount,
            avgTrainReturn: row.avgTrainReturn,
            avgTestReturn: row.avgTestReturn,
            avgTestDrawdown: row.avgTestDrawdown,
            rank: index + 1
          }))
        });
      }

      console.log(formatRankingTable(rankingRows));
      return;
    }

    if (compareUniverse) {
      const markets = await getSelectedUniverseMarketsWithMinimumCandles({
        universeName,
        timeframe,
        minCandles,
        limit: marketLimit
      });
      const rows = [];

      for (const { marketCode } of markets) {
        for (const candidate of listStrategyNames()) {
          const strategy = createStrategyByName(candidate);
          try {
            const result = await executeHoldoutBacktest({
              marketCode,
              timeframe,
              limit,
              holdoutDays,
              strategy,
              universeName,
              universeMarketCodes: markets.map((item) => item.marketCode)
            });

            rows.push({
              strategyName: result.strategyName,
              marketCode: result.marketCode,
              trainReturn: result.train.totalReturn,
              testReturn: result.test.totalReturn,
              testDrawdown: result.test.maxDrawdown,
              testWinRate: result.test.winRate,
              testTradeCount: result.test.tradeCount
            });
          } catch {
            continue;
          }
        }
      }

      console.log(formatComparisonTable(rows));
      return;
    }

    if (compareAll) {
      const contextMarkets = await getSelectedUniverseMarketsWithMinimumCandles({
        universeName,
        timeframe,
        minCandles,
        limit: marketLimit
      });
      const results = [];

      for (const candidate of listStrategyNames()) {
        const strategy = createStrategyByName(candidate);
        results.push(
          await executeHoldoutBacktest({
            marketCode,
            timeframe,
            limit,
            holdoutDays,
            strategy,
            universeName,
            universeMarketCodes: contextMarkets.map((item) => item.marketCode)
          })
        );
      }

      console.log(JSON.stringify(results, null, 2));
      return;
    }

    const strategy = createStrategyCandidate({
      strategyName,
      parametersJson
    });
    const contextMarkets = await getSelectedUniverseMarketsWithMinimumCandles({
      universeName,
      timeframe,
      minCandles,
      limit: marketLimit
    });
    const result = await executeHoldoutBacktest({
      marketCode,
      timeframe,
      limit,
      holdoutDays,
      strategy,
      universeName,
      universeMarketCodes: contextMarkets.map((item) => item.marketCode)
    });

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await closeDb();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
