#!/usr/bin/env bash
# Copyright The PDP-Connect Contributors
# SPDX-License-Identifier: Apache-2.0
#
# Bring up the Vana Personal Server's composed PDPP AS + RS as a conformance
# target, seed it, and tear it back down.
#
# Why this exists: the first runs against this target were a local untracked
# boot file plus a page of `POST ...` comments in a README. That is a recipe,
# not a procedure — nobody else could execute it, and the seeding step in
# particular (which instance handle, how many records, into which streams)
# silently decides whether five requirements are TESTED or merely SKIPPED.
# Everything that affected the published result is in this file.
#
# THE TARGET IS A COMPOSITION, and it is the integration owner's composition,
# not this suite's. That distinction is the whole point of how this is pinned.
#
# A PDPP deployment needs both halves, and for a while no single published ref
# had them: `feat/pdpp-record-storage-rs` carries the Resource Server and its
# query-surface fixes but DELETES the AS (no routes/pdpp-auth.ts, no
# pdpp/bootstrap.ts), so the authorize -> review -> approve -> PKCE journey the
# suite's adapter drives cannot run against it and a verdict there would be
# skips rather than findings. The suite briefly hand-merged the two to get a
# runnable target. That was a stopgap and is no longer what this does.
#
# The integration owner now publishes the composed tree, and PDPP_VANA_REF
# points at it. A conformance suite must not decide what the implementation
# under test consists of -- if it hand-assembles its own target it can report a
# result for a tree nobody ships. When they publish a new commit, override the
# ref rather than editing this file:
#   PDPP_VANA_REF=<their new sha> scripts/vana-target.sh up
#
# Setting PDPP_VANA_RS_REF additionally merges a second ref into PDPP_VANA_REF,
# for the narrow case of testing a fix before its owner has composed it. That is
# a debugging affordance, not the supported path: a result obtained that way is
# a result about a tree that exists only on the runner's disk, and the report
# must say so.
#
# Lifecycle safety: `stop` kills ONLY the PID recorded in the state directory.
# It never pattern-matches process names — a broad `pkill -f tsx` twice took out
# the caller's own shell during development of the sibling reference target.
#
# Usage:
#   vana-target.sh up      # compose, install, build, boot, seed, wait for ready
#   vana-target.sh env     # print the export line the suite needs (eval this)
#   vana-target.sh seed    # re-seed records only
#   vana-target.sh status  # is the owned process alive and answering?
#   vana-target.sh stop    # terminate the owned PID and clean up temp state
#
# Environment:
#   PDPP_VANA_PS         personal-server-ts checkout to run from (required)
#   PDPP_VANA_REF        the composed ref to test   (default below)
#   PDPP_VANA_RS_REF     optional extra ref to merge in (unsupported, see above)
#   PDPP_VANA_PORT       port to listen on          (default 8420)
#   PDPP_VANA_STATE_DIR  pid/db/log directory       (default mktemp -d)

set -euo pipefail

# The integration owner's composed tree in vana-com/personal-server-ts:
# origin/main + feat/pdpp-as-grants + feat/pdpp-record-storage-rs + integration
# work, carrying both PDPP halves and all three conformance fixes.
VANA_REF="${PDPP_VANA_REF:-5e98085}"
# Empty on the supported path. See the header before setting it.
EXTRA_REF="${PDPP_VANA_RS_REF:-}"
COMPOSED_BRANCH="pdpp-conformance-composed"

PORT="${PDPP_VANA_PORT:-8420}"
# A temp dir by default: this target's state is disposable, and a fixed path
# under $HOME made two concurrent runs silently share one SQLite file.
STATE_DIR="${PDPP_VANA_STATE_DIR:-$(mktemp -d -t pdpp-vana-target-XXXXXX)}"
PID_FILE="$STATE_DIR/server.pid"
LOG_FILE="$STATE_DIR/server.log"
ENV_FILE="$STATE_DIR/target.env"
BOOT_FILE_NAME="pdpp-conformance-boot.mts"

SOURCE_ID="https://registry.pdpp.dev/connectors/spotify"
CLIENT_ID="music_recommendations"
REDIRECT_URI="https://app.example.com/callback"
BASE_URL="http://127.0.0.1:$PORT"

