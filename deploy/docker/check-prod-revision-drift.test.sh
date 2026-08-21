#!/usr/bin/env bash
# Copyright The PDP-Connect Contributors
# SPDX-License-Identifier: Apache-2.0
#
# Tests for deploy/docker/check-prod-revision-drift.sh
#
# A `docker` stub on PATH answers `inspect` for fake container names with
# canned Config.Env output, so this never touches real containers. A
# throwaway git repo stands in for the pdpp checkout so origin/main and
# commit dates are controlled, not whatever this machine's history is.
#
# Run: bash deploy/docker/check-prod-revision-drift.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET_SCRIPT="$SCRIPT_DIR/check-prod-revision-drift.sh"

pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*" >&2; FAILURES=$((FAILURES + 1)); }

FAILURES=0

WORK_DIR="$(mktemp -d)"
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

REPO_DIR="$WORK_DIR/repo"
mkdir -p "$REPO_DIR"
git -C "$REPO_DIR" init --quiet --initial-branch=main
git -C "$REPO_DIR" config user.email "test@example.com"
git -C "$REPO_DIR" config user.name "Test"

# origin is just another local path here; git treats it identically.
ORIGIN_DIR="$WORK_DIR/origin.git"
git init --quiet --bare "$ORIGIN_DIR"
git -C "$REPO_DIR" remote add origin "$ORIGIN_DIR"

commit_at() {
  local epoch="$1" msg="$2"
  GIT_AUTHOR_DATE="@$epoch" GIT_COMMITTER_DATE="@$epoch" \
    git -C "$REPO_DIR" commit --quiet --allow-empty -m "$msg"
}

NOW=1755730000 # fixed epoch so "days behind" is deterministic

commit_at "$((NOW - 20*86400))" "c1 (old)"
OLD_SHA="$(git -C "$REPO_DIR" rev-parse HEAD)"
commit_at "$((NOW - 1*86400))" "c2 (recent, on origin)"
ON_ORIGIN_RECENT_SHA="$(git -C "$REPO_DIR" rev-parse HEAD)"

commit_at "$NOW" "c3 (main head, ahead of the deployed revision)"
git -C "$REPO_DIR" push --quiet origin main

# A commit that exists in the repo's object store but was never pushed —
# stands in for "built from a local/unpushed ref".
git -C "$REPO_DIR" checkout --quiet -b unpushed-branch "$OLD_SHA"
commit_at "$((NOW - 15*86400))" "unpushed work"
UNPUSHED_SHA="$(git -C "$REPO_DIR" rev-parse HEAD)"
git -C "$REPO_DIR" checkout --quiet main

STUB_BIN="$WORK_DIR/bin"
mkdir -p "$STUB_BIN"

write_docker_stub() {
  local revision_var="$1"
  cat > "$STUB_BIN/docker" <<STUB
#!/usr/bin/env bash
if [[ "\$1" == "inspect" ]]; then
  container="\$2"
  if [[ "\$container" == "missing-container" ]]; then
    exit 1
  fi
  printf 'PDPP_REFERENCE_REVISION=%s\n' "$revision_var"
  exit 0
fi
exit 1
STUB
  chmod +x "$STUB_BIN/docker"
}

run_check() {
  local container="$1"
  shift
  env "$@" \
    PATH="$STUB_BIN:$PATH" \
    PDPP_DRIFT_REPO_DIR="$REPO_DIR" \
    PDPP_DRIFT_REMOTE="origin" \
    PDPP_DRIFT_MAIN_BRANCH="main" \
    bash "$TARGET_SCRIPT" "$container"
}

# 1. revision literally "unknown" -> RULE 1 VIOLATION, exit 1
write_docker_stub "unknown"
if OUT=$(run_check "fake-container" 2>&1); then
  fail "unknown revision should exit nonzero. Output: $OUT"
else
  CODE=$?
  if [[ "$CODE" == "1" ]] && echo "$OUT" | grep -q "RULE 1 VIOLATION"; then
    pass "unknown revision -> RULE 1 VIOLATION, exit 1"
  else
    fail "unknown revision: wrong exit code ($CODE) or message: $OUT"
  fi
fi

# 2. revision string that isn't a commit at all (e.g. a literal branch name
#    like "drain") -> RULE 1 VIOLATION, exit 1
write_docker_stub "drain"
if OUT=$(run_check "fake-container" 2>&1); then
  fail "non-commit revision should exit nonzero. Output: $OUT"
else
  CODE=$?
  if [[ "$CODE" == "1" ]] && echo "$OUT" | grep -q "RULE 1 VIOLATION"; then
    pass "non-commit revision string -> RULE 1 VIOLATION, exit 1"
  else
    fail "non-commit revision: wrong exit code ($CODE) or message: $OUT"
  fi
fi

# 3. revision resolves locally but was never pushed to origin -> RULE 1 VIOLATION
write_docker_stub "$UNPUSHED_SHA"
if OUT=$(run_check "fake-container" 2>&1); then
  fail "unpushed revision should exit nonzero. Output: $OUT"
else
  CODE=$?
  if [[ "$CODE" == "1" ]] && echo "$OUT" | grep -q "RULE 1 VIOLATION"; then
    pass "unpushed revision -> RULE 1 VIOLATION, exit 1"
  else
    fail "unpushed revision: wrong exit code ($CODE) or message: $OUT"
  fi
fi

# 4. revision on origin, recent, within threshold -> exit 0
write_docker_stub "$ON_ORIGIN_RECENT_SHA"
if OUT=$(run_check "fake-container" PDPP_DRIFT_THRESHOLD_DAYS=7 2>&1); then
  pass "recent on-origin revision within threshold -> exit 0"
else
  fail "recent on-origin revision should exit 0. Output: $OUT"
fi

# 5. revision on origin but past the drift threshold -> DRIFT, exit 1
write_docker_stub "$ON_ORIGIN_RECENT_SHA"
if OUT=$(run_check "fake-container" PDPP_DRIFT_THRESHOLD_DAYS=0 2>&1); then
  fail "revision beyond threshold should exit nonzero. Output: $OUT"
else
  CODE=$?
  if [[ "$CODE" == "1" ]] && echo "$OUT" | grep -q "DRIFT:"; then
    pass "on-origin revision beyond threshold -> DRIFT, exit 1"
  else
    fail "drift-beyond-threshold: wrong exit code ($CODE) or message: $OUT"
  fi
fi

# 6. container not found -> config error, exit 2 (distinct from a drift finding)
write_docker_stub "irrelevant"
if OUT=$(run_check "missing-container" 2>&1); then
  fail "missing container should exit nonzero. Output: $OUT"
else
  CODE=$?
  if [[ "$CODE" == "2" ]]; then
    pass "missing container -> config error, exit 2"
  else
    fail "missing container: expected exit 2, got $CODE. Output: $OUT"
  fi
fi

echo
if (( FAILURES > 0 )); then
  echo "$FAILURES test(s) failed" >&2
  exit 1
fi
echo "All tests passed"
