#!/usr/bin/env bash
# Copyright The PDP-Connect Contributors
# SPDX-License-Identifier: Apache-2.0
#
# Bring up the PDP-Connect reference implementation's real AS + RS as a
# conformance target, seed it, run the suite, and tear it back down.
#
# Why this exists: the first attempt to run the suite against the reference
# implementation was a sequence of ad-hoc symlinks and fixed sleeps that nobody
# — including its author — could reproduce. This script is the reproducible
# form: one supervised lifecycle per run.
#
# Lifecycle safety. `run` is the only way to start a server, and it owns the
# whole lifecycle:
#   - the server is a direct child of this script. Its PID lives in a shell
#     variable, never in a file, so no stale PID can be signalled later;
#   - the EXIT/INT/TERM/HUP trap stops exactly that child (and reaps it);
#   - where `setpriv` exists the kernel also stops the child if this script is
#     SIGKILLed (PDEATHSIG), so even an unhandled kill leaves no server behind;
#   - every run gets its own state directory (mktemp under the state root) with
#     a lock held for the run, so two runs cannot share a database or a log;
#   - ports are chosen per run (free ports unless PDPP_REF_AS_PORT/RS_PORT are
#     set), refused if already in use, and the SAME ports go into the target
#     config generated for the suite, so the suite tests the server it booted.
# Nothing here matches process names: `pkill -f tsx` twice took out the
# caller's own shell during development.
#
# The committed targets/reference-implementation.json is a template: `run`
# never edits it, it writes a per-run copy with the resolved URLs and the
# actual data-connect version.
#
# Usage:
#   reference-target.sh run [--out DIR]
#                               # ONE command: install if needed (network), then
#                               # boot -> seed -> suite -> stop inside one
#                               # `test-sandbox --net none` invocation; writes
#                               # requirements.json, report.json, report.md,
#                               # target.json, server.log and (sandboxed)
#                               # sandbox-receipt.json to DIR; exits with the
#                               # suite's exit code
#   reference-target.sh install # install + build the checkout (needs network);
#                               # rebuilds when the checkout's HEAD differs from
#                               # the last build
#
# There is deliberately no standalone `up`/`stop`/`status`/`seed`: a server
# that outlives its run is the hazard this design removes.
#
# Environment:
#   PDPP_DC_REF          data-connect checkout to run from (required)
#   PDPP_DC_PIN          data-connect commit this target is known to work with
#                        (default below; refused at another HEAD unless
#                        PDPP_DC_ALLOW_UNPINNED=1, and then the report's target
#                        version says UNPINNED and names the actual commit)
#   PDPP_DC_NPM_ALLOW_GIT npm git-dependency policy for install (default root;
#                        current e94f4fd9 needs all for a pinned transitive git dependency)
#   PDPP_CONF_OUT        output dir for `run` (default: a fresh ./conformance-ri-out/run.XXXXXX
#                        per run; a named dir is locked for the run and only the files
#                        a run writes are cleared from it)
#   PDPP_REF_AS_PORT     authorization server port   (default: a free port)
#   PDPP_REF_RS_PORT     resource server port        (default: a free port)
#   PDPP_REF_STATE_DIR   state root for per-run dirs (default ~/.tmp/pdpp-ref-target)

set -euo pipefail

STATE_ROOT="${PDPP_REF_STATE_DIR:-$HOME/.tmp/pdpp-ref-target}"
# The data-connect commit this target is known to work with. Keep in step with
# `targetVersion` in targets/reference-implementation.json.
PDPP_DC_PIN="${PDPP_DC_PIN:-59a3fb480e7f3e2d68d46b1e4ee2cb23d505d113}"
SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
PACKAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILT_SHA_FILE_REL="node_modules/.pdpp-conformance-built-sha"

# Set by `_run-inner` once the run directory and ports exist.
RUN_DIR=""
AS_PORT=""
RS_PORT=""
SERVER_PID=""
SERVER_START=""
OUT_DIR=""
SUITE_PID=""
SUITE_START=""
GUARD=()
LOG_FILE=""
DB_FILE=""

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

checkout_head() {
  git -C "$PDPP_DC_REF" rev-parse HEAD 2>/dev/null ||
    die "$PDPP_DC_REF is not a git checkout, so its commit cannot be compared with the pin $PDPP_DC_PIN."
}

# "dirty" when tracked files differ from HEAD or untracked, non-ignored files
# exist; build output (node_modules, dist) is gitignored and does not count.
checkout_dirty() {
  [ -n "$(git -C "$PDPP_DC_REF" status --porcelain 2>/dev/null)" ]
}

