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
# Lifecycle safety, two rules, both learned the hard way:
#
# 1. `stop` kills ONLY the PID recorded in the state directory. It never
#    pattern-matches process names — a broad `pkill -f tsx` twice took out the
#    caller's own shell during development of the sibling reference target.
#
# 2. This script NEVER writes to the checkout it is pointed at. PDPP_VANA_PS is
#    read as a source of git objects and nothing else. The tree that is built
#    and booted is a private detached worktree under the state directory,
#    removed on `stop`. Before this rule existed, `compose` ran
#    `git checkout -B pdpp-conformance-composed <ref>` inside PDPP_VANA_PS; on
#    2026-09-18 that reset a live development branch three times and dropped a
#    pushed commit. `compose` now verifies the caller's HEAD and branch are
#    unchanged when it finishes, and test/vana-target-script.test.ts fails if
#    the script regains the ability to move a branch in a directory it does not
#    own.
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
# 69816450a3fbfc9effbf037ce16dae239bc018e9 (feat/pdpp-as-grants tip) adds
# optional pdpp.clients[].grantLifetimeSeconds operator policy, which
# expiring_widget below exercises for AS-8's expired-grant oracle. It carries
# def4ff7's explicit_ai_training_consent enforcement (AS-14) as an ancestor.
# 24802bbd0bff5d47524fa6b42697385f64dda529 (feat/pdpp-as-grants tip, descendant
# of 6981645) fixes the query validator to reject an owner-token filter[...] on
# an unsupported/malformed shape instead of silently serving unfiltered data --
# the fix RS-10/owner-filter-unknown-field-rejected checks for.
# face9fc rejects unsupported bracketed query shapes and owner expansion.
# The target declares no expandable relations; owner expansion therefore
# returns invalid_expand. RS-10 exercises these rejection paths over HTTP.
VANA_REF="${PDPP_VANA_REF:-face9fc81fc8fd47e6b730fd4b12651a17f3e78f}"
# Empty on the supported path. See the header before setting it.
EXTRA_REF="${PDPP_VANA_RS_REF:-}"

PORT="${PDPP_VANA_PORT:-8420}"
# A temp dir by default: this target's state is disposable, and a fixed path
# under $HOME made two concurrent runs silently share one SQLite file.
STATE_DIR="${PDPP_VANA_STATE_DIR:-$(mktemp -d -t pdpp-vana-target-XXXXXX)}"
PID_FILE="$STATE_DIR/server.pid"
LOG_FILE="$STATE_DIR/server.log"
ENV_FILE="$STATE_DIR/target.env"
BOOT_FILE_NAME="pdpp-conformance-boot.mts"

# The tree this script builds and boots: a private detached worktree of
# $PDPP_VANA_PS at $VANA_REF, created by `compose` and removed by `stop`.
# Everything that writes — npm install, the native rebuild, the generated boot
# file — writes HERE, never into the caller's checkout. See cmd_compose.
RUN_DIR="$STATE_DIR/tree"
# Full sha of the tree under test, set by cmd_compose and recorded in the report.
RUN_HEAD=""

SOURCE_ID="https://registry.pdpp.dev/connectors/spotify"
CLIENT_ID="music_recommendations"
REDIRECT_URI="https://app.example.com/callback"
BASE_URL="http://127.0.0.1:$PORT"

# A SECOND, dedicated client registered with an operator-configured
# grantLifetimeSeconds, for AS-8's expired-grant oracle. Kept separate from
# CLIENT_ID above so the ordinary client's grants never expire mid-run — only
# grants issued to expiring_widget carry the short AS-imposed lifetime. This
# value must match packages/conformance-suite/targets/vana-personal-server.json's
# expiryFixture.grantLifetimeSeconds.
EXPIRY_CLIENT_ID="expiring_widget"
# A year: long enough that no case in a run sees a grant expire, while still
# giving the AS a configured lifetime to state in the approval artifact (7.2-2).
MAIN_GRANT_LIFETIME_SECONDS=31536000
EXPIRY_GRANT_LIFETIME_SECONDS=3

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

