#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
DEFAULT_OUTPUT_ROOT="$ROOT_DIR/research/backtester/artifacts/bb-seeded-auto-deadline-$STAMP"
OUTPUT_ROOT="${1:-$DEFAULT_OUTPUT_ROOT}"
DEADLINE_EPOCH="${BB_AUTO_DEADLINE_EPOCH:-$(( $(date +%s) + 3 * 60 * 60 ))}"
SEED_ARTIFACT="${BB_AUTO_SEED_ARTIFACT:-$ROOT_DIR/research/backtester/research/2026-03-22-bb-top-return-seeds.json}"
ITERATIONS="${BB_AUTO_ITERATIONS:-3}"
CANDIDATES="${BB_AUTO_CANDIDATES:-8}"
PARALLELISM="${BB_AUTO_PARALLELISM:-8}"
MARKET_LIMIT="${BB_AUTO_MARKET_LIMIT:-12}"
SEED_CANDIDATES="${BB_AUTO_SEED_CANDIDATES:-3}"
MIN_DISTANCE="${BB_AUTO_MIN_DISTANCE:-0.12}"
LLM_PROVIDER="${BB_AUTO_LLM_PROVIDER:-codex}"
LLM_MODEL="${BB_AUTO_LLM_MODEL:-medium}"
LLM_TIMEOUT_MS="${BB_AUTO_LLM_TIMEOUT_MS:-120000}"
AUTO_RESEARCH_LOOP="${BB_AUTO_LOOP_VERSION:-v2}"
AUTO_RESEARCH_STAGE="${BB_AUTO_STAGE:-block}"
HOLDOUT_DAYS="${BB_AUTO_HOLDOUT_DAYS:-365}"
TRAINING_DAYS="${BB_AUTO_TRAINING_DAYS:-365}"
STEP_DAYS="${BB_AUTO_STEP_DAYS:-90}"
FAMILY_TIMEOUT_SECONDS="${BB_AUTO_FAMILY_TIMEOUT_SECONDS:-3300}"
STATUS_PATH="$OUTPUT_ROOT/status.json"
LOG_PATH="$OUTPUT_ROOT/batch.log"
LAST_STATUS_PHASE="starting"
LAST_STATUS_DETAIL="deadline batch created"

mkdir -p "$OUTPUT_ROOT"

write_status() {
  local phase="$1"
  local detail="$2"
  LAST_STATUS_PHASE="$phase"
  LAST_STATUS_DETAIL="$detail"
  cat >"$STATUS_PATH" <<JSON
{
  "updatedAt": "$(date --iso-8601=seconds)",
  "phase": "$phase",
  "detail": "$detail",
  "deadlineEpoch": $DEADLINE_EPOCH,
  "outputRoot": "$OUTPUT_ROOT"
}
JSON
}

log() {
  local line
  line="[$(date --iso-8601=seconds)] $1"
  printf '%s\n' "$line" >>"$LOG_PATH"

  # Background batch wrappers often lose their original stdout pipe.
  # Only mirror logs to stdout when an interactive terminal is attached.
  if [[ -t 1 ]]; then
    printf '%s\n' "$line"
  fi
}

should_resume_output() {
  local output_dir="$1"
  local status_path="$output_dir/status.json"

  if [[ ! -f "$status_path" ]]; then
    return 0
  fi

  if grep -q '"phase": "completed"' "$status_path"; then
    return 1
  fi

  return 0
}

