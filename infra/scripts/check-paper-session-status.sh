#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SESSION_ID="${1:-}"

if [[ -z "$SESSION_ID" ]]; then
  SESSION_ID="$(
    docker compose exec -T postgres psql -U postgres -d fst -At -c \
      "SELECT id FROM paper_sessions ORDER BY id DESC LIMIT 1;" \
      | tail -n 1 | tr -d '[:space:]'
  )"
fi

if [[ -z "$SESSION_ID" ]]; then
  echo "No paper session found"
  exit 1
fi

cd "$ROOT_DIR" || exit 1

./services/paper-trader/node_modules/.bin/tsx \
  services/paper-trader/src/index.ts \
  status \
  --session-id "$SESSION_ID"

echo

docker compose exec -T postgres psql -U postgres -d fst -c "
SELECT id, strategy_name, market_code, timeframe, status, current_balance, started_at, ended_at
FROM paper_sessions
WHERE id = $SESSION_ID;
"

docker compose exec -T postgres psql -U postgres -d fst -c "
SELECT paper_session_id, market_code, quantity, avg_entry_price, mark_price, unrealized_pnl, realized_pnl, updated_at
FROM paper_positions
WHERE paper_session_id = $SESSION_ID;
"

docker compose exec -T postgres psql -U postgres -d fst -c "
SELECT paper_session_id, side, executed_price, quantity, fee, status, executed_at
FROM paper_orders
WHERE paper_session_id = $SESSION_ID
ORDER BY id DESC
LIMIT 20;
"
