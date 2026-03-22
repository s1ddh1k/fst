#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

TARGET_ISO="${TARGET_ISO:-2021-01-01T00:00:00Z}"
UNIVERSE_NAME="${UNIVERSE_NAME:-krw-top}"
UNIVERSE_LIMIT="${UNIVERSE_LIMIT:-30}"
COARSE_BATCH_PAGES="${COARSE_BATCH_PAGES:-100}"
MICRO_BATCH_PAGES="${MICRO_BATCH_PAGES:-400}"
AUTO_RESEARCH_OUTPUT="${AUTO_RESEARCH_OUTPUT:-/tmp/fst-auto-research-overnight-$(date +%Y%m%d-%H%M%S)}"

log() {
  printf '[%s] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*"
}

log "refreshing universe name=${UNIVERSE_NAME} limit=${UNIVERSE_LIMIT}"
pnpm --filter @fst/data-collector dev refresh-universe \
  --quote KRW \
  --limit "${UNIVERSE_LIMIT}" \
  --name "${UNIVERSE_NAME}"

log "backfilling coarse frames to target=${TARGET_ISO}"
pnpm --filter @fst/data-collector dev backfill-until \
  --universe "${UNIVERSE_NAME}" \
  --timeframes 1d,1h,15m,5m \
  --target "${TARGET_ISO}" \
  --batch-pages "${COARSE_BATCH_PAGES}"

log "backfilling micro frame to target=${TARGET_ISO}"
pnpm --filter @fst/data-collector dev backfill-until \
  --universe "${UNIVERSE_NAME}" \
  --timeframes 1m \
  --target "${TARGET_ISO}" \
  --batch-pages "${MICRO_BATCH_PAGES}"

log "starting auto-research output=${AUTO_RESEARCH_OUTPUT}"
NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=12288}" \
pnpm --filter @fst/backtester dev -- \
  --auto-research \
  --auto-research-loop v2 \
  --auto-research-family multi-tf-regime-switch \
  --auto-research-mode holdout \
  --auto-research-iterations 1 \
  --auto-research-candidates 1 \
  --auto-research-parallelism 1 \
  --holdout-days 30 \
  --training-days 90 \
  --step-days 30 \
  --market-limit 5 \
  --limit 3961 \
  --auto-research-llm-timeout-ms 60000 \
  --auto-research-output "${AUTO_RESEARCH_OUTPUT}"

log "overnight pipeline completed"
