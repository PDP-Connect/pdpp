#!/usr/bin/env bash
# Copyright The PDP-Connect Contributors
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail() {
  echo "reference-stack: $*" >&2
  exit 1
}

# Compose has no config-file way to pin a project name, so it derives one from
# the current directory's basename whenever COMPOSE_PROJECT_NAME is unset.
# Every canonical up/down/verify path MUST target the one configured
# deployment ("pdpp" — matching PDPP_NEKO_DEPLOYMENT_ID's own default and
# .env.docker.example's documented contract, see docker-compose.neko.yml)
# regardless of which worktree basename this script happens to run from.
# Without this default, running from a differently-named worktree (a fresh
# deploy checkout, a second clone) silently starts a second, parallel stack —
# new network, new volumes, new containers — instead of erroring immediately.
#
# A caller MAY still export COMPOSE_PROJECT_NAME to something else on
# purpose: that is the existing, documented escape hatch the smoke scripts
# use (docker-smoke.sh, docker-neko-dynamic-allocator-smoke.sh,
# docker-neko-network-migration-smoke.sh, railway-sqlite-restart-smoke.sh)
# for throwaway/parallel instances, so we only supply a default, never
# override an explicit value.
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-pdpp}"

# The Compose project name alone is NOT a safe ownership boundary for the
# dynamic n.eko allocator. neko-surface-allocator-server.ts's
# #isOwnedByThisDeployment treats any container whose deployment_id label
# equals this instance's PDPP_NEKO_DEPLOYMENT_ID as owned by it, checked
# BEFORE any Compose-project fallback — so the one invariant that actually
# matters is unconditional: the EFFECTIVE PDPP_NEKO_DEPLOYMENT_ID (the value
# Compose will actually interpolate, after --env-file .env.docker
# precedence) must equal COMPOSE_PROJECT_NAME, for the canonical "pdpp"
# project exactly as much as for any alternate. Branching this check on
# "is the project non-canonical" (an earlier version of this guard) leaves
# the canonical path unchecked: a stray inherited shell
# PDPP_NEKO_DEPLOYMENT_ID=foreign-deployment (leftover from another
# session), or a foreign value persisted in .env.docker itself (Compose's
# --env-file is a lower-priority fallback for ${VAR} interpolation, so an
# unset shell var lets a foreign .env.docker value reach the container
# unnoticed), would both sail through under COMPOSE_PROJECT_NAME=pdpp and
# let this "canonical" allocator legacy-adopt a different deployment's
# dynamic browser-surface containers.
#
# Two cases, one invariant:
#
#   canonical (COMPOSE_PROJECT_NAME == "pdpp", whether by default or by an
#   explicit `pdpp` export): PDPP_NEKO_DEPLOYMENT_ID must resolve to "pdpp"
#   too. An explicitly inherited MISMATCHED shell value is rejected outright
#   (it can only mean stale state from another deployment's session) rather
#   than silently overridden — silently correcting it would hide exactly the
#   kind of leftover-env mistake this guard exists to catch. Otherwise
#   (unset, or already "pdpp") we force-export PDPP_NEKO_DEPLOYMENT_ID=pdpp
#   ourselves: Compose's shell-env-beats-env-file precedence for ${VAR}
#   interpolation (verified empirically: an exported shell value always wins
#   over the same var's --env-file value) makes this the one deterministic
#   way to neutralize a foreign value persisted in .env.docker, without
#   requiring every operator to hand-edit that file.
#
#   alternate (COMPOSE_PROJECT_NAME explicitly overridden away from "pdpp"):
#   unchanged from the prior revision — PDPP_NEKO_DEPLOYMENT_ID must be
#   explicitly exported and exactly equal to COMPOSE_PROJECT_NAME. This is
#   the existing, documented escape hatch the smoke scripts use
#   (docker-neko-network-migration-smoke.sh, docker-neko-network-durability-smoke.sh
#   both export a matching generated value to each variable).
#
# Either branch fails closed before any Compose invocation is built below.
CANONICAL_COMPOSE_PROJECT_NAME="pdpp"
if [[ "$COMPOSE_PROJECT_NAME" == "$CANONICAL_COMPOSE_PROJECT_NAME" ]]; then
  if [[ -n "${PDPP_NEKO_DEPLOYMENT_ID:-}" && "$PDPP_NEKO_DEPLOYMENT_ID" != "$CANONICAL_COMPOSE_PROJECT_NAME" ]]; then
    fail "COMPOSE_PROJECT_NAME is the canonical '$CANONICAL_COMPOSE_PROJECT_NAME'," \
      "but the shell already has PDPP_NEKO_DEPLOYMENT_ID='$PDPP_NEKO_DEPLOYMENT_ID'" \
      "inherited from somewhere else (another deployment's session, a" \
      "leftover export). That is a split identity: the allocator's" \
      "ownership check uses only the deployment id, so a foreign id here" \
      "would let this canonical deployment's allocator legacy-adopt a" \
      "different deployment's dynamic browser-surface containers. Unset" \
      "PDPP_NEKO_DEPLOYMENT_ID (or set it to '$CANONICAL_COMPOSE_PROJECT_NAME') before running the canonical stack."
  fi
  # Force the canonical value into the shell env so it deterministically
  # overrides any foreign value persisted in .env.docker via Compose's
  # shell-env-beats-env-file interpolation precedence — never leave this to
  # chance for the canonical path.
  export PDPP_NEKO_DEPLOYMENT_ID="$CANONICAL_COMPOSE_PROJECT_NAME"
