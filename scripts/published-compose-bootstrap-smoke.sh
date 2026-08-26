#!/usr/bin/env bash
# Copyright The PDP-Connect Contributors
# SPDX-License-Identifier: Apache-2.0

# Boots the published split images from an untouched copy of the documented
# environment. Every writable mount is an isolated bind directory: cleanup
# removes only this run's containers/network and temporary host files, never
# Docker volumes (including volumes owned by another Compose project).
set -euo pipefail

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$REPOSITORY_ROOT/docker-compose.yml"
ENV_TEMPLATE="$REPOSITORY_ROOT/.env.docker.example"
SMOKE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/pdpp-published-compose.XXXXXX")"
ENV_FILE="$SMOKE_ROOT/.env.docker"
OVERRIDE_FILE="$SMOKE_ROOT/compose.override.yml"
PROJECT_NAME="pdpp-published-bootstrap-${UID:-0}-$(date +%s)-$$"
COMPOSE=(docker compose --project-name "$PROJECT_NAME" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" -f "$OVERRIDE_FILE")

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "published-compose-bootstrap-smoke: required command not found: $1" >&2
    exit 127
  }
}

cleanup() {
  local exit_code=$?
  trap - EXIT
  if ! "${COMPOSE[@]}" down --remove-orphans >/dev/null 2>&1; then
    echo "published-compose-bootstrap-smoke: cleanup failed for $PROJECT_NAME" >&2
    exit_code=1
  fi
  # The containers write into the bind mounts as root (postgres data, the
  # downloaded embedding model), so a plain user-side `rm -rf` cannot remove
  # them and would otherwise report failure on an otherwise passing run.
  # Delete them from inside a container, which owns the same uid, then sweep
  # whatever is left. Only this run's temporary host directory is touched --
  # never a Docker volume.
  docker run --rm \
    --volume "$SMOKE_ROOT:/smoke-root" \
    "${PDPP_POSTGRES_IMAGE:-pgvector/pgvector:pg16}" \
    sh -c 'rm -rf /smoke-root/..?* /smoke-root/.[!.]* /smoke-root/*' >/dev/null 2>&1 || true
  rm -rf "$SMOKE_ROOT" 2>/dev/null || true
  if [[ -e "$SMOKE_ROOT" ]]; then
    echo "published-compose-bootstrap-smoke: could not fully remove $SMOKE_ROOT" >&2
  fi
  exit "$exit_code"
}

wait_for_url() {
  local url="$1"
  local label="$2"
  local timeout_seconds="$3"
  local started_at
  started_at="$(date +%s)"

  while true; do
    if curl --fail --silent --show-error "$url" >/dev/null; then
      return 0
    fi
    if (( $(date +%s) - started_at >= timeout_seconds )); then
      echo "published-compose-bootstrap-smoke: timed out waiting for $label at $url" >&2
      "${COMPOSE[@]}" logs --tail=160 >&2 || true
      return 1
    fi
    sleep 2
  done
}

