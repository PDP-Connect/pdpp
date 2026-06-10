#!/usr/bin/env bash
#
# Structural tests for the --tmux flag in claude-workstream.sh.
#
# Verifies tmux window creation and guard behaviour without invoking Claude.
# The inner claude-workstream.sh run will fail quickly (no claude binary mock),
# but the structural assertions — window created, exit-0, duplicate guard — are
# verified before that happens.
#
# Run: bash scripts/claude-workstream.tmux.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WRAPPER="$SCRIPT_DIR/claude-workstream.sh"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TEST_SESSION="test-ws-$$-tmux"
LANE="test-tmux-lane"

pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

# ---- setup ------------------------------------------------------------------

TMP_DIR="$(mktemp -d)"
TMP_PROMPT="$TMP_DIR/prompt.txt"
TMP_REPORT="$TMP_DIR/report.md"
echo "Test prompt — tmux structural test" >"$TMP_PROMPT"

cleanup() {
  tmux kill-session -t "$TEST_SESSION" 2>/dev/null || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

# ---- test 1: --tmux creates window and exits 0 ------------------------------

tmux new-session -d -s "$TEST_SESSION"

"$WRAPPER" \
  --lane "$LANE" \
  --worktree "$REPO_ROOT" \
  --prompt "$TMP_PROMPT" \
  --report "$TMP_REPORT" \
  --tmux \
  --tmux-session "$TEST_SESSION"

pass "--tmux exited 0"

# ---- test 2: tmux window has the expected name ------------------------------

if ! tmux list-windows -t "$TEST_SESSION" -F '#{window_name}' 2>/dev/null \
     | grep -qxF "ws-$LANE"; then
  tmux list-windows -t "$TEST_SESSION" >&2 || true
  fail "window 'ws-$LANE' not found in session $TEST_SESSION"
fi
pass "window 'ws-$LANE' exists in session $TEST_SESSION"

# ---- test 3: duplicate launch is refused (window already exists) ------------

if "$WRAPPER" \
     --lane "$LANE" \
     --worktree "$REPO_ROOT" \
     --prompt "$TMP_PROMPT" \
     --report "$TMP_REPORT" \
     --tmux \
     --tmux-session "$TEST_SESSION" 2>/dev/null; then
  fail "duplicate --tmux launch should exit non-zero"
fi
pass "duplicate --tmux launch refused (window already exists)"

# ---- test 4: --tmux-session default is 'main' (arg-parsing smoke) -----------

# Parse the script for the default value rather than actually creating a
# 'main' session, to avoid side-effects in the owner's live tmux.
if ! grep -q 'tmux_session_name="main"' "$WRAPPER"; then
  fail "default tmux_session_name should be 'main' in $WRAPPER"
fi
pass "default --tmux-session is 'main'"

# ---- test 5: --tmux requires --lane / --worktree / --prompt / --report ------

if "$WRAPPER" --tmux --tmux-session "$TEST_SESSION" 2>/dev/null; then
  fail "missing --lane should exit non-zero"
fi
pass "missing required args detected before tmux launch"

echo ""
echo "All --tmux structural tests passed."