else
  if [[ -z "${PDPP_NEKO_DEPLOYMENT_ID:-}" ]]; then
    fail "COMPOSE_PROJECT_NAME='$COMPOSE_PROJECT_NAME' overrides the canonical" \
      "project, but PDPP_NEKO_DEPLOYMENT_ID is not set. A mismatched or" \
      "missing deployment id lets the allocator legacy-adopt containers" \
      "from a different deployment. Export PDPP_NEKO_DEPLOYMENT_ID equal to" \
      "the exact same value as COMPOSE_PROJECT_NAME ('$COMPOSE_PROJECT_NAME')."
  fi
  if [[ "$PDPP_NEKO_DEPLOYMENT_ID" != "$COMPOSE_PROJECT_NAME" ]]; then
    fail "COMPOSE_PROJECT_NAME='$COMPOSE_PROJECT_NAME' and" \
      "PDPP_NEKO_DEPLOYMENT_ID='$PDPP_NEKO_DEPLOYMENT_ID' must be identical." \
      "A mismatched pair is a split identity: the allocator's ownership" \
      "check uses only the deployment id, so a distinct Compose project with" \
      "the wrong (e.g. inherited/default) deployment id can enumerate and" \
      "mutate a different deployment's browser-surface containers."
  fi
  export PDPP_NEKO_DEPLOYMENT_ID
fi

COMPOSE=(
  docker compose
  -p "$COMPOSE_PROJECT_NAME"
  --env-file .env.docker
  -f docker-compose.yml
  -f docker-compose.neko.yml
  --profile neko-dynamic
)
SERVICES=(postgres neko neko-allocator reference web)

usage() {
  cat <<'USAGE'
Usage:
  scripts/reference-stack.sh up [--build-app|--build-all|--no-build]
  scripts/reference-stack.sh verify
  scripts/reference-stack.sh ps
  scripts/reference-stack.sh logs [service]

Defaults:
  up --build-app

The stack always uses docker-compose.yml + docker-compose.neko.yml with the
neko-dynamic profile. That is the required shape for browser-backed connectors
that are configured through PDPP_NEKO_MANAGED_CONNECTORS.

up --build-app and up --build-all refuse to run when the working tree has
uncommitted tracked changes, so a deployed image reflects a reviewed commit.
Untracked/ignored scratch (e.g. tmp/) does not block. Set
PDPP_ALLOW_DIRTY_REFERENCE_BUILD=1 to build a dirty tree anyway.

Every command targets the Compose project "pdpp" by default, independent of
the worktree directory name, so this script always converges the one
canonical deployment instead of silently starting a parallel stack.

COMPOSE_PROJECT_NAME and PDPP_NEKO_DEPLOYMENT_ID are one identity, not two
independent knobs: the allocator's ownership check trusts
PDPP_NEKO_DEPLOYMENT_ID alone, so any mismatch between the two lets one
project's allocator adopt and mutate a DIFFERENT deployment's containers.
This script enforces equality unconditionally, before any Compose call:

  - Canonical (COMPOSE_PROJECT_NAME left at "pdpp"): PDPP_NEKO_DEPLOYMENT_ID
    is force-set to "pdpp" too, overriding any stale value a .env.docker
    file might carry. An inherited shell PDPP_NEKO_DEPLOYMENT_ID that
    already disagrees with "pdpp" is rejected outright rather than
    silently corrected.
  - Alternate (COMPOSE_PROJECT_NAME exported to something else on purpose,
    e.g. a throwaway/smoke instance): PDPP_NEKO_DEPLOYMENT_ID must ALSO be
    explicitly exported, set to the EXACT SAME value. Setting only
    COMPOSE_PROJECT_NAME fails closed with an explicit error instead of
    silently rendering a mismatched pair. See
    docker-neko-network-migration-smoke.sh / docker-neko-network-durability-smoke.sh
    for the pattern (both export a matching generated value to each variable).
USAGE
}