# Check out the ref under test INTO A DIRECTORY THIS SCRIPT OWNS.
#
# This script used to run `git checkout -B pdpp-conformance-composed $VANA_REF`
# directly inside $PDPP_VANA_PS. That is a destructive write to a directory the
# caller owns: it moves whatever branch the caller had checked out onto a ref
# this script chose. On 2026-09-18 it reset a live development branch three
# times and dropped a pushed commit from the local branch. A conformance runner
# has no business rewriting the history of the thing it is measuring.
#
# So: $PDPP_VANA_PS is now read ONLY as a source of git objects, never written.
# The tree that gets built and booted is $RUN_DIR, a private worktree under the
# state directory, removed on teardown. The caller's HEAD, branch, index and
# working tree are untouched, and `compose` verifies that afterwards.
cmd_compose() {
  require_checkout
  local git="git -C $PDPP_VANA_PS"

  # Everything below reads from the caller's object database. Record the exact
  # state we must not disturb, so the post-condition check has something real to
  # compare against rather than trusting that we wrote nothing.
  local before_head before_branch
  before_head=$($git rev-parse HEAD) || die "cannot read HEAD in $PDPP_VANA_PS"
  before_branch=$($git symbolic-ref --quiet HEAD || echo "DETACHED")

  $git rev-parse --verify --quiet "$VANA_REF^{commit}" >/dev/null ||
    die "ref $VANA_REF not found in $PDPP_VANA_PS. Fetch it first:
  git -C $PDPP_VANA_PS fetch origin waspflow/pdpp-integrated-journey-0917"

  # Uncommitted work in the caller's tree is no longer an obstacle — we do not
  # touch that tree — but it IS a correctness warning: those edits are not in
  # any commit, so they are not in the worktree we build from, and a caller
  # expecting to test them would otherwise get a silently different result.
  if [ -n "$($git status --porcelain --untracked-files=no)" ]; then
    log "NOTE: $PDPP_VANA_PS has uncommitted changes. They are NOT under test:"
    log "NOTE: this run builds $VANA_REF from a private worktree. Commit them"
    log "NOTE: and point PDPP_VANA_REF at the commit to include them."
  fi

  # Clear any worktree left by an earlier run THROUGH GIT, not with rm -rf: a
  # bare rm deletes the files and leaves the registration in the caller's
  # .git/worktrees, and the next `worktree add` then fails on a path git still
  # believes is in use. `compose` must be re-runnable against the same state dir.
  remove_run_worktree
  mkdir -p "$(dirname "$RUN_DIR")"

  # --detach, never -B: a detached worktree creates no branch and moves none.
  # The composed branch NAME is deliberately gone from the supported path; the
  # ref under test is identified by its sha, which is what the report records.
  log "checking out $VANA_REF into a private worktree"
  $git worktree add --detach "$RUN_DIR" "$VANA_REF" >/dev/null 2>&1 ||
    die "could not create a worktree for $VANA_REF under $RUN_DIR"

  local run_git="git -C $RUN_DIR"

  if [ -n "$EXTRA_REF" ]; then
    log "WARNING: merging $EXTRA_REF on top of $VANA_REF."
    log "WARNING: the result is a tree that exists only on this machine."
    log "WARNING: any report from this run must say so."
    $git rev-parse --verify --quiet "$EXTRA_REF^{commit}" >/dev/null ||
      die "extra ref $EXTRA_REF not found in $PDPP_VANA_PS."
    # Merged inside OUR worktree, onto a detached HEAD. The merge commit lands
    # on no branch and disappears with the worktree.
    $run_git -c user.email=conformance@pdpp.invalid -c user.name=conformance \
      merge --no-edit "$EXTRA_REF" >/dev/null 2>&1 ||
      die "merging $EXTRA_REF into $VANA_REF conflicts. Resolve it by hand and
re-run with PDPP_VANA_REF pointed at your merge commit, so the ref under test
names exactly what was tested."
  fi

  RUN_HEAD=$($run_git rev-parse HEAD)
  local head
  head=$($run_git rev-parse --short HEAD)
  log "  tree under test: $head (worktree $RUN_DIR)"

  # Fail closed if the AS is absent. A ref carrying only the RS passes every
  # check above and then produces a report full of skips that reads like a thin
  # result rather than the wrong target.
  [ -f "$RUN_DIR/packages/server/src/routes/pdpp-auth.ts" ] ||
    die "$head has no packages/server/src/routes/pdpp-auth.ts, so it serves no
authorization server and the consent journey cannot run. A resource-server-only
ref (e.g. feat/pdpp-record-storage-rs) is not a conformance target on its own --
use the integration owner's composed ref."

  # The post-condition, checked rather than asserted in a comment: the caller's
  # checkout is exactly where it was. If a future edit reintroduces a write to
  # $PDPP_VANA_PS, this fails loudly here instead of silently eating a commit.
  local after_head after_branch
  after_head=$($git rev-parse HEAD)
  after_branch=$($git symbolic-ref --quiet HEAD || echo "DETACHED")
  if [ "$before_head" != "$after_head" ] || [ "$before_branch" != "$after_branch" ]; then
    die "BUG: this script moved the caller's checkout $PDPP_VANA_PS
  from $before_branch @ $before_head
  to   $after_branch @ $after_head
That is exactly what it must never do. Restore with:
  git -C $PDPP_VANA_PS checkout $before_branch && git -C $PDPP_VANA_PS reset --hard $before_head"
  fi
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
  (cd "$RUN_DIR" && npm install --allow-git=root --no-audit --no-fund --ignore-scripts) ||
    die "dependency install failed; see the npm output above."

  # npm 12's install-script policy blocks preinstall/install/postinstall for
  # any dependency not covered by an `allowScripts` policy -- and blocks it as
  # a WARNING, not an error: `npm rebuild` still exits 0 with the native build
  # silently skipped. `--allow-scripts` can't fix this (project-scoped CLI use
  # is a hard npm error); the escape hatch is `--dangerously-allow-all-scripts`,
  # scoped here to only the three named packages this command rebuilds.
  # Verified below rather than trusted, since the exit code cannot tell us.
  log "building native modules"
  (cd "$RUN_DIR" && npm rebuild better-sqlite3 secp256k1 esbuild --dangerously-allow-all-scripts) ||
    die "native module build failed."

  (cd "$RUN_DIR" && node -e "require('better-sqlite3')(':memory:')") ||
    die "better-sqlite3 native binding did not build; npm rebuild exits 0 even
when its install scripts are blocked, so this checks the binding loads."

  log "building @opendatalabs/personal-server-ts-core"
  (cd "$RUN_DIR/packages/core" && npm run build) ||
    die "core build failed."
}

