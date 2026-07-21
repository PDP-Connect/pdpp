#!/usr/bin/env bash
set -euo pipefail

if [[ "${PDPP_DOCKER_NEKO_NETWORK_MIGRATION_SMOKE:-}" != "1" ]]; then
  echo "SKIP n.eko network migration Docker smoke: set PDPP_DOCKER_NEKO_NETWORK_MIGRATION_SMOKE=1 to run."
  exit 0
fi

# Falsifies the migration gap: a surface created BEFORE pdpp_neko_dynamic
# existed (attached only to the legacy default network) must be migrated
# in-place — same container id/StartedAt, expected network attached, legacy
# network detached, reachable — the first time the allocator sees it after an
# upgrade to this config, and `docker compose down` must succeed afterward.
#
# ISOLATION INCIDENT (2026-07-14, two rounds):
#
# Round 1: an earlier version of this script ran without any
# deployment-identity concept at all. The allocator's container listing
# filtered ONLY by the generic `owner=pdpp-reference` label, which every
# allocator instance on the machine shared — so this "throwaway" smoke's own
# allocator instance enumerated and reconfigured network attachments on REAL
# LIVE production containers sharing the same Docker daemon.
#
# Round 2 (same day, independent review of the round-1 fix): a required
# `deploymentId` was added, but with an `adoptUnnamespacedLegacyOwner` opt-in
# flag that, when enabled, matched EVERY unnamespaced `owner=pdpp-reference`
# container globally — reproducing the exact same incident under adoption=true.
# Fixed: `deploymentId` is now REQUIRED TO EQUAL the Compose project identity
# (COMPOSE_PROJECT_NAME), and legacy-container recognition additionally
# requires the container's Docker-Compose-assigned
# `com.docker.compose.project` label (set by Compose itself, never by this
# allocator — not spoofable by our own code) to match. The opt-in flag was
# removed entirely: it added no additional safety once the project check
# exists, and only risked stranding legacy containers if an operator forgot
# to set it (see #isOwnedByThisDeployment in neko-surface-allocator-server.ts).
#
# This script hard-fails before touching Docker at all unless EVERY
# identifier it will use — Compose project name (== deployment id), both
# network names — is demonstrably distinct from anything resembling a
# production default, and it proves isolation by planting a fake "foreign"
# container from an UNRELATED Compose project and asserting the smoke's own
# allocator instance never lists, inspects, or reconfigures it.
NAME_DENYLIST_RE='^(pdpp|pdpp_default|pdpp-reference)$'
RANDOM_SUFFIX="$(od -An -N4 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n' || echo "$$$(date +%s 2>/dev/null || echo 0)")"
PROJECT_NAME="pdppnetmigsmoke-$$-${RANDOM_SUFFIX}"
# Deliberately the SAME value as PROJECT_NAME (== COMPOSE_PROJECT_NAME), not
# a separately synthesized string — this is the exact relationship
# docker-compose.neko.yml's own default (PDPP_NEKO_DEPLOYMENT_ID defaults to
# COMPOSE_PROJECT_NAME) requires, and it is what makes legacy-container
# recognition via com.docker.compose.project actually work in this smoke.
DEPLOYMENT_ID="$PROJECT_NAME"
FOREIGN_PROJECT_NAME="pdppnetmigsmoke-foreignproj-$$-${RANDOM_SUFFIX}"
DYNAMIC_NETWORK="${PROJECT_NAME}-neko-dynamic"
# Deliberately NOT "${PROJECT_NAME}_default" — that name collides with
# Compose's own implicit default network for this project, which Compose
# insists on creating/managing itself. The migration mechanics under test
# (attach expected, verify, detach the one explicitly-configured legacy
# name) do not depend on the legacy network happening to be Compose's
# implicit default; production's actual default legacy name is covered by
# the "compose declares an explicit legacy network..." unit test instead.
LEGACY_NETWORK="${PROJECT_NAME}-legacy-net"