# The suite's expectations (seed shape, device flow, bootstrap sentinel) were
# verified against one data-connect commit. Another HEAD may still work, but a
# result from it says nothing about the pinned target, so refuse by default.
check_pin() {
  local head
  head=$(checkout_head)
  case "$head" in
    "$PDPP_DC_PIN"*) ;;
    *)
      if [ "${PDPP_DC_ALLOW_UNPINNED:-}" = 1 ]; then
        log "WARNING: $PDPP_DC_REF is at $head, not the pinned $PDPP_DC_PIN; the report will say UNPINNED."
      else
        die "$PDPP_DC_REF is at $head, not the pinned $PDPP_DC_PIN (PDPP_DC_PIN). Check out the pin, or set PDPP_DC_ALLOW_UNPINNED=1 to run anyway."
      fi
      ;;
  esac
  if checkout_dirty; then
    log "WARNING: $PDPP_DC_REF has uncommitted changes; the report will say +dirty."
  fi
}

# What the report calls the implementation under test: the ACTUAL commit, never
# the pin. The pinned, clean form matches targetVersion in the committed config.
actual_target_version() {
  local head label
  head=$(checkout_head)
  label="data-connect@${head} reference-implementation"
  case "$head" in
    "$PDPP_DC_PIN"*) ;;
    *) label="$label (UNPINNED override; pin is ${PDPP_DC_PIN:0:10})" ;;
  esac
  if checkout_dirty; then
    label="$label +dirty"
  fi
  printf '%s' "$label"
}

# The vendored packages the server imports at runtime, as "directory|output":
# the build output that must exist, relative to the checkout, for the build to
# count. A package directory that is absent (older checkouts) requires nothing.
VENDORED_BUILDS=(
  "packages/connector-protocol|packages/connector-protocol/dist/index.js"
  "reference-implementation/vendor/read-core|reference-implementation/vendor/read-core/dist/index.js"
  "reference-implementation/vendor/cli|reference-implementation/vendor/cli/dist/src/index.js"
  "reference-implementation/vendor/mcp-server|reference-implementation/vendor/mcp-server/dist/src/server.js"
)

# Succeeds when every required build output is present and non-empty.
build_outputs_present() {
  local entry dir output
  for entry in "${VENDORED_BUILDS[@]}"; do
    dir="${entry%%|*}"
    output="${entry##*|}"
    [ -d "$PDPP_DC_REF/$dir" ] || continue
    [ -s "$PDPP_DC_REF/$output" ] || return 1
  done
}

# Everything the run needs is on disk AND was built from the checkout's current
# HEAD. Presence of build output alone says nothing about which commit it is.
# A dirty checkout is never considered built: its build cannot be attributed.
is_installed() {
  [ -d "$PDPP_DC_REF/node_modules" ] &&
    build_outputs_present &&
    ! checkout_dirty &&
    [ "$(cat "$PDPP_DC_REF/$BUILT_SHA_FILE_REL" 2>/dev/null || true)" = "$(checkout_head)" ]
}

# Succeeds when nothing listens on 127.0.0.1:$1.
port_is_free() {
  python3 -c 'import socket,sys
s=socket.socket(); 
try:
    s.bind(("127.0.0.1", int(sys.argv[1])))
except OSError:
    sys.exit(1)' "$1"
}

free_port() {
  python3 -c 'import socket
s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])'
}

# Process identity. A bare PID is not an identity: once a child exits and is
# reaped (bash reaps on SIGCHLD, before any explicit `wait`), the kernel may hand
# the number to an unrelated process, and signalling it would hit a stranger. The
# kernel's per-process start time (field 22 of /proc/<pid>/stat, in clock ticks
# since boot) does not change across exec and differs for any later process that
# reuses the PID, so it is recorded at spawn and re-checked before every signal.
#
# Prints the start time of a LIVE (non-zombie) process; fails when there is none.
proc_start_time() {
  local stat rest
  stat=$(cat "/proc/$1/stat" 2>/dev/null) || return 1
  # comm (field 2) may contain spaces and parentheses: cut at the LAST ") ".
  rest="${stat##*) }"
  # shellcheck disable=SC2086
  set -- $rest
  [ "$1" != "Z" ] && [ "$1" != "X" ] || return 1
  printf '%s' "${20}"
}

# Succeeds only when PID $1 is still the process whose start time is $2.
owned_alive() {
  local current
  [ -n "$1" ] && [ -n "$2" ] || return 1
  current=$(proc_start_time "$1") || return 1
  [ "$current" = "$2" ]
}

# Poll until the AS answers its RFC 8414 metadata, or the budget runs out.
# Polling rather than sleeping: boot time varies with cold caches and machine
# load, so a fixed sleep is either wasteful or flaky, and it reports nothing
# useful when it fails. The owned child must still be alive, so an answer from
# some OTHER server that holds the port is never mistaken for ours.
wait_until_ready() {
  local deadline=$((SECONDS + READY_TIMEOUT_SECONDS))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if ! owned_alive "$SERVER_PID" "$SERVER_START"; then
      log "server process exited during startup; last log lines:"
      tail -20 "$LOG_FILE" >&2 || true
      return 1
    fi
    if curl -fsS -o /dev/null --max-time 3 \
      "http://127.0.0.1:$AS_PORT/.well-known/oauth-authorization-server" 2>/dev/null; then
      log "ready after ~$((SECONDS))s (AS :$AS_PORT, RS :$RS_PORT)"
      return 0
    fi
    sleep 2
  done
  log "not ready within ${READY_TIMEOUT_SECONDS}s; last log lines:"
  tail -20 "$LOG_FILE" >&2 || true
  return 1
}

