import { Pool } from "pg";

import { DATABASE_URL } from "./config.js";
import type { Candle, PeriodRange } from "./types.js";

const pool = new Pool({
  connectionString: DATABASE_URL
});

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
        volume
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
    volume: Number(row.volume)
  }));
}

export async function createBacktestRun(params: {
  strategyName: string;
  strategyVersion: string;
  parameters: Record<string, number>;
  marketCode: string;
  timeframe: string;
  trainRange: PeriodRange;
  testRange: PeriodRange;
}): Promise<number> {
  const result = await pool.query(
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

  return (result.rows[0] as { id: number }).id;
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
  maxDrawdown: number;
  winRate: number;
  tradeCount: number;
}): Promise<void> {
  await pool.query(
    `
      INSERT INTO backtest_metrics (
        backtest_run_id,
        segment_type,
        total_return,
        max_drawdown,
        win_rate,
        trade_count
      )
      VALUES ($1, $2, $3, $4, $5, $6)
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
