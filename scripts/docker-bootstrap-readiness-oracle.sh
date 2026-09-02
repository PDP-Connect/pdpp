#!/usr/bin/env bash
# Copyright The PDP-Connect Contributors
# SPDX-License-Identifier: Apache-2.0

# Exact-image first-boot oracle for a production-shaped, populated PostgreSQL
# clone. This script owns every Docker object it creates and never connects to
# an operator or production database. The first short-lived container creates
# the schema; the fresh oracle container then boots the same immutable image
# against that populated database so RestartCount and its logs are meaningful.
set -euo pipefail

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
EXPECTED_REVISION="${PDPP_BOOTSTRAP_EXPECTED_REVISION:-$(git -C "$REPOSITORY_ROOT" rev-parse HEAD)}"
IMAGE="${PDPP_BOOTSTRAP_IMAGE:-pdpp-core-bootstrap-oracle:${EXPECTED_REVISION}}"
POSTGRES_IMAGE="${PDPP_POSTGRES_IMAGE:-pgvector/pgvector:pg16}"
DEADLINE_SECONDS="${PDPP_BOOTSTRAP_DEADLINE_SECONDS:-900}"
LOCK_HOLD_SECONDS="${PDPP_BOOTSTRAP_LOCK_HOLD_SECONDS:-40}"
RUN_ID="${PDPP_BOOTSTRAP_RUN_ID:-${UID:-0}-$(date +%s)-$$}"
NETWORK="pdpp-bootstrap-oracle-net-${RUN_ID}"
POSTGRES_CONTAINER="pdpp-bootstrap-oracle-postgres-${RUN_ID}"
PREP_CONTAINER="pdpp-bootstrap-oracle-prep-${RUN_ID}"
ORACLE_CONTAINER="pdpp-bootstrap-oracle-${RUN_ID}"
TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/pdpp-bootstrap-oracle.XXXXXX")"
LOG_FILE="${PDPP_BOOTSTRAP_LOG_FILE:-$TEMP_ROOT/container.log}"
REPORT_FILE="${PDPP_BOOTSTRAP_REPORT_FILE:-$TEMP_ROOT/report.txt}"
PG_PASSWORD="pdpp-oracle-only"
DATABASE_URL="postgresql://pdpp:${PG_PASSWORD}@pg:5432/pdpp"

AS_PORT=""
RS_PORT=""
START_MS=""
AS_LISTENER_MS=""
RS_LISTENER_MS=""
READY_FILE_MS=""
AS_METADATA_MS=""
RS_METADATA_MS=""

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "docker-bootstrap-readiness-oracle: required command not found: $1" >&2
    exit 127
  }
}

now_ms() {
  node --input-type=module -e 'console.log(Date.now())'
}

