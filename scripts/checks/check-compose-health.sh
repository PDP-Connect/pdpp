#!/usr/bin/env bash
# Static validation: the docker compose stack wires `web` to wait for
# `reference` to be healthy. Without this, `web` answers dashboard requests
# before the AS/RS listeners are ready, surfacing as ECONNREFUSED on the
# first dashboard load.
set -euo pipefail

cd "$(dirname "$0")/../.."

fail() {
  echo "check-compose-health: $1" >&2
  exit 1
}

if ! command -v docker >/dev/null 2>&1; then
  echo "check-compose-health: docker not installed; skipping config validation" >&2
else
  docker compose config >/dev/null || fail "docker compose config failed"
fi

grep -qE '^\s*healthcheck:\s*$' docker-compose.yml \
  || fail "reference service missing healthcheck in docker-compose.yml"

grep -q 'localhost:7662/.well-known/oauth-authorization-server' docker-compose.yml \
  || fail "reference healthcheck must probe AS metadata"
grep -q 'localhost:7663/.well-known/oauth-protected-resource' docker-compose.yml \
  || fail "reference healthcheck must probe RS metadata"

python3 - <<'PY' || exit 1
import re
import sys

src = open("docker-compose.yml", encoding="utf-8").read()
m = re.search(r"^\s*web:\s*\n((?:\s{4,}.*\n)+)", src, re.MULTILINE)
if not m:
    print("check-compose-health: could not locate web service block", file=sys.stderr)
    sys.exit(1)
block = m.group(1)
if "service_healthy" not in block:
    print("check-compose-health: web.depends_on must use condition: service_healthy", file=sys.stderr)
    sys.exit(1)
PY

echo "check-compose-health: ok"
