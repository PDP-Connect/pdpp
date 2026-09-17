#!/usr/bin/env bash
# Copyright The PDP-Connect Contributors
# SPDX-License-Identifier: Apache-2.0
#
# Bring up the PDP-Connect reference implementation's real AS + RS as a
# conformance target, seed it, and tear it back down.
#
# Why this exists: the first attempt to run the suite against the reference
# implementation was a sequence of ad-hoc symlinks and fixed sleeps that nobody
# — including its author — could reproduce. This script is the reproducible
# form. Every version is pinned, the process is tracked by the PID this script
# owns, and readiness is polled rather than slept through.
#
# Lifecycle safety: `stop` kills ONLY the PID recorded in the state directory.
# It never pattern-matches process names. A `pkill -f tsx` twice took out the
# caller's own shell during development, which is exactly the failure this
# avoids. Ports are configurable so two runs cannot collide.
#
# Usage:
#   reference-target.sh up      # install, build, boot, seed, wait for ready
#   reference-target.sh seed    # re-seed records only
#   reference-target.sh status  # is the owned process alive and answering?
#   reference-target.sh stop    # terminate the owned PID, nothing else
#
# Environment:
#   PDPP_DC_REF          data-connect checkout to run from (required for `up`)
#   PDPP_REF_AS_PORT     authorization server port   (default 4401)
#   PDPP_REF_RS_PORT     resource server port        (default 4402)
#   PDPP_REF_STATE_DIR   pid/db/log directory        (default ~/.tmp/pdpp-ref-target)

set -euo pipefail

AS_PORT="${PDPP_REF_AS_PORT:-4401}"
RS_PORT="${PDPP_REF_RS_PORT:-4402}"
STATE_DIR="${PDPP_REF_STATE_DIR:-$HOME/.tmp/pdpp-ref-target}"
PID_FILE="$STATE_DIR/server.pid"
LOG_FILE="$STATE_DIR/server.log"
DB_FILE="$STATE_DIR/conf.sqlite"

# Credentials the suite's target config must match. Fixed here rather than
# generated so a run is repeatable: the reference AS otherwise invents
# introspection credentials at boot, which no external caller can then present.
DCR_TOKEN="conformance-dcr-token"
INTROSPECT_CLIENT_ID="conformance-rs"
INTROSPECT_CLIENT_SECRET="conformance-rs-secret"

SUBJECT_ID="subject_conformance"
CONNECTOR_ID="https://registry.pdpp.dev/connectors/github"
READY_TIMEOUT_SECONDS=180

log() { printf '[reference-target] %s\n' "$*" >&2; }

die() {
  log "ERROR: $*"
  exit 1
}

require_checkout() {
  [ -n "${PDPP_DC_REF:-}" ] || die "PDPP_DC_REF must point at a data-connect checkout."
  [ -d "$PDPP_DC_REF/reference-implementation" ] ||
    die "$PDPP_DC_REF has no reference-implementation directory."
}

# Poll until the AS answers its RFC 8414 metadata, or the budget runs out.
# Polling rather than sleeping: boot time varies with cold caches and machine
# load, so a fixed sleep is either wasteful or flaky, and it reports nothing
# useful when it fails.
wait_until_ready() {
  local deadline=$((SECONDS + READY_TIMEOUT_SECONDS))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if curl -fsS -o /dev/null --max-time 3 \
      "http://127.0.0.1:$AS_PORT/.well-known/oauth-authorization-server" 2>/dev/null; then
      log "ready after ~$((SECONDS))s (AS :$AS_PORT, RS :$RS_PORT)"
      return 0
    fi
    # Surface a dead process immediately instead of waiting out the budget.
    if [ -f "$PID_FILE" ] && ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      log "server process exited during startup; last log lines:"
      tail -20 "$LOG_FILE" >&2 || true
      return 1
    fi
    sleep 2
  done
  log "not ready within ${READY_TIMEOUT_SECONDS}s; last log lines:"
  tail -20 "$LOG_FILE" >&2 || true
  return 1
}

