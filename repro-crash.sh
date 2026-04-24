#!/usr/bin/env bash
# Frozen repro for the SIGSEGV-in-V8-parallel-scavenger crash under
# concurrent dashboard load. See openspec/changes/fix-rs-query-memory-pressure
# for the investigation context and the fix.
#
# Assumes:
#   - You are on a branch descended from commit 121d963 that preserves the
#     crash state (or on main after the fix-rs-query-memory-pressure change
#     lands; in that case the expected result is PASS).
#   - ~/pdpp-repro-db/polyfill.sqlite.snapshot exists, sha256
#     001afdcc3de0caf2543c0a401779e998fe16afeaec00e01dd1fa698a98a14805.
#   - Node 25.8.2 is active (see .nvmrc).
#
# Run from repo root:
#   bash repro-crash.sh               # single run, 10 rounds
#   bash repro-crash.sh --runs=5      # five runs; PASS iff all survived
#
# Exit codes:
#   0 = all runs survived 10 rounds
#   1 = at least one run crashed (or the single-run legacy mode crashed)
#   2 = setup failure (missing snapshot, checksum mismatch, server never bound)

set -u

if [ -n "${PDPP_ROOT:-}" ]; then
  ROOT="$PDPP_ROOT"
else
  ROOT="$(cd "$(dirname "$0")" && pwd)"
fi
SNAPSHOT="$HOME/pdpp-repro-db/polyfill.sqlite.snapshot"
WORKING_DB="$ROOT/packages/polyfill-connectors/.pdpp-data/polyfill.sqlite"
EXPECTED_SHA="001afdcc3de0caf2543c0a401779e998fe16afeaec00e01dd1fa698a98a14805"
LOG="/tmp/repro-crash.log"

RUNS=1
for arg in "$@"; do
  case "$arg" in
    --runs=*)
      RUNS="${arg#--runs=}"
      if ! [[ "$RUNS" =~ ^[0-9]+$ ]] || [ "$RUNS" -lt 1 ]; then
        echo "[repro] ERROR: --runs must be a positive integer." >&2
        exit 2
      fi
      ;;
    --help|-h)
      sed -n '2,21p' "$0"
      exit 0
      ;;
    *)
      echo "[repro] ERROR: unknown argument '$arg' (try --help)." >&2
      exit 2
      ;;
  esac
done

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

# Run one 10-round cycle against a fresh DB + fresh dev server.
# Writes "SURVIVED", "CRASHED", or "SETUP_FAILED" to $RESULT_FILE. All other
# output goes straight to stdout so progress is visible during the run.
RESULT_FILE="/tmp/repro-crash.result"

wait_for_http_ready() {
  local url="$1"
  local label="$2"
  local timeout_seconds="${3:-120}"
  local started_at
  started_at="$(date +%s)"
  while true; do
    if curl -fsS -o /dev/null --max-time 5 "$url"; then
      echo "[repro] $label ready: $url"
      return 0
    fi
    if [ $(( $(date +%s) - started_at )) -ge "$timeout_seconds" ]; then
      echo "[repro] ERROR: timed out waiting for $label at $url" >&2
      return 1
    fi
    sleep 1
  done
}

run_once() {
  : > "$RESULT_FILE"
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

  echo "[repro] Waiting for AS/RS + dashboard to be ready…"
  if ! wait_for_http_ready "http://localhost:7662/_ref/connectors" "authorization server" 120; then
    echo "[repro] ERROR: authorization server never became ready. Log tail:" >&2
    tail -40 "$LOG" >&2
    pkill -P "$DEV_PID" 2>/dev/null
    echo SETUP_FAILED > "$RESULT_FILE"
    return
  fi
  if ! wait_for_http_ready "http://localhost:7663/.well-known/oauth-protected-resource" "resource server" 120; then
    echo "[repro] ERROR: resource server never became ready. Log tail:" >&2
    tail -40 "$LOG" >&2
    pkill -P "$DEV_PID" 2>/dev/null
    echo SETUP_FAILED > "$RESULT_FILE"
    return
  fi
  if ! wait_for_http_ready "http://localhost:3000/dashboard/records" "dashboard" 120; then
    echo "[repro] ERROR: dashboard never became ready. Log tail:" >&2
    tail -40 "$LOG" >&2
    pkill -P "$DEV_PID" 2>/dev/null
    echo SETUP_FAILED > "$RESULT_FILE"
    return
  fi

  REFPID=$(ss -ltnp 'sport = :7662' 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1 || true)
  if [ -z "${REFPID:-}" ]; then
    echo "[repro] ERROR: reference server never bound to :7662. Log tail:" >&2
    tail -20 "$LOG" >&2
    pkill -P "$DEV_PID" 2>/dev/null
    echo SETUP_FAILED > "$RESULT_FILE"
    return
  fi
  echo "[repro] Reference server PID: $REFPID"

  echo "[repro] Hammering /dashboard/records + /dashboard/search + /planning/changes for up to 10 rounds…"
  local status=survived
  for round in $(seq 1 10); do
    (
      curl -s -o /dev/null -w "R$round records %{http_code}/%{time_total}s\n" --max-time 120 http://localhost:3000/dashboard/records &
      curl -s -o /dev/null -w "R$round search  %{http_code}/%{time_total}s\n" --max-time 120 'http://localhost:3000/dashboard/search?q=personal+server' &
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
    echo CRASHED > "$RESULT_FILE"
  else
    echo SURVIVED > "$RESULT_FILE"
  fi
}

# Main dispatch.
crash_count=0
survive_count=0
declare -a per_run_results=()

for run in $(seq 1 "$RUNS"); do
  echo ""
  echo "============================================================"
  echo "[repro] Run $run of $RUNS"
  echo "============================================================"
  run_once
  final_line=$(cat "$RESULT_FILE" 2>/dev/null || echo UNKNOWN)
  per_run_results+=("run $run: $final_line")
  case "$final_line" in
    CRASHED) crash_count=$((crash_count + 1)) ;;
    SURVIVED) survive_count=$((survive_count + 1)) ;;
    SETUP_FAILED)
      echo "[repro] Setup failed during run $run; aborting."
      exit 2
      ;;
    *)
      echo "[repro] Unknown result '$final_line' during run $run; aborting." >&2
      exit 2
      ;;
  esac
done

echo ""
echo "============================================================"
echo "[repro] Summary:"
for r in "${per_run_results[@]}"; do
  echo "  $r"
done
echo "  survived=$survive_count  crashed=$crash_count  total=$RUNS"
echo "============================================================"

if [ "$crash_count" -gt 0 ]; then
  echo "[repro] RESULT: FAIL ($crash_count/$RUNS runs crashed)"
  exit 1
fi
echo "[repro] RESULT: PASS ($RUNS/$RUNS runs survived 10 rounds)"
exit 0
