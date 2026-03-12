#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="$ROOT_DIR/logs"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"

if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

REGIME="${1:-${PAPER_DEFAULT_REGIME:-paper-trading-candidate}}"
TIMEFRAME="${2:-${PAPER_DEFAULT_TIMEFRAME:-5m}}"
MARKET="${3:-${PAPER_DEFAULT_MARKET:-KRW-BTC}}"
RANK="${4:-${PAPER_DEFAULT_RANK:-1}}"
BALANCE="${5:-${PAPER_STARTING_BALANCE:-1000000}}"
MAX_EVENTS="${6:-${PAPER_DEFAULT_MAX_EVENTS:-0}}"

mkdir -p "$LOG_DIR"

cd "$ROOT_DIR" || exit 1

SESSION_OUTPUT="$(
  ./services/paper-trader/node_modules/.bin/tsx \
    services/paper-trader/src/index.ts \
    start-session \
    --market "$MARKET" \
    --rank "$RANK" \
    --regime "$REGIME" \
    --timeframe "$TIMEFRAME" \
    --balance "$BALANCE"
)"

SESSION_ID="$(printf '%s\n' "$SESSION_OUTPUT" | sed -n 's/.*sessionId=\([0-9][0-9]*\).*/\1/p')"

if [[ -z "$SESSION_ID" ]]; then
  echo "Failed to parse session id"
  echo "$SESSION_OUTPUT"
  exit 1
fi

LOG_FILE="$LOG_DIR/paper-session-$SESSION_ID-$TIMESTAMP.log"

COMMAND="./services/paper-trader/node_modules/.bin/tsx services/paper-trader/src/index.ts run-session --session-id $SESSION_ID --regime $REGIME"

if [[ "$MAX_EVENTS" != "0" ]]; then
  COMMAND="$COMMAND --max-events $MAX_EVENTS"
fi

nohup bash -lc "
  cd '$ROOT_DIR' || exit 1
  echo \"[\$(date '+%Y-%m-%d %H:%M:%S')] paper session started\"
  echo \"[\$(date '+%Y-%m-%d %H:%M:%S')] session_id=$SESSION_ID regime=$REGIME timeframe=$TIMEFRAME market=$MARKET rank=$RANK balance=$BALANCE max_events=$MAX_EVENTS\"
  $COMMAND
  EXIT_CODE=\$?
  echo \"[\$(date '+%Y-%m-%d %H:%M:%S')] paper session finished with exit code \$EXIT_CODE\"
  exit \$EXIT_CODE
" >>"$LOG_FILE" 2>&1 &

PID=$!

echo "Started paper session"
echo "Session: $SESSION_ID"
echo "PID: $PID"
echo "Log: $LOG_FILE"
