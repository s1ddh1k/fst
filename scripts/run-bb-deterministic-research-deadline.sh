#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAMP="${BB_DETERMINISTIC_STAMP:-$(date +%Y%m%d-%H%M%S)}"
OUTPUT_ROOT="${BB_DETERMINISTIC_OUTPUT_ROOT:-$ROOT_DIR/research/backtester/artifacts}"
OUTPUT_DIR="${BB_DETERMINISTIC_OUTPUT_DIR:-$OUTPUT_ROOT/bb-deterministic-deadline-$STAMP}"
LOG_PATH="${BB_DETERMINISTIC_LOG_PATH:-$OUTPUT_DIR/batch.log}"
STATUS_PATH="${BB_DETERMINISTIC_STATUS_PATH:-$OUTPUT_DIR/wrapper-status.json}"

DEADLINE_SECONDS="${BB_DETERMINISTIC_DEADLINE_SECONDS:-10800}"
FAMILIES="${BB_DETERMINISTIC_FAMILIES:-all}"
CANDIDATE_COUNT="${BB_DETERMINISTIC_CANDIDATE_COUNT:-12}"
ELITE_COUNT="${BB_DETERMINISTIC_ELITE_COUNT:-4}"
GENERATIONS="${BB_DETERMINISTIC_GENERATIONS:-3}"
WALK_FORWARD_TOP="${BB_DETERMINISTIC_WALK_FORWARD_TOP:-4}"
TOP_SEEDS="${BB_DETERMINISTIC_TOP_SEEDS:-4}"
UNIVERSE="${BB_DETERMINISTIC_UNIVERSE:-krw-top}"
MARKET_LIMIT="${BB_DETERMINISTIC_MARKET_LIMIT:-12}"
MIN_5M_CANDLES="${BB_DETERMINISTIC_MIN_5M_CANDLES:-150000}"
HOLDOUT_DAYS="${BB_DETERMINISTIC_HOLDOUT_DAYS:-180}"
TRAINING_DAYS="${BB_DETERMINISTIC_TRAINING_DAYS:-180}"
STEP_DAYS="${BB_DETERMINISTIC_STEP_DAYS:-90}"
LIMIT="${BB_DETERMINISTIC_LIMIT:-6000}"
SEED="${BB_DETERMINISTIC_SEED:-20260322}"
MIN_TRADES="${BB_DETERMINISTIC_MIN_TRADES:-}"
MIN_NET_RETURN="${BB_DETERMINISTIC_MIN_NET_RETURN:-}"
MAX_DRAWDOWN="${BB_DETERMINISTIC_MAX_DRAWDOWN:-}"
MIN_POSITIVE_WINDOW_RATIO="${BB_DETERMINISTIC_MIN_POSITIVE_WINDOW_RATIO:-}"
MIN_RANDOM_PERCENTILE="${BB_DETERMINISTIC_MIN_RANDOM_PERCENTILE:-}"
REQUIRE_BOOTSTRAP_SIGNIFICANCE="${BB_DETERMINISTIC_REQUIRE_BOOTSTRAP_SIGNIFICANCE:-0}"
SEED_REPORTS="${BB_DETERMINISTIC_SEED_REPORTS:-$ROOT_DIR/research/backtester/research/2026-03-22-bb-top-return-seeds.json}"

mkdir -p "$OUTPUT_DIR"
mkdir -p "$(dirname "$LOG_PATH")"
mkdir -p "$(dirname "$STATUS_PATH")"

log() {
  local message="$1"
  printf '[%s] %s\n' "$(date --iso-8601=seconds)" "$message" >>"$LOG_PATH"
  if [[ -t 1 ]]; then
    printf '%s\n' "$message"
  fi
}

