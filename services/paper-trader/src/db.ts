import { Pool } from "pg";

import { DATABASE_URL } from "./config.js";
import type {
  PaperPositionRow,
  PaperSessionRow,
  StrategyRegimeRow,
  StrategyRegimeSnapshotRow
} from "./types.js";

const pool = new Pool({
  connectionString: DATABASE_URL
});

export async function closeDb(): Promise<void> {
  await pool.end();
}

export async function loadActiveStrategyRegimes(params: {
  regimeName: string;
  universeName: string;
  timeframe: string;
  limit?: number;
}): Promise<StrategyRegimeRow[]> {
  const result = await pool.query(
    `
      SELECT
        id,
        regime_name,
        universe_name,
        timeframe,
        holdout_days,
        strategy_type,
        strategy_names,
        parameters_json,
        weights_json,
        market_count,
        avg_train_return,
        avg_test_return,
        avg_test_drawdown,
        rank
      FROM strategy_regimes
      WHERE regime_name = $1
        AND universe_name = $2
        AND timeframe = $3
        AND is_active = TRUE
      ORDER BY rank ASC
      LIMIT $4
    `,
    [params.regimeName, params.universeName, params.timeframe, params.limit ?? 10]
  );

  return (result.rows as Array<Record<string, unknown>>).map((row) => ({
    id: Number(row.id),
    regimeName: String(row.regime_name),
    universeName: String(row.universe_name),
    timeframe: String(row.timeframe),
    holdoutDays: Number(row.holdout_days),
    strategyType: String(row.strategy_type),
    strategyNames: row.strategy_names as string[],
    parametersJson: row.parameters_json,
    weightsJson: row.weights_json,
    marketCount: Number(row.market_count),
    avgTrainReturn: Number(row.avg_train_return),
    avgTestReturn: Number(row.avg_test_return),
    avgTestDrawdown: Number(row.avg_test_drawdown),
    rank: Number(row.rank)
  }));
}

export async function listActiveStrategyRegimeSnapshots(limit = 20): Promise<StrategyRegimeSnapshotRow[]> {
  const result = await pool.query(
    `
      SELECT
        regime_name,
        universe_name,
        timeframe,
        holdout_days,
        MIN(source_label) AS source_label,
        MIN(training_days) AS training_days,
        MIN(step_days) AS step_days,
        MIN(min_markets) AS min_markets,
        MIN(min_trades) AS min_trades,
        MIN(candidate_pool_size) AS candidate_pool_size,
        MIN(CASE WHEN rank = 1 THEN strategy_names[1] ELSE NULL END) AS best_strategy_name,
        MIN(train_start_at) AS train_start_at,
        MAX(train_end_at) AS train_end_at,
        MIN(test_start_at) AS test_start_at,
        MAX(test_end_at) AS test_end_at,
        COUNT(*)::int AS recommendation_count,
        MAX(avg_test_return) AS best_avg_test_return,
        MIN(avg_test_drawdown) AS worst_avg_test_drawdown,
        MIN(created_at) AS generated_at,
        MAX(updated_at) AS updated_at
      FROM strategy_regimes
      WHERE is_active = TRUE
      GROUP BY regime_name, universe_name, timeframe, holdout_days
      ORDER BY MAX(updated_at) DESC, regime_name ASC, timeframe ASC
      LIMIT $1
    `,
    [limit]
  );

  return (result.rows as Array<Record<string, unknown>>).map((row) => ({
    regimeName: String(row.regime_name),
    universeName: String(row.universe_name),
    timeframe: String(row.timeframe),
    holdoutDays: Number(row.holdout_days),
    sourceLabel: row.source_label === null ? null : String(row.source_label),
    trainingDays: row.training_days === null ? null : Number(row.training_days),
    stepDays: row.step_days === null ? null : Number(row.step_days),
    minMarkets: row.min_markets === null ? null : Number(row.min_markets),
    minTrades: row.min_trades === null ? null : Number(row.min_trades),
    candidatePoolSize: row.candidate_pool_size === null ? null : Number(row.candidate_pool_size),
    bestStrategyName: row.best_strategy_name === null ? null : String(row.best_strategy_name),
    trainStartAt: row.train_start_at === null ? null : new Date(String(row.train_start_at)),
    trainEndAt: row.train_end_at === null ? null : new Date(String(row.train_end_at)),
    testStartAt: row.test_start_at === null ? null : new Date(String(row.test_start_at)),
    testEndAt: row.test_end_at === null ? null : new Date(String(row.test_end_at)),
    recommendationCount: Number(row.recommendation_count),
    bestAvgTestReturn: Number(row.best_avg_test_return),
    worstAvgTestDrawdown: Number(row.worst_avg_test_drawdown),
    generatedAt: new Date(String(row.generated_at)),
    updatedAt: new Date(String(row.updated_at))
  }));
}