require_env_file() {
  [[ -f .env.docker ]] || fail ".env.docker is missing; copy .env.docker.example first"
}

# Dynamic n.eko surfaces attach to a network declared `external: true` in
# docker-compose.neko.yml (see neko-surface-allocator-server.ts's own
# `ensureNetworkExists`, which repeats this same idempotent create). Compose
# requires an externally-declared network to exist before it can attach any
# service to it, including on a cold start before the allocator container has
# run any code — hence a plain pre-step here in addition to the allocator's
# own startup check.
ensure_dynamic_surface_network() {
  local name="${PDPP_NEKO_DOCKER_NETWORK:-pdpp_neko_dynamic}"
  # inspect-then-create (like the allocator's own ensureNetworkExists) has a
  # race: if a concurrent creator (a parallel deploy invocation, the
  # allocator's own startup check) creates the network between our inspect
  # and our create, our create fails on a name conflict even though the
  # network now exists. Tolerate that failure and re-inspect to confirm the
  # network actually exists before treating it as a hard error — mirrors the
  # allocator's own create-then-tolerate-409-then-confirm idiom.
  if docker network inspect "$name" >/dev/null 2>&1; then
    return 0
  fi
  docker network create --driver bridge "$name" >/dev/null 2>&1 || true
  docker network inspect "$name" >/dev/null 2>&1 \
    || fail "could not create or confirm the dynamic surface network '$name'"
}

# Compute PDPP_REFERENCE_REVISION for build-time injection.
# Prefers any value already in the environment (e.g. set by a CI caller),
# then falls back to `git describe --tags --always --dirty`, then a bare
# short SHA. Exported so docker compose inherits it when expanding the
# ${PDPP_REFERENCE_REVISION:-unknown} build arg in docker-compose.yml.
inject_revision() {
  if [[ -z "${PDPP_REFERENCE_REVISION:-}" ]]; then
    PDPP_REFERENCE_REVISION="$(
      git describe --tags --always --dirty 2>/dev/null \
        || git rev-parse --short=12 HEAD 2>/dev/null \
        || echo 'unknown'
    )"
  fi
  export PDPP_REFERENCE_REVISION
  echo "reference-stack: revision=${PDPP_REFERENCE_REVISION}"
}

# Refuse to build images from a tracked-dirty working tree by default.
#
# The owner has previously deployed from a dirty `main` by accident, baking
# unreviewed tracked edits into a live image even though PDPP_REFERENCE_REVISION
# named a commit. Only `up --build-app` / `up --build-all` call this; --no-build,
# verify, ps, and logs never require cleanliness.
#
# "Dirty" means tracked unstaged or staged changes only. Untracked and ignored
# files (e.g. scratch under tmp/) do not block. Set
# PDPP_ALLOW_DIRTY_REFERENCE_BUILD=1 to override; we print an explicit warning
# and proceed (the revision will carry git describe's `-dirty` suffix).
guard_clean_tree() {
  # Not a git work tree (e.g. building from an exported tarball): nothing to
  # guard. Mirrors inject_revision's tolerance of an absent git context.
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 0

  if git diff --quiet && git diff --cached --quiet; then
    return 0
  fi

  if [[ "${PDPP_ALLOW_DIRTY_REFERENCE_BUILD:-}" == "1" ]]; then
    echo "reference-stack: WARNING: PDPP_ALLOW_DIRTY_REFERENCE_BUILD=1 — building uncommitted tracked changes into the image:" >&2
    git status --short --untracked-files=no >&2
    return 0
  fi

  echo "reference-stack: refusing to build: the working tree has uncommitted tracked changes." >&2
  echo "reference-stack: a deployed image must reflect a reviewed commit, not local edits." >&2
  git status --short --untracked-files=no >&2
  echo "reference-stack: commit/stash the changes, or set PDPP_ALLOW_DIRTY_REFERENCE_BUILD=1 to build them anyway." >&2
  exit 1
}

