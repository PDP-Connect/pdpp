#!/usr/bin/env bash
#
# Tests for the dirty-tree build guard in scripts/reference-stack.sh
#
# The guard refuses `up --build-app` / `up --build-all` when the working tree
# has uncommitted tracked changes, so a deployed image reflects a reviewed
# commit rather than local edits. These tests prove:
#
#   1. clean tree              -> build proceeds (reaches docker)
#   2. untracked/ignored only  -> build proceeds (scratch under tmp/ never blocks)
#   3. tracked unstaged change -> build refused before docker (exit 1)
#   4. staged change           -> build refused before docker (exit 1)
#   5. PDPP_ALLOW_DIRTY_REFERENCE_BUILD=1 -> dirty build proceeds, with warning
#   6. --no-build / verify / ps / logs    -> never invoke the guard
#   7. refusal output is a short `git status --short`, no diff/secret leak
#
# The real script is copied into a throwaway git repo so argument dispatch and
# guard wiring are exercised end-to-end. A `docker` stub on PATH stops the run
# at the first compose call with a distinctive sentinel, so "guard passed" is
# observable without standing up the actual stack.
#
# Run: bash scripts/reference-stack.dirty-guard.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE_SCRIPT="$SCRIPT_DIR/reference-stack.sh"

pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*" >&2; FAILURES=$((FAILURES + 1)); }

FAILURES=0

# A sentinel the docker stub prints on its first invocation. Seeing it in
# output means control reached docker, i.e. the guard let the build proceed.
DOCKER_SENTINEL="DOCKER_STUB_REACHED"

# ---- per-test fixture: a fresh throwaway repo with the script installed -----

make_fixture() {
  local dir
  dir="$(mktemp -d)"
  (
    cd "$dir"
    git init -q
    git config user.email test@example.com
    git config user.name test
    printf 'tmp/\n' > .gitignore
    mkdir -p scripts tmp
    cp "$SOURCE_SCRIPT" scripts/reference-stack.sh
    # require_env_file must pass so we exercise the guard, not env checks.
    printf 'PDPP_PLACEHOLDER=1\n' > .env.docker
    # A tracked file the dirty cases can mutate.
    printf 'orig\n' > tracked.txt
    git add .gitignore scripts/reference-stack.sh tracked.txt
    git commit -qm init
    # docker stub: print sentinel + args and exit non-zero so the run stops at
    # the first compose call rather than trying to build/verify a real stack.
    mkdir -p stub-bin
    cat > stub-bin/docker <<STUB
#!/usr/bin/env bash
echo "$DOCKER_SENTINEL \$*"
exit 97
STUB
    chmod +x stub-bin/docker
  )
  echo "$dir"
}

# Run the installed script with the docker stub first on PATH. Captures combined
# output and exit code into globals OUT and CODE.
run_stack() {
  local dir="$1"; shift
  OUT="$(cd "$dir" && PATH="$dir/stub-bin:$PATH" bash scripts/reference-stack.sh "$@" 2>&1)" && CODE=0 || CODE=$?
}

# ---- test 1: clean tree builds (reaches docker) ----------------------------

DIR="$(make_fixture)"
run_stack "$DIR" up --build-app
if [[ "$OUT" == *"$DOCKER_SENTINEL"* ]]; then
  pass "clean tree: build proceeds to docker"
else
  fail "clean tree: did not reach docker (code=$CODE) output: $OUT"
fi
rm -rf "$DIR"

# ---- test 2: untracked + ignored-only does not block -----------------------

DIR="$(make_fixture)"
(cd "$DIR" && printf 'scratch\n' > tmp/scratch.txt && printf 'new\n' > untracked.txt)
run_stack "$DIR" up --build-all
if [[ "$OUT" == *"$DOCKER_SENTINEL"* ]]; then
  pass "untracked/ignored only: build proceeds (tmp/ scratch ignored)"
else
  fail "untracked/ignored only: was blocked (code=$CODE) output: $OUT"
fi
rm -rf "$DIR"

# ---- test 3: tracked unstaged change is refused before docker --------------

DIR="$(make_fixture)"
(cd "$DIR" && printf 'edited\n' >> tracked.txt)
run_stack "$DIR" up --build-app
if [[ "$CODE" -eq 1 && "$OUT" != *"$DOCKER_SENTINEL"* && "$OUT" == *"refusing to build"* ]]; then
  pass "tracked unstaged change: refused before docker (exit 1)"
else
  fail "tracked unstaged change: not refused as expected (code=$CODE) output: $OUT"
fi
rm -rf "$DIR"

# ---- test 4: staged change is refused before docker ------------------------

DIR="$(make_fixture)"
(cd "$DIR" && printf 'edited\n' >> tracked.txt && git add tracked.txt)
run_stack "$DIR" up --build-all
if [[ "$CODE" -eq 1 && "$OUT" != *"$DOCKER_SENTINEL"* && "$OUT" == *"refusing to build"* ]]; then
  pass "staged change: refused before docker (exit 1)"
else
  fail "staged change: not refused as expected (code=$CODE) output: $OUT"
fi
rm -rf "$DIR"

# ---- test 5: override env var allows the dirty build, with a warning --------

DIR="$(make_fixture)"
(cd "$DIR" && printf 'edited\n' >> tracked.txt)
OUT="$(cd "$DIR" && PATH="$DIR/stub-bin:$PATH" PDPP_ALLOW_DIRTY_REFERENCE_BUILD=1 \
  bash scripts/reference-stack.sh up --build-app 2>&1)" && CODE=0 || CODE=$?
if [[ "$OUT" == *"$DOCKER_SENTINEL"* && "$OUT" == *"WARNING"* && "$OUT" == *"PDPP_ALLOW_DIRTY_REFERENCE_BUILD=1"* ]]; then
  pass "override: dirty build proceeds with explicit warning"
else
  fail "override: did not proceed-with-warning as expected (code=$CODE) output: $OUT"
fi
rm -rf "$DIR"

# ---- test 6: non-build commands never invoke the guard ---------------------
# Even with a dirty tracked tree, --no-build/verify/ps/logs must not be blocked
# by cleanliness. They will still hit the docker stub (and exit non-zero from
# it), but must NOT print the guard refusal.

for sub in "up --no-build" "verify" "ps" "logs"; do
  DIR="$(make_fixture)"
  (cd "$DIR" && printf 'edited\n' >> tracked.txt)
  # shellcheck disable=SC2086
  run_stack "$DIR" $sub
  if [[ "$OUT" != *"refusing to build"* ]]; then
    pass "non-build '$sub': cleanliness not required"
  else
    fail "non-build '$sub': unexpectedly blocked by guard. output: $OUT"
  fi
  rm -rf "$DIR"
done

# ---- test 7: refusal output is short status only, no diff content -----------

DIR="$(make_fixture)"
(cd "$DIR" && printf 'a-secret-looking-line\n' >> tracked.txt)
run_stack "$DIR" up --build-app
# The short status names the file but must not echo the changed line content.
if [[ "$OUT" == *"tracked.txt"* && "$OUT" != *"a-secret-looking-line"* ]]; then
  pass "refusal output: short status only, no diff/line content leaked"
else
  fail "refusal output: leaked content or missing status. output: $OUT"
fi
rm -rf "$DIR"

# ---- summary ----------------------------------------------------------------

echo ""
if [[ "$FAILURES" -eq 0 ]]; then
  echo "All tests passed."
else
  echo "$FAILURES test(s) failed." >&2
  exit 1
fi
