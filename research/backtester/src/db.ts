import { Pool } from "pg";

import {
  getMarketStateConfigKey,
  resolveMarketStateConfig
} from "../../strategies/src/index.js";
import type {
  BenchmarkMarketContext,
  MarketBreadthContext,
  MarketStateConfig,
  MarketStateContext,
  RelativeStrengthContext
} from "../../strategies/src/index.js";
import { DATABASE_URL } from "./config.js";
import type { Candle, PeriodRange } from "./types.js";

const pool = new Pool({
  connectionString: DATABASE_URL
});

const FEATURE_INSERT_BATCH_SIZE = 250;

type MarketBreadthFeatureRow = {
  featureTimeUtc: Date;
  sampleSize: number;
  breadth: MarketBreadthContext;
  benchmarkMarketCode?: string;
  benchmark?: BenchmarkMarketContext;
};

type MarketRelativeStrengthFeatureRow = {
  marketCode: string;
  featureTimeUtc: Date;
  relativeStrength: RelativeStrengthContext;
};

function chunk<T>(items: T[], size: number): T[][] {
  if (items.length === 0) {
    return [];
  }

  const batches: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }

  return batches;
}

function buildValuesClause(rowCount: number, columnCount: number): string {
  return Array.from({ length: rowCount }, (_, rowIndex) => {
    const placeholders = Array.from(
      { length: columnCount },
      (_, columnIndex) => `$${rowIndex * columnCount + columnIndex + 1}`
    );

    return `(${placeholders.join(", ")})`;
  }).join(", ");
}

function toOptionalNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function toOptionalBoolean(value: unknown): boolean | null {
  return value === null || value === undefined ? null : Boolean(value);
}

function toOptionalBenchmarkRegime(
  value: unknown
): BenchmarkMarketContext["regime"] | undefined {
  switch (value) {
    case "trend_up":
    case "trend_down":
    case "range":
    case "volatile":
    case "unknown":
      return value;
    default:
      return undefined;
  }
}

export async function closeDb(): Promise<void> {
  await pool.end();
}

export async function loadCandles(params: {
  marketCode: string;
  timeframe: string;
  limit?: number;
  range?: PeriodRange;
}): Promise<Candle[]> {
  const hasRange = Boolean(params.range);
  const result = await pool.query(
    `
      SELECT
        market_code,
        timeframe,
        candle_time_utc,
        open_price,
        high_price,
        low_price,
        close_price,
        volume,
        notional
      FROM candles
      WHERE market_code = $1
        AND timeframe = $2
        AND ($3::timestamptz IS NULL OR candle_time_utc >= $3)
        AND ($4::timestamptz IS NULL OR candle_time_utc <= $4)
      ORDER BY candle_time_utc ASC
      LIMIT $5
    `,
    [
      params.marketCode,
      params.timeframe,
      hasRange ? params.range?.start.toISOString() : null,
      hasRange ? params.range?.end.toISOString() : null,
      params.limit ?? 5000
    ]
  );

  return (result.rows as Array<Record<string, string | Date>>).map((row) => ({
    marketCode: String(row.market_code),
    timeframe: String(row.timeframe),
    candleTimeUtc: new Date(row.candle_time_utc as string | Date),
    openPrice: Number(row.open_price),
    highPrice: Number(row.high_price),
    lowPrice: Number(row.low_price),
    closePrice: Number(row.close_price),
    volume: Number(row.volume),
    quoteVolume: row.notional === null || row.notional === undefined ? undefined : Number(row.notional)
  }));
}

