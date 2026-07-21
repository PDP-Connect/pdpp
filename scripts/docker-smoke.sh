#!/usr/bin/env bash
set -euo pipefail

PROJECT_NAME="${COMPOSE_PROJECT_NAME:-pdpp-docker-smoke}"
ORIGIN="${PDPP_REFERENCE_ORIGIN:-http://localhost:3002}"
OWNER_PASSWORD="${PDPP_OWNER_PASSWORD:-$(node -e "console.log(require('node:crypto').randomBytes(24).toString('base64url'))")}"

export COMPOSE_PROJECT_NAME="$PROJECT_NAME"
export PDPP_REFERENCE_ORIGIN="$ORIGIN"
export PDPP_OWNER_PASSWORD="$OWNER_PASSWORD"
export PDPP_DB_PATH="${PDPP_DB_PATH:-/tmp/pdpp-smoke.sqlite}"
export PDPP_EMBEDDING_DOWNLOAD_ALLOWED="${PDPP_EMBEDDING_DOWNLOAD_ALLOWED:-0}"

cleanup() {
  docker compose down --remove-orphans >/dev/null
}
trap cleanup EXIT

docker compose up --build -d

wait_for() {
  local url="$1"
  local label="$2"
  local max="${3:-90}"
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

wait_for "$ORIGIN" "web origin"
wait_for "$ORIGIN/.well-known/oauth-authorization-server" "authorization metadata"
wait_for "$ORIGIN/.well-known/oauth-protected-resource" "resource metadata"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"; cleanup' EXIT

curl -fsS "$ORIGIN/.well-known/oauth-authorization-server" > "$tmpdir/as.json"
curl -fsS "$ORIGIN/.well-known/oauth-protected-resource" > "$tmpdir/rs.json"

node --input-type=module - "$tmpdir/as.json" "$tmpdir/rs.json" "$ORIGIN" <<'NODE'
import { readFileSync } from 'node:fs';

const [asPath, rsPath, origin] = process.argv.slice(2);
const as = JSON.parse(readFileSync(asPath, 'utf8'));
const rs = JSON.parse(readFileSync(rsPath, 'utf8'));
const combined = JSON.stringify({ as, rs });

for (const internal of ['reference:', 'web:', 'http://reference', 'http://web']) {
  if (combined.includes(internal)) {
    throw new Error(`metadata leaked internal Docker URL fragment: ${internal}`);
  }
}

if (as.issuer !== origin) {
  throw new Error(`AS issuer mismatch: expected ${origin}, got ${as.issuer}`);
}
if (rs.resource !== origin) {
  throw new Error(`RS resource mismatch: expected ${origin}, got ${rs.resource}`);
}
if (!Array.isArray(rs.authorization_servers) || rs.authorization_servers[0] !== origin) {
  throw new Error(`RS authorization_servers mismatch: ${JSON.stringify(rs.authorization_servers)}`);
}
NODE

console_headers="$(curl -sS -D - -o /dev/null "$ORIGIN/")"
console_status="$(printf '%s\n' "$console_headers" | awk 'NR == 1 { print $2 }')"
console_location="$(printf '%s\n' "$console_headers" | awk 'tolower($1) == "location:" { print $2; exit }' | tr -d '\r')"
case "$console_status" in
  303|307|308) ;;
  *)
    echo "Expected / to redirect with owner auth enabled; got status: $console_status" >&2
    exit 1
    ;;
esac
case "$console_location" in
  /owner/login*|"$ORIGIN"/owner/login*) ;;
  *)
    echo "Expected / to redirect to /owner/login; got location: $console_location" >&2
    exit 1
    ;;
esac

echo "Docker smoke passed for $ORIGIN"
