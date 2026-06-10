#!/usr/bin/env bash
set -euo pipefail

# SQLite-on-volume restart-survival smoke for the Railway Core deploy gate
# (openspec/changes/add-railway-core-deploy-target task 2.3, deploy/railway/
# README.md "First-live-test gate" step 7 durability check).
#
# This is the local proxy for the live "restart the reference service; the owner
# login and the stored records survive; re-run the query" acceptance step, on
# the SQLite-on-a-mounted-volume storage option (Option B). It complements
# `pnpm docker:smoke` (composed-origin metadata + owner-gating) and
# `scripts/railway-mcp-query-smoke.mjs` (seed + scoped MCP query) by proving the
# one property neither of those covers: data written before a container
# REPLACEMENT is still present after it, because it lives on the volume rather
# than the container's writable layer.
#
# What it does:
#   1. Boot the composed stack with SQLite forced onto the persistent
#      `pdpp-home` named volume (PDPP_STORAGE_BACKEND=sqlite,
#      PDPP_DB_PATH=/root/.pdpp/pdpp.sqlite). The compose default
#      /var/lib/pdpp/pdpp.sqlite is intentionally NOT on a mounted volume — the
#      same trap the runbook and env-check warn about — so we override it here.
#   2. Seed a deterministic record set via railway-mcp-query-smoke.mjs and prove
#      the scoped MCP query returns it (pre-restart baseline).
#   3. Force-recreate the reference CONTAINER (not just restart the process):
#      `docker compose up -d --force-recreate --no-deps reference`. The named
#      volume persists across the new container; the writable layer does not. If
#      the records were on the container layer instead of the volume, they would
#      vanish here.
#   4. After the new container is healthy, re-run the scoped MCP query and assert
#      the same seeded records are still returned, and that an owner login still
#      succeeds (owner-session signing derives from PDPP_OWNER_PASSWORD, so a
#      stable password keeps sessions valid across the restart).
#
# Requires Docker + a built (or pullable) reference/console image, exactly like
# scripts/docker-smoke.sh. It is the live-gate proxy, not a CI unit test; the
# pass/fail decision logic it relies on is unit-tested offline in
# scripts/railway-mcp-query-smoke.test.mjs.
#
# Usage:
#   bash scripts/railway-sqlite-restart-smoke.sh
#   PDPP_REFERENCE_ORIGIN=http://localhost:3002 bash scripts/railway-sqlite-restart-smoke.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PROJECT_NAME="${COMPOSE_PROJECT_NAME:-pdpp-sqlite-restart-smoke}"
ORIGIN="${PDPP_REFERENCE_ORIGIN:-http://localhost:3002}"
OWNER_PASSWORD="${PDPP_OWNER_PASSWORD:-$(node -e "console.log(require('node:crypto').randomBytes(24).toString('base64url'))")}"

export COMPOSE_PROJECT_NAME="$PROJECT_NAME"
export PDPP_REFERENCE_ORIGIN="$ORIGIN"
export PDPP_OWNER_PASSWORD="$OWNER_PASSWORD"

# Force the durable SQLite-on-volume path: store the DB under the mounted
# `pdpp-home` volume (/root/.pdpp) so it survives a container replacement.
export PDPP_STORAGE_BACKEND="sqlite"
export PDPP_DB_PATH="/root/.pdpp/pdpp.sqlite"
# Keep PDPP_DATABASE_URL unset so the reference does not pick Postgres.
unset PDPP_DATABASE_URL || true
export PDPP_EMBEDDING_DOWNLOAD_ALLOWED="${PDPP_EMBEDDING_DOWNLOAD_ALLOWED:-0}"
# docker-compose.yml still starts the Postgres service because `reference`
# depends on its healthcheck, even though this smoke uses SQLite. Avoid
# colliding with another local stack's default 55432 bind.
export PDPP_POSTGRES_PORT="${PDPP_POSTGRES_PORT:-$(node - <<'NODE'
const net = require('node:net');
const server = net.createServer();
server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  server.close(() => process.stdout.write(String(port)));
});
NODE
)}"

cd "$REPO_ROOT"

cleanup() {
  docker compose down --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_for() {
  local url="$1"
  local label="$2"
  local max="${3:-120}"
  local start
  start="$(date +%s)"
  while true; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    if (( $(date +%s) - start >= max )); then
      echo "Timed out waiting for $label at $url" >&2
      docker compose logs --tail=160 >&2 || true
      return 1
    fi
    sleep 2
  done
}

seed_and_query() {
  # Seed (the pre-restart baseline) and assert the scoped MCP query returns the
  # seeded records.
  node "$SCRIPT_DIR/railway-mcp-query-smoke.mjs" \
    --origin "$ORIGIN" \
    --owner-password "$OWNER_PASSWORD"
}

query_only() {
  # Re-query WITHOUT re-seeding — the authoritative durability proof. If the
  # records were on the replaced container's writable layer instead of the
  # volume, --no-seed would find nothing and fail.
  node "$SCRIPT_DIR/railway-mcp-query-smoke.mjs" \
    --origin "$ORIGIN" \
    --owner-password "$OWNER_PASSWORD" \
    --no-seed
}

assert_owner_login() {
  # Prove an owner login still succeeds after the restart (session signing key
  # is derived from the stable PDPP_OWNER_PASSWORD). We only check that the
  # login POST issues a session cookie; the deeper record check is the query.
  local csrf_jar status
  csrf_jar="$(mktemp)"
  curl -fsS -c "$csrf_jar" "$ORIGIN/owner/login" >/dev/null 2>&1 || true
  status="$(curl -s -o /dev/null -w '%{http_code}' -b "$csrf_jar" -c "$csrf_jar" \
    -X POST "$ORIGIN/owner/login" \
    --data-urlencode "password=$OWNER_PASSWORD" \
    --data-urlencode "return_to=/dashboard" || true)"
  rm -f "$csrf_jar"
  # A CSRF-protected form login that we drive without scraping the hidden field
  # may legitimately 403 on CSRF; the authoritative owner-session proof is the
  # mjs smoke's own login step. Here we only fail on a 5xx (server broke after
  # restart) — a 302 (ok) or 403 (csrf, expected without field) are both fine.
  case "$status" in
    5*)
      echo "Owner login endpoint returned $status after restart — server unhealthy" >&2
      return 1
      ;;
    *) ;;
  esac
}

echo "== SQLite restart-survival smoke =="
echo "origin:     $ORIGIN"
echo "storage:    sqlite @ $PDPP_DB_PATH (on the pdpp-home volume)"
echo "pg port:    $PDPP_POSTGRES_PORT (bound only because compose health-depends on postgres)"
echo

echo "[1/4] booting composed stack on SQLite-on-volume ..."
docker compose up --build -d
wait_for "$ORIGIN" "web origin"
wait_for "$ORIGIN/.well-known/oauth-authorization-server" "authorization metadata"

echo "[2/4] seeding records + proving scoped MCP query (pre-restart) ..."
seed_and_query

echo "[3/4] force-recreating the reference container (volume persists, layer does not) ..."
docker compose up -d --build --force-recreate --no-deps reference
wait_for "$ORIGIN/.well-known/oauth-authorization-server" "authorization metadata (post-restart)"

echo "[4/4] re-querying WITHOUT re-seeding + owner login (post-restart) ..."
query_only
assert_owner_login

echo
echo "SQLite restart-survival smoke passed: seeded records and owner auth survived a container replacement on $ORIGIN"
