#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUTPUT_ROOT="${1:-$ROOT_DIR/research/backtester/artifacts/bb-seeded-auto-$STAMP}"
SEED_ARTIFACT="${2:-$ROOT_DIR/research/backtester/research/2026-03-22-bb-top-return-seeds.json}"
ITERATIONS="${BB_AUTO_ITERATIONS:-1}"
CANDIDATES="${BB_AUTO_CANDIDATES:-6}"
PARALLELISM="${BB_AUTO_PARALLELISM:-$CANDIDATES}"
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
OVERALL_EXIT=0

mkdir -p "$OUTPUT_ROOT"

cd "$ROOT_DIR/research/backtester"

COMMON_ARGS=(
  node
  --import
  tsx
  src/index.ts
  --auto-research
  --stage
  "$AUTO_RESEARCH_STAGE"
  --auto-research-mode
  walk-forward
  --auto-research-iterations
  "$ITERATIONS"
  --auto-research-candidates
  "$CANDIDATES"
  --auto-research-parallelism
  "$PARALLELISM"
  --holdout-days
  "$HOLDOUT_DAYS"
  --training-days
  "$TRAINING_DAYS"
  --step-days
  "$STEP_DAYS"
  --market-limit
  "$MARKET_LIMIT"
  --llm-provider
  "$LLM_PROVIDER"
  --llm-model
  "$LLM_MODEL"
  --auto-research-loop
  "$AUTO_RESEARCH_LOOP"
  --auto-research-llm-timeout-ms
  "$LLM_TIMEOUT_MS"
  --auto-research-seed-artifact
  "$SEED_ARTIFACT"
  --auto-research-seed-candidates
  "$SEED_CANDIDATES"
  --auto-research-candidate-min-distance
  "$MIN_DISTANCE"
)

FAMILIES=(
  "block:bb-reversion-1h"
  "block:bb-reversion-1h-daily"
  "block:bb-reversion-1h-hourly"
)

LABELS=(
  "weekly"
  "daily"
  "hourly"
)

for index in "${!FAMILIES[@]}"; do
  label="${LABELS[$index]}"
  family="${FAMILIES[$index]}"
  output_dir="$OUTPUT_ROOT/$label"
  log_path="$OUTPUT_ROOT/$label.log"

  {
    echo "[bb-seeded-auto] label=$label family=$family started_at=$(date --iso-8601=seconds)"
    "${COMMON_ARGS[@]}" \
      --auto-research-family "$family" \
      --auto-research-output "$output_dir"
    echo "[bb-seeded-auto] label=$label family=$family finished_at=$(date --iso-8601=seconds)"
  } >"$log_path" 2>&1 || {
    echo "[bb-seeded-auto] label=$label family=$family failed_at=$(date --iso-8601=seconds)" >>"$log_path"
    OVERALL_EXIT=1
    continue
  }

  child_phase="$(node -e 'const fs=require("fs"); const file=process.argv[1]; try { const parsed=JSON.parse(fs.readFileSync(file, "utf8")); process.stdout.write(String(parsed.phase ?? "")); } catch { process.stdout.write(""); }' "$output_dir/status.json")"
  child_verified="false"
  if node -e 'const fs=require("fs"); const file=process.argv[1]; try { const parsed=JSON.parse(fs.readFileSync(file, "utf8")); process.exit(parsed?.verification?.artifactAudit?.ok === true ? 0 : 1); } catch { process.exit(1); }' "$output_dir/status.json"; then
    child_verified="true"
  fi
  if [[ "$child_phase" != "completed" || "$child_verified" != "true" ]]; then
    echo "[bb-seeded-auto] label=$label family=$family child_phase=$child_phase child_verified=$child_verified treated_as_failure" >>"$log_path"
    OVERALL_EXIT=1
  fi
done

echo "$OUTPUT_ROOT"
exit "$OVERALL_EXIT"
