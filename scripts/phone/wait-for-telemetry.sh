#!/usr/bin/env bash
# Poll PDPP web container stream-debug JSONL for a line containing substring.
# Usage: wait-for-telemetry.sh <substring> [timeout-s]
set -eu
NEEDLE="${1:-}"
TIMEOUT="${2:-30}"
if [ -z "$NEEDLE" ]; then
  echo "usage: wait-for-telemetry.sh <substring> [timeout-s]" >&2
  exit 2
fi
ROOT="/home/user/code/pdpp"
DC="docker compose --env-file $ROOT/.env.docker -f $ROOT/docker-compose.yml -f $ROOT/docker-compose.neko.yml"
DATE_UTC="$(date -u +%Y-%m-%d)"
FILE="/app/tmp/stream-debug/${DATE_UTC}.jsonl"

START="$(date +%s)"
while :; do
  HIT="$($DC exec -T web sh -c "tail -c 200000 '$FILE' 2>/dev/null || true" 2>/dev/null \
    | grep -F "$NEEDLE" | tail -1 || true)"
  if [ -n "$HIT" ]; then
    echo "$HIT"
    echo "PASS: found '$NEEDLE'" >&2
    exit 0
  fi
  NOW="$(date +%s)"
  ELAPSED=$((NOW - START))
  if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
    echo "FAIL: timeout ${TIMEOUT}s waiting for '$NEEDLE'" >&2
    exit 1
  fi
  sleep 1
done