run_family() {
  local label="$1"
  local family="$2"
  local attempt="$3"
  local family_output="$OUTPUT_ROOT/${label}-run-$(printf '%02d' "$attempt")"
  local family_log="$family_output.log"
  local family_status="$family_output/wrapper-status.json"
  local resume_from=""
  local remaining_seconds
  local effective_timeout_seconds
  local exit_code=0
  local timed_out=false
  local resume_json="null"
  local -a command

  mkdir -p "$family_output"
  remaining_seconds=$((DEADLINE_EPOCH - $(date +%s)))
  if (( remaining_seconds <= 0 )); then
    log "skip label=$label family=$family attempt=$attempt reason=deadline-reached"
    return 0
  fi

  effective_timeout_seconds="$FAMILY_TIMEOUT_SECONDS"
  if (( remaining_seconds < effective_timeout_seconds )); then
    effective_timeout_seconds="$remaining_seconds"
  fi

  if (( attempt > 1 )); then
    local previous_attempt=$((attempt - 1))
    local previous_output="$OUTPUT_ROOT/${label}-run-$(printf '%02d' "$previous_attempt")"
    if [[ -d "$previous_output" ]] && should_resume_output "$previous_output"; then
      resume_from="$previous_output"
      resume_json="\"$resume_from\""
    fi
  fi

  log "start label=$label family=$family attempt=$attempt stage=$AUTO_RESEARCH_STAGE output=$family_output${resume_from:+ resume=$resume_from}"
  write_status "running" "label=$label family=$family attempt=$attempt stage=$AUTO_RESEARCH_STAGE timeoutSeconds=$effective_timeout_seconds${resume_from:+ resume=$resume_from}"

  command=(
    node --import tsx src/index.ts
    --auto-research
    --stage "$AUTO_RESEARCH_STAGE"
    --auto-research-mode walk-forward
    --auto-research-iterations "$ITERATIONS"
    --auto-research-candidates "$CANDIDATES"
    --auto-research-parallelism "$PARALLELISM"
    --holdout-days "$HOLDOUT_DAYS"
    --training-days "$TRAINING_DAYS"
    --step-days "$STEP_DAYS"
    --market-limit "$MARKET_LIMIT"
    --llm-provider "$LLM_PROVIDER"
    --llm-model "$LLM_MODEL"
    --auto-research-loop "$AUTO_RESEARCH_LOOP"
    --auto-research-llm-timeout-ms "$LLM_TIMEOUT_MS"
    --auto-research-seed-artifact "$SEED_ARTIFACT"
    --auto-research-seed-candidates "$SEED_CANDIDATES"
    --auto-research-candidate-min-distance "$MIN_DISTANCE"
    --auto-research-family "$family"
    --auto-research-output "$family_output"
  )

  if [[ -n "$resume_from" ]]; then
    command+=(--auto-research-resume "$resume_from")
  fi

  if (
    cd "$ROOT_DIR/research/backtester"
    timeout --signal=TERM --kill-after=30s "${effective_timeout_seconds}s" \
      "${command[@]}"
  ) >"$family_log" 2>&1; then
    exit_code=0
  else
    exit_code=$?
  fi

  if [[ "$exit_code" == "124" || "$exit_code" == "137" ]]; then
    timed_out=true
  fi

  cat >"$family_status" <<JSON
{
  "updatedAt": "$(date --iso-8601=seconds)",
  "label": "$label",
  "family": "$family",
  "attempt": $attempt,
  "exitCode": $exit_code,
  "timedOut": $timed_out,
  "timeoutSeconds": $effective_timeout_seconds,
  "logPath": "$family_log",
  "resumeFrom": $resume_json
}
JSON

  write_status "running" "lastCompleted label=$label family=$family attempt=$attempt exitCode=$exit_code"
  log "finish label=$label family=$family attempt=$attempt exitCode=$exit_code timeoutSeconds=$effective_timeout_seconds"
}

handle_exit() {
  local exit_code=$?
  if (( exit_code == 0 )); then
    return
  fi

  LAST_STATUS_PHASE="failed"
  LAST_STATUS_DETAIL="wrapper-exit=$exit_code lastStatus=${LAST_STATUS_DETAIL}"
  cat >"$STATUS_PATH" <<JSON
{
  "updatedAt": "$(date --iso-8601=seconds)",
  "phase": "$LAST_STATUS_PHASE",
  "detail": "$LAST_STATUS_DETAIL",
  "deadlineEpoch": $DEADLINE_EPOCH,
  "outputRoot": "$OUTPUT_ROOT"
}
JSON
  printf '[%s] wrapper failed exitCode=%s lastStatus=%s\n' "$(date --iso-8601=seconds)" "$exit_code" "$LAST_STATUS_DETAIL" >>"$LOG_PATH"
}

trap handle_exit EXIT

write_status "starting" "deadline batch created"
log "deadline batch start output=$OUTPUT_ROOT deadline_epoch=$DEADLINE_EPOCH"

attempt=0
while [[ "$(date +%s)" -lt "$DEADLINE_EPOCH" ]]; do
  attempt=$((attempt + 1))

  for item in \
    "weekly:block:bb-reversion-1h" \
    "daily:block:bb-reversion-1h-daily" \
    "hourly:block:bb-reversion-1h-hourly"
  do
    if [[ "$(date +%s)" -ge "$DEADLINE_EPOCH" ]]; then
      break 2
    fi

    label="${item%%:*}"
    family="${item#*:}"
    run_family "$label" "$family" "$attempt"
  done
done

write_status "completed" "deadline reached"
log "deadline batch completed"