export async function createPaperSession(params: {
  strategyName: string;
  parametersJson: unknown;
  marketCode: string;
  timeframe: string;
  startingBalance: number;
}): Promise<PaperSessionRow> {
  const result = await pool.query(
    `
      INSERT INTO paper_sessions (
        strategy_name,
        parameters_json,
        market_code,
        timeframe,
        starting_balance,
        current_balance,
        status
      )
      VALUES ($1, $2::jsonb, $3, $4, $5, $5, 'ready')
      RETURNING
        id,
        strategy_name,
        market_code,
        timeframe,
        starting_balance,
        current_balance,
        status,
        started_at
    `,
    [
      params.strategyName,
      JSON.stringify(params.parametersJson),
      params.marketCode,
      params.timeframe,
      params.startingBalance
    ]
  );

  const row = result.rows[0] as Record<string, unknown>;

  return {
    id: Number(row.id),
    strategyName: String(row.strategy_name),
    marketCode: String(row.market_code),
    timeframe: String(row.timeframe),
    startingBalance: Number(row.starting_balance),
    currentBalance: Number(row.current_balance),
    status: String(row.status),
    startedAt: new Date(String(row.started_at))
  };
}

export async function getPaperSession(sessionId: number): Promise<PaperSessionRow | null> {
  const result = await pool.query(
    `
      SELECT
        id,
        strategy_name,
        market_code,
        timeframe,
        starting_balance,
        current_balance,
        status,
        started_at
      FROM paper_sessions
      WHERE id = $1
    `,
    [sessionId]
  );

  const row = result.rows[0] as Record<string, unknown> | undefined;

  if (!row) {
    return null;
  }

  return {
    id: Number(row.id),
    strategyName: String(row.strategy_name),
    marketCode: String(row.market_code),
    timeframe: String(row.timeframe),
    startingBalance: Number(row.starting_balance),
    currentBalance: Number(row.current_balance),
    status: String(row.status),
    startedAt: new Date(String(row.started_at))
  };
}

export async function listPaperSessions(limit = 20): Promise<PaperSessionRow[]> {
  const result = await pool.query(
    `
      SELECT
        id,
        strategy_name,
        market_code,
        timeframe,
        starting_balance,
        current_balance,
        status,
        started_at
      FROM paper_sessions
      ORDER BY id DESC
      LIMIT $1
    `,
    [limit]
  );

  return (result.rows as Array<Record<string, unknown>>).map((row) => ({
    id: Number(row.id),
    strategyName: String(row.strategy_name),
    marketCode: String(row.market_code),
    timeframe: String(row.timeframe),
    startingBalance: Number(row.starting_balance),
    currentBalance: Number(row.current_balance),
    status: String(row.status),
    startedAt: new Date(String(row.started_at))
  }));
}

export async function getLatestPaperOrders(sessionId: number, limit = 10): Promise<
  Array<{
    side: string;
    executedPrice: number | null;
    quantity: number;
    fee: number;
    status: string;
    executedAt: Date | null;
  }>
> {
  const result = await pool.query(
    `
      SELECT
        side,
        executed_price,
        quantity,
        fee,
        status,
        executed_at
      FROM paper_orders
      WHERE paper_session_id = $1
      ORDER BY id DESC
      LIMIT $2
    `,
    [sessionId, limit]
  );

  return (result.rows as Array<Record<string, unknown>>).map((row) => ({
    side: String(row.side),
    executedPrice: row.executed_price === null ? null : Number(row.executed_price),
    quantity: Number(row.quantity),
    fee: Number(row.fee),
    status: String(row.status),
    executedAt: row.executed_at === null ? null : new Date(String(row.executed_at))
  }));
}

