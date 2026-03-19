import { getDb, closeDb as closeSqliteDb } from "./sqlite.js";
import type { CollectorRun, Market, Ticker, UpbitCandle, Timeframe } from "./types.js";

export async function closeDb(): Promise<void> {
  closeSqliteDb();
}

export async function upsertMarkets(markets: Market[]): Promise<number> {
  if (markets.length === 0) {
    return 0;
  }

  const db = getDb();

  const upsert = db.prepare(`
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
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
    ON CONFLICT (market_code)
    DO UPDATE SET
      base_currency = EXCLUDED.base_currency,
      quote_currency = EXCLUDED.quote_currency,
      display_name = EXCLUDED.display_name,
      english_name = EXCLUDED.english_name,
      warning = EXCLUDED.warning,
      caution_json = EXCLUDED.caution_json,
      is_active = 1,
      updated_at = datetime('now')
  `);

  const runAll = db.transaction(() => {
    for (const market of markets) {
      const [quoteCurrency, baseCurrency] = market.market.split("-");
      upsert.run(
        market.market,
        baseCurrency,
        quoteCurrency,
        market.korean_name,
        market.english_name,
        market.market_event?.warning ? 1 : 0,
        JSON.stringify(market.market_event?.caution ?? {})
      );
    }
  });

  runAll();
  return markets.length;
}

export async function replaceMarketUniverse(params: {
  universeName: string;
  quoteCurrency: string;
  selectionReason: string;
  selectedMarkets: Ticker[];
  warningByMarket: Map<string, boolean>;
}): Promise<number> {
  const db = getDb();

  const deselect = db.prepare(`
    UPDATE market_universe
    SET is_selected = 0,
        updated_at = datetime('now')
    WHERE universe_name = ?
  `);

  const upsert = db.prepare(`
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
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, datetime('now'), datetime('now'))
    ON CONFLICT (market_code)
    DO UPDATE SET
      quote_currency = EXCLUDED.quote_currency,
      universe_name = EXCLUDED.universe_name,
      rank = EXCLUDED.rank,
      acc_trade_price_24h = EXCLUDED.acc_trade_price_24h,
      warning = EXCLUDED.warning,
      is_selected = 1,
      selection_reason = EXCLUDED.selection_reason,
      computed_at = datetime('now'),
      updated_at = datetime('now')
  `);

  const runAll = db.transaction(() => {
    deselect.run(params.universeName);

    for (const [index, ticker] of params.selectedMarkets.entries()) {
      upsert.run(
        ticker.market,
        params.quoteCurrency,
        params.universeName,
        index + 1,
        ticker.acc_trade_price_24h,
        (params.warningByMarket.get(ticker.market) ?? false) ? 1 : 0,
        params.selectionReason
      );
    }
  });

  runAll();
  return params.selectedMarkets.length;
}

export async function getSelectedUniverseMarkets(universeName: string): Promise<string[]> {
  const db = getDb();

  const rows = db.prepare(`
    SELECT market_code
    FROM market_universe
    WHERE universe_name = ?
      AND is_selected = 1
    ORDER BY rank ASC
  `).all(universeName) as Array<{ market_code: string }>;

  return rows.map((row) => row.market_code);
}

export async function upsertCandles(
  marketCode: string,
  timeframe: Timeframe,
  candles: UpbitCandle[]
): Promise<number> {
  if (candles.length === 0) {
    return 0;
  }

  const db = getDb();

  const upsert = db.prepare(`
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
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'upbit')
    ON CONFLICT (market_code, timeframe, candle_time_utc)
    DO UPDATE SET
      open_price = EXCLUDED.open_price,
      high_price = EXCLUDED.high_price,
      low_price = EXCLUDED.low_price,
      close_price = EXCLUDED.close_price,
      volume = EXCLUDED.volume,
      notional = EXCLUDED.notional
  `);

  const runAll = db.transaction(() => {
    for (const candle of candles) {
      upsert.run(
        marketCode,
        timeframe,
        candle.candle_date_time_utc,
        candle.opening_price,
        candle.high_price,
        candle.low_price,
        candle.trade_price,
        candle.candle_acc_trade_volume,
        candle.candle_acc_trade_price
      );
    }
  });

  runAll();
  return candles.length;
}