# The boot entrypoint is generated rather than committed to the server repo, so
# this script owns every input that shapes the run.
write_boot_file() {
  cat > "$RUN_DIR/$BOOT_FILE_NAME" <<BOOT
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
const EXPIRY_CLIENT_ID = "$EXPIRY_CLIENT_ID";
const EXPIRY_GRANT_LIFETIME_SECONDS = $EXPIRY_GRANT_LIFETIME_SECONDS;
const MAIN_GRANT_LIFETIME_SECONDS = $MAIN_GRANT_LIFETIME_SECONDS;
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
    protocol_version: "0.1.0",
    source: { kind: "connector", id: SOURCE_ID },
    declaration_version: "2026-08-11",
    publisher: { id: "https://vana.org" },
    display: { name: "Spotify" },
    streams: [
      {
        name: "$GRANTED_STREAM",
        description: "Seeded Spotify top artists for conformance tests.",
        display: { label: "Top artists" },
        semantics: "mutable_state",
        schema: {
          \$schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            genres: { type: "array", items: { type: "string" } },
            source_updated_at: { type: "string", format: "date-time" },
          },
          required: ["id"],
          additionalProperties: false,
        },
        primary_key: ["id"],
        cursor_field: "source_updated_at",
        consent_time_field: "source_updated_at",
        selection: { fields: true, resources: false },
      },
      {
        name: "$UNGRANTED_STREAM",
        description: "Seeded Spotify saved tracks for conformance tests.",
        display: { label: "Saved tracks" },
        semantics: "mutable_state",
        schema: {
          \$schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            artist: { type: "string" },
            source_updated_at: { type: "string", format: "date-time" },
          },
          required: ["id"],
          additionalProperties: false,
        },
        primary_key: ["id"],
        cursor_field: "source_updated_at",
        consent_time_field: "source_updated_at",
        selection: { fields: true, resources: false },
      },
    ],
    extensions: {},
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
    // expiring_widget is registered alongside CLIENT_ID and given an
    // operator-configured grantLifetimeSeconds. CLIENT_ID has none, so its
    // grants are unaffected -- AS-8's expiry oracle exercises the SAME real
    // config-boundary policy PS's own bootstrap tests cover, not a suite-side
    // fabrication.
    clients: [
      // CLIENT_ID carries a LONG grantLifetimeSeconds, not none.
      //
      // Clause 7.2-2 requires the approval artifact to state grant expiry, and
      // this server computes one only for a client whose config gives it a
      // lifetime (grantExpiryFor, packages/server/src/pdpp/bootstrap.ts). With
      // no lifetime the artifact honestly has no expiry to state, and the
      // conformance run reported that absence as a server defect when it was a
      // gap in how the target was configured.
      //
      // A year, so nothing else in a run is affected: every case expecting an
      // ordinary grant to still work partway through still gets one. The SHORT
      // lifetime that AS-8's expiry oracle needs stays on its own dedicated
      // client below, for the reason recorded there.
      { clientId: CLIENT_ID, redirectUris: [REDIRECT], grantLifetimeSeconds: MAIN_GRANT_LIFETIME_SECONDS },
      {
        clientId: EXPIRY_CLIENT_ID,
        redirectUris: [REDIRECT],
        grantLifetimeSeconds: EXPIRY_GRANT_LIFETIME_SECONDS,
      },
    ],
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
    cd "$RUN_DIR"
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
  # The version recorded in the report is the HEAD of the tree we BUILT, read
  # from our own worktree. It used to be read from $PDPP_VANA_PS, which was only
  # ever correct because the script had just rewritten that checkout to match --
  # i.e. the report's provenance depended on the destructive behaviour removed
  # above. Now the two are independent and this names the tree actually booted.
  local target_version
  target_version="personal-server-ts@$VANA_REF $(git -C "$RUN_DIR" rev-parse --short HEAD)"

  umask 077
  {
    printf 'export PDPP_VANA_OWNER_TOKEN=%s\n' "$dev_token"
    printf "export PDPP_VANA_TARGET_VERSION='%s'\n" "$target_version"
  } > "$ENV_FILE"

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