# Both streams are declared and seeded on purpose. The stream-membership
# oracles (RS-2 enforcement, RS-6 error classification) work by holding one
# stream OUT of the grant, so a single-stream deployment can only report `skip`
# on them. TOP_ARTISTS_COUNT is >1 for the same reason: a stream too short to
# produce a page cursor cannot exercise the cursor/changes_since token-space
# separation case. These numbers are load-bearing on coverage, not decoration.
GRANTED_STREAM="top_artists"
UNGRANTED_STREAM="saved_tracks"
TOP_ARTISTS_COUNT=5
SAVED_TRACKS_COUNT=3

READY_TIMEOUT_SECONDS=180

log() { printf '[vana-target] %s\n' "$*" >&2; }

die() {
  log "ERROR: $*"
  exit 1
}

require_checkout() {
  [ -n "${PDPP_VANA_PS:-}" ] ||
    die "PDPP_VANA_PS must point at a personal-server-ts checkout."
  [ -d "$PDPP_VANA_PS/packages/server" ] ||
    die "$PDPP_VANA_PS has no packages/server directory."
}

# Check out the ref under test. On the supported path this is one checkout of
# the integration owner's published composition and nothing more.
cmd_compose() {
  require_checkout
  local git="git -C $PDPP_VANA_PS"

  $git rev-parse --verify --quiet "$VANA_REF^{commit}" >/dev/null ||
    die "ref $VANA_REF not found in $PDPP_VANA_PS. Fetch it first:
  git -C $PDPP_VANA_PS fetch origin waspflow/pdpp-integrated-journey-0917"

  # Refuse to discard uncommitted work in someone else's checkout.
  if [ -n "$($git status --porcelain --untracked-files=no)" ]; then
    die "$PDPP_VANA_PS has uncommitted changes; commit or stash them first."
  fi

  log "checking out $VANA_REF -> $COMPOSED_BRANCH"
  $git checkout -B "$COMPOSED_BRANCH" "$VANA_REF" >/dev/null 2>&1 ||
    die "could not check out $VANA_REF"

  if [ -n "$EXTRA_REF" ]; then
    log "WARNING: merging $EXTRA_REF on top of $VANA_REF."
    log "WARNING: the result is a tree that exists only on this machine."
    log "WARNING: any report from this run must say so."
    $git rev-parse --verify --quiet "$EXTRA_REF^{commit}" >/dev/null ||
      die "extra ref $EXTRA_REF not found in $PDPP_VANA_PS."
    $git merge --no-edit "$EXTRA_REF" >/dev/null 2>&1 ||
      die "merging $EXTRA_REF into $VANA_REF conflicts. Resolve it by hand and
re-run with PDPP_VANA_REF pointed at your merge commit, so the ref under test
names exactly what was tested."
  fi

  local head
  head=$($git rev-parse --short HEAD)
  log "  tree under test: $head"

  # Fail closed if the AS is absent. A ref carrying only the RS passes every
  # check above and then produces a report full of skips that reads like a thin
  # result rather than the wrong target.
  [ -f "$PDPP_VANA_PS/packages/server/src/routes/pdpp-auth.ts" ] ||
    die "$head has no packages/server/src/routes/pdpp-auth.ts, so it serves no
authorization server and the consent journey cannot run. A resource-server-only
ref (e.g. feat/pdpp-record-storage-rs) is not a conformance target on its own --
use the integration owner's composed ref."
}

cmd_build() {
  require_checkout
  # `--allow-git=root` is required because a dependency is a pinned git
  # reference. npm's default `allow-git=none` is a local POLICY setting, not a
  # network restriction — the registry is reachable either way. Scoped to root
  # so a transitive git dependency added later still has to be reviewed.
  # `--ignore-scripts` first because workspace `prepare` scripts build one
  # another before the links they need exist; native modules are built after.
  log "installing dependencies"
  (cd "$PDPP_VANA_PS" && npm install --allow-git=root --no-audit --no-fund --ignore-scripts) ||
    die "dependency install failed; see the npm output above."

  log "building native modules"
  (cd "$PDPP_VANA_PS" && npm rebuild better-sqlite3 secp256k1 esbuild) ||
    die "native module build failed."

  log "building @opendatalabs/personal-server-ts-core"
  (cd "$PDPP_VANA_PS/packages/core" && npm run build) ||
    die "core build failed."
}