allocate_ports() {
  node --input-type=module -e '
    import { createServer } from "node:net";
    const servers = await Promise.all(Array.from({ length: 2 }, () => new Promise((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve(server));
    })));
    console.log(servers.map((server) => server.address().port).join(" "));
    await Promise.all(servers.map((server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
  '
}

cleanup() {
  local exit_code=$?
  trap - EXIT
  if [[ "$exit_code" -ne 0 ]] && docker inspect "$ORACLE_CONTAINER" >/dev/null 2>&1; then
    docker logs "$ORACLE_CONTAINER" >"$LOG_FILE" 2>&1 || true
  fi
  docker rm -f "$ORACLE_CONTAINER" "$PREP_CONTAINER" "$POSTGRES_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  if [[ -f "$LOG_FILE" ]]; then
    echo "docker-bootstrap-readiness-oracle: logs=$LOG_FILE" >&2
  fi
  rm -rf "$TEMP_ROOT" 2>/dev/null || true
  exit "$exit_code"
}

wait_for_postgres() {
  local deadline=$(( $(date +%s) + 120 ))
  while (( $(date +%s) < deadline )); do
    if docker exec "$POSTGRES_CONTAINER" pg_isready -U pdpp -d pdpp >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "docker-bootstrap-readiness-oracle: PostgreSQL did not become ready" >&2
  return 1
}

wait_for_url() {
  local url="$1"
  local deadline=$(( $(date +%s) + DEADLINE_SECONDS ))
  while (( $(date +%s) < deadline )); do
    if curl --fail --silent --show-error "$url" >/dev/null 2>&1; then
      return 0
    fi
    if ! docker inspect "$ORACLE_CONTAINER" >/dev/null 2>&1; then
      echo "docker-bootstrap-readiness-oracle: oracle container disappeared while waiting for $url" >&2
      return 1
    fi
    if [[ "$(docker inspect --format '{{.State.Status}}' "$ORACLE_CONTAINER")" == "exited" ]]; then
      echo "docker-bootstrap-readiness-oracle: oracle container exited while waiting for $url" >&2
      return 1
    fi
    sleep 1
  done
  echo "docker-bootstrap-readiness-oracle: deadline exceeded waiting for $url" >&2
  return 1
}

wait_for_internal_tcp_port() {
  local container="$1"
  local port="$2"
  local deadline=$(( $(date +%s) + DEADLINE_SECONDS ))
  while (( $(date +%s) < deadline )); do
    if docker exec "$container" node --input-type=module -e '
      import net from "node:net";
      const socket = net.createConnection({ host: "127.0.0.1", port: Number(process.argv[1]) });
      socket.once("connect", () => { socket.destroy(); process.exit(0); });
      socket.once("error", () => process.exit(1));
      setTimeout(() => process.exit(1), 500);
    ' "$port" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

require_command docker
require_command curl
require_command node
[[ -z "$(git -C "$REPOSITORY_ROOT" status --porcelain)" ]] || {
  echo "docker-bootstrap-readiness-oracle: repository must be clean for exact-image evidence" >&2
  exit 1
}
[[ "$EXPECTED_REVISION" =~ ^[0-9a-f]{40}$ ]] || {
  echo "docker-bootstrap-readiness-oracle: expected revision must be a full lowercase SHA-1" >&2
  exit 1
}

trap cleanup EXIT

read -r AS_PORT RS_PORT <<<"$(allocate_ports)"

core_env=(
  --env NODE_ENV=production
  --env PORT=3000
  --env PDPP_OWNER_PASSWORD=oracle-owner-password-only
  --env PDPP_CREDENTIAL_ENCRYPTION_KEY=oracle-credential-key-only
  --env PDPP_STORAGE_BACKEND=postgres
  --env PDPP_DATABASE_URL="$DATABASE_URL"
  --env PDPP_REFERENCE_ORIGIN="http://127.0.0.1:${AS_PORT}"
  --env PDPP_RECONCILE_POLYFILL_MANIFESTS=1
  --env PDPP_SKIP_AUTO_SCHEDULE_ENROLLMENT=1
  --env PDPP_BROWSER_HEADLESS=1
)
docker build \
  --build-arg "PDPP_REFERENCE_REVISION=$EXPECTED_REVISION" \
  --build-arg "PDPP_BUILD_REVISION=$EXPECTED_REVISION" \
  --build-arg "PDPP_BUILD_SOURCE=local-exact-image-oracle" \
  --build-arg "PDPP_BUILD_CREATED=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --build-arg "PDPP_BUILD_DIRTY=clean" \
  --tag "$IMAGE" \
  "$REPOSITORY_ROOT"

docker network create "$NETWORK" >/dev/null
docker run --detach --name "$POSTGRES_CONTAINER" --network "$NETWORK" --network-alias pg \
  --env POSTGRES_USER=pdpp --env "POSTGRES_PASSWORD=$PG_PASSWORD" --env POSTGRES_DB=pdpp \
  "$POSTGRES_IMAGE" >/dev/null
wait_for_postgres

# Prepare the clone by letting the exact image create its real production
# schema, then add enough harmless synthetic records to exercise the populated
# database budget. No production tables or rows
# are read or written by this path.
docker run --detach --name "$PREP_CONTAINER" --network "$NETWORK" "${core_env[@]}" "$IMAGE" >/dev/null
prep_deadline=$(( $(date +%s) + DEADLINE_SECONDS ))
while ! docker exec "$PREP_CONTAINER" curl --fail --silent http://127.0.0.1:7662/.well-known/oauth-authorization-server >/dev/null 2>&1; do
  (( $(date +%s) < prep_deadline )) || { echo "docker-bootstrap-readiness-oracle: schema preparation exceeded deadline" >&2; exit 1; }
  [[ "$(docker inspect --format '{{.State.Status}}' "$PREP_CONTAINER")" != "exited" ]] || {
    docker logs "$PREP_CONTAINER" >&2
    exit 1
  }
  sleep 1
done
docker rm -f "$PREP_CONTAINER" >/dev/null
docker exec "$POSTGRES_CONTAINER" psql -U pdpp -d pdpp -v ON_ERROR_STOP=1 -c \
  "INSERT INTO records (connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, semantic_time, version, primary_key_text) SELECT 'oracle_connector', 'oracle_instance', 'messages', 'oracle-' || n, jsonb_build_object('id', n, 'body', 'synthetic bootstrap row'), now()::text, now()::text, 1, 'oracle-' || n FROM generate_series(1, 300000) AS n;" \
  >/dev/null
DATABASE_SIZE_BYTES="$(docker exec "$POSTGRES_CONTAINER" psql -U pdpp -d pdpp -At -c \
  "SELECT pg_database_size(current_database());" | tr -d '[:space:]')"
[[ "$DATABASE_SIZE_BYTES" =~ ^[0-9]+$ ]] || { echo "docker-bootstrap-readiness-oracle: could not measure clone size" >&2; exit 1; }
(( DATABASE_SIZE_BYTES >= 64 * 1024 * 1024 )) || {
  echo "docker-bootstrap-readiness-oracle: clone did not reach populated-database threshold (${DATABASE_SIZE_BYTES} bytes)" >&2
  exit 1
}

# Hold the same advisory lock beyond the former 29.375-second retry window.
# The lock session is owned by the disposable PostgreSQL container and is
# released automatically after pg_sleep or when cleanup removes that container.
docker exec -d "$POSTGRES_CONTAINER" env PGPASSWORD="$PG_PASSWORD" psql -U pdpp -d pdpp \
  -c "SELECT pg_advisory_lock(482571, 150); SELECT pg_sleep(${LOCK_HOLD_SECONDS});" >/dev/null
sleep 2

START_MS="$(now_ms)"
docker run --detach --name "$ORACLE_CONTAINER" --network "$NETWORK" \
  --publish "127.0.0.1:${AS_PORT}:7662" --publish "127.0.0.1:${RS_PORT}:7663" \
  --restart=no "${core_env[@]}" "$IMAGE" >/dev/null

if wait_for_internal_tcp_port "$ORACLE_CONTAINER" 7662; then AS_LISTENER_MS="$(now_ms)"; else exit 1; fi
if wait_for_internal_tcp_port "$ORACLE_CONTAINER" 7663; then RS_LISTENER_MS="$(now_ms)"; else exit 1; fi
if wait_for_url "http://127.0.0.1:${AS_PORT}/.well-known/oauth-authorization-server"; then AS_METADATA_MS="$(now_ms)"; else exit 1; fi
if wait_for_url "http://127.0.0.1:${RS_PORT}/.well-known/oauth-protected-resource"; then RS_METADATA_MS="$(now_ms)"; else exit 1; fi
ready_deadline=$(( $(date +%s) + DEADLINE_SECONDS ))
while [[ -z "$READY_FILE_MS" ]]; do
  (( $(date +%s) < ready_deadline )) || { echo "docker-bootstrap-readiness-oracle: ready file deadline exceeded" >&2; exit 1; }
  if docker exec "$ORACLE_CONTAINER" test -f /tmp/pdpp-reference-ready; then
    READY_FILE_MS="$(now_ms)"
    break
  fi
  sleep 1
done

docker logs "$ORACLE_CONTAINER" >"$LOG_FILE" 2>&1
revision_label="$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$ORACLE_CONTAINER")"
runtime_revision="$(docker exec "$ORACLE_CONTAINER" printenv PDPP_REFERENCE_REVISION)"
restart_count="$(docker inspect --format '{{.RestartCount}}' "$ORACLE_CONTAINER")"
for forbidden in "startup failed" "reference exited" "Timed out waiting for PostgreSQL bootstrap serialization lock"; do
  ! grep -Fq "$forbidden" "$LOG_FILE" || {
    echo "docker-bootstrap-readiness-oracle: forbidden log evidence: $forbidden" >&2
    exit 1
  }
done
grep -Fq "postgres bootstrap lock waiting" "$LOG_FILE" || {
  echo "docker-bootstrap-readiness-oracle: missing real lock-contention wait evidence" >&2
  exit 1
}
grep -Fq "postgres bootstrap lock acquired" "$LOG_FILE" || {
  echo "docker-bootstrap-readiness-oracle: missing real lock-contention acquisition evidence" >&2
  exit 1
}
[[ "$revision_label" == "$EXPECTED_REVISION" ]] || { echo "docker-bootstrap-readiness-oracle: OCI revision mismatch" >&2; exit 1; }
[[ "$runtime_revision" == "$EXPECTED_REVISION" ]] || { echo "docker-bootstrap-readiness-oracle: runtime revision mismatch" >&2; exit 1; }
[[ "$restart_count" == "0" ]] || { echo "docker-bootstrap-readiness-oracle: RestartCount=$restart_count" >&2; exit 1; }

{
  echo "oracle=PASS"
  echo "revision=$EXPECTED_REVISION"
  echo "image=$IMAGE"
  echo "database=disposable populated PostgreSQL clone (300000 synthetic records)"
  echo "database_size_bytes=$DATABASE_SIZE_BYTES"
  echo "lock_contention_hold_seconds=$LOCK_HOLD_SECONDS (old fixed window=29.375; pre-start cushion=2)"
  echo "start_ms=$START_MS"
  echo "as_listener_ms=$AS_LISTENER_MS"
  echo "rs_listener_ms=$RS_LISTENER_MS"
  echo "ready_file_ms=$READY_FILE_MS"
  echo "as_metadata_200_ms=$AS_METADATA_MS"
  echo "rs_metadata_200_ms=$RS_METADATA_MS"
  echo "as_listener_after_start_ms=$((AS_LISTENER_MS - START_MS))"
  echo "rs_listener_after_start_ms=$((RS_LISTENER_MS - START_MS))"
  echo "as_metadata_after_start_ms=$((AS_METADATA_MS - START_MS))"
  echo "rs_metadata_after_start_ms=$((RS_METADATA_MS - START_MS))"
  echo "ready_file_after_start_ms=$((READY_FILE_MS - START_MS))"
  echo "restart_count=$restart_count"
  echo "logs=$LOG_FILE"
  echo "--- captured logs ---"
  sed -n '1,240p' "$LOG_FILE"
} | tee "$REPORT_FILE"
echo "docker-bootstrap-readiness-oracle: report=$REPORT_FILE" >&2