cmd_install() {
  require_checkout
  check_pin
  mkdir -p "$STATE_ROOT"
  # Two installs into one checkout would interleave npm and builds, so they
  # queue on a lock. The subshell scopes it: the lock is released when the
  # install ends, not held for the rest of a run (which would serialize runs).
  (
    exec 8>"$STATE_ROOT/install.lock"
    flock 8
    install_locked
  )
}

install_locked() {
  if is_installed; then
    log "checkout already built from $(checkout_head)"
    return 0
  fi
  rm -f "$PDPP_DC_REF/$BUILT_SHA_FILE_REL"
  # The checkout is an npm workspace (`workspaces` in package.json, no
  # pnpm-workspace.yaml), so npm is the correct installer: pnpm 10 ignores that
  # declaration and leaves the vendored @pdpp/* packages unlinked.
  #
  # `--allow-git=root` is required because one dependency is a pinned git+ssh
  # reference. npm's default `allow-git=none` is a local POLICY setting, not a
  # network restriction — the registry is reachable either way. The flag is
  # scoped to root by default. A reviewed target with a pinned transitive git
  # dependency can opt into all through PDPP_DC_NPM_ALLOW_GIT for this invocation.
  # npm ci requires the committed lockfile and never rewrites the target tree.
  # Two phases on purpose. Vendored @pdpp/* packages declare `prepare` scripts
  # that build one another, and npm runs those during install before the
  # workspace links they depend on exist — so a single `npm install` fails on an
  # ordering problem, not a real dependency problem. Resolve the tree first with
  # scripts off, then build the vendored packages once everything is linked.
  log "installing dependencies (npm workspaces, lockfile-pinned)"
  (cd "$PDPP_DC_REF" && npm ci --allow-git="${PDPP_DC_NPM_ALLOW_GIT:-root}" --no-audit --no-fund --ignore-scripts) ||
    die "dependency install failed; see the npm output above."

  build_vendored_and_stamp
}

# Build the vendored packages the server imports at runtime, then record which
# commit the output belongs to.
#
# The stamp is the only thing later runs trust, so it is written last and only
# on proof that the output is fresh: every build output is deleted first (so an
# old dist cannot survive a failed rebuild and be labelled with the new HEAD),
# every build must exit zero, and every required output must exist afterwards.
# There is no tolerated failure: a build that "emits usable JavaScript but exits
# non-zero" cannot be told from one that left stale files behind.
build_vendored_and_stamp() {
  local entry dir buildlog
  rm -f "$PDPP_DC_REF/$BUILT_SHA_FILE_REL"
  log "cleaning vendored build outputs"
  for entry in "${VENDORED_BUILDS[@]}"; do
    dir="${entry%%|*}"
    [ -d "$PDPP_DC_REF/$dir" ] || continue
    rm -rf "$PDPP_DC_REF/$dir/dist"
  done

  log "building vendored workspace packages"
  # connector-protocol is a root-level workspace that npm install does not build
  # while lifecycle scripts are disabled above; the others import one another.
  for entry in "${VENDORED_BUILDS[@]}"; do
    dir="${entry%%|*}"
    [ -d "$PDPP_DC_REF/$dir" ] || continue
    mkdir -p "$STATE_ROOT"
    buildlog="$(mktemp "$STATE_ROOT/build.XXXXXX")"
    if (cd "$PDPP_DC_REF/$dir" && npm run build --if-present) >"$buildlog" 2>&1; then
      log "  built $dir"
      rm -f "$buildlog"
    else
      log "  $dir build FAILED; last output:"
      tail -20 "$buildlog" >&2 || true
      rm -f "$buildlog"
      die "$dir build failed; refusing to use or stamp a partial build."
    fi
  done

  build_outputs_present ||
    die "a vendored build exited zero but left a required output missing or empty; the reference server cannot boot (it statically imports vendor/mcp-server at server/index.ts:16)."
  if ! checkout_dirty; then
    checkout_head > "$PDPP_DC_REF/$BUILT_SHA_FILE_REL"
  fi
}