# The boot entrypoint is generated rather than committed to the server repo, so
# this script owns every input that shapes the run.
write_boot_file() {
  cat > "$PDPP_VANA_PS/$BOOT_FILE_NAME" <<BOOT
// Generated by packages/conformance-suite/scripts/vana-target.sh. Do not edit.
//
// Boots the composed PDPP AS + RS over plain HTTP. Configuration mirrors
// packages/server/src/pdpp-live-http-journey.test.ts, the integration lane's
// own verified recipe: a declaration file, a pre-registered client whose
// redirect_uri matches exactly, a data_files scope row per stream, and the
// owner signature. Nothing about the server is modified.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

const STATE = "$STATE_DIR";
const PORT = $PORT;

// A fixed dev-only signature for a throwaway local server. It authorizes
// nothing beyond this process and its temp state directory.
process.env.VANA_MASTER_KEY_SIGNATURE =
  "0xedbb7743cce459345238442dcfb291f234a321d253485eaa58251aa0f28ea8f1410ab988bae2657b689cd24417b41e315efc22ba333024f4a6269c424ded8d361b";

const SOURCE_ID = "$SOURCE_ID";
const CLIENT_ID = "$CLIENT_ID";
const REDIRECT = "$REDIRECT_URI";
// One scope row per declared stream: declaration trust is derived from what the
// server actually serves, so a declaration is refused without a matching row.
const SCOPES = ["spotify.$GRANTED_STREAM", "spotify.$UNGRANTED_STREAM"];

const { ServerConfigSchema } = await import(
  "@opendatalabs/personal-server-ts-core/schemas"
);
const { createServer } = await import("./packages/server/src/bootstrap.js");
const { listenHttpServer } = await import("./packages/server/src/listen.js");
const { initializeDatabase } = await import(
  "./packages/server/src/storage/index-schema.js"
);

await mkdir(join(STATE, "declarations"), { recursive: true });
await mkdir(join(STATE, "data"), { recursive: true });

const declarationPath = join(STATE, "declarations", "spotify.json");
await writeFile(
  declarationPath,
  JSON.stringify({
    source_id: SOURCE_ID,
    source_kind: "connector",
    version: "2026-08-11",
    streams: [
      {
        name: "$GRANTED_STREAM",
        fields: ["id", "name", "genres", "source_updated_at"],
        required_fields: ["id"],
        consent_time_field: "source_updated_at",
        primary_key: ["id"],
      },
      {
        name: "$UNGRANTED_STREAM",
        fields: ["id", "title", "artist", "source_updated_at"],
        required_fields: ["id"],
        consent_time_field: "source_updated_at",
        primary_key: ["id"],
      },
    ],
  }),
  "utf-8"
);

const db = initializeDatabase(join(STATE, "index.db"));
const insertScope = db.prepare(
  \`INSERT OR IGNORE INTO data_files (file_id, path, scope, collected_at, size_bytes)
   VALUES (?, ?, ?, ?, ?)\`
);
SCOPES.forEach((scope, i) => {
  insertScope.run(
    \`file-\${i + 1}\`,
    \`\${scope.split(".").join("/")}/2026-01-01T00:00:00Z.json\`,
    scope,
    "2026-01-01T00:00:00Z",
    128
  );
});
db.close();

const config = ServerConfigSchema.parse({
  tunnel: { enabled: false },
  pdpp: {
    enabled: true,
    declarationPaths: [declarationPath],
    clients: [{ clientId: CLIENT_ID, redirectUris: [REDIRECT] }],
  },
});

const ctx = await createServer(config, {
  serverDir: STATE,
  dataDir: join(STATE, "data"),
});

let bound: AddressInfo | undefined;
await listenHttpServer({
  fetch: ctx.app.fetch,
  port: PORT,
  hostname: "127.0.0.1",
  onListening: (info: AddressInfo) => {
    bound = info;
  },
});

// The owner credential is minted fresh at every boot, so it is printed for the
// launcher to capture rather than persisted anywhere in the repository.
console.log(
  JSON.stringify({
    ready: true,
    baseUrl: \`http://127.0.0.1:\${bound?.port ?? PORT}\`,
    devToken: ctx.devToken,
    clientId: CLIENT_ID,
    redirectUri: REDIRECT,
    sourceId: SOURCE_ID,
  })
);
BOOT
}

# Poll for the readiness line the boot file prints, rather than sleeping a fixed
# interval: boot time varies with cold caches and machine load, so a fixed sleep
# is either wasteful or flaky and reports nothing useful when it fails.
wait_until_ready() {
  local deadline=$((SECONDS + READY_TIMEOUT_SECONDS))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if grep -q '"ready":true' "$LOG_FILE" 2>/dev/null &&
      curl -fsS -o /dev/null --max-time 3 \
        "$BASE_URL/.well-known/oauth-protected-resource" 2>/dev/null; then
      log "ready after ~${SECONDS}s on :$PORT"
      return 0
    fi
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

  cmd_compose
  cmd_build
  write_boot_file

  log "starting server (state $STATE_DIR)"
  (
    cd "$PDPP_VANA_PS"
    setsid nohup npx tsx "$BOOT_FILE_NAME" > "$LOG_FILE" 2>&1 < /dev/null &
    echo $! > "$PID_FILE"
  )
  log "owned PID $(cat "$PID_FILE"), log $LOG_FILE"

  wait_until_ready || die "server did not become ready."

  # The per-boot owner token goes to a file in the disposable state directory,
  # never to the committed target config.
  local dev_token
  dev_token=$(grep -o '{"ready":true.*}' "$LOG_FILE" | tail -1 |
    python3 -c 'import json,sys;print(json.load(sys.stdin)["devToken"])') ||
    die "could not read the dev token from $LOG_FILE"
  umask 077
  printf 'export PDPP_VANA_OWNER_TOKEN=%s\n' "$dev_token" > "$ENV_FILE"

  cmd_seed
  log "run:  eval \"\$($0 env)\" && npx tsx src/cli.ts --target targets/vana-personal-server.json"
}

cmd_env() {
  [ -f "$ENV_FILE" ] || die "no target.env in $STATE_DIR; run \`$0 up\` first."
  cat "$ENV_FILE"
}

# Seed both declared streams over the owner-authenticated ingest route.
#
# The `instance` handle is not invented: it is read from a real grant review,
# which is the only surface that publishes it. Hardcoding a derived-looking
# string would work until the server changed how it derives them, then fail as a
# confusing ingest rejection.
cmd_seed() {
  [ -f "$ENV_FILE" ] || die "no target.env in $STATE_DIR; run \`$0 up\` first."
  # shellcheck disable=SC1090
  . "$ENV_FILE"

  local owner_token
  owner_token=$(curl -fsS -X POST "$BASE_URL/pdpp/v1/owner/token" \
    -H "authorization: Bearer $PDPP_VANA_OWNER_TOKEN" |
    python3 -c 'import json,sys;print(json.load(sys.stdin)["access_token"])') ||
    die "could not mint an owner token"

  log "reading the instance handle from a grant review"
  local challenge session_id instance
  challenge=$(python3 -c '
import hashlib, base64
v = "pdpp-conformance-verifier-0000000000000000000000000000"
print(base64.urlsafe_b64encode(hashlib.sha256(v.encode()).digest()).rstrip(b"=").decode())')

  session_id=$(curl -fsS -X POST "$BASE_URL/pdpp/v1/authorize" \
    -H "authorization: Bearer $owner_token" -H 'content-type: application/json' \
    -d "$(python3 - "$CLIENT_ID" "$REDIRECT_URI" "$challenge" "$SOURCE_ID" "$GRANTED_STREAM" <<'PY'
import json, sys
client_id, redirect, challenge, source_id, stream = sys.argv[1:6]
print(json.dumps({
    "client_id": client_id,
    "redirect_uri": redirect,
    "code_challenge": challenge,
    "code_challenge_method": "S256",
    "client_display": {"name": "pdpp-conformance-suite"},
    "authorization_details": [{
        "type": "https://pdpp.dev/data-access",
        "source": {"id": source_id},
        "purpose_code": "https://pdpp.dev/purpose/personalization",
        "access_mode": "continuous",
        "streams": [{"name": stream,
                     "fields": ["id", "name", "genres", "source_updated_at"]}],
    }],
}))
PY
    )" | python3 -c 'import json,sys;print(json.load(sys.stdin)["session_id"])') ||
    die "authorize failed"

  instance=$(curl -fsS "$BASE_URL/pdpp/v1/authorize/$session_id/review" \
    -H "authorization: Bearer $owner_token" |
    python3 -c '
import json, sys
review = json.load(sys.stdin)["review"]
print(review["data"]["streams"][0]["instance_ids"][0])') ||
    die "review failed; cannot determine the instance handle"
  log "  instance $instance"

  ingest_stream "$owner_token" "$instance" "$GRANTED_STREAM" "$TOP_ARTISTS_COUNT" artists
  ingest_stream "$owner_token" "$instance" "$UNGRANTED_STREAM" "$SAVED_TRACKS_COUNT" tracks
  log "seeded $GRANTED_STREAM=$TOP_ARTISTS_COUNT $UNGRANTED_STREAM=$SAVED_TRACKS_COUNT"
}

ingest_stream() {
  local owner_token="$1" instance="$2" stream="$3" count="$4" shape="$5"
  local body accepted
  body=$(python3 - "$instance" "$count" "$shape" <<'PY'
import json, sys
instance, count, shape = sys.argv[1], int(sys.argv[2]), sys.argv[3]
records = []
for i in range(1, count + 1):
    ts = f"2026-{'01' if shape == 'artists' else '02'}-{i:02d}T00:00:00Z"
    if shape == "artists":
        data = {"id": f"art_{i}", "name": f"Artist {i}",
                "genres": ["indie", "rock"], "source_updated_at": ts}
        key = f"art_{i}"
    else:
        data = {"id": f"trk_{i}", "title": f"Track {i}",
                "artist": f"Artist {i}", "source_updated_at": ts}
        key = f"trk_{i}"
    records.append({"instance": instance, "key": key, "emitted_at": ts, "data": data})
print(json.dumps(records))
PY
  )
  accepted=$(curl -fsS -X POST "$BASE_URL/v1/streams/$stream/records/ingest" \
    -H "authorization: Bearer $owner_token" -H 'content-type: application/json' \
    -d "$body" | python3 -c 'import json,sys;print(json.load(sys.stdin)["accepted"])') ||
    die "ingest into $stream failed"
  [ "$accepted" = "$count" ] ||
    die "ingest into $stream accepted $accepted of $count records"
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
      "$BASE_URL/.well-known/oauth-protected-resource" 2>/dev/null; then
      log "PID $pid alive and answering on :$PORT"
      return 0
    fi
    log "PID $pid alive but not answering on :$PORT"
    return 1
  fi
  log "recorded PID $pid is not running"
  return 1
}

# Terminate only the PID this script started. Never a pattern match.
cmd_stop() {
  if [ -f "$PID_FILE" ]; then
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
  else
    log "nothing to stop"
  fi

  # Remove the generated boot file and the credential-bearing state, so a run
  # leaves neither an untracked file in the server checkout nor a token on disk.
  rm -f "$PDPP_VANA_PS/$BOOT_FILE_NAME" 2>/dev/null || true
  rm -f "$ENV_FILE" 2>/dev/null || true
  case "$STATE_DIR" in
    */pdpp-vana-target-*) rm -rf "$STATE_DIR" && log "removed $STATE_DIR" ;;
    *) log "state dir $STATE_DIR was caller-supplied; leaving it in place" ;;
  esac
}

case "${1:-}" in
  up) cmd_up ;;
  env) cmd_env ;;
  seed) cmd_seed ;;
  status) cmd_status ;;
  stop) cmd_stop ;;
  *)
    printf 'usage: %s {up|env|seed|status|stop}\n' "$0" >&2
    exit 2
    ;;
esac
