#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SESSION_NAME="${FST_TMUX_SESSION:-fst}"
COMMAND="${1:-up}"

create_window() {
  local window_name="$1"
  local message="$2"

  if tmux list-windows -t "$SESSION_NAME" -F '#W' | grep -qx "$window_name"; then
    tmux respawn-window -k -t "$SESSION_NAME:$window_name" "bash -lc 'cd \"$ROOT_DIR\" && clear && printf \"%b\" \"$message\" && exec bash'"
    return
  fi

  tmux new-window -d -t "$SESSION_NAME" -n "$window_name" \
    "bash -lc 'cd \"$ROOT_DIR\" && clear && printf \"%b\" \"$message\" && exec bash'"
}

ensure_session() {
  if ! command -v tmux >/dev/null 2>&1; then
    echo "tmux is required"
    exit 1
  fi

  if ! tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    tmux new-session -d -s "$SESSION_NAME" -n overview "bash -lc 'cd \"$ROOT_DIR\" && clear && exec bash'"
  fi

  create_window "overview" "fst workspace\\n\\nroot: $ROOT_DIR\\n\\nstartup\\n  docker compose up -d\\n  bash infra/scripts/tmux-fst.sh attach\\n\\ncollector\\n  bash infra/scripts/run-overnight-backfill.sh 10\\n  bash infra/scripts/check-collector-status.sh\\n\\npaper\\n  bash infra/scripts/run-paper-session.sh\\n  bash infra/scripts/check-paper-session-status.sh\\n\\ndesktop\\n  pnpm --filter @fst/desktop dev\\n"
  create_window "desktop" "desktop window\\n\\nlaunch\\n  pnpm --filter @fst/desktop dev\\n\\nsmoke\\n  pnpm --filter @fst/desktop smoke\\n"
  create_window "collector" "collector window\\n\\nstatus\\n  bash infra/scripts/check-collector-status.sh\\n\\nbackfill\\n  bash infra/scripts/run-overnight-backfill.sh 10\\n"
  create_window "paper" "paper window\\n\\nstart session\\n  bash infra/scripts/run-paper-session.sh\\n\\nstatus\\n  bash infra/scripts/check-paper-session-status.sh\\n"
  create_window "logs" "logs window\\n\\nlatest files\\n  ls -lt logs | head\\n\\nfollow collector\\n  tail -f logs/collector-*.log\\n\\nfollow paper\\n  tail -f logs/paper-session-*.log\\n"

  tmux select-window -t "$SESSION_NAME:overview"
}

attach_session() {
  ensure_session

  if [[ -n "${TMUX:-}" ]]; then
    tmux switch-client -t "$SESSION_NAME"
  else
    tmux attach-session -t "$SESSION_NAME"
  fi
}

print_status() {
  if ! tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    echo "session=$SESSION_NAME status=missing"
    exit 1
  fi

  echo "session=$SESSION_NAME status=running"
  tmux list-windows -t "$SESSION_NAME" -F 'window=#{window_index}:#{window_name} active=#{window_active} panes=#{window_panes}'
}

destroy_session() {
  if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    tmux kill-session -t "$SESSION_NAME"
    echo "session=$SESSION_NAME status=stopped"
    return
  fi

  echo "session=$SESSION_NAME status=missing"
}

case "$COMMAND" in
  up)
    ensure_session
    echo "session=$SESSION_NAME status=ready"
    ;;
  attach)
    attach_session
    ;;
  status)
    print_status
    ;;
  down)
    destroy_session
    ;;
  *)
    echo "Usage: bash infra/scripts/tmux-fst.sh [up|attach|status|down]"
    exit 1
    ;;
esac
