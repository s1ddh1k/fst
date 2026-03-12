#!/usr/bin/env bash

set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="$ROOT_DIR/logs"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
LOG_FILE="$LOG_DIR/collector-$TIMESTAMP.log"
PAGES="${1:-10}"

mkdir -p "$LOG_DIR"

cd "$ROOT_DIR" || exit 1

{
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] overnight backfill started"
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] pages=$PAGES"

  pnpm --filter @fst/data-collector dev run-overnight --pages "$PAGES"

  EXIT_CODE=$?
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] overnight backfill finished with exit code $EXIT_CODE"
  exit "$EXIT_CODE"
} >>"$LOG_FILE" 2>&1 &

PID=$!

echo "Started overnight backfill"
echo "PID: $PID"
echo "Log: $LOG_FILE"
