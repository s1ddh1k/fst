-- SQLite schema for FST (migrated from PostgreSQL)
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS markets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_code TEXT NOT NULL UNIQUE,
  base_currency TEXT NOT NULL,
  quote_currency TEXT NOT NULL,
  display_name TEXT NOT NULL,
  english_name TEXT,
  warning INTEGER NOT NULL DEFAULT 0,
  caution_json TEXT NOT NULL DEFAULT '{}',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS market_universe (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_code TEXT NOT NULL UNIQUE,
  quote_currency TEXT NOT NULL,
  universe_name TEXT NOT NULL,
  rank INTEGER NOT NULL,
  acc_trade_price_24h REAL NOT NULL,
  warning INTEGER NOT NULL DEFAULT 0,
  is_selected INTEGER NOT NULL DEFAULT 1,
  selection_reason TEXT NOT NULL,
  computed_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_market_universe_name_selected_rank
  ON market_universe (universe_name, is_selected, rank);

CREATE TABLE IF NOT EXISTS candles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_code TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  candle_time_utc TEXT NOT NULL,
  open_price REAL NOT NULL,
  high_price REAL NOT NULL,
  low_price REAL NOT NULL,
  close_price REAL NOT NULL,
  volume REAL NOT NULL,
  notional REAL,
  source TEXT NOT NULL DEFAULT 'upbit',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (market_code, timeframe, candle_time_utc)
);

CREATE INDEX IF NOT EXISTS idx_candles_market_timeframe_time
  ON candles (market_code, timeframe, candle_time_utc DESC);

CREATE TABLE IF NOT EXISTS market_breadth_features (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  universe_name TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  config_key TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  feature_time_utc TEXT NOT NULL,
  sample_size INTEGER NOT NULL,
  advancing_ratio REAL NOT NULL,
  above_trend_ratio REAL NOT NULL,
  positive_momentum_ratio REAL NOT NULL,
  average_momentum REAL,
  average_z_score REAL,
  average_volume_spike REAL,
  average_historical_volatility REAL,
  dispersion_score REAL,
  liquidity_score REAL,
  composite_trend_score REAL,
  composite_change REAL,
  composite_momentum REAL,
  composite_historical_volatility REAL,
  composite_regime TEXT,
  risk_on_score REAL NOT NULL,
  benchmark_market_code TEXT,
  benchmark_momentum REAL,
  benchmark_above_trend INTEGER,
  benchmark_historical_volatility REAL,
  benchmark_regime TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (universe_name, timeframe, config_key, feature_time_utc)
);

CREATE INDEX IF NOT EXISTS idx_market_breadth_features_lookup
  ON market_breadth_features (universe_name, timeframe, config_key, feature_time_utc DESC);

CREATE TABLE IF NOT EXISTS market_relative_strength_features (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  universe_name TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  config_key TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  market_code TEXT NOT NULL,
  feature_time_utc TEXT NOT NULL,
  momentum_spread REAL,
  z_score_spread REAL,
  volume_spike_spread REAL,
  benchmark_momentum_spread REAL,
  momentum_percentile REAL,
  cohort_momentum_spread REAL,
  cohort_z_score_spread REAL,
  cohort_volume_spike_spread REAL,
  composite_momentum_spread REAL,
  composite_change_spread REAL,
  liquidity_spread REAL,
  return_percentile REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (universe_name, timeframe, config_key, feature_time_utc, market_code)
);

CREATE INDEX IF NOT EXISTS idx_market_relative_strength_features_lookup
  ON market_relative_strength_features (
    universe_name, timeframe, config_key, market_code, feature_time_utc DESC
  );

CREATE TABLE IF NOT EXISTS collector_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_type TEXT NOT NULL,
  market_code TEXT,
  timeframe TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  status TEXT NOT NULL,
  message TEXT
);

CREATE TABLE IF NOT EXISTS collector_run_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  collector_run_id INTEGER NOT NULL REFERENCES collector_runs(id) ON DELETE CASCADE,
  market_code TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  item_type TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_count INTEGER,
  received_count INTEGER,
  saved_count INTEGER,
  cursor_time_utc TEXT,
  message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS collector_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_code TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  last_synced_candle_time_utc TEXT,
  earliest_synced_candle_time_utc TEXT,
  last_success_at TEXT,
  last_failure_at TEXT,
  last_run_type TEXT,
  last_status TEXT,
  last_message TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (market_code, timeframe)
);