# Preflight disk headroom check.
#
# Fails when the filesystem hosting ROOT has < 2 GiB free (a Docker build or
# stack restart would almost certainly hit "No space left on device").
# Warns when < 5 GiB free (operator should prune before the next restart).
# Thresholds match the reference diagnostics module so dashboard and script
# agree on the boundary.
#
# Uses `df -k` (POSIX; available in BusyBox and macOS alike). The check runs
# on --build-app and --build-all only — not --no-build, verify, ps, or logs.
check_disk_headroom() {
  local free_kb
  # df -kP: -k for kilobytes, -P for POSIX output (prevents long device names
  # from wrapping the header line onto row 2, which would shift column 4 to row 3).
  free_kb="$(df -kP "${ROOT}" | awk 'NR==2 {print $4}')"
  if [[ -z "$free_kb" ]] || ! [[ "$free_kb" =~ ^[0-9]+$ ]]; then
    echo "reference-stack: WARNING: could not probe disk headroom on ${ROOT} — skipping check." >&2
    return 0
  fi

  local free_bytes=$(( free_kb * 1024 ))
  local warn_bytes=$(( 5 * 1024 * 1024 * 1024 ))   # 5 GiB
  local error_bytes=$(( 2 * 1024 * 1024 * 1024 ))   # 2 GiB

  if (( free_bytes < error_bytes )); then
    echo "reference-stack: ERROR: only $(( free_kb / 1024 / 1024 )) GiB free on ${ROOT}." >&2
    echo "reference-stack: A Docker build or stack restart is very likely to fail with 'No space left on device'." >&2
    echo "reference-stack: Run: docker builder prune" >&2
    echo "reference-stack: Or run: docker system prune" >&2
    echo "reference-stack: Inspect Docker volumes manually before removing any volume data." >&2
    exit 1
  fi

  if (( free_bytes < warn_bytes )); then
    echo "reference-stack: WARNING: only $(( free_kb / 1024 / 1024 )) GiB free on ${ROOT}." >&2
    echo "reference-stack: Consider running 'docker system prune' before restarting." >&2
  fi
}

service_container() {
  "${COMPOSE[@]}" ps -q "$1"
}

wait_healthy() {
  local service="$1"
  local timeout="${2:-90}"
  local started now container status
  started="$(date +%s)"
  while true; do
    container="$(service_container "$service" || true)"
    if [[ -n "$container" ]]; then
      status="$(docker inspect "$container" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>/dev/null || true)"
      case "$status" in
        healthy|running) return 0 ;;
      esac
    fi
    now="$(date +%s)"
    if (( now - started >= timeout )); then
      "${COMPOSE[@]}" ps >&2 || true
      "${COMPOSE[@]}" logs --tail=120 "$service" >&2 || true
      fail "timed out waiting for $service to become healthy/running"
    fi
    sleep 2
  done
}

verify_reference_env() {
  local env_output managed mode cap allocator base_url cdp_url static_profile rs_url rs_public_url
  env_output="$("${COMPOSE[@]}" exec -T reference sh -lc 'printf "%s\n" \
    "managed=${PDPP_NEKO_MANAGED_CONNECTORS:-}" \
    "mode=${PDPP_NEKO_SURFACE_MODE:-}" \
    "cap=${PDPP_NEKO_SURFACE_CAP:-}" \
    "allocator=${PDPP_NEKO_ALLOCATOR_URL:-}" \
    "base=${PDPP_NEKO_BASE_URL:-}" \
    "cdp=${PDPP_NEKO_CDP_HTTP_URL:-}" \
    "static_profile=${PDPP_NEKO_STATIC_PROFILE_KEY:-}" \
    "rs_url=${PDPP_RS_URL:-}" \
    "rs_public_url=${RS_PUBLIC_URL:-}"')"

  managed="$(printf '%s\n' "$env_output" | sed -n 's/^managed=//p')"
  mode="$(printf '%s\n' "$env_output" | sed -n 's/^mode=//p')"
  cap="$(printf '%s\n' "$env_output" | sed -n 's/^cap=//p')"
  allocator="$(printf '%s\n' "$env_output" | sed -n 's/^allocator=//p')"
  base_url="$(printf '%s\n' "$env_output" | sed -n 's/^base=//p')"
  cdp_url="$(printf '%s\n' "$env_output" | sed -n 's/^cdp=//p')"
  static_profile="$(printf '%s\n' "$env_output" | sed -n 's/^static_profile=//p')"
  rs_url="$(printf '%s\n' "$env_output" | sed -n 's/^rs_url=//p')"
  rs_public_url="$(printf '%s\n' "$env_output" | sed -n 's/^rs_public_url=//p')"

  [[ -n "$managed" ]] || fail "reference is missing PDPP_NEKO_MANAGED_CONNECTORS; did you omit docker-compose.neko.yml?"
  [[ "$managed" == *"https://registry.pdpp.org/connectors/chatgpt"* ]] \
    || fail "managed connector list does not include ChatGPT"
  [[ "$managed" == *"https://registry.pdpp.org/connectors/chase"* ]] \
    || fail "managed connector list does not include Chase"
  [[ "$managed" == *"https://registry.pdpp.org/connectors/usaa"* ]] \
    || fail "managed connector list does not include USAA"
  [[ "$managed" == *"https://registry.pdpp.org/connectors/amazon"* ]] \
    || fail "managed connector list does not include Amazon"
  [[ "$managed" == *"https://registry.pdpp.org/connectors/reddit"* ]] \
    || fail "managed connector list does not include Reddit"
  [[ "$mode" == "dynamic" ]] || fail "expected PDPP_NEKO_SURFACE_MODE=dynamic, got '${mode:-<empty>}'"
  [[ "$cap" =~ ^[1-9][0-9]*$ ]] || fail "PDPP_NEKO_SURFACE_CAP must be a positive integer, got '${cap:-<empty>}'"
  [[ -n "$allocator" ]] || fail "dynamic mode requires PDPP_NEKO_ALLOCATOR_URL"
  [[ -z "$base_url" ]] || fail "dynamic mode must leave PDPP_NEKO_BASE_URL empty"
  [[ -z "$cdp_url" ]] || fail "dynamic mode must leave PDPP_NEKO_CDP_HTTP_URL empty"
  [[ -z "$static_profile" ]] || fail "dynamic mode must leave PDPP_NEKO_STATIC_PROFILE_KEY empty"
  [[ -n "$rs_url" ]] || fail "reference is missing PDPP_RS_URL; hosted-MCP self-calls would hairpin through RS_PUBLIC_URL"
  [[ -z "$rs_public_url" || "$rs_url" != "$rs_public_url" ]] || fail "PDPP_RS_URL must be internal and distinct from RS_PUBLIC_URL"

  "${COMPOSE[@]}" exec -T reference node -e '
    const url = process.env.PDPP_NEKO_ALLOCATOR_URL;
    fetch(url).then(
      (response) => {
        console.log(`allocator reachable (${response.status})`);
      },
      (error) => {
        console.error(`allocator unreachable: ${error.message}`);
        process.exit(1);
      },
    );
  ' >/dev/null
}

