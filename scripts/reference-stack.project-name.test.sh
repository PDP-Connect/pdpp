#!/usr/bin/env bash
# Copyright The PDP-Connect Contributors
# SPDX-License-Identifier: Apache-2.0

#
# Tests for the Compose project-name default and the paired-identity guard
# in scripts/reference-stack.sh
#
# Regression coverage for a real incident: running the canonical script bare
# from a clean deployment worktree whose directory basename was NOT "pdpp"
# (e.g. `pdpp-deploy-56-0729`) let Compose derive its project name from that
# basename instead of the intended live deployment. That silently started a
# second, parallel stack (its own network/volumes/containers) before failing
# on a host port collision, rather than converging the one real deployment.
#
# A follow-up review found that fixing only the Compose project name is
# unsafe on its own: neko-surface-allocator-server.ts's
# #isOwnedByThisDeployment decides container ownership purely from
# PDPP_NEKO_DEPLOYMENT_ID, which docker-compose.neko.yml only defaults from
# COMPOSE_PROJECT_NAME when PDPP_NEKO_DEPLOYMENT_ID is unset in BOTH the
# shell env and --env-file .env.docker. A real .env.docker (copied from
# .env.docker.example) persists PDPP_NEKO_DEPLOYMENT_ID=pdpp, so exporting
# only COMPOSE_PROJECT_NAME=review-override would render a split identity —
# Compose project "review-override" with deployment_id "pdpp" — letting that
# "isolated" project's allocator enumerate and mutate the real deployment's
# containers. The script now fails closed unless an override pairs
# COMPOSE_PROJECT_NAME with an EXPLICIT, EQUAL PDPP_NEKO_DEPLOYMENT_ID.
#
# A second follow-up review found that branching the pairing check on
# "is the project non-canonical" left the canonical "pdpp" path completely
# unvalidated: an inherited shell PDPP_NEKO_DEPLOYMENT_ID=foreign-deployment
# (leftover from another session) or a foreign value persisted only in
# .env.docker would both reach Compose unrejected under
# COMPOSE_PROJECT_NAME=pdpp, letting the canonical allocator legacy-adopt a
# different deployment's containers. The guard now enforces the SAME
# equality invariant unconditionally: for canonical "pdpp" it rejects an
# inherited mismatched shell value outright, and force-exports
# PDPP_NEKO_DEPLOYMENT_ID=pdpp so it deterministically overrides any stale
# .env.docker value (Compose's shell-env-beats-env-file precedence for
# ${VAR} interpolation, verified empirically).
#
# These tests prove, for every canonical subcommand (up --no-build, verify,
# ps, logs) and an arbitrary worktree basename:
#
#   1. no COMPOSE_PROJECT_NAME/PDPP_NEKO_DEPLOYMENT_ID set -> resolves to
#      project "pdpp" AND effective deployment id "pdpp" (both asserted,
#      not just the project name)
#   2. canonical project, but the shell already has an INHERITED, MISMATCHED
#      PDPP_NEKO_DEPLOYMENT_ID -> fails closed before reaching docker
#   3. canonical project, .env.docker persists a FOREIGN PDPP_NEKO_DEPLOYMENT_ID
#      with no shell override -> the script's own force-export neutralizes
#      it; a controlled, non-mutating `docker compose config` render proves
#      the value Compose actually interpolates is "pdpp", not the foreign one
#   4. COMPOSE_PROJECT_NAME overridden WITHOUT PDPP_NEKO_DEPLOYMENT_ID set at
#      all -> fails closed before reaching docker (the split-identity risk)
#   5. COMPOSE_PROJECT_NAME overridden with a MISMATCHED PDPP_NEKO_DEPLOYMENT_ID
#      -> fails closed before reaching docker
#   6. COMPOSE_PROJECT_NAME overridden WITH a matching PDPP_NEKO_DEPLOYMENT_ID
#      -> proceeds, and BOTH rendered values equal the intended override
#      (the documented pattern docker-neko-network-migration-smoke.sh /
#      docker-neko-network-durability-smoke.sh already use)
#   7. two runs from differently-named worktrees with no override both
#      resolve to the SAME project name ("pdpp") -> no parallel
#      project/volume/network identity is possible by omission
#
# The real script is copied into a throwaway git repo under an arbitrary,
# non-"pdpp" directory name so argument dispatch and the default wiring are
# exercised end-to-end. A `docker` stub on PATH intercepts every `compose`
# invocation and records the resolved `-p <project>` argument plus the
# PDPP_NEKO_DEPLOYMENT_ID the script exported into its own environment,
# instead of touching real Docker. Test 3 additionally invokes the REAL
# `docker compose ... config` (non-mutating render only — no daemon
# resource is created) to prove the effective interpolated value, matching
# the independent gate's own reproduction methodology.
#
# Run: bash scripts/reference-stack.project-name.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE_SCRIPT="$SCRIPT_DIR/reference-stack.sh"

pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*" >&2; FAILURES=$((FAILURES + 1)); }

FAILURES=0

# ---- per-test fixture: a fresh throwaway repo, under a caller-chosen ------
# ---- (arbitrary, non-"pdpp") basename, with the script installed ---------
#
# env_docker_deployment_id (optional 2nd arg): when non-empty, seeds
# .env.docker with PDPP_NEKO_DEPLOYMENT_ID=<value> — simulating an operator's
# real .env.docker (copied from .env.docker.example, which persists a
# literal default) carrying a foreign value. Defaults to unset (a plain
# placeholder-only .env.docker), matching prior fixture behavior.

make_fixture() {
  local basename="$1" env_docker_deployment_id="${2:-}"
  local parent project_dir
  parent="$(mktemp -d)"
  project_dir="$parent/$basename"
  mkdir -p "$project_dir"
  (
    cd "$project_dir"
    git init -q
    git config user.email test@example.com
    git config user.name test
    mkdir -p scripts
    cp "$SOURCE_SCRIPT" scripts/reference-stack.sh
    printf 'PDPP_PLACEHOLDER=1\n' > .env.docker
    if [[ -n "$env_docker_deployment_id" ]]; then
      printf 'PDPP_NEKO_DEPLOYMENT_ID=%s\n' "$env_docker_deployment_id" >> .env.docker
    fi
    git add scripts/reference-stack.sh .env.docker
    git commit -qm init -q

    # docker stub: for any `compose ... -p <name> ...` invocation, record the
    # project name argument, and the deployment id the script exported into
    # its own environment, to files — then exit non-zero so the run stops at
    # the first compose call rather than trying to reach a real stack.
    mkdir -p stub-bin
    cat > stub-bin/docker <<'STUB'
#!/usr/bin/env bash
if [[ "$1" == "network" && "$2" == "inspect" ]]; then
  [[ -f .pdpp-test-network-created ]]
  exit $?
fi
if [[ "$1" == "network" && "$2" == "create" ]]; then
  : > .pdpp-test-network-created
  exit 0
fi
if [[ "$1" == "compose" ]]; then
  args=("$@")
  for ((i = 0; i < ${#args[@]}; i++)); do
    if [[ "${args[$i]}" == "-p" ]]; then
      printf '%s' "${args[$((i + 1))]}" > "$PDPP_TEST_PROJECT_NAME_FILE"
      break
    fi
  done
  printf '%s' "${PDPP_NEKO_DEPLOYMENT_ID:-}" > "$PDPP_TEST_DEPLOYMENT_ID_FILE"
fi
echo "DOCKER_STUB_REACHED $*"
exit 97
STUB
    chmod +x stub-bin/docker
  )
  echo "$project_dir"
}

# Runs the installed script with the docker stub first on PATH, from inside
# the fixture directory (so `cd` picks up its basename). Captures:
#   PROJECT_NAME_SEEN     - the `-p <name>` argument the stub observed
#   DEPLOYMENT_ID_SEEN    - PDPP_NEKO_DEPLOYMENT_ID as seen by the stub process
#   RUN_EXIT_CODE         - the script's own exit code
#   RUN_OUTPUT             - combined stdout+stderr
#
# project_override / deployment_id_override: empty string means "leave
# unset". Passed explicitly (never via a nested subshell export) so captured
# globals survive under `set -u`.
run_stack() {
  local dir="$1" project_override="$2" deployment_id_override="$3"; shift 3
  local project_file deployment_file
  project_file="$(mktemp)"
  deployment_file="$(mktemp)"

  local -a env_args=()
  if [[ -n "$project_override" ]]; then
    env_args+=("COMPOSE_PROJECT_NAME=$project_override")
  fi
  if [[ -n "$deployment_id_override" ]]; then
    env_args+=("PDPP_NEKO_DEPLOYMENT_ID=$deployment_id_override")
  fi

  RUN_OUTPUT="$(cd "$dir" && PATH="$dir/stub-bin:$PATH" \
    PDPP_TEST_PROJECT_NAME_FILE="$project_file" \
    PDPP_TEST_DEPLOYMENT_ID_FILE="$deployment_file" \
    env -u COMPOSE_PROJECT_NAME -u PDPP_NEKO_DEPLOYMENT_ID "${env_args[@]}" \
    bash scripts/reference-stack.sh "$@" 2>&1)" && RUN_EXIT_CODE=0 || RUN_EXIT_CODE=$?

  PROJECT_NAME_SEEN="$(cat "$project_file" 2>/dev/null || true)"
  DEPLOYMENT_ID_SEEN="$(cat "$deployment_file" 2>/dev/null || true)"
  rm -f "$project_file" "$deployment_file"
}

ARBITRARY_BASENAMES=(
  "pdpp-deploy-56-0729"
  "checkout-xyz"
  "totally-unrelated-name"
)

# ---- test 1: arbitrary worktree basenames all resolve to "pdpp" -----------
# (no COMPOSE_PROJECT_NAME/PDPP_NEKO_DEPLOYMENT_ID set), across every
# canonical subcommand. Asserts BOTH the project name AND the effective
# deployment id, not just the project name — the gap the second review
# found in the prior version of this test.

for basename in "${ARBITRARY_BASENAMES[@]}"; do
  for sub in "up --no-build" "verify" "ps" "logs"; do
    DIR="$(make_fixture "$basename")"
    # shellcheck disable=SC2086
    run_stack "$DIR" "" "" $sub
    if [[ "$PROJECT_NAME_SEEN" == "pdpp" && "$DEPLOYMENT_ID_SEEN" == "pdpp" ]]; then
      pass "basename '$basename', '$sub': resolves to project 'pdpp' AND deployment id 'pdpp' (default), not the directory name"
    else
      fail "basename '$basename', '$sub': resolved project='$PROJECT_NAME_SEEN' deployment_id='$DEPLOYMENT_ID_SEEN', expected both 'pdpp' (output: $RUN_OUTPUT)"
    fi
    rm -rf "$(dirname "$DIR")"
  done
done

# ---- test 2: canonical project + INHERITED MISMATCHED shell deployment id -
# ---- fails closed before reaching docker -----------------------------------

for basename in "${ARBITRARY_BASENAMES[@]}"; do
  DIR="$(make_fixture "$basename")"
  run_stack "$DIR" "" "foreign-deployment" ps
  if [[ "$RUN_EXIT_CODE" -ne 0 && -z "$PROJECT_NAME_SEEN" && "$RUN_OUTPUT" == *"inherited from somewhere else"* ]]; then
    pass "basename '$basename': canonical project with inherited mismatched PDPP_NEKO_DEPLOYMENT_ID fails closed before docker"
  else
    fail "basename '$basename': inherited mismatch was not refused as expected (exit=$RUN_EXIT_CODE, project_seen='$PROJECT_NAME_SEEN') output: $RUN_OUTPUT"
  fi
  rm -rf "$(dirname "$DIR")"
done

# Same case but with COMPOSE_PROJECT_NAME explicitly set to "pdpp" (not just
# left at its default) — the gate's second poison case.
for basename in "${ARBITRARY_BASENAMES[@]}"; do
  DIR="$(make_fixture "$basename")"
  run_stack "$DIR" "pdpp" "foreign-deployment" ps
  if [[ "$RUN_EXIT_CODE" -ne 0 && -z "$PROJECT_NAME_SEEN" && "$RUN_OUTPUT" == *"inherited from somewhere else"* ]]; then
    pass "basename '$basename': EXPLICIT COMPOSE_PROJECT_NAME=pdpp with inherited mismatched PDPP_NEKO_DEPLOYMENT_ID fails closed before docker"
  else
    fail "basename '$basename': explicit-pdpp inherited mismatch was not refused as expected (exit=$RUN_EXIT_CODE, project_seen='$PROJECT_NAME_SEEN') output: $RUN_OUTPUT"
  fi
  rm -rf "$(dirname "$DIR")"
done

# ---- test 3: canonical project, .env.docker-sourced FOREIGN deployment id -
# ---- is neutralized by the script's own force-export -----------------------
# No shell PDPP_NEKO_DEPLOYMENT_ID is set (nothing to reject as "inherited"),
# but .env.docker itself carries a foreign value — simulating the exact
# .env.docker.example-derived-file shape the gate's own render used.

for basename in "${ARBITRARY_BASENAMES[@]}"; do
  DIR="$(make_fixture "$basename" "foreign-deployment")"
  run_stack "$DIR" "" "" ps
  if [[ "$RUN_EXIT_CODE" -eq 97 && "$PROJECT_NAME_SEEN" == "pdpp" && "$DEPLOYMENT_ID_SEEN" == "pdpp" ]]; then
    pass "basename '$basename': .env.docker-sourced foreign deployment id neutralized; script force-exports 'pdpp' before docker"
  else
    fail "basename '$basename': .env.docker foreign id was not neutralized (exit=$RUN_EXIT_CODE, project='$PROJECT_NAME_SEEN', deployment_id='$DEPLOYMENT_ID_SEEN') output: $RUN_OUTPUT"
  fi
  rm -rf "$(dirname "$DIR")"
done

# Controlled, non-mutating render with the REAL `docker compose ... config`
# (no daemon resource created) proving the value Compose actually
# interpolates for PDPP_NEKO_DEPLOYMENT_ID is "pdpp", not the foreign value
# .env.docker carries — matching the independent gate's own reproduction
# methodology, run once (not per-basename) since it needs the real compose
# files from the repo root, not the fixture's stub.
if command -v docker >/dev/null 2>&1 && [[ -f "$SCRIPT_DIR/../docker-compose.yml" ]]; then
  RENDER_DIR="$(mktemp -d)"
  cp "$SCRIPT_DIR/../docker-compose.yml" "$SCRIPT_DIR/../docker-compose.neko.yml" "$RENDER_DIR/" 2>/dev/null
  printf 'PDPP_NEKO_DEPLOYMENT_ID=foreign-deployment\n' > "$RENDER_DIR/.env.docker"
  RENDERED="$(cd "$RENDER_DIR" && env -u COMPOSE_PROJECT_NAME PDPP_NEKO_DEPLOYMENT_ID=pdpp \
    docker compose -p pdpp --env-file .env.docker -f docker-compose.yml -f docker-compose.neko.yml --profile neko-dynamic config 2>/dev/null \
    | grep -A0 'PDPP_NEKO_DEPLOYMENT_ID:' || true)"
  rm -rf "$RENDER_DIR"
  if [[ "$RENDERED" == *": pdpp"* ]]; then
    pass "controlled render: shell PDPP_NEKO_DEPLOYMENT_ID=pdpp overrides .env.docker's foreign value in the actual interpolated Compose config ($RENDERED)"
  else
    fail "controlled render: expected PDPP_NEKO_DEPLOYMENT_ID: pdpp in rendered config, got: '$RENDERED'"
  fi
else
  echo "SKIP: controlled render test (docker or repo compose files not available in this environment)"
fi

# ---- test 4: override WITHOUT a paired deployment id fails closed ---------

for basename in "${ARBITRARY_BASENAMES[@]}"; do
  DIR="$(make_fixture "$basename")"
  run_stack "$DIR" "pdpp-smoke-override" "" up --no-build
  if [[ "$RUN_EXIT_CODE" -ne 0 && -z "$PROJECT_NAME_SEEN" && "$RUN_OUTPUT" == *"PDPP_NEKO_DEPLOYMENT_ID"* ]]; then
    pass "basename '$basename': COMPOSE_PROJECT_NAME override with no PDPP_NEKO_DEPLOYMENT_ID fails closed before docker"
  else
    fail "basename '$basename': unpaired override was not refused as expected (exit=$RUN_EXIT_CODE, project_seen='$PROJECT_NAME_SEEN') output: $RUN_OUTPUT"
  fi
  rm -rf "$(dirname "$DIR")"
done

# ---- test 5: override WITH a MISMATCHED deployment id fails closed --------

for basename in "${ARBITRARY_BASENAMES[@]}"; do
  DIR="$(make_fixture "$basename")"
  run_stack "$DIR" "pdpp-smoke-override" "some-other-id" up --no-build
  if [[ "$RUN_EXIT_CODE" -ne 0 && -z "$PROJECT_NAME_SEEN" && "$RUN_OUTPUT" == *"must be identical"* ]]; then
    pass "basename '$basename': mismatched COMPOSE_PROJECT_NAME/PDPP_NEKO_DEPLOYMENT_ID pair fails closed before docker"
  else
    fail "basename '$basename': mismatched pair was not refused as expected (exit=$RUN_EXIT_CODE, project_seen='$PROJECT_NAME_SEEN') output: $RUN_OUTPUT"
  fi
  rm -rf "$(dirname "$DIR")"
done

# ---- test 6: override WITH a matching deployment id proceeds, and both ----
# ---- rendered values equal the intended override --------------------------

for basename in "${ARBITRARY_BASENAMES[@]}"; do
  DIR="$(make_fixture "$basename")"
  run_stack "$DIR" "pdpp-smoke-override" "pdpp-smoke-override" up --no-build
  if [[ "$PROJECT_NAME_SEEN" == "pdpp-smoke-override" && "$DEPLOYMENT_ID_SEEN" == "pdpp-smoke-override" ]]; then
    pass "basename '$basename': paired COMPOSE_PROJECT_NAME + PDPP_NEKO_DEPLOYMENT_ID override proceeds with identical rendered pair"
  else
    fail "basename '$basename': paired override did not render as expected (project='$PROJECT_NAME_SEEN', deployment_id='$DEPLOYMENT_ID_SEEN') output: $RUN_OUTPUT"
  fi
  rm -rf "$(dirname "$DIR")"
done

# ---- test 7: two differently-named worktrees never diverge without an -----
# ---- explicit override -> no possible parallel project/volume identity ----

SEEN_NAMES=()
for basename in "pdpp-deploy-56-0729" "some-other-checkout-name"; do
  DIR="$(make_fixture "$basename")"
  run_stack "$DIR" "" "" up --no-build
  SEEN_NAMES+=("$PROJECT_NAME_SEEN")
  rm -rf "$(dirname "$DIR")"
done

if [[ "${SEEN_NAMES[0]}" == "${SEEN_NAMES[1]}" && "${SEEN_NAMES[0]}" == "pdpp" ]]; then
  pass "two differently-named worktrees converge on the same project ('pdpp') -> no parallel stack possible by omission"
else
  fail "differently-named worktrees diverged: '${SEEN_NAMES[0]}' vs '${SEEN_NAMES[1]}'"
fi

# ---- summary ----------------------------------------------------------------

echo ""
if [[ "$FAILURES" -eq 0 ]]; then
  echo "All tests passed."
else
  echo "$FAILURES test(s) failed." >&2
  exit 1
fi
