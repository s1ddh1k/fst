CREATE TABLE IF NOT EXISTS markets (
  id BIGSERIAL PRIMARY KEY,
  market_code TEXT NOT NULL UNIQUE,
  base_currency TEXT NOT NULL,
  quote_currency TEXT NOT NULL,
  display_name TEXT NOT NULL,
  english_name TEXT,
  warning BOOLEAN NOT NULL DEFAULT FALSE,
  caution_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE markets ADD COLUMN IF NOT EXISTS english_name TEXT;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS warning BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS caution_json JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS market_universe (
  id BIGSERIAL PRIMARY KEY,
  market_code TEXT NOT NULL UNIQUE,
  quote_currency TEXT NOT NULL,
  universe_name TEXT NOT NULL,
  rank INTEGER NOT NULL,
  acc_trade_price_24h NUMERIC(24, 8) NOT NULL,
  warning BOOLEAN NOT NULL DEFAULT FALSE,
  is_selected BOOLEAN NOT NULL DEFAULT TRUE,
  selection_reason TEXT NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_market_universe_name_selected_rank
  ON market_universe (universe_name, is_selected, rank);

CREATE TABLE IF NOT EXISTS candles (
  id BIGSERIAL PRIMARY KEY,
  market_code TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  candle_time_utc TIMESTAMPTZ NOT NULL,
  open_price NUMERIC(24, 8) NOT NULL,
  high_price NUMERIC(24, 8) NOT NULL,
  low_price NUMERIC(24, 8) NOT NULL,
  close_price NUMERIC(24, 8) NOT NULL,
  volume NUMERIC(24, 8) NOT NULL,
  notional NUMERIC(24, 8),
  source TEXT NOT NULL DEFAULT 'upbit',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (market_code, timeframe, candle_time_utc)
);

CREATE INDEX IF NOT EXISTS idx_candles_market_timeframe_time
  ON candles (market_code, timeframe, candle_time_utc DESC);

CREATE TABLE IF NOT EXISTS collector_runs (
  id BIGSERIAL PRIMARY KEY,
  run_type TEXT NOT NULL,
  market_code TEXT,
  timeframe TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL,
  message TEXT
);

CREATE TABLE IF NOT EXISTS collector_run_items (
  id BIGSERIAL PRIMARY KEY,
  collector_run_id BIGINT NOT NULL REFERENCES collector_runs(id) ON DELETE CASCADE,
  market_code TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  item_type TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_count INTEGER,
  received_count INTEGER,
  saved_count INTEGER,
  cursor_time_utc TIMESTAMPTZ,
  message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS collector_state (
  id BIGSERIAL PRIMARY KEY,
  market_code TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  last_synced_candle_time_utc TIMESTAMPTZ,
  earliest_synced_candle_time_utc TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  last_run_type TEXT,
  last_status TEXT,
  last_message TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (market_code, timeframe)
);

CREATE TABLE IF NOT EXISTS data_gaps (
  id BIGSERIAL PRIMARY KEY,
  market_code TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  gap_start_utc TIMESTAMPTZ NOT NULL,
  gap_end_utc TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolution_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_data_gaps_market_timeframe_status
  ON data_gaps (market_code, timeframe, status);

CREATE TABLE IF NOT EXISTS backtest_runs (
  id BIGSERIAL PRIMARY KEY,
  strategy_name TEXT NOT NULL,
  strategy_version TEXT NOT NULL DEFAULT '0.1.0',
  parameters_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  market_code TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  train_start_at TIMESTAMPTZ NOT NULL,
  train_end_at TIMESTAMPTZ NOT NULL,
  test_start_at TIMESTAMPTZ NOT NULL,
  test_end_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS backtest_metrics (
  id BIGSERIAL PRIMARY KEY,
  backtest_run_id BIGINT NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE,
  segment_type TEXT NOT NULL,
  total_return NUMERIC(18, 8),
  annualized_return NUMERIC(18, 8),
  max_drawdown NUMERIC(18, 8),
  sharpe_ratio NUMERIC(18, 8),
  sortino_ratio NUMERIC(18, 8),
  win_rate NUMERIC(18, 8),
  profit_factor NUMERIC(18, 8),
  trade_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS strategy_regimes (
  id BIGSERIAL PRIMARY KEY,
  regime_name TEXT NOT NULL,
  universe_name TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  holdout_days INTEGER NOT NULL,
  strategy_type TEXT NOT NULL,
  strategy_names TEXT[] NOT NULL,
  parameters_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  weights_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  market_count INTEGER NOT NULL,
  avg_train_return NUMERIC(18, 8) NOT NULL,
  avg_test_return NUMERIC(18, 8) NOT NULL,
  avg_test_drawdown NUMERIC(18, 8) NOT NULL,
  rank INTEGER NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_strategy_regimes_lookup
  ON strategy_regimes (regime_name, universe_name, timeframe, is_active, rank);

ALTER TABLE strategy_regimes
  ADD COLUMN IF NOT EXISTS source_label TEXT,
  ADD COLUMN IF NOT EXISTS training_days INTEGER,
  ADD COLUMN IF NOT EXISTS step_days INTEGER,
  ADD COLUMN IF NOT EXISTS min_markets INTEGER,
  ADD COLUMN IF NOT EXISTS min_trades NUMERIC(18, 8),
  ADD COLUMN IF NOT EXISTS candidate_pool_size INTEGER,
  ADD COLUMN IF NOT EXISTS best_strategy_name TEXT,
  ADD COLUMN IF NOT EXISTS train_start_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS train_end_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS test_start_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS test_end_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS paper_sessions (
  id BIGSERIAL PRIMARY KEY,
  strategy_name TEXT NOT NULL,
  parameters_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  market_code TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  starting_balance NUMERIC(24, 8) NOT NULL,
  current_balance NUMERIC(24, 8) NOT NULL,
  status TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS paper_orders (
  id BIGSERIAL PRIMARY KEY,
  paper_session_id BIGINT NOT NULL REFERENCES paper_sessions(id) ON DELETE CASCADE,
  side TEXT NOT NULL,
  order_type TEXT NOT NULL,
  requested_price NUMERIC(24, 8),
  executed_price NUMERIC(24, 8),
  quantity NUMERIC(24, 8) NOT NULL,
  fee NUMERIC(24, 8) NOT NULL DEFAULT 0,
  slippage NUMERIC(24, 8) NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  executed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS paper_positions (
  id BIGSERIAL PRIMARY KEY,
  paper_session_id BIGINT NOT NULL REFERENCES paper_sessions(id) ON DELETE CASCADE,
  market_code TEXT NOT NULL,
  quantity NUMERIC(24, 8) NOT NULL,
  avg_entry_price NUMERIC(24, 8) NOT NULL,
  mark_price NUMERIC(24, 8),
  unrealized_pnl NUMERIC(24, 8) NOT NULL DEFAULT 0,
  realized_pnl NUMERIC(24, 8) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS system_logs (
  id BIGSERIAL PRIMARY KEY,
  service_name TEXT NOT NULL,
  level TEXT NOT NULL,
  event_type TEXT NOT NULL,
  message TEXT NOT NULL,
  context_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
