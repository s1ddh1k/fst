#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export BB_AUTO_STAGE="${BB_AUTO_STAGE:-auto}"
export BB_AUTO_LOOP_VERSION="${BB_AUTO_LOOP_VERSION:-v2}"

exec "$ROOT_DIR/scripts/run-bb-seeded-auto-research-deadline.sh" "$@"
