#!/bin/bash
# Run all paper trading sessions + periodic data sync.
# Usage: ./scripts/run-paper-trading.sh

set -e
cd "$(dirname "$0")/.."

export SQLITE_PATH="$(pwd)/data/fst.db"

echo "=== FST Paper Trading ==="
echo "DB: $SQLITE_PATH"
echo ""

# Sync latest data first
echo "Syncing latest candles..."
cd services/data-collector
npx tsx src/index.ts sync-latest-batch --markets KRW-ETH,KRW-XRP,KRW-DOGE --timeframes 1h 2>&1 | tail -3
cd ../..

# Show active sessions
echo ""
echo "Active sessions:"
cd services/paper-trader
npx tsx src/index.ts show-recommendations 2>&1
echo ""

# Run sessions in parallel
echo "Starting paper trading sessions..."
npx tsx src/index.ts run-session --session-id 11 &
PID1=$!
npx tsx src/index.ts run-session --session-id 12 &
PID2=$!
npx tsx src/index.ts run-session --session-id 13 &
PID3=$!

echo "Sessions started: ETH(pid=$PID1) XRP(pid=$PID2) DOGE(pid=$PID3)"
echo "Press Ctrl+C to stop all."

# Data sync every hour in background
while true; do
  sleep 3600
  echo "[$(date -u '+%Y-%m-%d %H:%M')] Syncing candles..."
  cd ../../services/data-collector
  npx tsx src/index.ts sync-latest-batch --markets KRW-ETH,KRW-XRP,KRW-DOGE --timeframes 1h 2>&1 | tail -1
  cd ../../services/paper-trader
done &
SYNC_PID=$!

trap "kill $PID1 $PID2 $PID3 $SYNC_PID 2>/dev/null; echo 'Stopped.'; exit 0" INT TERM

wait $PID1 $PID2 $PID3