CREATE TABLE IF NOT EXISTS data_gaps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_code TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  gap_start_utc TEXT NOT NULL,
  gap_end_utc TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  detected_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  resolution_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_data_gaps_market_timeframe_status
  ON data_gaps (market_code, timeframe, status);

CREATE TABLE IF NOT EXISTS backtest_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_name TEXT NOT NULL,
  strategy_version TEXT NOT NULL DEFAULT '0.1.0',
  parameters_json TEXT NOT NULL DEFAULT '{}',
  market_code TEXT NOT NULL,
  universe_name TEXT,
  market_count INTEGER,
  timeframe TEXT NOT NULL,
  train_start_at TEXT NOT NULL,
  train_end_at TEXT NOT NULL,
  test_start_at TEXT NOT NULL,
  test_end_at TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS backtest_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  backtest_run_id INTEGER NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE,
  segment_type TEXT NOT NULL,
  total_return REAL,
  gross_return REAL,
  net_return REAL,
  annualized_return REAL,
  max_drawdown REAL,
  sharpe_ratio REAL,
  sortino_ratio REAL,
  win_rate REAL,
  profit_factor REAL,
  trade_count INTEGER NOT NULL DEFAULT 0,
  turnover REAL,
  avg_hold_bars REAL,
  fee_paid REAL,
  slippage_paid REAL,
  rejected_orders_count INTEGER,
  cooldown_skips_count INTEGER,
  bootstrap_p_value REAL,
  bootstrap_ci_lower REAL,
  bootstrap_ci_upper REAL,
  random_benchmark_percentile REAL,
  trade_to_parameter_ratio REAL,
  avg_position_weight REAL,
  max_position_weight REAL,
  circuit_breaker_count INTEGER
);

CREATE TABLE IF NOT EXISTS strategy_regimes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  regime_name TEXT NOT NULL,
  universe_name TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  holdout_days INTEGER NOT NULL,
  strategy_type TEXT NOT NULL,
  strategy_names TEXT NOT NULL DEFAULT '[]',
  parameters_json TEXT NOT NULL DEFAULT '[]',
  weights_json TEXT NOT NULL DEFAULT '[]',
  market_count INTEGER NOT NULL,
  avg_train_return REAL NOT NULL,
  avg_test_return REAL NOT NULL,
  avg_test_drawdown REAL NOT NULL,
  rank INTEGER NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  source_label TEXT,
  training_days INTEGER,
  step_days INTEGER,
  min_markets INTEGER,
  min_trades REAL,
  candidate_pool_size INTEGER,
  best_strategy_name TEXT,
  train_start_at TEXT,
  train_end_at TEXT,
  test_start_at TEXT,
  test_end_at TEXT,
  verification_status TEXT,
  verification_source_kind TEXT,
  verification_output_dir TEXT,
  verification_checked_at TEXT,
  verification_details_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_strategy_regimes_lookup
  ON strategy_regimes (regime_name, universe_name, timeframe, is_active, rank);

CREATE TABLE IF NOT EXISTS paper_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_name TEXT NOT NULL,
  parameters_json TEXT NOT NULL DEFAULT '{}',
  market_code TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  starting_balance REAL NOT NULL,
  current_balance REAL NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS paper_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_session_id INTEGER NOT NULL REFERENCES paper_sessions(id) ON DELETE CASCADE,
  market_code TEXT,
  side TEXT NOT NULL,
  order_type TEXT NOT NULL,
  requested_price REAL,
  executed_price REAL,
  quantity REAL NOT NULL,
  fee REAL NOT NULL DEFAULT 0,
  slippage REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  executed_at TEXT
);

CREATE TABLE IF NOT EXISTS paper_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_session_id INTEGER NOT NULL REFERENCES paper_sessions(id) ON DELETE CASCADE,
  market_code TEXT NOT NULL,
  quantity REAL NOT NULL,
  avg_entry_price REAL NOT NULL,
  mark_price REAL,
  unrealized_pnl REAL NOT NULL DEFAULT 0,
  realized_pnl REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS system_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_name TEXT NOT NULL,
  level TEXT NOT NULL,
  event_type TEXT NOT NULL,
  message TEXT NOT NULL,
  context_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