export async function createCollectorRun(
  runType: string,
  marketCode: string | null,
  timeframe: Timeframe | null
): Promise<CollectorRun> {
  const db = getDb();

  const result = db.prepare(`
    INSERT INTO collector_runs (run_type, market_code, timeframe, status)
    VALUES (?, ?, ?, 'running')
  `).run(runType, marketCode, timeframe);

  return {
    id: Number(result.lastInsertRowid),
    status: "running"
  } as CollectorRun;
}

export async function finishCollectorRun(
  runId: number,
  status: "success" | "failed",
  message: string | null
): Promise<void> {
  const db = getDb();

  db.prepare(`
    UPDATE collector_runs
    SET status = ?,
        message = ?,
        finished_at = datetime('now')
    WHERE id = ?
  `).run(status, message, runId);
}

export async function createCollectorRunItem(params: {
  collectorRunId: number;
  marketCode: string;
  timeframe: Timeframe;
  itemType: string;
  requestedCount?: number | null;
  cursorTimeUtc?: Date | null;
}): Promise<number> {
  const db = getDb();

  const result = db.prepare(`
    INSERT INTO collector_run_items (
      collector_run_id,
      market_code,
      timeframe,
      item_type,
      status,
      requested_count,
      cursor_time_utc
    )
    VALUES (?, ?, ?, ?, 'running', ?, ?)
  `).run(
    params.collectorRunId,
    params.marketCode,
    params.timeframe,
    params.itemType,
    params.requestedCount ?? null,
    params.cursorTimeUtc?.toISOString() ?? null
  );

  return Number(result.lastInsertRowid);
}

export async function finishCollectorRunItem(params: {
  itemId: number;
  status: "success" | "failed";
  receivedCount?: number | null;
  savedCount?: number | null;
  message?: string | null;
}): Promise<void> {
  const db = getDb();

  db.prepare(`
    UPDATE collector_run_items
    SET status = ?,
        received_count = ?,
        saved_count = ?,
        message = ?,
        finished_at = datetime('now')
    WHERE id = ?
  `).run(
    params.status,
    params.receivedCount ?? null,
    params.savedCount ?? null,
    params.message ?? null,
    params.itemId
  );
}

export async function getLatestCandleTime(
  marketCode: string,
  timeframe: Timeframe
): Promise<Date | null> {
  const db = getDb();

  const row = db.prepare(`
    SELECT candle_time_utc
    FROM candles
    WHERE market_code = ? AND timeframe = ?
    ORDER BY candle_time_utc DESC
    LIMIT 1
  `).get(marketCode, timeframe) as { candle_time_utc: string } | undefined;

  return row ? new Date(row.candle_time_utc) : null;
}

export async function getEarliestCandleTime(
  marketCode: string,
  timeframe: Timeframe
): Promise<Date | null> {
  const db = getDb();

  const row = db.prepare(`
    SELECT candle_time_utc
    FROM candles
    WHERE market_code = ? AND timeframe = ?
    ORDER BY candle_time_utc ASC
    LIMIT 1
  `).get(marketCode, timeframe) as { candle_time_utc: string } | undefined;

  return row ? new Date(row.candle_time_utc) : null;
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
  const db = getDb();

  db.prepare(`
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
      ?,
      ?,
      ?,
      ?,
      CASE WHEN ? = 'success' THEN datetime('now') ELSE NULL END,
      CASE WHEN ? = 'failed' THEN datetime('now') ELSE NULL END,
      ?,
      ?,
      ?,
      datetime('now')
    )
    ON CONFLICT (market_code, timeframe)
    DO UPDATE SET
      last_synced_candle_time_utc = COALESCE(EXCLUDED.last_synced_candle_time_utc, collector_state.last_synced_candle_time_utc),
      earliest_synced_candle_time_utc = COALESCE(EXCLUDED.earliest_synced_candle_time_utc, collector_state.earliest_synced_candle_time_utc),
      last_success_at = CASE WHEN EXCLUDED.last_status = 'success' THEN datetime('now') ELSE collector_state.last_success_at END,
      last_failure_at = CASE WHEN EXCLUDED.last_status = 'failed' THEN datetime('now') ELSE collector_state.last_failure_at END,
      last_run_type = EXCLUDED.last_run_type,
      last_status = EXCLUDED.last_status,
      last_message = EXCLUDED.last_message,
      updated_at = datetime('now')
  `).run(
    params.marketCode,
    params.timeframe,
    params.latestCandleTimeUtc?.toISOString() ?? null,
    params.earliestCandleTimeUtc?.toISOString() ?? null,
    params.status,
    params.status,
    params.runType,
    params.status,
    params.message ?? null
  );
}