write_status() {
  local phase="$1"
  local message="$2"
  local tmp_status="${STATUS_PATH}.$$.$RANDOM.tmp"
  cat >"$tmp_status" <<EOF
{
  "updatedAt": "$(date --iso-8601=seconds)",
  "phase": "$phase",
  "message": $(printf '%s' "$message" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'),
  "outputDir": $(printf '%s' "$OUTPUT_DIR" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'),
  "logPath": $(printf '%s' "$LOG_PATH" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'),
  "deadlineSeconds": $DEADLINE_SECONDS
}
EOF
  mv "$tmp_status" "$STATUS_PATH"
}

finished=0
cleanup() {
  local exit_code=$?
  if [[ $finished -eq 1 ]]; then
    return
  fi

  if [[ $exit_code -eq 0 ]]; then
    write_status "completed" "deterministic BB research wrapper exited cleanly"
  else
    write_status "failed" "deterministic BB research wrapper exited unexpectedly (code=$exit_code)"
  fi
}
trap cleanup EXIT

write_status "starting" "preparing deterministic BB research command"
log "starting deterministic BB research output=$OUTPUT_DIR"

command=(
  pnpm --filter @fst/backtester tune:bb --
  --families "$FAMILIES"
  --candidate-count "$CANDIDATE_COUNT"
  --elite-count "$ELITE_COUNT"
  --generations "$GENERATIONS"
  --walk-forward-top "$WALK_FORWARD_TOP"
  --top-seeds "$TOP_SEEDS"
  --universe "$UNIVERSE"
  --market-limit "$MARKET_LIMIT"
  --min-5m-candles "$MIN_5M_CANDLES"
  --holdout-days "$HOLDOUT_DAYS"
  --training-days "$TRAINING_DAYS"
  --step-days "$STEP_DAYS"
  --limit "$LIMIT"
  --seed "$SEED"
  --output-dir "$OUTPUT_DIR"
)

IFS=',' read -r -a seed_report_array <<<"$SEED_REPORTS"
for seed_report in "${seed_report_array[@]}"; do
  seed_report="${seed_report#"${seed_report%%[![:space:]]*}"}"
  seed_report="${seed_report%"${seed_report##*[![:space:]]}"}"
  if [[ -n "$seed_report" ]]; then
    command+=(--seed-report "$seed_report")
  fi
done

if [[ -n "$MIN_TRADES" ]]; then
  command+=(--min-trades "$MIN_TRADES")
fi
if [[ -n "$MIN_NET_RETURN" ]]; then
  command+=(--min-net-return "$MIN_NET_RETURN")
fi
if [[ -n "$MAX_DRAWDOWN" ]]; then
  command+=(--max-drawdown "$MAX_DRAWDOWN")
fi
if [[ -n "$MIN_POSITIVE_WINDOW_RATIO" ]]; then
  command+=(--min-positive-window-ratio "$MIN_POSITIVE_WINDOW_RATIO")
fi
if [[ -n "$MIN_RANDOM_PERCENTILE" ]]; then
  command+=(--min-random-percentile "$MIN_RANDOM_PERCENTILE")
fi
if [[ "$REQUIRE_BOOTSTRAP_SIGNIFICANCE" == "1" ]]; then
  command+=(--require-bootstrap-significance)
fi

write_status "running" "deterministic BB research is running"
log "command: ${command[*]}"

set +e
timeout --signal=TERM --kill-after=30s "${DEADLINE_SECONDS}s" "${command[@]}" >>"$LOG_PATH" 2>&1
exit_code=$?
set -e

if [[ $exit_code -eq 0 ]]; then
  log "kernel completed, running artifact audit"
  set +e
  pnpm --filter @fst/backtester audit:bb -- --output-dir "$OUTPUT_DIR" >>"$LOG_PATH" 2>&1
  audit_exit_code=$?
  set -e
  if [[ $audit_exit_code -ne 0 ]]; then
    finished=1
    write_status "failed" "deterministic BB research audit failed with exit code $audit_exit_code"
    log "artifact audit failed with exit code $audit_exit_code"
    exit "$audit_exit_code"
  fi
  log "artifact audit passed, running replay verification"
  set +e
  pnpm --filter @fst/backtester replay:bb -- --output-dir "$OUTPUT_DIR" >>"$LOG_PATH" 2>&1
  replay_exit_code=$?
  set -e
  if [[ $replay_exit_code -ne 0 ]]; then
    finished=1
    write_status "failed" "deterministic BB research replay verification failed with exit code $replay_exit_code"
    log "replay verification failed with exit code $replay_exit_code"
    exit "$replay_exit_code"
  fi
  finished=1
  write_status "completed" "deterministic BB research completed and passed wrapper audit + replay verification"
  log "completed successfully"
  exit 0
fi

if [[ $exit_code -eq 124 ]]; then
  finished=1
  write_status "timed_out" "deterministic BB research hit deadline"
  log "timed out after ${DEADLINE_SECONDS}s"
  exit 124
fi

finished=1
write_status "failed" "deterministic BB research failed with exit code $exit_code"
log "failed with exit code $exit_code"
exit "$exit_code"