# Drop the private worktree, including its registration in the caller's
# .git/worktrees. A plain `rm -rf` of the state dir would delete the files and
# leave the caller's repository carrying a stale worktree entry — still not a
# branch move, but still litter this script put in someone else's checkout.
# `--force` because the tree is dirty by construction (node_modules, the built
# core package, the generated boot file); that force applies to OUR worktree.
remove_run_worktree() {
  [ -d "$RUN_DIR" ] || return 0
  [ -n "${PDPP_VANA_PS:-}" ] || return 0
  log "removing private worktree $RUN_DIR"
  git -C "$PDPP_VANA_PS" worktree remove --force "$RUN_DIR" >/dev/null 2>&1 ||
    rm -rf "$RUN_DIR"
  git -C "$PDPP_VANA_PS" worktree prune >/dev/null 2>&1 || true
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
  rm -f "$RUN_DIR/$BOOT_FILE_NAME" 2>/dev/null || true
  rm -f "$ENV_FILE" 2>/dev/null || true
  remove_run_worktree
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
  # `compose` is the checkout step alone, with no install, build or boot. It is
  # separable so the non-destructiveness rule can be tested directly: the guard
  # in test/vana-target-script.test.ts runs THIS verb against a throwaway
  # repository and asserts the branch and HEAD did not move. Testing it through
  # `up` would mean an npm install and a server boot per assertion, which is
  # slow enough that the guard would not be run.
  compose)
    cmd_compose
    printf '%s\n' "$RUN_HEAD"
    ;;
  *)
    printf 'usage: %s {up|env|seed|status|stop|compose}\n' "$0" >&2
    exit 2
    ;;
esac