# Boot the server as a direct child of this script and keep its PID in memory.
boot_server() {
  # The entrypoint lives in the run dir, so the checkout under test stays
  # untouched; it imports the server by absolute path.
  local boot_file="$RUN_DIR/pdpp-conformance-boot.mts"
  cat > "$boot_file" <<BOOT
import { startServer } from "$PDPP_DC_REF/reference-implementation/server/index.ts";
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

  # `node --import tsx` rather than the tsx launcher: one process, so stopping
  # the PID stops the server and nothing is left behind as a grandchild.
  [ -d "$PDPP_DC_REF/node_modules/tsx" ] || [ -d "$PDPP_DC_REF/reference-implementation/node_modules/tsx" ] ||
    die "no tsx under $PDPP_DC_REF; run: $0 install"
  # Where available, PDEATHSIG makes the kernel stop the server if this script
  # is killed uncatchably (SIGKILL), which no trap can handle.
  local guard=()
  if command -v setpriv >/dev/null 2>&1; then
    guard=(setpriv --pdeathsig SIGTERM)
  else
    log "NOTE: setpriv not found; a SIGKILL of this script would leave the server running"
  fi
  GUARD=("${guard[@]}")
  log "starting server"
  (
    cd "$PDPP_DC_REF/reference-implementation"
    # Draft connections (a second instance of one connector) are refused unless
    # an operator credential-encryption key is configured. Nothing is encrypted
    # in these runs; the key is random and lives only in this process.
    PDPP_CREDENTIAL_ENCRYPTION_KEY="$(head -c 32 /dev/urandom | base64)" \
      exec "${guard[@]}" node --import tsx "$boot_file" > "$LOG_FILE" 2>&1 < /dev/null
  ) &
  SERVER_PID=$!
  SERVER_START=$(proc_start_time "$SERVER_PID" || true)
  log "owned PID $SERVER_PID (start time ${SERVER_START:-unknown}), log $LOG_FILE"
  wait_until_ready || die "server did not become ready."
}