verify() {
  require_env_file
  "${COMPOSE[@]}" config >/dev/null
  wait_healthy postgres 90
  wait_healthy neko 120
  wait_healthy neko-allocator 45
  wait_healthy reference 120
  wait_healthy web 90
  verify_reference_env
  echo "reference-stack: ok"
}

# Test-only escape hatch: a regression test sources this file (functions
# only) to exercise ensure_dynamic_surface_network against a fake `docker` on
# PATH, without triggering the real CLI dispatch below. Not read or used by
# normal invocation (`bash scripts/reference-stack.sh ...` always executes,
# never sources, so this branch never runs there).
if [[ "${PDPP_REFERENCE_STACK_TEST_SOURCE_ONLY:-}" == "1" ]]; then
  return 0 2>/dev/null || exit 0
fi

cmd="${1:-up}"
shift || true

case "$cmd" in
  up)
    require_env_file
    mode="--build-app"
    if [[ $# -gt 0 ]]; then
      mode="$1"
      shift
    fi
    [[ $# -eq 0 ]] || fail "unexpected extra arguments: $*"
    case "$mode" in
      --build-app)
        guard_clean_tree
        check_disk_headroom
        ensure_dynamic_surface_network
        inject_revision
        # The reference app depends on n.eko's container-local settle route.
        # Build/converge both in one deployment so a new app cannot be paired
        # with an old static n.eko image.
        "${COMPOSE[@]}" build reference web neko neko-allocator
        "${COMPOSE[@]}" up -d --no-build "${SERVICES[@]}"
        ;;
      --build-all)
        guard_clean_tree
        check_disk_headroom
        ensure_dynamic_surface_network
        inject_revision
        "${COMPOSE[@]}" up -d --build "${SERVICES[@]}"
        ;;
      --no-build)
        ensure_dynamic_surface_network
        "${COMPOSE[@]}" up -d --no-build "${SERVICES[@]}"
        ;;
      *)
        fail "unknown up mode '$mode'"
        ;;
    esac
    verify
    ;;
  verify)
    verify
    ;;
  ps)
    require_env_file
    "${COMPOSE[@]}" ps
    ;;
  logs)
    require_env_file
    if [[ $# -gt 0 ]]; then
      "${COMPOSE[@]}" logs --tail=180 "$@"
    else
      "${COMPOSE[@]}" logs --tail=180
    fi
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage >&2
    fail "unknown command '$cmd'"
    ;;
esac
