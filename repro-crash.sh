#!/usr/bin/env bash
# Frozen repro for the SIGSEGV-in-V8-parallel-scavenger crash under
# concurrent dashboard load. See openspec/changes/audit-db-query-surface
# for the investigation context.
#
# Assumes:
#   - You are on the `repro/scavenger-crash-2026-04-23` branch (or later
#     descended from commit 121d963 that preserves the crash state).
#   - ~/pdpp-repro-db/polyfill.sqlite.snapshot exists, sha256
#     001afdcc3de0caf2543c0a401779e998fe16afeaec00e01dd1fa698a98a14805.
#   - Node 25.8.2 is active (see .nvmrc if added).
#
# Run from repo root:
#   bash repro-crash.sh
#
# Exit 0 = server survived 10 rounds; exit 1 = crashed.

set -u

ROOT="$(cd "$(dirname "$0")" && pwd)"
SNAPSHOT="$HOME/pdpp-repro-db/polyfill.sqlite.snapshot"
WORKING_DB="$ROOT/packages/polyfill-connectors/.pdpp-data/polyfill.sqlite"
EXPECTED_SHA="001afdcc3de0caf2543c0a401779e998fe16afeaec00e01dd1fa698a98a14805"
LOG="/tmp/repro-crash.log"

if [ ! -f "$SNAPSHOT" ]; then
  echo "[repro] ERROR: snapshot not found at $SNAPSHOT" >&2
  exit 2
fi

actual_sha=$(sha256sum "$SNAPSHOT" | awk '{print $1}')
if [ "$actual_sha" != "$EXPECTED_SHA" ]; then
  echo "[repro] ERROR: snapshot checksum mismatch." >&2
  echo "  expected: $EXPECTED_SHA" >&2
  echo "  got:      $actual_sha" >&2
  exit 2
fi

echo "[repro] Killing any running dev processes…"
pkill -f 'pnpm.*dev' 2>/dev/null
pkill -f 'next-server' 2>/dev/null
pkill -f 'server/index.js' 2>/dev/null
sleep 2

echo "[repro] Restoring working DB from snapshot…"
mkdir -p "$(dirname "$WORKING_DB")"
# Need writable copy because reference server opens r/w even though we won't
# mutate under this repro. Remove any stale -wal/-shm files from previous run.
rm -f "$WORKING_DB" "$WORKING_DB-wal" "$WORKING_DB-shm"
cp "$SNAPSHOT" "$WORKING_DB"
chmod u+w "$WORKING_DB"

echo "[repro] Starting pnpm dev (background, log: $LOG)…"
cd "$ROOT"
nohup pnpm dev > "$LOG" 2>&1 &
DEV_PID=$!
echo "[repro] pnpm dev PID: $DEV_PID"

echo "[repro] Waiting for servers to be ready…"
for i in $(seq 1 30); do
  sleep 1
  if grep -q 'authorization server' "$LOG" 2>/dev/null && grep -q 'Ready in' "$LOG" 2>/dev/null; then
    echo "[repro] Ready after ${i}s."
    break
  fi
done

REFPID=$(ss -ltnp 'sport = :7662' 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1 || true)
if [ -z "${REFPID:-}" ]; then
  echo "[repro] ERROR: reference server never bound to :7662. Log tail:" >&2
  tail -20 "$LOG" >&2
  pkill -P $DEV_PID 2>/dev/null
  exit 2
fi
echo "[repro] Reference server PID: $REFPID"

echo "[repro] Hammering /dashboard/records + /dashboard/search + /planning/changes for up to 10 rounds…"
status=survived
for round in $(seq 1 10); do
  (
    curl -s -o /dev/null -w "R$round records %{http_code}/%{time_total}s\n" --max-time 120 http://localhost:3000/dashboard/records &
    curl -s -o /dev/null -w "R$round search  %{http_code}/%{time_total}s\n" --max-time 120 'http://localhost:3000/dashboard/search?q=personal+server&scope=messages' &
    curl -s -o /dev/null -w "R$round changes %{http_code}/%{time_total}s\n" --max-time 120 http://localhost:3000/planning/changes &
    wait
  )
  if ! ps -p "$REFPID" > /dev/null 2>&1; then
    echo "[repro] !!! Reference server DIED after round $round"
    status=crashed
    break
  fi
done

echo "[repro] Cleaning up…"
pkill -f 'pnpm.*dev' 2>/dev/null
pkill -f 'next-server' 2>/dev/null
pkill -f 'server/index.js' 2>/dev/null

if [ "$status" = "crashed" ]; then
  echo "[repro] RESULT: CRASHED — reproduction succeeded."
  exit 1
else
  echo "[repro] RESULT: SURVIVED 10 rounds. Reproduction did not fire this run."
  echo "[repro] This is non-deterministic; try again a few times before concluding anything."
  exit 0
fi
