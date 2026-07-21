#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE=(
  docker compose
  --env-file .env.docker
  -f docker-compose.yml
  -f docker-compose.neko.yml
  --profile neko-dynamic
)
SERVICES=(postgres neko neko-allocator reference web)

fail() {
  echo "reference-stack: $*" >&2
  exit 1
}

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
    ensure_dynamic_surface_network
    case "$mode" in
      --build-app)
        guard_clean_tree
        check_disk_headroom
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
        inject_revision
        "${COMPOSE[@]}" up -d --build "${SERVICES[@]}"
        ;;
      --no-build)
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