for identifier in "$PROJECT_NAME" "$DEPLOYMENT_ID" "$FOREIGN_PROJECT_NAME" "$DYNAMIC_NETWORK" "$LEGACY_NETWORK"; do
  if [[ "$identifier" =~ $NAME_DENYLIST_RE ]]; then
    echo "n.eko network migration Docker smoke refused to run: synthesized identifier collided with a denylisted live/default name ($identifier)." >&2
    exit 1
  fi
  [[ -n "$identifier" ]] || {
    echo "n.eko network migration Docker smoke refused to run: failed to synthesize a non-empty throwaway identifier." >&2
    exit 1
  }
done
if [[ "$PROJECT_NAME" == "$FOREIGN_PROJECT_NAME" ]]; then
  echo "n.eko network migration Docker smoke refused to run: project name and foreign-control project name must not collide." >&2
  exit 1
fi

# Deliberately does NOT read PDPP_NEKO_PROFILE_STORAGE_ROOT from the
# inherited environment, for the same reason COMPOSE_PROJECT_NAME and
# PDPP_NEKO_DOCKER_NETWORK above are never inherited: a real deploy shell is
# likely to already have this set, and honoring it here would let this
# throwaway harness read/write a live deployment's Chromium profile
# directories instead of its own. Always synthesized fresh, scoped by this
# run's own PROJECT_NAME, so two concurrent invocations (or one that failed
# to clean up a prior run) never collide or race on each other's profile
# state.
PROFILE_ROOT="/tmp/pdpp-neko-profiles-${PROJECT_NAME}"
HOST_PORT_START="${PDPP_NEKO_WEBRTC_HOST_PORT_START:-59211}"
HOST_PORT_END="${PDPP_NEKO_WEBRTC_HOST_PORT_END:-59212}"
LABEL_OWNER="org.pdpp.reference.neko.owner=pdpp-reference"
LABEL_DEPLOYMENT="org.pdpp.reference.neko.deployment_id=${DEPLOYMENT_ID}"
LABEL_COMPOSE_PROJECT="com.docker.compose.project=${FOREIGN_PROJECT_NAME}"
SMOKE_SURFACE="net-migration-smoke-surface"
FOREIGN_SURFACE="net-migration-smoke-foreign-surface"

export COMPOSE_PROJECT_NAME="$PROJECT_NAME"
export PDPP_NEKO_DOCKER_NETWORK="$DYNAMIC_NETWORK"
export PDPP_NEKO_LEGACY_DOCKER_NETWORK="$LEGACY_NETWORK"
export PDPP_NEKO_DEPLOYMENT_ID="$DEPLOYMENT_ID"
export PDPP_NEKO_PROFILE_STORAGE_ROOT="$PROFILE_ROOT"
export PDPP_NEKO_WEBRTC_HOST_PORT_START="$HOST_PORT_START"
export PDPP_NEKO_WEBRTC_HOST_PORT_END="$HOST_PORT_END"
export PDPP_NEKO_ALLOCATOR_PORT="${PDPP_NEKO_ALLOCATOR_PORT:-7333}"
export NEKO_PASSWORD="${NEKO_PASSWORD:-pdpp-net-migration-smoke}"
export NEKO_USERNAME="${NEKO_USERNAME:-operator}"

DC=(docker compose -f docker-compose.yml -f docker-compose.neko.yml --profile neko-dynamic)