allocate_ports() {
  node --input-type=module -e '
    import { createServer } from "node:net";

    const servers = await Promise.all(
      Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve(server));
      }))
    );
    console.log(servers.map((server) => server.address().port).join(" "));
    await Promise.all(servers.map((server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
  '
}

require_command docker
require_command curl
require_command node
[[ -f "$COMPOSE_FILE" && -f "$ENV_TEMPLATE" ]] || {
  echo "published-compose-bootstrap-smoke: repository Compose inputs are missing" >&2
  exit 1
}

trap cleanup EXIT

cp "$ENV_TEMPLATE" "$ENV_FILE"
# Run the documented step 2 exactly as selfhost-quickstart.md tells a new user
# to. Without it PDPP_OWNER_PASSWORD stays empty and the reference container
# refuses to boot ("Refusing to start: ... PDPP_OWNER_PASSWORD is unset"), so a
# smoke test that skips this step can never pass and never guards the real path.
# `--write` patches only empty values and resolves `.env.docker` relative to the
# working directory, so run it from the smoke root: the isolated copy is patched
# and the operator's real .env.docker is never touched.
(cd "$SMOKE_ROOT" && bash "$REPOSITORY_ROOT/scripts/generate-secrets.sh" --write >/dev/null)
for required_secret in PDPP_OWNER_PASSWORD PDPP_CREDENTIAL_ENCRYPTION_KEY; do
  if ! grep -qE "^${required_secret}=.+" "$ENV_FILE"; then
    echo "published-compose-bootstrap-smoke: $required_secret was not populated by generate-secrets.sh" >&2
    exit 1
  fi
done
mkdir -p \
  "$SMOKE_ROOT/reference-data" \
  "$SMOKE_ROOT/reference-transformers" \
  "$SMOKE_ROOT/reference-home" \
  "$SMOKE_ROOT/postgres-data" \
  "$SMOKE_ROOT/imports/claude" \
  "$SMOKE_ROOT/imports/codex" \
  "$SMOKE_ROOT/tools/slackdump"

requested_ports="${PDPP_PUBLISHED_SMOKE_WEB_PORT:-} ${PDPP_PUBLISHED_SMOKE_AS_PORT:-} ${PDPP_PUBLISHED_SMOKE_RS_PORT:-} ${PDPP_PUBLISHED_SMOKE_POSTGRES_PORT:-}"
if [[ "$requested_ports" == "   " ]]; then
  ports="$(allocate_ports)" || {
    echo "published-compose-bootstrap-smoke: could not allocate isolated host ports" >&2
    exit 1
  }
elif [[ "$requested_ports" == *"  "* || "$requested_ports" == " "* || "$requested_ports" == *" " ]]; then
  echo "published-compose-bootstrap-smoke: set all four PDPP_PUBLISHED_SMOKE_*_PORT overrides or none" >&2
  exit 1
else
  ports="$requested_ports"
fi
read -r web_port as_port rs_port postgres_port <<<"$ports"
if [[ -z "$web_port" || -z "$as_port" || -z "$rs_port" || -z "$postgres_port" ]]; then
  echo "published-compose-bootstrap-smoke: port allocator returned an incomplete result" >&2
  exit 1
fi
export PDPP_WEB_PORT="$web_port"
export PDPP_REFERENCE_AS_PORT="$as_port"
export PDPP_REFERENCE_RS_PORT="$rs_port"
export PDPP_POSTGRES_PORT="$postgres_port"
export PDPP_REFERENCE_ORIGIN="http://127.0.0.1:$web_port"

printf '%s\n' \
  'services:' \
  '  reference:' \
  '    volumes:' \
  '      - type: bind' \
  "        source: $SMOKE_ROOT/reference-data" \
  '        target: /var/lib/pdpp' \
  '      - type: bind' \
  "        source: $SMOKE_ROOT/reference-transformers" \
  '        target: /var/cache/pdpp/transformers' \
  '      - type: bind' \
  "        source: $SMOKE_ROOT/reference-home" \
  '        target: /root/.pdpp' \
  '      - type: bind' \
  "        source: $SMOKE_ROOT/imports/claude" \
  '        target: /imports/claude' \
  '        read_only: true' \
  '      - type: bind' \
  "        source: $SMOKE_ROOT/imports/codex" \
  '        target: /imports/codex' \
  '        read_only: true' \
  '      - type: bind' \
  "        source: $SMOKE_ROOT/tools/slackdump" \
  '        target: /opt/pdpp-tools/slackdump' \
  '        read_only: true' \
  '  postgres:' \
  '    volumes:' \
  '      - type: bind' \
  "        source: $SMOKE_ROOT/postgres-data" \
  '        target: /var/lib/postgresql/data' >"$OVERRIDE_FILE"

resolved_config="$("${COMPOSE[@]}" config)"
for bind_source in \
  "$SMOKE_ROOT/reference-data" \
  "$SMOKE_ROOT/reference-transformers" \
  "$SMOKE_ROOT/reference-home" \
  "$SMOKE_ROOT/postgres-data" \
  "$SMOKE_ROOT/imports/claude" \
  "$SMOKE_ROOT/imports/codex" \
  "$SMOKE_ROOT/tools/slackdump"; do
  if [[ "$resolved_config" != *"source: $bind_source"* ]]; then
    echo "published-compose-bootstrap-smoke: Compose did not retain isolated bind source $bind_source" >&2
    exit 1
  fi
done

"${COMPOSE[@]}" pull reference web postgres
"${COMPOSE[@]}" up --detach --no-build --wait --wait-timeout 180

wait_for_url "http://127.0.0.1:$as_port/.well-known/oauth-authorization-server" "authorization metadata" 90
wait_for_url "http://127.0.0.1:$rs_port/.well-known/oauth-protected-resource" "resource metadata" 90
wait_for_url "http://127.0.0.1:$web_port/" "web service" 90

printf 'published-compose-bootstrap-smoke: passed (%s)\n' "$PROJECT_NAME"