# Seed over HTTP with an owner token. Records are NDJSON RECORD envelopes per
# Core Section 4; the connector runtime is not used because it requires
# in-process database access and this path stays black-box.
cmd_seed() {
  log "minting an owner token via the device-code flow"
  local device user_code device_code owner_token
  local client_id
  client_id=$(curl -fsS -X POST "http://127.0.0.1:$AS_PORT/oauth/register" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $DCR_TOKEN" \
    --data '{"client_name":"pdpp-reference-target-seeder","redirect_uris":["http://127.0.0.1/conformance-seeder"]}' |
    python3 -c 'import json,sys;print(json.load(sys.stdin)["client_id"])') ||
    die "seeder client registration failed"
  device=$(curl -fsS -X POST "http://127.0.0.1:$AS_PORT/oauth/device_authorization" \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    --data-urlencode "client_id=$client_id") || die "device authorization failed"
  user_code=$(printf '%s' "$device" | python3 -c 'import json,sys;print(json.load(sys.stdin)["user_code"])')
  device_code=$(printf '%s' "$device" | python3 -c 'import json,sys;print(json.load(sys.stdin)["device_code"])')

  curl -fsS -o /dev/null -X POST "http://127.0.0.1:$AS_PORT/device/approve" \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    --data-urlencode "subject_id=$SUBJECT_ID" \
    --data-urlencode "user_code=$user_code" || die "device approval failed"

  owner_token=$(curl -fsS -X POST "http://127.0.0.1:$AS_PORT/oauth/token" \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    --data-urlencode "client_id=$client_id" \
    --data-urlencode "device_code=$device_code" \
    --data-urlencode 'grant_type=urn:ietf:params:oauth:grant-type:device_code' |
    python3 -c 'import json,sys;print(json.load(sys.stdin)["access_token"])') ||
    die "owner token redemption failed"

  # The registered declaration is the RI's own github seed manifest plus two
  # streams that carry a `blob_ref` field, so the blob endpoint has a stored
  # blob to be asked for (RS-1) and a second blob no grant over the first
  # stream can reach. The suite's seeded `streams` list does not name them; only
  # the blob fixture hook uses them.
  log "registering the connector manifest"
  local manifest="$RUN_DIR/conformance-github-manifest.json"
  python3 - "$PDPP_DC_REF/reference-implementation/fixtures/seed-manifests/github.json" "$manifest" <<'PY'
import copy, json, sys
manifest = json.load(open(sys.argv[1]))
template = next(s for s in manifest["streams"] if s["name"] == "repositories")
for name in ("conformance_attachments", "conformance_private_attachments"):
    stream = copy.deepcopy(template)
    stream["name"] = name
    stream["description"] = "Blob-bearing stream used by the conformance suite's blob fixture"
    stream["schema"] = {
        "type": "object",
        "properties": {
            "id": {"type": "string"},
            "name": {"type": "string"},
            "updated_at": {"type": "string", "format": "date-time"},
            "blob_ref": {
                "type": "object",
                "properties": {
                    "blob_id": {"type": "string"},
                    "mime_type": {"type": "string"},
                    "size_bytes": {"type": "integer"},
                    "sha256": {"type": "string"},
                },
                "required": ["blob_id"],
                "additionalProperties": True,
            },
        },
        "required": ["id", "name"],
    }
    stream["cursor_field"] = "updated_at"
    stream.pop("consent_time_field", None)
    stream.pop("views", None)
    manifest["streams"].append(stream)
events = copy.deepcopy(template)
events.update({"name": "conformance_events", "description": "Append-only conformance events",
               "semantics": "append_only", "primary_key": ["id"], "cursor_field": "occurred_at",
               "schema": {"type": "object", "properties": {
                   "id": {"type": "string"}, "public_value": {"type": "string"},
                   "hidden_value": {"type": "string"}, "occurred_at": {"type": "string", "format": "date-time"}},
                   "required": ["id", "public_value", "occurred_at"]}})
events.pop("views", None)
events.pop("consent_time_field", None)
manifest["streams"].append(events)
json.dump(manifest, open(sys.argv[2], "w"))
PY
  curl -sS -o "$RUN_DIR/manifest-registration.out" -w '%{http_code}' -X POST "http://127.0.0.1:$AS_PORT/connectors" \
    -H 'Content-Type: application/json' \
    --data-binary "@$manifest" | grep -q '^2' ||
    log "connector registration returned non-2xx: $(head -c 600 "$RUN_DIR/manifest-registration.out")"

  # A second connector whose declaration lets the owner open several draft
  # connections, so one connector can have more than one instance. The
  # multi-instance fan-in fixture builds on it.
  log "registering the fan-in connector manifest"
  local fanin="$RUN_DIR/conformance-fanin-manifest.json"
  python3 - "$PDPP_DC_REF/reference-implementation/fixtures/seed-manifests/github.json" "$fanin" <<'PY'
import copy, json, sys
manifest = json.load(open(sys.argv[1]))
template = next(s for s in manifest["streams"] if s["name"] == "repositories")
stream = copy.deepcopy(template)
stream["name"] = "conformance_items"
stream["description"] = "Items used by the conformance suite's multi-instance fixture"
stream["schema"] = {
    "type": "object",
    "properties": {
        "id": {"type": "string"},
        "name": {"type": "string"},
        "seen_at": {"type": ["string", "null"], "format": "date-time"},
    },
    "required": ["id", "name"],
}
stream["cursor_field"] = "seen_at"
stream.pop("consent_time_field", None)
stream.pop("views", None)
manifest["streams"] = [stream]
manifest.pop("profiles", None)
manifest["connector_id"] = "conformance-fanin"
manifest["connector_key"] = "conformance-fanin"
manifest["manifest_uri"] = "https://registry.pdpp.dev/connectors/conformance-fanin"
manifest["display_name"] = "Conformance fan-in"
manifest["setup"] = {
    "credential_capture": {
        "kind": "api_key",
        "label": "API key",
        "fields": [
            {"name": "api_key", "label": "API key", "type": "password", "env": ["CONFORMANCE_FANIN_KEY"], "secret": True}
        ],
    }
}
json.dump(manifest, open(sys.argv[2], "w"))
PY
  curl -sS -o "$RUN_DIR/fanin-registration.out" -w '%{http_code}' -X POST "http://127.0.0.1:$AS_PORT/connectors" \
    -H 'Content-Type: application/json' \
    --data-binary "@$fanin" | grep -q '^2' ||
    log "fan-in connector registration returned non-2xx: $(head -c 600 "$RUN_DIR/fanin-registration.out")"

  log "ingesting records"
  local stream ndjson
  for stream in repositories starred conformance_events; do
    ndjson=$(python3 - "$stream" "$OUT_DIR/fixture-truth.json" <<'PY'
import json, sys
stream = sys.argv[1]
if stream == "repositories":
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
elif stream == "starred":
    rows = [
        {"id": "star_1", "full_name": "other/one", "description": "starred one",
         "language": "Rust", "stargazers_count": 100, "starred_at": "2026-01-10T00:00:00Z"},
        {"id": "star_2", "full_name": "other/two", "description": "starred two",
         "language": "Python", "stargazers_count": 200, "starred_at": "2026-01-20T00:00:00Z"},
    ]
else:
    rows = [{"id": "event_1", "public_value": "visible event", "hidden_value": "private event",
             "occurred_at": "2026-02-10T00:00:00Z"}]
# Expected truth comes from the authored inputs, never an RS readback.
from pathlib import Path
truth_path = Path(sys.argv[2])
truth = json.loads(truth_path.read_text()) if truth_path.exists() else {"streams": {}}
truth["streams"][stream] = rows
truth_path.write_text(json.dumps(truth, indent=2) + "\n")
print("\n".join(json.dumps({"type": "RECORD", "stream": stream, "key": r["id"],
                            "data": r, "emitted_at": "2026-03-01T00:00:00Z"}) for r in rows))
PY
    )
    curl -fsS -X POST \
      "http://127.0.0.1:$RS_PORT/v1/ingest/$stream?connector_id=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$CONNECTOR_ID")&collection_mode=full_refresh" \
      -H 'Content-Type: application/x-ndjson' \
      -H "Authorization: Bearer $owner_token" \
      --data-binary "$ndjson" || die "ingest of $stream failed"
    printf '\n' >&2
  done
  # Provision equal keys under separate connection handles independently of
  # the fan-in pagination fixture (whose oracle needs globally unique ids).
  python3 - "$AS_PORT" "$RS_PORT" "$OUT_DIR/fixture-truth.json" "$DCR_TOKEN" <<'PY'
