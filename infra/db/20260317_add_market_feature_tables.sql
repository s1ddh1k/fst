CREATE TABLE IF NOT EXISTS market_breadth_features (
  id BIGSERIAL PRIMARY KEY,
  universe_name TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  config_key TEXT NOT NULL,
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  feature_time_utc TIMESTAMPTZ NOT NULL,
  sample_size INTEGER NOT NULL,
  advancing_ratio NUMERIC(18, 8) NOT NULL,
  above_trend_ratio NUMERIC(18, 8) NOT NULL,
  positive_momentum_ratio NUMERIC(18, 8) NOT NULL,
  average_momentum NUMERIC(18, 8),
  average_z_score NUMERIC(18, 8),
  average_volume_spike NUMERIC(18, 8),
  average_historical_volatility NUMERIC(18, 8),
  dispersion_score NUMERIC(18, 8),
  liquidity_score NUMERIC(18, 8),
  composite_trend_score NUMERIC(18, 8),
  composite_change NUMERIC(18, 8),
  composite_momentum NUMERIC(18, 8),
  composite_historical_volatility NUMERIC(18, 8),
  composite_regime TEXT,
  risk_on_score NUMERIC(18, 8) NOT NULL,
  benchmark_market_code TEXT,
  benchmark_momentum NUMERIC(18, 8),
  benchmark_above_trend BOOLEAN,
  benchmark_historical_volatility NUMERIC(18, 8),
  benchmark_regime TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (universe_name, timeframe, config_key, feature_time_utc)
);

CREATE INDEX IF NOT EXISTS idx_market_breadth_features_lookup
  ON market_breadth_features (universe_name, timeframe, config_key, feature_time_utc DESC);

ALTER TABLE market_breadth_features
  ADD COLUMN IF NOT EXISTS dispersion_score NUMERIC(18, 8),
  ADD COLUMN IF NOT EXISTS liquidity_score NUMERIC(18, 8),
  ADD COLUMN IF NOT EXISTS composite_trend_score NUMERIC(18, 8),
  ADD COLUMN IF NOT EXISTS composite_change NUMERIC(18, 8),
  ADD COLUMN IF NOT EXISTS composite_momentum NUMERIC(18, 8),
  ADD COLUMN IF NOT EXISTS composite_historical_volatility NUMERIC(18, 8),
  ADD COLUMN IF NOT EXISTS composite_regime TEXT;

CREATE TABLE IF NOT EXISTS market_relative_strength_features (
  id BIGSERIAL PRIMARY KEY,
  universe_name TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  config_key TEXT NOT NULL,
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  market_code TEXT NOT NULL,
  feature_time_utc TIMESTAMPTZ NOT NULL,
  momentum_spread NUMERIC(18, 8),
  z_score_spread NUMERIC(18, 8),
  volume_spike_spread NUMERIC(18, 8),
  benchmark_momentum_spread NUMERIC(18, 8),
  momentum_percentile NUMERIC(18, 8),
  cohort_momentum_spread NUMERIC(18, 8),
  cohort_z_score_spread NUMERIC(18, 8),
  cohort_volume_spike_spread NUMERIC(18, 8),
  composite_momentum_spread NUMERIC(18, 8),
  composite_change_spread NUMERIC(18, 8),
  liquidity_spread NUMERIC(18, 8),
  return_percentile NUMERIC(18, 8),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (universe_name, timeframe, config_key, feature_time_utc, market_code)
);

CREATE INDEX IF NOT EXISTS idx_market_relative_strength_features_lookup
  ON market_relative_strength_features (
    universe_name,
    timeframe,
    config_key,
    market_code,
    feature_time_utc DESC
  );

ALTER TABLE market_relative_strength_features
  ADD COLUMN IF NOT EXISTS cohort_momentum_spread NUMERIC(18, 8),
  ADD COLUMN IF NOT EXISTS cohort_z_score_spread NUMERIC(18, 8),
  ADD COLUMN IF NOT EXISTS cohort_volume_spike_spread NUMERIC(18, 8),
  ADD COLUMN IF NOT EXISTS composite_momentum_spread NUMERIC(18, 8),
  ADD COLUMN IF NOT EXISTS composite_change_spread NUMERIC(18, 8),
  ADD COLUMN IF NOT EXISTS liquidity_spread NUMERIC(18, 8),
  ADD COLUMN IF NOT EXISTS return_percentile NUMERIC(18, 8);