export async function updatePaperSession(params: {
  sessionId: number;
  currentBalance: number;
  status?: string;
}): Promise<void> {
  await pool.query(
    `
      UPDATE paper_sessions
      SET current_balance = $2,
          status = COALESCE($3, status)
      WHERE id = $1
    `,
    [params.sessionId, params.currentBalance, params.status ?? null]
  );
}

export async function getPaperPosition(params: {
  sessionId: number;
  marketCode: string;
}): Promise<PaperPositionRow | null> {
  const result = await pool.query(
    `
      SELECT
        id,
        paper_session_id,
        market_code,
        quantity,
        avg_entry_price,
        mark_price,
        unrealized_pnl,
        realized_pnl,
        updated_at
      FROM paper_positions
      WHERE paper_session_id = $1
        AND market_code = $2
      LIMIT 1
    `,
    [params.sessionId, params.marketCode]
  );

  const row = result.rows[0] as Record<string, unknown> | undefined;

  if (!row) {
    return null;
  }

  return {
    id: Number(row.id),
    paperSessionId: Number(row.paper_session_id),
    marketCode: String(row.market_code),
    quantity: Number(row.quantity),
    avgEntryPrice: Number(row.avg_entry_price),
    markPrice: row.mark_price === null ? null : Number(row.mark_price),
    unrealizedPnl: Number(row.unrealized_pnl),
    realizedPnl: Number(row.realized_pnl),
    updatedAt: new Date(String(row.updated_at))
  };
}

export async function upsertPaperPosition(params: {
  sessionId: number;
  marketCode: string;
  quantity: number;
  avgEntryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  realizedPnl: number;
}): Promise<void> {
  const existing = await getPaperPosition({
    sessionId: params.sessionId,
    marketCode: params.marketCode
  });

  if (existing) {
    await pool.query(
      `
        UPDATE paper_positions
        SET quantity = $3,
            avg_entry_price = $4,
            mark_price = $5,
            unrealized_pnl = $6,
            realized_pnl = $7,
            updated_at = NOW()
        WHERE paper_session_id = $1
          AND market_code = $2
      `,
      [
        params.sessionId,
        params.marketCode,
        params.quantity,
        params.avgEntryPrice,
        params.markPrice,
        params.unrealizedPnl,
        params.realizedPnl
      ]
    );
    return;
  }

  await pool.query(
    `
      INSERT INTO paper_positions (
        paper_session_id,
        market_code,
        quantity,
        avg_entry_price,
        mark_price,
        unrealized_pnl,
        realized_pnl,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
    `,
    [
      params.sessionId,
      params.marketCode,
      params.quantity,
      params.avgEntryPrice,
      params.markPrice,
      params.unrealizedPnl,
      params.realizedPnl
    ]
  );
}

export async function insertPaperOrder(params: {
  sessionId: number;
  side: "BUY" | "SELL";
  orderType: string;
  requestedPrice: number;
  executedPrice: number;
  quantity: number;
  fee: number;
  slippage: number;
}): Promise<void> {
  await pool.query(
    `
      INSERT INTO paper_orders (
        paper_session_id,
        side,
        order_type,
        requested_price,
        executed_price,
        quantity,
        fee,
        slippage,
        status,
        created_at,
        executed_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'filled', NOW(), NOW())
    `,
    [
      params.sessionId,
      params.side,
      params.orderType,
      params.requestedPrice,
      params.executedPrice,
      params.quantity,
      params.fee,
      params.slippage
    ]
  );
}

export async function loadRecentCandles(params: {
  marketCode: string;
  timeframe: string;
  limit: number;
}): Promise<
  Array<{
    marketCode: string;
    timeframe: string;
    candleTimeUtc: Date;
    openPrice: number;
    highPrice: number;
    lowPrice: number;
    closePrice: number;
    volume: number;
  }>
> {
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
      ORDER BY candle_time_utc DESC
      LIMIT $3
    `,
    [params.marketCode, params.timeframe, params.limit]
  );

  return (result.rows as Array<Record<string, unknown>>)
    .map((row) => ({
      marketCode: String(row.market_code),
      timeframe: String(row.timeframe),
      candleTimeUtc: new Date(String(row.candle_time_utc)),
      openPrice: Number(row.open_price),
      highPrice: Number(row.high_price),
      lowPrice: Number(row.low_price),
      closePrice: Number(row.close_price),
      volume: Number(row.volume)
    }))
    .reverse();
}