import json, sys, urllib.request, urllib.parse
as_url, rs_url = (f"http://127.0.0.1:{port}" for port in sys.argv[1:3])
def post(url, data, token=None, form=False, ndjson=False):
    content_type = "application/x-ndjson" if ndjson else "application/x-www-form-urlencoded" if form else "application/json"
    body = data if ndjson else urllib.parse.urlencode(data) if form else json.dumps(data)
    headers = {"Content-Type": content_type, "Accept": "application/json"}
    if token: headers["Authorization"] = "Bearer " + token
    with urllib.request.urlopen(urllib.request.Request(url, body.encode(), headers)) as response:
        body = response.read()
        return None if url.endswith("/device/approve") else json.loads(body)
client = post(as_url + "/oauth/register", {"client_name": "conformance-isolated-instances", "redirect_uris": ["http://127.0.0.1/conformance-seeder"]}, sys.argv[4])["client_id"]
device = post(as_url + "/oauth/device_authorization", {"client_id": client}, form=True)
post(as_url + "/device/approve", {"subject_id": "owner_local", "user_code": device["user_code"]}, form=True)
token = post(as_url + "/oauth/token", {"client_id": client, "device_code": device["device_code"], "grant_type": "urn:ietf:params:oauth:grant-type:device_code"}, form=True)["access_token"]
connections = []
for label in ("first", "second"):
    instance = post(as_url + "/_ref/connectors/conformance-fanin/draft-connection", {}, token)["connector_instance_id"]
    data = {"id": "equal_key", "name": label + " connection value", "seen_at": "2026-03-01T00:00:00Z"}
    line = json.dumps({"type": "RECORD", "stream": "conformance_items", "key": "equal_key", "data": data, "emitted_at": "2026-03-01T00:00:00Z"})
    query = urllib.parse.urlencode({"connector_id": "conformance-fanin", "connector_instance_id": instance})
    result = post(rs_url + "/v1/ingest/conformance_items?" + query, line, token, ndjson=True)
    if result.get("records_accepted") != 1: raise RuntimeError("equal-key fixture ingest refused")
    connections.append({"instance_id": instance, "stream": "conformance_items", "key": "equal_key", "data": data})
with open(sys.argv[3]) as source: truth = json.load(source)
truth["isolated_connections"] = {"subject_id": "owner_local", "source_id": "https://registry.pdpp.dev/connectors/conformance-fanin", "records": connections}
# The adapter later provisions these exact independent byte inputs lazily.
import hashlib
shared = b"PDPP conformance shared persisted blob\n" * 64
private = b"PDPP conformance private-only persisted blob\n" * 32
truth["blobs"] = [{"sha256": hashlib.sha256(data).hexdigest(), "length": len(data), "references": refs} for data, refs in (
    (shared, ["conformance_private_attachments/att_shared_private", "conformance_attachments/att_1"]),
    (private, ["conformance_private_attachments/att_private_1"]))]
with open(sys.argv[3], "w") as output: json.dump(truth, output, indent=2); output.write("\n")
# Supplemental explicit-choice evidence uses the real PAR/review/approval
# journey. These probes are separate from the normative suite case counts.
import urllib.error
results = []
def is_omission_refusal(stage, status, body):
    if stage not in ("PAR", "review") or status != 400: return False
    try:
        parsed = json.loads(body)
    except ValueError:
        return False
    if not isinstance(parsed, dict): return False
    refusal = parsed.get("error")
    if not isinstance(refusal, dict): return False
    message = refusal.get("message")
    return (refusal.get("code") == "source.authorization_details_invalid" and isinstance(message, str)
        and "Omitted instance_ids requires exactly one eligible instance" in message and "found 2" in message)
def issue_choice(instance_ids):
    selection = {"name": "conformance_items", "fields": ["id", "name", "seen_at"]}
    if instance_ids is not None: selection["instance_ids"] = instance_ids
    detail = {"type": "https://pdpp.dev/data-access", "source": {"kind": "connector", "id": truth["isolated_connections"]["source_id"]},
              "purpose_code": "https://pdpp.dev/purpose/personal_analytics", "access_mode": "continuous", "streams": [selection]}
    stage = "PAR"
    try:
        staged = post(as_url + "/oauth/par", {"client_id": client, "client_display": {"name": "conformance-isolated-instances"}, "authorization_details": [detail]})
        stage = "review"
        reviewed = post(as_url + "/consent/review", {"request_uri": staged["request_uri"], "subject_id": "owner_local"})
        stage = "approval"
        return post(as_url + "/consent/approve", {"request_uri": staged["request_uri"], "approval_review_revision": reviewed["approval_review_revision"]})
    except urllib.error.HTTPError as error:
        error.conformance_stage = stage
        raise
