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
USAGE
}

require_env_file() {
  [[ -f .env.docker ]] || fail ".env.docker is missing; copy .env.docker.example first"
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
  local env_output managed mode cap allocator base_url cdp_url static_profile
  env_output="$("${COMPOSE[@]}" exec -T reference sh -lc 'printf "%s\n" \
    "managed=${PDPP_NEKO_MANAGED_CONNECTORS:-}" \
    "mode=${PDPP_NEKO_SURFACE_MODE:-}" \
    "cap=${PDPP_NEKO_SURFACE_CAP:-}" \
    "allocator=${PDPP_NEKO_ALLOCATOR_URL:-}" \
    "base=${PDPP_NEKO_BASE_URL:-}" \
    "cdp=${PDPP_NEKO_CDP_HTTP_URL:-}" \
    "static_profile=${PDPP_NEKO_STATIC_PROFILE_KEY:-}"')"

  managed="$(printf '%s\n' "$env_output" | sed -n 's/^managed=//p')"
  mode="$(printf '%s\n' "$env_output" | sed -n 's/^mode=//p')"
  cap="$(printf '%s\n' "$env_output" | sed -n 's/^cap=//p')"
  allocator="$(printf '%s\n' "$env_output" | sed -n 's/^allocator=//p')"
  base_url="$(printf '%s\n' "$env_output" | sed -n 's/^base=//p')"
  cdp_url="$(printf '%s\n' "$env_output" | sed -n 's/^cdp=//p')"
  static_profile="$(printf '%s\n' "$env_output" | sed -n 's/^static_profile=//p')"

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
        inject_revision
        "${COMPOSE[@]}" build reference web neko-allocator
        "${COMPOSE[@]}" up -d --no-build "${SERVICES[@]}"
        ;;
      --build-all)
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
