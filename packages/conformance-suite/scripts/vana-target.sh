#!/usr/bin/env bash
# Copyright The PDP-Connect Contributors
# SPDX-License-Identifier: Apache-2.0
# Disposable loopback lifecycle. The exact suite status is returned after teardown.
set -euo pipefail
SUITE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PDPP_VANA_REF="${PDPP_VANA_REF:-0b5eac036a33cb714cdd6d3a71abddd98e609f2d}"
export PDPP_VANA_PS PDPP_VANA_REF
export PDPP_VANA_PORT="${PDPP_VANA_PORT:-0}"
mkdir -p "$HOME/.tmp"
export PDPP_VANA_STATE_DIR
PDPP_VANA_STATE_DIR="$(mktemp -d "$HOME/.tmp/pdpp-vana-target-XXXXXX")"
export PDPP_VANA_REPORT_DIR="${PDPP_VANA_REPORT_DIR:-$PDPP_VANA_STATE_DIR-reports}"
mkdir -p "$PDPP_VANA_REPORT_DIR"
start_tick() { [[ -r "/proc/$1/stat" ]] && sed 's/.*) //' "/proc/$1/stat" | awk '{print $20}'; }
cleanup() {
  local result=$?
  if [[ -n "${suite_pid:-}" && -n "${suite_start:-}" && "$(start_tick "$suite_pid")" = "$suite_start" ]]; then
    kill -TERM "$suite_pid" 2>/dev/null || true
    wait "$suite_pid" 2>/dev/null || true
  fi
  if [[ -n "${server_pid:-}" && -n "${server_start:-}" && "$(start_tick "$server_pid")" = "$server_start" ]]; then
    kill -TERM "$server_pid" 2>/dev/null || true
    for ((attempt=0;attempt<50;attempt++)); do
      kill -0 "$server_pid" 2>/dev/null || break
      sleep 0.1
    done
    if [[ "$(start_tick "$server_pid")" = "$server_start" ]]; then kill -KILL "$server_pid" 2>/dev/null || true; fi
    wait "$server_pid" 2>/dev/null || true
  fi
  # Readiness contains a per-boot credential; only retain the redacted log.
  if [[ -f "$PDPP_VANA_STATE_DIR/server.log" ]]; then
    awk 'index($0, "{\"ready\":true") != 1' "$PDPP_VANA_STATE_DIR/server.log" > "$PDPP_VANA_REPORT_DIR/server.log"
  fi
  rm -rf "$PDPP_VANA_STATE_DIR"
  return "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
exec 9>"$PDPP_VANA_REPORT_DIR/.lifecycle.lock"
flock -n 9 || { echo 'Another lifecycle owns this report directory' >&2; exit 1; }
# Invalidate only this lifecycle's own outputs before attempting a fresh boot.
for name in baseline.json baseline.md report.json report.md requirements.json target.json fixture-truth.json fixture-probes.json experimental-v0.2.json experimental-v0.2.md server.log core-v0.1.json core-v0.1.md requirements-v0.1.json; do
  rm -f "$PDPP_VANA_REPORT_DIR/$name"
done
: "${PDPP_VANA_PS:?Set PDPP_VANA_PS to a clean personal-server-ts checkout}"
[[ "$PDPP_VANA_REF" =~ ^[0-9a-f]{40}$ ]] || { echo 'Full PS commit SHA required' >&2; exit 1; }
[[ "$(git -C "$PDPP_VANA_PS" rev-parse HEAD)" = "$PDPP_VANA_REF" ]] || { echo 'PS checkout differs from pin' >&2; exit 1; }
[[ -z "$(git -C "$PDPP_VANA_PS" status --porcelain --untracked-files=normal)" ]] || { echo 'PS checkout is dirty' >&2; exit 1; }
[[ -x "$PDPP_VANA_PS/node_modules/.bin/tsx" ]] || { echo 'Install PS dependencies with npm ci, then build core first' >&2; exit 1; }
[[ "${1:-run}" = run ]] || { echo 'usage: vana-target.sh run' >&2; exit 2; }
setpriv --pdeathsig KILL node --import "$PDPP_VANA_PS/node_modules/tsx/dist/loader.mjs" "$SUITE_DIR/scripts/vana-boot.mts" > "$PDPP_VANA_STATE_DIR/server.log" 2>&1 &
server_pid=$!
server_start="$(start_tick "$server_pid")"
for ((attempt=0;attempt<120;attempt++)); do
  if rg -q '"ready":true' "$PDPP_VANA_STATE_DIR/server.log"; then break; fi
  if ! kill -0 "$server_pid" 2>/dev/null; then cat "$PDPP_VANA_STATE_DIR/server.log" >&2; exit 1; fi
  sleep 0.5
done
if ! rg -q '"ready":true' "$PDPP_VANA_STATE_DIR/server.log"; then cat "$PDPP_VANA_STATE_DIR/server.log" >&2; exit 1; fi
cd "$SUITE_DIR"
setpriv --pdeathsig KILL node --import tsx scripts/vana-run.ts &
suite_pid=$!
suite_start="$(start_tick "$suite_pid")"
set +e
wait "$suite_pid"
suite_status=$?
set -e
exit "$suite_status"