for record in connections:
    try:
        issued = issue_choice([record["instance_id"]])
        selected = next(s for s in issued["grant"]["streams"] if s["name"] == "conformance_items")["instance_ids"]
        request = urllib.request.Request(rs_url + "/v1/streams/conformance_items/records", headers={"Authorization": "Bearer " + issued["token"]})
        with urllib.request.urlopen(request) as response: rows = json.load(response)["data"]
        actual = [row.get("data", row) for row in rows]
        ok = selected == [record["instance_id"]] and actual == [record["data"]]
        results.append({"case": "explicit-single-instance-choice", "instance_id": record["instance_id"], "outcome": "pass" if ok else "fail", "expected": [record["data"]], "actual": actual, "granted_instance_ids": selected})
    except urllib.error.HTTPError as error:
        results.append({"case": "explicit-single-instance-choice", "instance_id": record["instance_id"], "outcome": "fail", "http_status": error.code, "body": error.read().decode()[:500]})
    except (KeyError, StopIteration, TypeError, ValueError) as error:
        results.append({"case": "explicit-single-instance-choice", "instance_id": record["instance_id"], "outcome": "skip", "reason": "provisioning/readback shape unavailable: " + str(error)})
positive_controls_passed = len(results) == 2 and all(result["outcome"] == "pass" for result in results)
if not positive_controls_passed:
    results.append({"case": "no-implicit-fan-in", "outcome": "skip", "reason": "Both explicit instance-choice positive controls must pass first"})
else:
    try:
        issued = issue_choice(None)
        selected = next(s for s in issued["grant"]["streams"] if s["name"] == "conformance_items").get("instance_ids", [])
        results.append({"case": "no-implicit-fan-in", "outcome": "pass" if len(selected) == 1 else "fail", "granted_instance_ids": selected})
    except urllib.error.HTTPError as error:
        body = error.read().decode()
        stage = getattr(error, "conformance_stage", "unknown")
        specific_omission_refusal = is_omission_refusal(stage, error.code, body)
        results.append({"case": "no-implicit-fan-in", "outcome": "pass" if specific_omission_refusal else "skip", "stage": stage, "http_status": error.code, "body": body[:500],
                        "reason": "Omitted instance selection rejected before approval" if specific_omission_refusal else "Unrelated refusal does not prove instance-selection enforcement"})
    except (KeyError, StopIteration, TypeError, ValueError) as error:
        results.append({"case": "no-implicit-fan-in", "outcome": "skip", "reason": "issuance readback unavailable: " + str(error)})
from pathlib import Path
output_dir = Path(sys.argv[3]).parent
(output_dir / "instance-choice-probes.json").write_text(json.dumps({"scope": "supplemental reference topology probes; separate from normative suite counts", "results": results}, indent=2) + "\n")
(output_dir / "instance-choice-probes.md").write_text("# Reference instance choice probes\n\nSupplemental reference topology probes; separate from normative suite counts.\n\n" + "\n".join(f"- {result['case']}: **{result['outcome']}**" for result in results) + "\n")
PY
  log "seeded"
}

# Stop exactly the child this run started: $1 is its PID and $2 the start time
# recorded at spawn. Every signal is preceded by an identity check, so a PID the
# kernel has since given to another process is never signalled. (The check and
# the signal are two steps; the window is microseconds and the process would
# also have to have been created, with the same PID, inside it.) A child that
# already exited is just reaped.
stop_owned() {
  local pid="$1" start="$2"
  [ -n "$pid" ] || return 0
  if owned_alive "$pid" "$start"; then
    log "stopping owned PID $pid"
    kill -TERM "$pid" 2>/dev/null || true
    local i
    for i in $(seq 1 20); do
      owned_alive "$pid" "$start" || break
      sleep 0.5
    done
    if owned_alive "$pid" "$start"; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
    wait "$pid" 2>/dev/null || true
  else
    log "owned PID $pid is already gone (or its number was reused); not signalling"
  fi
}

stop_all() {
  local suite="$SUITE_PID" suite_start="$SUITE_START" server="$SERVER_PID" server_start="$SERVER_START"
  SUITE_PID=""
  SUITE_START=""
  SERVER_PID=""
  SERVER_START=""
  stop_owned "$suite" "$suite_start"
  stop_owned "$server" "$server_start"
}

# Per-run target config: the committed template with this run's URLs and the
# actual data-connect version. The template is never edited.
write_target_config() {
  python3 - "$PACKAGE_DIR/targets/reference-implementation.json" "$RUN_DIR/target.json" \
    "$AS_PORT" "$RS_PORT" "$(actual_target_version)" <<'PY'
import json, sys
template, out, as_port, rs_port, version = sys.argv[1:6]
config = json.load(open(template))
config["asUrl"] = f"http://127.0.0.1:{as_port}"
config["rsUrl"] = f"http://127.0.0.1:{rs_port}"
config["targetVersion"] = version
config["streams"].append({"name": "conformance_events", "fields": ["id", "public_value", "hidden_value", "occurred_at"],
    "primaryKey": ["id"], "cursorField": "occurred_at", "semantics": "append_only",
    "recordCount": 1, "expectedOwnerMetadata": {"schemaRequired": ["id", "public_value", "occurred_at"]}})
config["foreignSubjectRecordIds"]["conformance_events"] = []
json.dump(config, open(out, "w"), indent=2)
PY
}

