import {
  closeDb,
  getSelectedUniverseMarketsWithMinimumCandles,
  replaceStrategyRegimes
} from "./db.js";
import { buildStrategyGrid } from "./parameter-grid.js";
import { buildTwoStrategyPortfolios } from "./portfolio-grid.js";
import { runPortfolioBacktest } from "./portfolio.js";
import {
  formatComparisonTable,
  formatPortfolioRankingTable,
  formatRankingTable,
  formatWalkForwardRankingTable
} from "./report.js";
import { executeHoldoutBacktest, executeWalkForwardBacktest } from "./runner.js";
import { createStrategyByName, listStrategyNames } from "./strategy-registry.js";
import { loadCandles } from "./db.js";
import { splitTrainTestByDays } from "./validation.js";

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
  walkForwardSweep: boolean;
}): number {
  const perDay = candlesPerDay(params.timeframe);
  const baseDays = params.walkForwardSweep
    ? params.trainingDays + params.holdoutDays + params.stepDays
    : params.holdoutDays * 2;
  const buffered = Math.ceil(baseDays * perDay * 1.1);

  return Math.max(params.requestedLimit, buffered);
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function createStrategyByNameWithParameters(
  strategyName: string,
  parameters: Record<string, number>
): ReturnType<typeof createStrategyByName> {
  const strategy = createStrategyByName(strategyName);

  return {
    ...strategy,
    parameters
  };
}

function createStrategyCandidate(params: {
  strategyName: string;
  parametersJson?: string;
}): ReturnType<typeof createStrategyByName> {
  if (!params.parametersJson) {
    return createStrategyByName(params.strategyName);
  }

  return createStrategyByNameWithParameters(
    params.strategyName,
    parseJson<Record<string, number>>(params.parametersJson)
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
  const candidateSweep = process.argv.includes("--candidate-sweep");
  const candidateWalkForward = process.argv.includes("--candidate-walk-forward");
  const paperCandidates = process.argv.includes("--paper-candidates");
  const portfolioSweep = process.argv.includes("--portfolio-sweep");
  const saveRegime = process.argv.includes("--save-regime");
  const parametersJson = getOption(process.argv, "--parameters-json");
  const trainingDays = Number.parseInt(
    getOption(process.argv, "--training-days") ?? String(holdoutDays * 2),
    10
  );
  const stepDays = Number.parseInt(getOption(process.argv, "--step-days") ?? String(holdoutDays), 10);
  const minMarkets = Number.parseInt(getOption(process.argv, "--min-markets") ?? "2", 10);
  const minTrades = Number.parseFloat(getOption(process.argv, "--min-trades") ?? "1");
  const minCandles = Number.parseInt(
    getOption(process.argv, "--min-candles") ?? String(Math.max(150, trainingDays + holdoutDays + 30)),
    10
  );
  const limit = resolveRequiredLimit({
    timeframe,
    requestedLimit,
    holdoutDays,
    trainingDays,
    stepDays,
    walkForwardSweep
  });

  try {
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
            strategy
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
              strategy
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
              strategy
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
              strategy
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
              strategy
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
      const results = [];

      for (const candidate of listStrategyNames()) {
        const strategy = createStrategyByName(candidate);
        results.push(
          await executeHoldoutBacktest({
            marketCode,
            timeframe,
            limit,
            holdoutDays,
            strategy
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
    const result = await executeHoldoutBacktest({
      marketCode,
      timeframe,
      limit,
      holdoutDays,
      strategy
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
