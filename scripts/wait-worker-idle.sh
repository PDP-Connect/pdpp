#!/usr/bin/env bash
#
# wait-worker-idle.sh — Block until a live Claude worker lane is idle.
#
# An interactive `claude` session (launched by `claude-workstream.sh --interactive`)
# writes its conversation to a JSONL transcript at
#   ~/.claude/projects/<project-slug>/<session-id>.jsonl
# The worker is IDLE (finished its turn, awaiting input) exactly when the last
# `assistant` event in that JSONL carries `stop_reason: "end_turn"`. While the
# worker is mid-turn the last assistant event is `tool_use` (awaiting a tool
# result) and is typically followed by `user` (tool-result) lines, so the
# genuinely-last line is NOT a reliable signal — the last ASSISTANT event is.
#
# This is the deterministic idle gate the live-control flow uses to time
# steering / revision / reaping. It NEVER screen-scrapes the pane for prompt
# glyphs (that race is what the JSONL marker exists to avoid).
#
# Usage:
#   scripts/wait-worker-idle.sh <lane-or-session-id> [--timeout <seconds>] [--interval <seconds>]
#
# Argument:
#   <lane-or-session-id>  A lane name (resolved to its session_id via the lane's
#                         latest status.json) OR a session-id UUID directly.
#
# Options:
#   --timeout <seconds>   Max seconds to wait before giving up. Default: 600.
#   --interval <seconds>  Poll interval. Default: 2.
#
# Exit codes:
#   0  worker is idle (last assistant event has stop_reason "end_turn")
#   1  timed out before the worker went idle
#   2  usage / resolution error (no arg, session JSONL not found, etc.)

set -euo pipefail

die() {
  echo "wait-worker-idle: $*" >&2
  exit 2
}

target=""
timeout=600
interval=2

while [[ $# -gt 0 ]]; do
  case "$1" in
    --timeout) timeout="${2:-}"; shift 2 ;;
    --interval) interval="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,38p' "$0"; exit 2 ;;
    --*) die "unknown option: $1" ;;
    *)
      [[ -z "$target" ]] || die "unexpected extra argument: $1"
      target="$1"; shift ;;
  esac
done

[[ -n "$target" ]] || die "a lane name or session-id is required"
[[ "$timeout" =~ ^[0-9]+$ ]] || die "--timeout must be an integer (got: $timeout)"
[[ "$interval" =~ ^[0-9]+$ && "$interval" -ge 1 ]] || die "--interval must be a positive integer (got: $interval)"
command -v jq >/dev/null 2>&1 || die "jq is required"

projects_dir="${HOME}/.claude/projects"

# ---- resolve a session id ---------------------------------------------------
# A UUID-shaped target is taken as a session id directly. Otherwise treat it as
# a lane name and read the session_id from that lane's latest status.json.
uuid_re='^[0-9a-fA-F-]{36}$'
session_id=""

resolve_session_id_from_lane() {
  local lane="$1"
  # Locate this repo's wrapper artifact root the same way the wrapper does.
  local script_dir repo_root wrapper_dir lane_dir latest sj
  script_dir="$(cd "$(dirname "$0")" && pwd)"
  repo_root="$(cd "$script_dir/.." && pwd)"
  wrapper_dir="$repo_root/tmp/workstreams/claude-wrapper/$lane"
  [[ -d "$wrapper_dir" ]] || return 1
  # Newest run dir wins (timestamped names sort lexicographically).
  lane_dir="$(find "$wrapper_dir" -mindepth 1 -maxdepth 1 -type d | sort | tail -1)"
  [[ -n "$lane_dir" ]] || return 1
  sj="$lane_dir/status.json"
  [[ -f "$sj" ]] || return 1
  jq -r '.session_id // ""' "$sj"
}

if [[ "$target" =~ $uuid_re ]]; then
  session_id="$target"
else
  session_id="$(resolve_session_id_from_lane "$target" || true)"
  [[ -n "$session_id" ]] \
    || die "could not resolve a session_id for lane '$target' (no interactive status.json found)"
fi

# ---- locate the session JSONL ----------------------------------------------
# The transcript is <session-id>.jsonl under some project-slug dir. Pick the
# newest match (a session id is unique, but guard against stale copies).
find_jsonl() {
  find "$projects_dir" -maxdepth 2 -type f -name "${session_id}.jsonl" \
    -printf '%T@\t%p\n' 2>/dev/null | sort -rn | head -1 | cut -f2-
}

# ---- idle predicate ---------------------------------------------------------
# True when the last `assistant` event in the JSONL has stop_reason "end_turn".
worker_is_idle() {
  local jsonl="$1"
  local last_reason
  # Stream the file, keep only assistant events' stop_reason, take the last one.
  last_reason="$(jq -rc 'select(.type=="assistant") | .message.stop_reason // empty' "$jsonl" 2>/dev/null | tail -1)"
  [[ "$last_reason" == "end_turn" ]]
}

deadline=$(( $(date +%s) + timeout ))

echo "wait-worker-idle: session_id=$session_id timeout=${timeout}s interval=${interval}s" >&2

while :; do
  jsonl="$(find_jsonl)"
  if [[ -n "$jsonl" && -f "$jsonl" ]] && worker_is_idle "$jsonl"; then
    echo "wait-worker-idle: idle (end_turn) — $jsonl" >&2
    exit 0
  fi
  if [[ "$(date +%s)" -ge "$deadline" ]]; then
    if [[ -z "$jsonl" ]]; then
      echo "wait-worker-idle: TIMEOUT after ${timeout}s — session JSONL for $session_id never appeared" >&2
    else
      echo "wait-worker-idle: TIMEOUT after ${timeout}s — worker never reached end_turn ($jsonl)" >&2
    fi
    exit 1
  fi
  sleep "$interval"
done