cmd_up() {
  require_checkout
  mkdir -p "$STATE_DIR"

  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    log "already running as PID $(cat "$PID_FILE"); reusing it."
    wait_until_ready && cmd_seed
    return
  fi

  log "installing dependencies (pinned by the checkout's lockfile)"
  (cd "$PDPP_DC_REF" && pnpm install --frozen-lockfile --prefer-offline) ||
    die "dependency install failed. The reference implementation declares \`workspaces\`
  in package.json with no pnpm-workspace.yaml, so pnpm may not link its vendored
  @pdpp/* packages, and npm refuses its git-protocol dependency in restricted
  networks. Both are checkout-side issues; report them rather than hand-linking."

  log "writing boot entrypoint"
  cat > "$PDPP_DC_REF/reference-implementation/pdpp-conformance-boot.mts" <<BOOT
import { startServer } from "./server/index.ts";
const server = await startServer({
  asPort: $AS_PORT,
  rsPort: $RS_PORT,
  dbPath: "$DB_FILE",
  dynamicClientRegistrationInitialAccessTokens: ["$DCR_TOKEN"],
  // Pinned so the suite can authenticate at the introspection endpoint. Left
  // unset, the AS generates credentials no external caller can present, and
  // every introspection requirement reports as untestable.
  introspectionCallerCredentials: {
    clientId: "$INTROSPECT_CLIENT_ID",
    clientSecret: "$INTROSPECT_CLIENT_SECRET",
  },
  ignoreAmbientPublicUrls: true,
  ownerAuthPassword: "",
  quiet: true,
});
console.log(JSON.stringify({ asPort: server.asPort, rsPort: server.rsPort }));
BOOT

  rm -f "$DB_FILE" "$DB_FILE-wal" "$DB_FILE-shm"
  log "starting server"
  (
    cd "$PDPP_DC_REF/reference-implementation"
    setsid nohup npx tsx pdpp-conformance-boot.mts > "$LOG_FILE" 2>&1 < /dev/null &
    echo $! > "$PID_FILE"
  )
  log "owned PID $(cat "$PID_FILE"), log $LOG_FILE"

  wait_until_ready || die "server did not become ready."
  cmd_seed
}

# Seed over HTTP with an owner token. Records are NDJSON RECORD envelopes per
# Core Section 4; the connector runtime is not used because it requires
# in-process database access and this path stays black-box.
cmd_seed() {
  log "minting an owner token via the device-code flow"
  local device user_code device_code owner_token
  device=$(curl -fsS -X POST "http://127.0.0.1:$AS_PORT/oauth/device_authorization" \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    --data-urlencode 'client_id=cli_longview') || die "device authorization failed"
  user_code=$(printf '%s' "$device" | python3 -c 'import json,sys;print(json.load(sys.stdin)["user_code"])')
  device_code=$(printf '%s' "$device" | python3 -c 'import json,sys;print(json.load(sys.stdin)["device_code"])')

  curl -fsS -o /dev/null -X POST "http://127.0.0.1:$AS_PORT/device/approve" \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    --data-urlencode "subject_id=$SUBJECT_ID" \
    --data-urlencode "user_code=$user_code" || die "device approval failed"

  owner_token=$(curl -fsS -X POST "http://127.0.0.1:$AS_PORT/oauth/token" \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    --data-urlencode 'client_id=cli_longview' \
    --data-urlencode "device_code=$device_code" \
    --data-urlencode 'grant_type=urn:ietf:params:oauth:grant-type:device_code' |
    python3 -c 'import json,sys;print(json.load(sys.stdin)["access_token"])') ||
    die "owner token redemption failed"

  log "registering the connector manifest"
  curl -fsS -o /dev/null -X POST "http://127.0.0.1:$AS_PORT/connectors" \
    -H 'Content-Type: application/json' \
    --data-binary "@$PDPP_DC_REF/reference-implementation/fixtures/seed-manifests/github.json" ||
    log "connector registration returned non-2xx (it may already be registered)"

  log "ingesting records"
  local ndjson
  ndjson=$(python3 - <<'PY'
import json
rows = [
    {"id": "repo_1", "name": "alpha", "full_name": "acme/alpha", "description": "first",
     "language": "TypeScript", "stargazers_count": 12, "forks_count": 1,
     "is_private": False, "is_fork": False, "topics": ["a"],
     "source_created_at": "2026-01-01T00:00:00Z", "source_updated_at": "2026-02-01T00:00:00Z"},
    {"id": "repo_2", "name": "beta", "full_name": "acme/beta", "description": "second",
     "language": "Go", "stargazers_count": 34, "forks_count": 2,
     "is_private": True, "is_fork": False, "topics": ["b"],
     "source_created_at": "2026-01-05T00:00:00Z", "source_updated_at": "2026-02-05T00:00:00Z"},
]
print("\n".join(json.dumps({"type": "RECORD", "stream": "repositories", "key": r["id"],
                            "data": r, "emitted_at": "2026-03-01T00:00:00Z"}) for r in rows))
PY
  )
  curl -fsS -X POST \
    "http://127.0.0.1:$RS_PORT/v1/ingest/repositories?connector_id=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$CONNECTOR_ID")&collection_mode=full_refresh" \
    -H 'Content-Type: application/x-ndjson' \
    -H "Authorization: Bearer $owner_token" \
    --data-binary "$ndjson" || die "ingest failed"
  log "seeded"
}

cmd_status() {
  if [ ! -f "$PID_FILE" ]; then
    log "no owned process recorded in $STATE_DIR"
    return 1
  fi
  local pid
  pid=$(cat "$PID_FILE")
  if kill -0 "$pid" 2>/dev/null; then
    if curl -fsS -o /dev/null --max-time 3 \
      "http://127.0.0.1:$AS_PORT/.well-known/oauth-authorization-server" 2>/dev/null; then
      log "PID $pid alive and answering on :$AS_PORT"
      return 0
    fi
    log "PID $pid alive but not answering on :$AS_PORT"
    return 1
  fi
  log "recorded PID $pid is not running"
  return 1
}

# Terminate only the PID this script started. Never a pattern match: a broad
# `pkill -f` twice killed the caller's own shell during development.
cmd_stop() {
  [ -f "$PID_FILE" ] || { log "nothing to stop"; return 0; }
  local pid
  pid=$(cat "$PID_FILE")
  if kill -0 "$pid" 2>/dev/null; then
    log "stopping owned PID $pid"
    kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.5
    done
    kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
  else
    log "recorded PID $pid already gone"
  fi
  rm -f "$PID_FILE"
}

case "${1:-}" in
  up) cmd_up ;;
  seed) cmd_seed ;;
  status) cmd_status ;;
  stop) cmd_stop ;;
  *)
    printf 'usage: %s {up|seed|status|stop}\n' "$0" >&2
    exit 2
    ;;
esac
