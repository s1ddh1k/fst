#!/usr/bin/env bash

set -euo pipefail

docker exec fst-postgres psql -U postgres -d fst -c "
SELECT run_type, market_code, timeframe, status, message, started_at, finished_at
FROM collector_runs
ORDER BY id DESC
LIMIT 20;
"

docker exec fst-postgres psql -U postgres -d fst -c "
SELECT market_code, timeframe, last_run_type, last_status, last_message, updated_at
FROM collector_state
ORDER BY updated_at DESC
LIMIT 20;
"

docker exec fst-postgres psql -U postgres -d fst -c "
SELECT market_code, timeframe, status, gap_start_utc, gap_end_utc, resolution_message
FROM data_gaps
ORDER BY id DESC
LIMIT 20;
"

docker exec fst-postgres psql -U postgres -d fst -c "
SELECT service_name, level, event_type, message, created_at
FROM system_logs
ORDER BY id DESC
LIMIT 20;
"