# Inner half of `run`: everything that needs no network. Boot, run the suite,
# always stop the owned process, and return the suite's exit code.
cmd_run_inner() {
  local out="$1" rc=0
  OUT_DIR="$out"
  mkdir -p "$STATE_ROOT"
  RUN_DIR="$(mktemp -d "$STATE_ROOT/run.XXXXXX")"
  LOG_FILE="$RUN_DIR/server.log"
  DB_FILE="$RUN_DIR/conf.sqlite"
  # Held for the life of this process: a second run cannot adopt this directory.
  exec 9>"$RUN_DIR/lock"
  flock -n 9 || die "run directory $RUN_DIR is locked by another run"

  trap 'stop_all; cp "$LOG_FILE" "$OUT_DIR/server.log" 2>/dev/null || true; rm -rf "$RUN_DIR"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM HUP

  AS_PORT="${PDPP_REF_AS_PORT:-$(free_port)}"
  RS_PORT="${PDPP_REF_RS_PORT:-$(free_port)}"
  [ "$AS_PORT" != "$RS_PORT" ] || RS_PORT="$(free_port)"
  port_is_free "$AS_PORT" || die "AS port $AS_PORT is already in use"
  port_is_free "$RS_PORT" || die "RS port $RS_PORT is already in use"

  write_target_config
  cp "$RUN_DIR/target.json" "$out/target.json"
  boot_server
  cmd_seed
  log "running the suite against :$AS_PORT/:$RS_PORT ($(actual_target_version))"
  # Backgrounded and waited on so a TERM/INT reaches the trap promptly instead
  # of after the suite finishes; one exec'd process, so SUITE_PID is the suite.
  (
    cd "$PACKAGE_DIR"
    exec "${GUARD[@]}" node --import tsx src/cli.ts --target "$RUN_DIR/target.json" \
      --json "$out/report.json" --markdown "$out/report.md" --requirements-json "$out/requirements.json" > "$out/suite.stdout" 2> "$out/suite.stderr"
  ) &
  SUITE_PID=$!
  SUITE_START=$(proc_start_time "$SUITE_PID" || true)
  wait "$SUITE_PID" || rc=$?
  SUITE_PID=""
  SUITE_START=""
  log "suite exit code $rc"
  return "$rc"
}

# The files one run writes into its output directory. A run clears exactly these
# (never the rest of the directory) so a previous run's report cannot be mistaken
# for this run's, even when this run fails before writing its own.
OUT_FILES=(baseline.json baseline.md fixture-truth.json instance-choice-probes.json instance-choice-probes.md target.json report.json report.md requirements.json suite.stdout suite.stderr server.log sandbox-receipt.json)

# Claim an output directory for this run: hold an exclusive lock for the life of
# the process (a second run on the same directory is refused, not interleaved),
# then remove only the files a run owns.
claim_out_dir() {
  local out="$1" f
  exec 7>"$out/.run.lock"
  flock -n 7 || die "output directory $out is in use by another run; choose a different --out or wait."
  for f in "${OUT_FILES[@]}"; do
    rm -f "$out/$f"
  done
}

cmd_run() {
  # Unless --out / PDPP_CONF_OUT names a directory, every run gets its own, so
  # two ordinary invocations from one directory cannot overwrite each other.
  local out="${PDPP_CONF_OUT:-}" explicit=0
  [ -z "$out" ] || explicit=1
  while [ $# -gt 0 ]; do
    case "$1" in
      --out) [ $# -ge 2 ] || die "--out needs a directory"; out="$2"; explicit=1; shift 2 ;;
      *) die "unknown run option: $1" ;;
    esac
  done
  if [ "$explicit" = 0 ]; then
    mkdir -p ./conformance-ri-out
    out="$(mktemp -d ./conformance-ri-out/run.XXXXXX)"
  fi
  mkdir -p "$out"
  out="$(cd "$out" && pwd)"
  claim_out_dir "$out"
  log "output directory: $out"
  require_checkout
  check_pin

  # Installing needs the network, so it happens before the sandbox is entered.
  # `cmd_install` is a no-op when the checkout is already built from its HEAD.
  cmd_install

  local rc=0
  if command -v test-sandbox >/dev/null 2>&1; then
    log "running boot -> suite -> stop inside one test-sandbox --net none invocation"
    test-sandbox --net none --receipt "$out/sandbox-receipt.json" -- \
      bash "$SCRIPT_PATH" _run-inner "$out" || rc=$?
  else
    log "NOTE: test-sandbox is not on PATH; running the same sequence WITHOUT network isolation or cgroup limits"
    bash "$SCRIPT_PATH" _run-inner "$out" || rc=$?
  fi
  log "reports: $out/report.json $out/report.md (exit $rc: 0 complete pass, 1 failures, 2 incomplete coverage)"
  return "$rc"
}

# Dispatch only when executed, so tests can `source` this file for its functions.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  case "${1:-}" in
    run) shift; cmd_run "$@" ;;
    _run-inner) shift; cmd_run_inner "$@" ;;
    install) cmd_install ;;
    *)
      printf 'usage: %s {run [--out DIR]|install}\n' "$0" >&2
      exit 2
      ;;
  esac
fi
