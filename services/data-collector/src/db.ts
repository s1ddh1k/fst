import { Pool } from "pg";

import { DATABASE_URL } from "./config.js";
import type { CollectorRun, Market, Ticker, UpbitCandle, Timeframe } from "./types.js";

const pool = new Pool({
  connectionString: DATABASE_URL
});

export async function closeDb(): Promise<void> {
  await pool.end();
}

export async function upsertMarkets(markets: Market[]): Promise<number> {
  if (markets.length === 0) {
    return 0;
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    for (const market of markets) {
      const [quoteCurrency, baseCurrency] = market.market.split("-");

      await client.query(
        `
          INSERT INTO markets (
            market_code,
            base_currency,
            quote_currency,
            display_name,
            english_name,
            warning,
            caution_json,
            is_active,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, TRUE, NOW())
          ON CONFLICT (market_code)
          DO UPDATE SET
            base_currency = EXCLUDED.base_currency,
            quote_currency = EXCLUDED.quote_currency,
            display_name = EXCLUDED.display_name,
            english_name = EXCLUDED.english_name,
            warning = EXCLUDED.warning,
            caution_json = EXCLUDED.caution_json,
            is_active = TRUE,
            updated_at = NOW()
        `,
        [
          market.market,
          baseCurrency,
          quoteCurrency,
          market.korean_name,
          market.english_name,
          market.market_event?.warning ?? false,
          JSON.stringify(market.market_event?.caution ?? {})
        ]
      );
    }

    await client.query("COMMIT");
    return markets.length;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function replaceMarketUniverse(params: {
  universeName: string;
  quoteCurrency: string;
  selectionReason: string;
  selectedMarkets: Ticker[];
  warningByMarket: Map<string, boolean>;
}): Promise<number> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `
        UPDATE market_universe
        SET is_selected = FALSE,
            updated_at = NOW()
        WHERE universe_name = $1
      `,
      [params.universeName]
    );

    for (const [index, ticker] of params.selectedMarkets.entries()) {
      await client.query(
        `
          INSERT INTO market_universe (
            market_code,
            quote_currency,
            universe_name,
            rank,
            acc_trade_price_24h,
            warning,
            is_selected,
            selection_reason,
            computed_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7, NOW(), NOW())
          ON CONFLICT (market_code)
          DO UPDATE SET
            quote_currency = EXCLUDED.quote_currency,
            universe_name = EXCLUDED.universe_name,
            rank = EXCLUDED.rank,
            acc_trade_price_24h = EXCLUDED.acc_trade_price_24h,
            warning = EXCLUDED.warning,
            is_selected = TRUE,
            selection_reason = EXCLUDED.selection_reason,
            computed_at = NOW(),
            updated_at = NOW()
        `,
        [
          ticker.market,
          params.quoteCurrency,
          params.universeName,
          index + 1,
          ticker.acc_trade_price_24h,
          params.warningByMarket.get(ticker.market) ?? false,
          params.selectionReason
        ]
      );
    }

    await client.query("COMMIT");
    return params.selectedMarkets.length;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getSelectedUniverseMarkets(universeName: string): Promise<string[]> {
  const result = await pool.query(
    `
      SELECT market_code
      FROM market_universe
      WHERE universe_name = $1
        AND is_selected = TRUE
      ORDER BY rank ASC
    `,
    [universeName]
  );

  return (result.rows as Array<{ market_code: string }>).map((row) => row.market_code);
}

export async function upsertCandles(
  marketCode: string,
  timeframe: Timeframe,
  candles: UpbitCandle[]
): Promise<number> {
  if (candles.length === 0) {
    return 0;
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    for (const candle of candles) {
      await client.query(
        `
          INSERT INTO candles (
            market_code,
            timeframe,
            candle_time_utc,
            open_price,
            high_price,
            low_price,
            close_price,
            volume,
            notional,
            source
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'upbit')
          ON CONFLICT (market_code, timeframe, candle_time_utc)
          DO UPDATE SET
            open_price = EXCLUDED.open_price,
            high_price = EXCLUDED.high_price,
            low_price = EXCLUDED.low_price,
            close_price = EXCLUDED.close_price,
            volume = EXCLUDED.volume,
            notional = EXCLUDED.notional
        `,
        [
          marketCode,
          timeframe,
          candle.candle_date_time_utc,
          candle.opening_price,
          candle.high_price,
          candle.low_price,
          candle.trade_price,
          candle.candle_acc_trade_volume,
          candle.candle_acc_trade_price
        ]
      );
    }

    await client.query("COMMIT");
    return candles.length;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function createCollectorRun(
  runType: string,
  marketCode: string | null,
  timeframe: Timeframe | null
): Promise<CollectorRun> {
  const result = await pool.query(
    `
      INSERT INTO collector_runs (run_type, market_code, timeframe, status)
      VALUES ($1, $2, $3, 'running')
      RETURNING id, status
    `,
    [runType, marketCode, timeframe]
  );
  return result.rows[0] as CollectorRun;
}

export async function finishCollectorRun(
  runId: number,
  status: "success" | "failed",
  message: string | null
): Promise<void> {
  await pool.query(
    `
      UPDATE collector_runs
      SET status = $2,
          message = $3,
          finished_at = NOW()
      WHERE id = $1
    `,
    [runId, status, message]
  );
}

export async function createCollectorRunItem(params: {
  collectorRunId: number;
  marketCode: string;
  timeframe: Timeframe;
  itemType: string;
  requestedCount?: number | null;
  cursorTimeUtc?: Date | null;
}): Promise<number> {
  const result = await pool.query(
    `
      INSERT INTO collector_run_items (
        collector_run_id,
        market_code,
        timeframe,
        item_type,
        status,
        requested_count,
        cursor_time_utc
      )
      VALUES ($1, $2, $3, $4, 'running', $5, $6)
      RETURNING id
    `,
    [
      params.collectorRunId,
      params.marketCode,
      params.timeframe,
      params.itemType,
      params.requestedCount ?? null,
      params.cursorTimeUtc ?? null
    ]
  );

  return (result.rows[0] as { id: number }).id;
}

export async function finishCollectorRunItem(params: {
  itemId: number;
  status: "success" | "failed";
  receivedCount?: number | null;
  savedCount?: number | null;
  message?: string | null;
}): Promise<void> {
  await pool.query(
    `
      UPDATE collector_run_items
      SET status = $2,
          received_count = $3,
          saved_count = $4,
          message = $5,
          finished_at = NOW()
      WHERE id = $1
    `,
    [
      params.itemId,
      params.status,
      params.receivedCount ?? null,
      params.savedCount ?? null,
      params.message ?? null
    ]
  );
}

export async function getLatestCandleTime(
  marketCode: string,
  timeframe: Timeframe
): Promise<Date | null> {
  const result = await pool.query(
    `
      SELECT candle_time_utc
      FROM candles
      WHERE market_code = $1 AND timeframe = $2
      ORDER BY candle_time_utc DESC
      LIMIT 1
    `,
    [marketCode, timeframe]
  );

  return (result.rows[0] as { candle_time_utc: Date } | undefined)?.candle_time_utc ?? null;
}

export async function getEarliestCandleTime(
  marketCode: string,
  timeframe: Timeframe
): Promise<Date | null> {
  const result = await pool.query(
    `
      SELECT candle_time_utc
      FROM candles
      WHERE market_code = $1 AND timeframe = $2
      ORDER BY candle_time_utc ASC
      LIMIT 1
    `,
    [marketCode, timeframe]
  );

  return (result.rows[0] as { candle_time_utc: Date } | undefined)?.candle_time_utc ?? null;
}

export async function updateCollectorState(params: {
  marketCode: string;
  timeframe: Timeframe;
  latestCandleTimeUtc?: Date | null;
  earliestCandleTimeUtc?: Date | null;
  runType: string;
  status: "success" | "failed";
  message?: string | null;
}): Promise<void> {
  await pool.query(
    `
      INSERT INTO collector_state (
        market_code,
        timeframe,
        last_synced_candle_time_utc,
        earliest_synced_candle_time_utc,
        last_success_at,
        last_failure_at,
        last_run_type,
        last_status,
        last_message,
        updated_at
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        CASE WHEN $6 = 'success' THEN NOW() ELSE NULL END,
        CASE WHEN $6 = 'failed' THEN NOW() ELSE NULL END,
        $5,
        $6,
        $7,
        NOW()
      )
      ON CONFLICT (market_code, timeframe)
      DO UPDATE SET
        last_synced_candle_time_utc = COALESCE(EXCLUDED.last_synced_candle_time_utc, collector_state.last_synced_candle_time_utc),
        earliest_synced_candle_time_utc = COALESCE(EXCLUDED.earliest_synced_candle_time_utc, collector_state.earliest_synced_candle_time_utc),
        last_success_at = CASE WHEN EXCLUDED.last_status = 'success' THEN NOW() ELSE collector_state.last_success_at END,
        last_failure_at = CASE WHEN EXCLUDED.last_status = 'failed' THEN NOW() ELSE collector_state.last_failure_at END,
        last_run_type = EXCLUDED.last_run_type,
        last_status = EXCLUDED.last_status,
        last_message = EXCLUDED.last_message,
        updated_at = NOW()
    `,
    [
      params.marketCode,
      params.timeframe,
      params.latestCandleTimeUtc ?? null,
      params.earliestCandleTimeUtc ?? null,
      params.runType,
      params.status,
      params.message ?? null
    ]
  );
}

export async function upsertDataGap(params: {
  marketCode: string;
  timeframe: Timeframe;
  gapStartUtc: Date;
  gapEndUtc: Date;
  resolutionMessage?: string | null;
}): Promise<void> {
  await pool.query(
    `
      INSERT INTO data_gaps (
        market_code,
        timeframe,
        gap_start_utc,
        gap_end_utc,
        status,
        resolution_message
      )
      VALUES ($1, $2, $3, $4, 'open', $5)
    `,
    [
      params.marketCode,
      params.timeframe,
      params.gapStartUtc,
      params.gapEndUtc,
      params.resolutionMessage ?? null
    ]
  );
}

export async function insertSystemLog(
  serviceName: string,
  level: string,
  eventType: string,
  message: string,
  context: Record<string, unknown> = {}
): Promise<void> {
  await pool.query(
    `
      INSERT INTO system_logs (service_name, level, event_type, message, context_json)
      VALUES ($1, $2, $3, $4, $5::jsonb)
    `,
    [serviceName, level, eventType, message, JSON.stringify(context)]
  );
}

export async function getCollectorStateRows(): Promise<
  Array<{
    market_code: string;
    timeframe: string;
    last_synced_candle_time_utc: Date | null;
    earliest_synced_candle_time_utc: Date | null;
    last_success_at: Date | null;
    last_failure_at: Date | null;
    last_run_type: string | null;
    last_status: string | null;
    last_message: string | null;
    updated_at: Date;
  }>
> {
  const result = await pool.query(
    `
      SELECT
        market_code,
        timeframe,
        last_synced_candle_time_utc,
        earliest_synced_candle_time_utc,
        last_success_at,
        last_failure_at,
        last_run_type,
        last_status,
        last_message,
        updated_at
      FROM collector_state
      ORDER BY market_code, timeframe
    `
  );

  return result.rows as Array<{
    market_code: string;
    timeframe: string;
    last_synced_candle_time_utc: Date | null;
    earliest_synced_candle_time_utc: Date | null;
    last_success_at: Date | null;
    last_failure_at: Date | null;
    last_run_type: string | null;
    last_status: string | null;
    last_message: string | null;
    updated_at: Date;
  }>;
}

export async function getRecentCollectorRuns(limit = 20): Promise<
  Array<{
    run_type: string;
    market_code: string | null;
    timeframe: string | null;
    status: string;
    message: string | null;
    started_at: Date;
    finished_at: Date | null;
  }>
> {
  const result = await pool.query(
    `
      SELECT run_type, market_code, timeframe, status, message, started_at, finished_at
      FROM collector_runs
      ORDER BY id DESC
      LIMIT $1
    `,
    [limit]
  );

  return result.rows as Array<{
    run_type: string;
    market_code: string | null;
    timeframe: string | null;
    status: string;
    message: string | null;
    started_at: Date;
    finished_at: Date | null;
  }>;
}

export async function getCandleTimes(
  marketCode: string,
  timeframe: Timeframe
): Promise<Date[]> {
  const result = await pool.query(
    `
      SELECT candle_time_utc
      FROM candles
      WHERE market_code = $1 AND timeframe = $2
      ORDER BY candle_time_utc ASC
    `,
    [marketCode, timeframe]
  );

  return (result.rows as Array<{ candle_time_utc: Date }>).map((row) => row.candle_time_utc);
}

export async function clearOpenDataGaps(
  marketCode: string,
  timeframe: Timeframe
): Promise<void> {
  await pool.query(
    `
      UPDATE data_gaps
      SET status = 'resolved',
          resolved_at = NOW(),
          resolution_message = 'gap_scan_resolved'
      WHERE market_code = $1
        AND timeframe = $2
        AND status = 'open'
    `,
    [marketCode, timeframe]
  );
}