# Defense in depth beyond the docker ps --filter match itself: re-inspect
# each candidate id and refuse to remove it unless the label value on the
# container is BYTE-IDENTICAL to this run's own synthesized identifier.
# Never trust a filter match alone for a destructive operation.
rm_if_labeled_exactly() {
  local label_key="$1" expected_value="$2" id
  shift 2
  for id in "$@"; do
    [[ -n "$id" ]] || continue
    local actual_value
    actual_value="$(docker inspect -f "{{ index .Config.Labels \"$label_key\" }}" "$id" 2>/dev/null || true)"
    if [[ "$actual_value" == "$expected_value" ]]; then
      docker rm -f "$id" >/dev/null 2>&1 || true
    else
      echo "n.eko network migration Docker smoke: refused to remove $id — $label_key was '$actual_value', expected exactly '$expected_value'." >&2
    fi
  done
}

cleanup() {
  set +e
  local ids
  # Scoped by this exact run's OWN deployment_id label — never the fixed
  # surface-id label alone, which is a constant string shared across every
  # invocation of this script (concurrent runs, or a coincidental unrelated
  # live surface using the same id) and would let one run's cleanup remove
  # a container it does not own.
  ids="$(docker ps -aq --filter "label=$LABEL_OWNER" --filter "label=$LABEL_DEPLOYMENT" 2>/dev/null || true)"
  if [[ -n "$ids" ]]; then
    rm_if_labeled_exactly "org.pdpp.reference.neko.deployment_id" "$DEPLOYMENT_ID" $ids
  fi
  # The foreign-project negative-control container carries a DIFFERENT
  # (also freshly synthesized, denylist-checked) com.docker.compose.project,
  # never this run's own deployment_id — scoped the same way for the same
  # reason, exact match against this run's own synthesized value, not a
  # fixed literal.
  ids="$(docker ps -aq --filter "label=$LABEL_OWNER" --filter "label=$LABEL_COMPOSE_PROJECT" 2>/dev/null || true)"
  if [[ -n "$ids" ]]; then
    rm_if_labeled_exactly "com.docker.compose.project" "$FOREIGN_PROJECT_NAME" $ids
  fi
  "${DC[@]}" down --remove-orphans >/dev/null 2>&1 || true
  # Only this smoke's own throwaway networks are removed here — production
  # code must never detach/remove anything but the one explicitly configured
  # legacy network on a container it owns, and never remove either network
  # outright. Test-only teardown.
  docker network rm "$DYNAMIC_NETWORK" >/dev/null 2>&1 || true
  docker network rm "$LEGACY_NETWORK" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() {
  echo "n.eko network migration Docker smoke failed: $1" >&2
  "${DC[@]}" logs --tail=180 neko-allocator >&2 || true
  exit 1
}

command -v docker >/dev/null 2>&1 || fail "docker is not installed"
docker info >/dev/null 2>&1 || fail "docker daemon is not reachable"

cleanup
mkdir -p "$PROFILE_ROOT"

# The expected network (declared `external: true` in docker-compose.neko.yml)
# must exist before Compose can attach any service to it, on every run.
docker network create --driver bridge "$DYNAMIC_NETWORK" >/dev/null
docker network create --driver bridge "$LEGACY_NETWORK" >/dev/null

"${DC[@]}" build neko neko-allocator

echo "n.eko network migration Docker smoke: starting the allocator under deployment id ${DEPLOYMENT_ID}..."
"${DC[@]}" up -d neko-allocator

deadline=$((SECONDS + 90))
until "${DC[@]}" exec -T neko-allocator node -e "fetch('http://127.0.0.1:${PDPP_NEKO_ALLOCATOR_PORT}/surfaces').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; do
  if (( SECONDS >= deadline )); then
    fail "allocator did not become reachable"
  fi
  sleep 2
done

acquire_container_id() {
  local surface_id="$1"
  local host_port="$2"
  "${DC[@]}" exec -T neko-allocator node --input-type=module - <<NODE
import assert from "node:assert/strict";
const baseUrl = "http://127.0.0.1:${PDPP_NEKO_ALLOCATOR_PORT}";
async function request(path, init = {}) {
  const response = await fetch(new URL(path, baseUrl), init);
  if (!response.ok) {
    throw new Error(\`\${init.method ?? "GET"} \${path} returned HTTP \${response.status}: \${await response.text()}\`);
  }
  return response.json();
}
await request("/surfaces", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    surface_id: "${surface_id}",
    connector_id: "chatgpt",
    profile_key: "pdpp-smoke://profile/${surface_id}",
  }),
});
const deadline = Date.now() + 180_000;
let latest;
while (Date.now() < deadline) {
  latest = (await request("/surfaces/${surface_id}")).surface;
  if (latest.health === "ready") {
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}
assert.equal(latest?.health, "ready", \`surface did not become ready; latest=\${JSON.stringify(latest)}\`);
console.log(latest.container_id);
NODE
}

before_id="$(acquire_container_id "$SMOKE_SURFACE" "$HOST_PORT_START" | tail -n1)"
[[ -n "$before_id" ]] || fail "did not obtain a container id"
before_started_at="$(docker inspect -f '{{.State.StartedAt}}' "$before_id")"

echo "n.eko network migration Docker smoke: simulating a pre-existing surface by force-attaching the legacy network and detaching the expected one directly via Docker..."
# This reproduces exactly the state an operator upgrading from a pre-fix
# deploy would find: a running, allocator-owned (but unnamespaced) container
# attached only to the legacy network, never the externally-managed one —
# without needing to fight Compose's `external: true` semantics by juggling
# which network name Compose itself treats as "the" expected network across
# two `up` calls.
docker network connect "$LEGACY_NETWORK" "$before_id" >/dev/null
docker network disconnect "$DYNAMIC_NETWORK" "$before_id" >/dev/null
before_networks="$(docker inspect -f '{{json .NetworkSettings.Networks}}' "$before_id")"
[[ "$before_networks" == *"$LEGACY_NETWORK"* ]] || fail "smoke setup did not attach the container to the legacy network as expected"
[[ "$before_networks" != *"\"$DYNAMIC_NETWORK\""* ]] || fail "smoke setup did not detach the expected network as expected"

echo "n.eko network migration Docker smoke: planting a FOREIGN unnamespaced legacy container from a DIFFERENT Compose project (this is exactly the round-2 isolation incident shape) that must remain completely untouched..."
# This is the isolation regression test that actually matters: a second
# container sharing the generic owner label, with NO deployment_id label at
# all — the same shape as a genuinely-unmigrated legacy container — but
# whose com.docker.compose.project is a DIFFERENT project than this
# allocator instance's own. This is exactly the shape that broke under the
# round-2 fix's adoptUnnamespacedLegacyOwner=true (it matched ANY
# unnamespaced container globally, ignoring which Compose project actually
# created it). The current fix requires com.docker.compose.project to match
# this instance's deploymentId before ever recognizing an unnamespaced
# container, so this must remain completely untouched. Created directly via
# `docker run` (not through this allocator instance) so it is never
# influenced by this instance's own bookkeeping, then planted on the same
# legacy network as the real smoke surface to maximize the chance an
# isolation bug would touch it.
foreign_id="$(
  docker run -d \
    --network "$LEGACY_NETWORK" \
    --label "org.pdpp.reference.neko.owner=pdpp-reference" \
    --label "com.docker.compose.project=${FOREIGN_PROJECT_NAME}" \
    --label "org.pdpp.reference.neko.surface_id=${FOREIGN_SURFACE}" \
    --label "org.pdpp.reference.neko.backend=neko" \
    --label "org.pdpp.reference.neko.connector_id=chatgpt" \
    --label "org.pdpp.reference.neko.profile_key=foreign-profile" \
    --label "org.pdpp.reference.neko.webrtc_host_port=${HOST_PORT_END}" \
    alpine:3 sleep 3600
)"
foreign_before_networks="$(docker inspect -f '{{json .NetworkSettings.Networks}}' "$foreign_id")"

echo "n.eko network migration Docker smoke: accessing the allocator (listSurfaces + getSurfaceStatus + ensureSurface) to trigger migration..."
# The core falsification: the allocator must migrate the SAME real smoke
# container in-place on next access, not replace it — while the foreign
# container must show up nowhere in its output and must never be touched.
# This is also the only place the reachability-before-detach gate
# (#isReachableOnExpectedNetwork) is exercised against a real Docker
# network and a real neko process, not a fake fetch — the surface reaching
# "ready" here proves both the network attach AND the direct-IP HTTP probe
# on the expected network actually succeeded before the legacy network was
# detached (see the post-migration network assertions below).
migrate_and_report() {
  "${DC[@]}" exec -T neko-allocator node --input-type=module - <<NODE
const baseUrl = "http://127.0.0.1:${PDPP_NEKO_ALLOCATOR_PORT}";
const deadline = Date.now() + 120_000;
let latest;
let listed;
while (Date.now() < deadline) {
  const response = await fetch(new URL("/surfaces/${SMOKE_SURFACE}", baseUrl));
  if (response.ok) {
    latest = (await response.json()).surface;
    if (latest?.health === "ready") {
      listed = (await (await fetch(new URL("/surfaces", baseUrl))).json()).surfaces;
      break;
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}
console.log(JSON.stringify({ latest, listed }));
NODE
}

report_json="$(migrate_and_report | tail -n1)"
after_id="$(node -e "console.log(JSON.parse(process.argv[1]).latest?.container_id ?? '')" "$report_json" 2>/dev/null || true)"
after_health="$(node -e "console.log(JSON.parse(process.argv[1]).latest?.health ?? '')" "$report_json" 2>/dev/null || true)"
listed_foreign="$(node -e "
const parsed = JSON.parse(process.argv[1]);
const listed = parsed.listed ?? [];
console.log(listed.some((s) => s.container_id === process.argv[2] || s.surface_id === process.argv[3]) ? 'yes' : 'no');
" "$report_json" "$foreign_id" "$FOREIGN_SURFACE" 2>/dev/null || echo "unknown")"

[[ -n "$after_id" ]] || fail "did not obtain a container id after migrating (response: $report_json)"
[[ "$after_id" == "$before_id" ]] \
  || fail "container identity changed across migration ($before_id -> $after_id) — migration must never replace the container"
[[ "$after_health" == "ready" ]] || fail "surface is not ready after migration (response: $report_json)"
[[ "$listed_foreign" == "no" ]] \
  || fail "the allocator's listSurfaces enumerated the FOREIGN-deployment container — isolation is broken (response: $report_json)"

after_started_at="$(docker inspect -f '{{.State.StartedAt}}' "$before_id")"
[[ "$after_started_at" == "$before_started_at" ]] \
  || fail "container $before_id restarted (StartedAt changed from $before_started_at to $after_started_at) — process identity was not preserved by migration"

after_networks="$(docker inspect -f '{{json .NetworkSettings.Networks}}' "$before_id")"
[[ "$after_networks" == *"$DYNAMIC_NETWORK"* ]] || fail "expected network was not attached after migration (networks: $after_networks)"
[[ "$after_networks" != *"\"$LEGACY_NETWORK\""* ]] || fail "legacy network was not detached after successful migration (networks: $after_networks)"

echo "n.eko network migration Docker smoke: confirming the FOREIGN-deployment container's networks are completely unchanged..."
foreign_after_networks="$(docker inspect -f '{{json .NetworkSettings.Networks}}' "$foreign_id")"
[[ "$foreign_after_networks" == "$foreign_before_networks" ]] \
  || fail "the foreign-deployment container's networks changed ($foreign_before_networks -> $foreign_after_networks) — isolation is broken"
foreign_still_running="$(docker inspect -f '{{.State.Running}}' "$foreign_id" 2>/dev/null || echo "gone")"
[[ "$foreign_still_running" == "true" ]] \
  || fail "the foreign-deployment container was stopped or removed — isolation is broken"

echo "n.eko network migration Docker smoke: confirming 'docker compose down' now succeeds cleanly..."
"${DC[@]}" down || fail "docker compose down failed after migration"

still_running="$(docker inspect -f '{{.State.Running}}' "$before_id" 2>/dev/null || echo "gone")"
[[ "$still_running" == "true" ]] \
  || fail "the migrated container ($before_id) was not left running after 'docker compose down' — migration should preserve the externally-managed-network durability guarantee"

docker rm -f "$foreign_id" >/dev/null 2>&1 || true

echo "n.eko network migration Docker smoke passed: container $before_id survived an in-place legacy-to-expected network migration with unchanged StartedAt, is reachable/ready, has the expected network attached and the legacy network detached, 'docker compose down' succeeds afterward, and the foreign-project unnamespaced container ($foreign_id, com.docker.compose.project=$FOREIGN_PROJECT_NAME) was never enumerated or touched, for project/deployment $PROJECT_NAME."