export async function upsertDataGap(params: {
  marketCode: string;
  timeframe: Timeframe;
  gapStartUtc: Date;
  gapEndUtc: Date;
  resolutionMessage?: string | null;
}): Promise<void> {
  const db = getDb();

  db.prepare(`
    INSERT INTO data_gaps (
      market_code,
      timeframe,
      gap_start_utc,
      gap_end_utc,
      status,
      resolution_message
    )
    VALUES (?, ?, ?, ?, 'open', ?)
  `).run(
    params.marketCode,
    params.timeframe,
    params.gapStartUtc.toISOString(),
    params.gapEndUtc.toISOString(),
    params.resolutionMessage ?? null
  );
}

export async function insertSystemLog(
  serviceName: string,
  level: string,
  eventType: string,
  message: string,
  context: Record<string, unknown> = {}
): Promise<void> {
  const db = getDb();

  db.prepare(`
    INSERT INTO system_logs (service_name, level, event_type, message, context_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(serviceName, level, eventType, message, JSON.stringify(context));
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
  const db = getDb();

  const rows = db.prepare(`
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
  `).all() as Array<Record<string, string | null>>;

  return rows.map((row) => ({
    market_code: row.market_code as string,
    timeframe: row.timeframe as string,
    last_synced_candle_time_utc: row.last_synced_candle_time_utc ? new Date(row.last_synced_candle_time_utc) : null,
    earliest_synced_candle_time_utc: row.earliest_synced_candle_time_utc ? new Date(row.earliest_synced_candle_time_utc) : null,
    last_success_at: row.last_success_at ? new Date(row.last_success_at) : null,
    last_failure_at: row.last_failure_at ? new Date(row.last_failure_at) : null,
    last_run_type: row.last_run_type ?? null,
    last_status: row.last_status ?? null,
    last_message: row.last_message ?? null,
    updated_at: new Date(row.updated_at as string)
  }));
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
  const db = getDb();

  const rows = db.prepare(`
    SELECT run_type, market_code, timeframe, status, message, started_at, finished_at
    FROM collector_runs
    ORDER BY id DESC
    LIMIT ?
  `).all(limit) as Array<Record<string, string | null>>;

  return rows.map((row) => ({
    run_type: row.run_type as string,
    market_code: row.market_code ?? null,
    timeframe: row.timeframe ?? null,
    status: row.status as string,
    message: row.message ?? null,
    started_at: new Date(row.started_at as string),
    finished_at: row.finished_at ? new Date(row.finished_at) : null
  }));
}

export async function getCandleTimes(
  marketCode: string,
  timeframe: Timeframe
): Promise<Date[]> {
  const db = getDb();

  const rows = db.prepare(`
    SELECT candle_time_utc
    FROM candles
    WHERE market_code = ? AND timeframe = ?
    ORDER BY candle_time_utc ASC
  `).all(marketCode, timeframe) as Array<{ candle_time_utc: string }>;

  return rows.map((row) => new Date(row.candle_time_utc));
}

export async function clearOpenDataGaps(
  marketCode: string,
  timeframe: Timeframe
): Promise<void> {
  const db = getDb();

  db.prepare(`
    UPDATE data_gaps
    SET status = 'resolved',
        resolved_at = datetime('now'),
        resolution_message = 'gap_scan_resolved'
    WHERE market_code = ?
      AND timeframe = ?
      AND status = 'open'
  `).run(marketCode, timeframe);
}