export async function loadCandlesForMarkets(params: {
  marketCodes: string[];
  timeframe: string;
  limit?: number;
  range?: PeriodRange;
}): Promise<Record<string, Candle[]>> {
  if (params.marketCodes.length === 0) {
    return {};
  }

  const hasRange = Boolean(params.range);
  const result = await pool.query(
    `
      WITH ranked AS (
        SELECT
          market_code,
          timeframe,
          candle_time_utc,
          open_price,
          high_price,
          low_price,
          close_price,
          volume,
          notional,
          ROW_NUMBER() OVER (
            PARTITION BY market_code
            ORDER BY candle_time_utc DESC
          ) AS row_number
        FROM candles
        WHERE market_code = ANY($1::text[])
          AND timeframe = $2
          AND ($3::timestamptz IS NULL OR candle_time_utc >= $3)
          AND ($4::timestamptz IS NULL OR candle_time_utc <= $4)
      )
      SELECT
        market_code,
        timeframe,
        candle_time_utc,
        open_price,
        high_price,
        low_price,
        close_price,
        volume,
        notional
      FROM ranked
      WHERE ($5::int IS NULL OR row_number <= $5)
      ORDER BY market_code ASC, candle_time_utc ASC
    `,
    [
      params.marketCodes,
      params.timeframe,
      hasRange ? params.range?.start.toISOString() : null,
      hasRange ? params.range?.end.toISOString() : null,
      params.limit ?? null
    ]
  );

  const grouped = Object.fromEntries(params.marketCodes.map((marketCode) => [marketCode, [] as Candle[]]));

  for (const row of result.rows as Array<Record<string, string | Date>>) {
    const marketCode = String(row.market_code);
    grouped[marketCode]?.push({
      marketCode,
      timeframe: String(row.timeframe),
      candleTimeUtc: new Date(row.candle_time_utc as string | Date),
      openPrice: Number(row.open_price),
      highPrice: Number(row.high_price),
      lowPrice: Number(row.low_price),
      closePrice: Number(row.close_price),
      volume: Number(row.volume),
      quoteVolume: row.notional === null || row.notional === undefined ? undefined : Number(row.notional)
    });
  }

  return grouped;
}

