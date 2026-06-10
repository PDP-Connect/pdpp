#!/usr/bin/env bash
#
# Structural tests for signal-handling in claude-workstream.sh.
#
# Verifies that termination signals cause status.json to be written with
# status:"aborted" and a non-zero exit code, without requiring a real Claude
# API call.
#
# Strategy: replace `claude` on PATH with a stub that sleeps so the wrapper is
# still running when we send the signal.
#
# Signal delivery notes:
#   SIGTERM delivered to the wrapper PID is caught by bash's trap.
#   SIGINT works in a real terminal (Ctrl+C reaches the whole process group),
#   but environments that set SIG_IGN on SIGINT (e.g. some CI sandboxes)
#   cannot exercise the INT path. The test detects and skips that case.
#
# Run: bash scripts/claude-workstream.abort.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WRAPPER="$SCRIPT_DIR/claude-workstream.sh"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

pass() { echo "PASS: $*"; }
skip() { echo "SKIP: $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

# ---- setup ------------------------------------------------------------------

TMP_DIR="$(mktemp -d)"
TMP_PROMPT="$TMP_DIR/prompt.txt"
TMP_REPORT="$TMP_DIR/report.md"
TMP_BIN="$TMP_DIR/bin"

echo "Test prompt — abort signal structural test" >"$TMP_PROMPT"
mkdir -p "$TMP_BIN"

# Stub claude binary: sleeps so the wrapper is still alive when we signal it.
cat >"$TMP_BIN/claude" <<'STUB'
#!/usr/bin/env bash
sleep 30
STUB
chmod +x "$TMP_BIN/claude"

export PATH="$TMP_BIN:$PATH"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

# Detect if SIGINT is ignored for background children in this shell.
# bash sets SIG_IGN on SIGINT for background jobs (&). Children inherit this.
# kill -INT <background_pid> therefore has no effect, making INT tests
# meaningless in any script-driven test harness. In production (tmux/terminal
# foreground), INT is NOT ignored and the trap fires correctly.
sigint_ignored_for_background() {
  local tmp_ign
  # Launch a background sleep and check its SigIgn mask.
  sleep 10 &
  local bpid=$!
  tmp_ign="$(awk '/^SigIgn:/{print $2}' /proc/$bpid/status 2>/dev/null || echo "")"
  kill "$bpid" 2>/dev/null; wait "$bpid" 2>/dev/null || true
  [[ -n "$tmp_ign" ]] && (( (16#$tmp_ign & 2) != 0 ))
}

# ---- helper -----------------------------------------------------------------
# run_wrapper_and_signal SIGNAL
#   Starts the wrapper in background, waits for status.json to be seeded,
#   sends SIGNAL to the wrapper (and its process group if setsid was used),
#   waits for exit. Prints: <exit_code> <status_json_path>
run_wrapper_and_signal() {
  local signal="$1"
  local lane="test-abort-${signal,,}"
  local aroot="$TMP_DIR/artifacts/$lane"

  "$WRAPPER" \
    --lane  "$lane" \
    --worktree "$REPO_ROOT" \
    --prompt "$TMP_PROMPT" \
    --report "$TMP_REPORT" \
    --artifact-root "$aroot" \
    --no-recovery \
    >/dev/null 2>&1 &
  local wpid=$!

  # Poll until status.json appears (seeded early by the initial write_status call).
  local waited=0
  while [[ $waited -lt 50 ]]; do
    local sj
    sj="$(find "$aroot" -name "status.json" 2>/dev/null | head -1)"
    [[ -n "$sj" ]] && break
    sleep 0.1
    (( waited++ )) || true
  done

  kill "-$signal" "$wpid" 2>/dev/null || true

  local rc=0
  wait "$wpid" 2>/dev/null || rc=$?

  local status_json
  status_json="$(find "$aroot" -name "status.json" 2>/dev/null | head -1)"

  echo "$rc $status_json"
}

# ---- test 1: SIGTERM writes status:aborted ----------------------------------

result="$(run_wrapper_and_signal TERM)"
exit_code="${result%% *}"
status_file="${result#* }"

[[ -n "$status_file" && -f "$status_file" ]] \
  || fail "SIGTERM: status.json not found (result='$result')"

status_value="$(jq -r .status "$status_file")"
[[ "$status_value" = "aborted" ]] \
  || fail "SIGTERM: expected status=aborted, got '$status_value'"
pass "SIGTERM writes status:aborted"

[[ "$exit_code" -ne 0 ]] \
  || fail "SIGTERM: expected non-zero exit, got $exit_code"
pass "SIGTERM exits non-zero (exit=$exit_code)"

# ---- test 2: SIGINT writes status:aborted (skipped if INT is ignored) -------

if sigint_ignored_for_background; then
  skip "SIGINT: environment has SIG_IGN on SIGINT — INT tests not meaningful here"
else
  result2="$(run_wrapper_and_signal INT)"
  exit_code2="${result2%% *}"
  status_file2="${result2#* }"

  [[ -n "$status_file2" && -f "$status_file2" ]] \
    || fail "SIGINT: status.json not found (result='$result2')"

  status_value2="$(jq -r .status "$status_file2")"
  [[ "$status_value2" = "aborted" ]] \
    || fail "SIGINT: expected status=aborted, got '$status_value2'"
  pass "SIGINT writes status:aborted"

  [[ "$exit_code2" -ne 0 ]] \
    || fail "SIGINT: expected non-zero exit, got $exit_code2"
  pass "SIGINT exits non-zero (exit=$exit_code2)"
fi

# ---- test 3: normal completion does not produce status:aborted --------------

# Use a stub claude that exits 0 immediately so the wrapper runs to completion.
cat >"$TMP_BIN/claude" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB

lane_normal="test-abort-normal"
aroot_normal="$TMP_DIR/artifacts/$lane_normal"

"$WRAPPER" \
  --lane "$lane_normal" \
  --worktree "$REPO_ROOT" \
  --prompt "$TMP_PROMPT" \
  --report "$TMP_REPORT" \
  --artifact-root "$aroot_normal" \
  --no-recovery || true   # non-zero expected (report absent → failed)

status_file_normal="$(find "$aroot_normal" -name "status.json" 2>/dev/null | head -1)"
[[ -n "$status_file_normal" && -f "$status_file_normal" ]] \
  || fail "normal: status.json not found under $aroot_normal"

status_normal="$(jq -r .status "$status_file_normal")"
[[ "$status_normal" != "aborted" ]] \
  || fail "normal run should not produce status:aborted, got '$status_normal'"
pass "normal (no-signal) run not mis-classified as aborted (status=$status_normal)"

echo ""
echo "All abort-signal structural tests passed."