export async function upsertMarketBreadthFeatures(params: {
  universeName: string;
  timeframe: string;
  config?: MarketStateConfig;
  rows: MarketBreadthFeatureRow[];
}): Promise<number> {
  if (params.rows.length === 0) {
    return 0;
  }

  const resolvedConfig = resolveMarketStateConfig(params.config);
  const configKey = getMarketStateConfigKey(resolvedConfig);
  const configJson = JSON.stringify(resolvedConfig);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    for (const batch of chunk(params.rows, FEATURE_INSERT_BATCH_SIZE)) {
      const values: Array<boolean | number | string | null> = [];

      for (const row of batch) {
        values.push(
          params.universeName,
          params.timeframe,
          configKey,
          configJson,
          row.featureTimeUtc.toISOString(),
          row.sampleSize,
          row.breadth.advancingRatio,
          row.breadth.aboveTrendRatio,
          row.breadth.positiveMomentumRatio,
          row.breadth.averageMomentum,
          row.breadth.averageZScore,
          row.breadth.averageVolumeSpike,
          row.breadth.averageHistoricalVolatility,
          row.breadth.dispersionScore,
          row.breadth.liquidityScore,
          row.breadth.compositeTrendScore,
          row.benchmark?.averageChange ?? null,
          row.benchmark?.momentum ?? null,
          row.benchmark?.historicalVolatility ?? null,
          row.benchmark?.regime ?? null,
          row.breadth.riskOnScore,
          row.benchmarkMarketCode ?? row.benchmark?.marketCode ?? "__COMPOSITE__",
          row.benchmark?.momentum ?? null,
          row.benchmark?.aboveTrend ?? null,
          row.benchmark?.historicalVolatility ?? null,
          row.benchmark?.regime ?? null
        );
      }

      await client.query(
        `
          INSERT INTO market_breadth_features (
            universe_name,
            timeframe,
            config_key,
            config_json,
            feature_time_utc,
            sample_size,
            advancing_ratio,
            above_trend_ratio,
            positive_momentum_ratio,
            average_momentum,
            average_z_score,
            average_volume_spike,
            average_historical_volatility,
            dispersion_score,
            liquidity_score,
            composite_trend_score,
            composite_change,
            composite_momentum,
            composite_historical_volatility,
            composite_regime,
            risk_on_score,
            benchmark_market_code,
            benchmark_momentum,
            benchmark_above_trend,
            benchmark_historical_volatility,
            benchmark_regime
          )
          VALUES ${buildValuesClause(batch.length, 26)}
          ON CONFLICT (universe_name, timeframe, config_key, feature_time_utc)
          DO UPDATE SET
            config_json = EXCLUDED.config_json,
            sample_size = EXCLUDED.sample_size,
            advancing_ratio = EXCLUDED.advancing_ratio,
            above_trend_ratio = EXCLUDED.above_trend_ratio,
            positive_momentum_ratio = EXCLUDED.positive_momentum_ratio,
            average_momentum = EXCLUDED.average_momentum,
            average_z_score = EXCLUDED.average_z_score,
            average_volume_spike = EXCLUDED.average_volume_spike,
            average_historical_volatility = EXCLUDED.average_historical_volatility,
            dispersion_score = EXCLUDED.dispersion_score,
            liquidity_score = EXCLUDED.liquidity_score,
            composite_trend_score = EXCLUDED.composite_trend_score,
            composite_change = EXCLUDED.composite_change,
            composite_momentum = EXCLUDED.composite_momentum,
            composite_historical_volatility = EXCLUDED.composite_historical_volatility,
            composite_regime = EXCLUDED.composite_regime,
            risk_on_score = EXCLUDED.risk_on_score,
            benchmark_market_code = EXCLUDED.benchmark_market_code,
            benchmark_momentum = EXCLUDED.benchmark_momentum,
            benchmark_above_trend = EXCLUDED.benchmark_above_trend,
            benchmark_historical_volatility = EXCLUDED.benchmark_historical_volatility,
            benchmark_regime = EXCLUDED.benchmark_regime,
            updated_at = NOW()
        `,
        values
      );
    }

    await client.query("COMMIT");
    return params.rows.length;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function upsertMarketRelativeStrengthFeatures(params: {
  universeName: string;
  timeframe: string;
  config?: MarketStateConfig;
  rows: MarketRelativeStrengthFeatureRow[];
}): Promise<number> {
  if (params.rows.length === 0) {
    return 0;
  }

  const resolvedConfig = resolveMarketStateConfig(params.config);
  const configKey = getMarketStateConfigKey(resolvedConfig);
  const configJson = JSON.stringify(resolvedConfig);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    for (const batch of chunk(params.rows, FEATURE_INSERT_BATCH_SIZE)) {
      const values: Array<number | string | null> = [];

      for (const row of batch) {
        values.push(
          params.universeName,
          params.timeframe,
          configKey,
          configJson,
          row.marketCode,
          row.featureTimeUtc.toISOString(),
          row.relativeStrength.momentumSpread,
          row.relativeStrength.zScoreSpread,
          row.relativeStrength.volumeSpikeSpread,
          row.relativeStrength.benchmarkMomentumSpread,
          row.relativeStrength.momentumPercentile,
          row.relativeStrength.cohortMomentumSpread,
          row.relativeStrength.cohortZScoreSpread,
          row.relativeStrength.cohortVolumeSpikeSpread,
          row.relativeStrength.compositeMomentumSpread,
          row.relativeStrength.compositeChangeSpread,
          row.relativeStrength.liquiditySpread,
          row.relativeStrength.returnPercentile
        );
      }

      await client.query(
        `
          INSERT INTO market_relative_strength_features (
            universe_name,
            timeframe,
            config_key,
            config_json,
            market_code,
            feature_time_utc,
            momentum_spread,
            z_score_spread,
            volume_spike_spread,
            benchmark_momentum_spread,
            momentum_percentile,
            cohort_momentum_spread,
            cohort_z_score_spread,
            cohort_volume_spike_spread,
            composite_momentum_spread,
            composite_change_spread,
            liquidity_spread,
            return_percentile
          )
          VALUES ${buildValuesClause(batch.length, 18)}
          ON CONFLICT (universe_name, timeframe, config_key, feature_time_utc, market_code)
          DO UPDATE SET
            config_json = EXCLUDED.config_json,
            momentum_spread = EXCLUDED.momentum_spread,
            z_score_spread = EXCLUDED.z_score_spread,
            volume_spike_spread = EXCLUDED.volume_spike_spread,
            benchmark_momentum_spread = EXCLUDED.benchmark_momentum_spread,
            momentum_percentile = EXCLUDED.momentum_percentile,
            cohort_momentum_spread = EXCLUDED.cohort_momentum_spread,
            cohort_z_score_spread = EXCLUDED.cohort_z_score_spread,
            cohort_volume_spike_spread = EXCLUDED.cohort_volume_spike_spread,
            composite_momentum_spread = EXCLUDED.composite_momentum_spread,
            composite_change_spread = EXCLUDED.composite_change_spread,
            liquidity_spread = EXCLUDED.liquidity_spread,
            return_percentile = EXCLUDED.return_percentile,
            updated_at = NOW()
        `,
        values
      );
    }

    await client.query("COMMIT");
    return params.rows.length;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function loadMarketStateFeatureSeries(params: {
  marketCode: string;
  universeName: string;
  timeframe: string;
  config?: MarketStateConfig;
  range?: PeriodRange;
}): Promise<Record<string, MarketStateContext>> {
  const hasRange = Boolean(params.range);
  const resolvedConfig = resolveMarketStateConfig(params.config);
  const configKey = getMarketStateConfigKey(resolvedConfig);
  const result = await pool.query(
    `
      SELECT
        b.universe_name,
        b.feature_time_utc,
        b.sample_size,
        b.advancing_ratio,
        b.above_trend_ratio,
        b.positive_momentum_ratio,
        b.average_momentum,
        b.average_z_score,
        b.average_volume_spike,
        b.average_historical_volatility,
        b.dispersion_score,
        b.liquidity_score,
        b.composite_trend_score,
        b.composite_change,
        b.composite_momentum,
        b.composite_historical_volatility,
        b.composite_regime,
        b.risk_on_score,
        b.benchmark_market_code,
        b.benchmark_momentum,
        b.benchmark_above_trend,
        b.benchmark_historical_volatility,
        b.benchmark_regime,
        r.momentum_spread,
        r.z_score_spread,
        r.volume_spike_spread,
        r.benchmark_momentum_spread,
        r.momentum_percentile,
        r.cohort_momentum_spread,
        r.cohort_z_score_spread,
        r.cohort_volume_spike_spread,
        r.composite_momentum_spread,
        r.composite_change_spread,
        r.liquidity_spread,
        r.return_percentile
      FROM market_breadth_features b
      LEFT JOIN market_relative_strength_features r
        ON r.universe_name = b.universe_name
       AND r.timeframe = b.timeframe
       AND r.config_key = b.config_key
       AND r.feature_time_utc = b.feature_time_utc
       AND r.market_code = $4
      WHERE b.universe_name = $1
        AND b.timeframe = $2
        AND b.config_key = $3
        AND ($5::timestamptz IS NULL OR b.feature_time_utc >= $5)
        AND ($6::timestamptz IS NULL OR b.feature_time_utc <= $6)
      ORDER BY b.feature_time_utc ASC
    `,
    [
      params.universeName,
      params.timeframe,
      configKey,
      params.marketCode,
      hasRange ? params.range?.start.toISOString() : null,
      hasRange ? params.range?.end.toISOString() : null
    ]
  );

  const featureSeries: Record<string, MarketStateContext> = {};

  for (const row of result.rows as Array<Record<string, unknown>>) {
    const referenceTime = new Date(row.feature_time_utc as string | Date);
    const compositeRegime =
      toOptionalBenchmarkRegime(row.composite_regime) ??
      toOptionalBenchmarkRegime(row.benchmark_regime);
    const benchmarkMarketCode =
      row.benchmark_market_code === null || row.benchmark_market_code === undefined
        ? undefined
        : String(row.benchmark_market_code);
    const composite = {
      source: "universe_composite" as const,
      marketCode: benchmarkMarketCode ?? "__COMPOSITE__",
      averageChange: toOptionalNumber(row.composite_change),
      momentum:
        toOptionalNumber(row.composite_momentum) ?? toOptionalNumber(row.benchmark_momentum),
      aboveTrend: toOptionalBoolean(row.benchmark_above_trend),
      aboveTrendRatio: Number(row.above_trend_ratio),
      historicalVolatility:
        toOptionalNumber(row.composite_historical_volatility) ??
        toOptionalNumber(row.benchmark_historical_volatility),
      trendScore:
        toOptionalNumber(row.composite_trend_score) ?? Number(row.risk_on_score),
      liquidityScore:
        toOptionalNumber(row.liquidity_score) ?? 0,
      dispersionScore:
        toOptionalNumber(row.dispersion_score) ?? 0,
      regime: compositeRegime ?? "unknown"
    };
    const hasRelativeStrength = [
      row.momentum_spread,
      row.z_score_spread,
      row.volume_spike_spread,
      row.benchmark_momentum_spread,
      row.momentum_percentile,
      row.cohort_momentum_spread,
      row.composite_momentum_spread,
      row.return_percentile
    ].some((value) => value !== null && value !== undefined);
    const cohortMomentumSpread =
      toOptionalNumber(row.cohort_momentum_spread) ?? toOptionalNumber(row.momentum_spread);
    const cohortZScoreSpread =
      toOptionalNumber(row.cohort_z_score_spread) ?? toOptionalNumber(row.z_score_spread);
    const cohortVolumeSpikeSpread =
      toOptionalNumber(row.cohort_volume_spike_spread) ??
      toOptionalNumber(row.volume_spike_spread);
    const compositeMomentumSpread =
      toOptionalNumber(row.composite_momentum_spread) ??
      toOptionalNumber(row.benchmark_momentum_spread);

    featureSeries[referenceTime.toISOString()] = {
      universeName: String(row.universe_name),
      benchmarkMarketCode: composite.marketCode,
      referenceTime,
      sampleSize: Number(row.sample_size),
      breadth: {
        sampleSize: Number(row.sample_size),
        advancingRatio: Number(row.advancing_ratio),
        aboveTrendRatio: Number(row.above_trend_ratio),
        positiveMomentumRatio: Number(row.positive_momentum_ratio),
        averageMomentum: toOptionalNumber(row.average_momentum),
        averageZScore: toOptionalNumber(row.average_z_score),
        averageVolumeSpike: toOptionalNumber(row.average_volume_spike),
        averageHistoricalVolatility: toOptionalNumber(row.average_historical_volatility),
        dispersionScore: toOptionalNumber(row.dispersion_score) ?? 0,
        liquidityScore: toOptionalNumber(row.liquidity_score) ?? 0,
        compositeTrendScore: toOptionalNumber(row.composite_trend_score) ?? 0,
        riskOnScore: Number(row.risk_on_score)
      },
      relativeStrength: hasRelativeStrength
        ? {
            momentumSpread: cohortMomentumSpread,
            zScoreSpread: cohortZScoreSpread,
            volumeSpikeSpread: cohortVolumeSpikeSpread,
            benchmarkMomentumSpread: compositeMomentumSpread,
            momentumPercentile: toOptionalNumber(row.momentum_percentile),
            cohortMomentumSpread,
            cohortZScoreSpread,
            cohortVolumeSpikeSpread,
            compositeMomentumSpread,
            compositeChangeSpread: toOptionalNumber(row.composite_change_spread),
            liquiditySpread: toOptionalNumber(row.liquidity_spread),
            returnPercentile: toOptionalNumber(row.return_percentile)
          }
        : undefined,
      composite,
      benchmark: composite
    };
  }

  return featureSeries;
}

export async function createBacktestRun(params: {
  strategyName: string;
  strategyVersion: string;
  parameters: Record<string, number>;
  marketCode: string;
  universeName?: string;
  marketCount?: number;
  timeframe: string;
  trainRange: PeriodRange;
  testRange: PeriodRange;
}): Promise<number> {
  try {
    const result = await pool.query(
      `
        INSERT INTO backtest_runs (
          strategy_name,
          strategy_version,
          parameters_json,
          market_code,
          universe_name,
          market_count,
          timeframe,
          train_start_at,
          train_end_at,
          test_start_at,
          test_end_at,
          status
        )
        VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10, $11, 'running')
        RETURNING id
      `,
      [
        params.strategyName,
        params.strategyVersion,
        JSON.stringify(params.parameters),
        params.marketCode,
        params.universeName ?? null,
        params.marketCount ?? null,
        params.timeframe,
        params.trainRange.start.toISOString(),
        params.trainRange.end.toISOString(),
        params.testRange.start.toISOString(),
        params.testRange.end.toISOString()
      ]
    );

    return (result.rows[0] as { id: number }).id;
  } catch (error) {
    if (!(error instanceof Error) || !/universe_name|market_count/.test(error.message)) {
      throw error;
    }

    const fallback = await pool.query(
      `
        INSERT INTO backtest_runs (
          strategy_name,
          strategy_version,
          parameters_json,
          market_code,
          timeframe,
          train_start_at,
          train_end_at,
          test_start_at,
          test_end_at,
          status
        )
        VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, 'running')
        RETURNING id
      `,
      [
        params.strategyName,
        params.strategyVersion,
        JSON.stringify(params.parameters),
        params.marketCode,
        params.timeframe,
        params.trainRange.start.toISOString(),
        params.trainRange.end.toISOString(),
        params.testRange.start.toISOString(),
        params.testRange.end.toISOString()
      ]
    );

    return (fallback.rows[0] as { id: number }).id;
  }
}

export async function completeBacktestRun(
  backtestRunId: number,
  status: "success" | "failed"
): Promise<void> {
  await pool.query(
    `
      UPDATE backtest_runs
      SET status = $2,
          finished_at = NOW()
      WHERE id = $1
    `,
    [backtestRunId, status]
  );
}

export async function insertBacktestMetrics(params: {
  backtestRunId: number;
  segmentType: string;
  totalReturn: number;
  grossReturn?: number;
  netReturn?: number;
  maxDrawdown: number;
  winRate: number;
  tradeCount: number;
  turnover?: number;
  avgHoldBars?: number;
  feePaid?: number;
  slippagePaid?: number;
  rejectedOrdersCount?: number;
  cooldownSkipsCount?: number;
}): Promise<void> {
  try {
    await pool.query(
      `
        INSERT INTO backtest_metrics (
          backtest_run_id,
          segment_type,
          total_return,
          gross_return,
          net_return,
          max_drawdown,
          win_rate,
          trade_count,
          turnover,
          avg_hold_bars,
          fee_paid,
          slippage_paid,
          rejected_orders_count,
          cooldown_skips_count
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      `,
      [
        params.backtestRunId,
        params.segmentType,
        params.totalReturn,
        params.grossReturn ?? params.totalReturn,
        params.netReturn ?? params.totalReturn,
        params.maxDrawdown,
        params.winRate,
        params.tradeCount,
        params.turnover ?? 0,
        params.avgHoldBars ?? 0,
        params.feePaid ?? 0,
        params.slippagePaid ?? 0,
        params.rejectedOrdersCount ?? 0,
        params.cooldownSkipsCount ?? 0
      ]
    );
  } catch (error) {
    if (!(error instanceof Error) || !/gross_return|net_return|turnover|avg_hold_bars|fee_paid|slippage_paid|rejected_orders_count|cooldown_skips_count/.test(error.message)) {
      throw error;
    }

    await pool.query(
      `
        INSERT INTO backtest_metrics (
          backtest_run_id,
          segment_type,
          total_return,
          annualized_return,
          max_drawdown,
          sharpe_ratio,
          sortino_ratio,
          win_rate,
          profit_factor,
          trade_count
        )
        VALUES ($1, $2, $3, NULL, $4, NULL, NULL, $5, NULL, $6)
      `,
      [
        params.backtestRunId,
        params.segmentType,
        params.totalReturn,
        params.maxDrawdown,
        params.winRate,
        params.tradeCount
      ]
    );
  }
}

export async function getSelectedUniverseMarkets(params: {
  universeName: string;
  limit?: number;
}): Promise<string[]> {
  const result = await pool.query(
    `
      SELECT market_code
      FROM market_universe
      WHERE universe_name = $1
        AND is_selected = TRUE
      ORDER BY rank ASC
      LIMIT $2
    `,
    [params.universeName, params.limit ?? 999]
  );

  return (result.rows as Array<{ market_code: string }>).map((row) => row.market_code);
}

export async function getSelectedUniverseMarketsWithMinimumCandles(params: {
  universeName: string;
  timeframe: string;
  minCandles: number;
  limit?: number;
}): Promise<Array<{ marketCode: string; candleCount: number }>> {
  const result = await pool.query(
    `
      SELECT
        mu.market_code,
        COUNT(c.id)::int AS candle_count
      FROM market_universe mu
      LEFT JOIN candles c
        ON c.market_code = mu.market_code
       AND c.timeframe = $2
      WHERE mu.universe_name = $1
        AND mu.is_selected = TRUE
      GROUP BY mu.rank, mu.market_code
      HAVING COUNT(c.id) >= $3
      ORDER BY mu.rank ASC
      LIMIT $4
    `,
    [params.universeName, params.timeframe, params.minCandles, params.limit ?? 999]
  );

  return (result.rows as Array<{ market_code: string; candle_count: number }>).map((row) => ({
    marketCode: row.market_code,
    candleCount: row.candle_count
  }));
}

export async function getCandidateMarketsWithMinimumCandles(params: {
  quoteCurrency?: string;
  timeframe: string;
  minCandles: number;
  limit?: number;
}): Promise<Array<{ marketCode: string; candleCount: number }>> {
  const quoteCurrency = params.quoteCurrency ?? "KRW";
  const result = await pool.query(
    `
      SELECT
        c.market_code,
        COUNT(c.id)::int AS candle_count
      FROM candles c
      WHERE c.timeframe = $1
        AND c.market_code LIKE $2
      GROUP BY c.market_code
      HAVING COUNT(c.id) >= $3
      ORDER BY c.market_code ASC
      LIMIT $4
    `,
    [params.timeframe, `${quoteCurrency}-%`, params.minCandles, params.limit ?? 9999]
  );

  return (result.rows as Array<{ market_code: string; candle_count: number }>).map((row) => ({
    marketCode: row.market_code,
    candleCount: row.candle_count
  }));
}

export async function replaceStrategyRegimes(params: {
  regimeName: string;
  universeName: string;
  timeframe: string;
  holdoutDays: number;
  metadata?: {
    sourceLabel?: string;
    trainingDays?: number;
    stepDays?: number;
    minMarkets?: number;
    minTrades?: number;
    candidatePoolSize?: number;
    bestStrategyName?: string;
    trainStartAt?: Date;
    trainEndAt?: Date;
    testStartAt?: Date;
    testEndAt?: Date;
  };
  rows: Array<{
    strategyType: string;
    strategyNames: string[];
    parameters: unknown;
    weights: unknown;
    marketCount: number;
    avgTrainReturn: number;
    avgTestReturn: number;
    avgTestDrawdown: number;
    rank: number;
  }>;
}): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `
        UPDATE strategy_regimes
        SET is_active = FALSE,
            updated_at = NOW()
        WHERE regime_name = $1
          AND universe_name = $2
          AND timeframe = $3
      `,
      [params.regimeName, params.universeName, params.timeframe]
    );

    for (const row of params.rows) {
      await client.query(
        `
          INSERT INTO strategy_regimes (
            regime_name,
            universe_name,
            timeframe,
            holdout_days,
            source_label,
            training_days,
            step_days,
            min_markets,
            min_trades,
            candidate_pool_size,
            best_strategy_name,
            train_start_at,
            train_end_at,
            test_start_at,
            test_end_at,
            strategy_type,
            strategy_names,
            parameters_json,
            weights_json,
            market_count,
            avg_train_return,
            avg_test_return,
            avg_test_drawdown,
            rank,
            is_active,
            created_at,
            updated_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, $19::jsonb, $20, $21, $22, $23, $24, TRUE, NOW(), NOW()
          )
        `,
        [
          params.regimeName,
          params.universeName,
          params.timeframe,
          params.holdoutDays,
          params.metadata?.sourceLabel ?? null,
          params.metadata?.trainingDays ?? null,
          params.metadata?.stepDays ?? null,
          params.metadata?.minMarkets ?? null,
          params.metadata?.minTrades ?? null,
          params.metadata?.candidatePoolSize ?? null,
          params.metadata?.bestStrategyName ?? null,
          params.metadata?.trainStartAt?.toISOString() ?? null,
          params.metadata?.trainEndAt?.toISOString() ?? null,
          params.metadata?.testStartAt?.toISOString() ?? null,
          params.metadata?.testEndAt?.toISOString() ?? null,
          row.strategyType,
          row.strategyNames,
          JSON.stringify(row.parameters),
          JSON.stringify(row.weights),
          row.marketCount,
          row.avgTrainReturn,
          row.avgTestReturn,
          row.avgTestDrawdown,
          row.rank
        ]
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
