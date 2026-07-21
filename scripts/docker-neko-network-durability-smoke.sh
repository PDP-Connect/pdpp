#!/usr/bin/env bash
set -euo pipefail

if [[ "${PDPP_DOCKER_NEKO_NETWORK_DURABILITY_SMOKE:-}" != "1" ]]; then
  echo "SKIP n.eko network durability Docker smoke: set PDPP_DOCKER_NEKO_NETWORK_DURABILITY_SMOKE=1 to run."
  exit 0
fi

# This smoke tears down and force-removes whatever project/network it is
# pointed at (docker compose down --remove-orphans, docker network rm). It
# MUST NEVER be allowed to resolve to a live/default identifier, so it
# deliberately does NOT read COMPOSE_PROJECT_NAME or PDPP_NEKO_DOCKER_NETWORK
# from the inherited environment at all — those are exactly the variables a
# real deploy shell is likely to already have set, and honoring them here
# would let this "throwaway" harness mutate a live stack. The identifiers are
# always synthesized fresh (PID + a random suffix so repeated/parallel runs
# never collide), then checked against a deny-list of known live/default
# names as defense in depth in case a future edit reintroduces env passthrough.
DENYLIST_RE='^(pdpp|pdpp_default|pdpp-reference)$'
RANDOM_SUFFIX="$(od -An -N4 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n' || echo "$$$(date +%s 2>/dev/null || echo 0)")"
PROJECT_NAME="pdppnetdurasmoke-$$-${RANDOM_SUFFIX}"
DYNAMIC_NETWORK="${PROJECT_NAME}-neko-dynamic"
# Required by the allocator with no code-level default (see
# NekoSurfaceAllocatorServerOptions#deploymentId). Deliberately the SAME
# value as PROJECT_NAME (== COMPOSE_PROJECT_NAME) — this instance's
# deploymentId must equal its own Compose project identity for
# #isOwnedByThisDeployment to work correctly and never collide with a
# different deployment's containers on a shared Docker host.
DEPLOYMENT_ID="$PROJECT_NAME"

if [[ "$PROJECT_NAME" =~ $DENYLIST_RE || "$DYNAMIC_NETWORK" =~ $DENYLIST_RE ]]; then
  echo "n.eko network durability Docker smoke refused to run: synthesized identifier collided with a denylisted live/default name ($PROJECT_NAME / $DYNAMIC_NETWORK)." >&2
  exit 1
fi
if [[ -z "$PROJECT_NAME" || -z "$DYNAMIC_NETWORK" || -z "$DEPLOYMENT_ID" ]]; then
  echo "n.eko network durability Docker smoke refused to run: failed to synthesize a non-empty throwaway identifier." >&2
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
HOST_PORT_START="${PDPP_NEKO_WEBRTC_HOST_PORT_START:-59201}"
HOST_PORT_END="${PDPP_NEKO_WEBRTC_HOST_PORT_END:-59201}"
LABEL_OWNER="org.pdpp.reference.neko.owner=pdpp-reference"
LABEL_DEPLOYMENT="org.pdpp.reference.neko.deployment_id=${DEPLOYMENT_ID}"
SMOKE_SURFACE="net-durability-smoke-surface"

export COMPOSE_PROJECT_NAME="$PROJECT_NAME"
export PDPP_NEKO_DOCKER_NETWORK="$DYNAMIC_NETWORK"
export PDPP_NEKO_DEPLOYMENT_ID="$DEPLOYMENT_ID"
export PDPP_NEKO_PROFILE_STORAGE_ROOT="$PROFILE_ROOT"
export PDPP_NEKO_WEBRTC_HOST_PORT_START="$HOST_PORT_START"
export PDPP_NEKO_WEBRTC_HOST_PORT_END="$HOST_PORT_END"
export PDPP_NEKO_ALLOCATOR_PORT="${PDPP_NEKO_ALLOCATOR_PORT:-7332}"
export NEKO_PASSWORD="${NEKO_PASSWORD:-pdpp-net-durability-smoke}"
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
      echo "n.eko network durability Docker smoke: refused to remove $id — $label_key was '$actual_value', expected exactly '$expected_value'." >&2
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
  "${DC[@]}" down --remove-orphans >/dev/null 2>&1 || true
  # Only this smoke's throwaway network is removed here — an externally
  # managed network's whole point is that ordinary `compose down` must never
  # do this. Test-only teardown, not production behavior.
  docker network rm "$DYNAMIC_NETWORK" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() {
  echo "n.eko network durability Docker smoke failed: $1" >&2
  "${DC[@]}" logs --tail=180 neko-allocator >&2 || true
  exit 1
}

command -v docker >/dev/null 2>&1 || fail "docker is not installed"
docker info >/dev/null 2>&1 || fail "docker daemon is not reachable"

cleanup
mkdir -p "$PROFILE_ROOT"

# `external: true` requires the network to pre-exist before any service can
# attach to it — mirrors scripts/reference-stack.sh's own pre-create step.
docker network create --driver bridge "$DYNAMIC_NETWORK" >/dev/null

"${DC[@]}" build neko neko-allocator
"${DC[@]}" up -d neko-allocator

deadline=$((SECONDS + 90))
until "${DC[@]}" exec -T neko-allocator node -e "fetch('http://127.0.0.1:${PDPP_NEKO_ALLOCATOR_PORT}/surfaces').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; do
  if (( SECONDS >= deadline )); then
    fail "allocator did not become reachable"
  fi
  sleep 2
done

acquire_container_id() {
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
    surface_id: "${SMOKE_SURFACE}",
    connector_id: "chatgpt",
    profile_key: "pdpp-smoke://profile/net-durability",
  }),
});
const deadline = Date.now() + 180_000;
let latest;
while (Date.now() < deadline) {
  latest = (await request("/surfaces/${SMOKE_SURFACE}")).surface;
  if (latest.health === "ready") {
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}
assert.equal(latest?.health, "ready", \`surface did not become ready; latest=\${JSON.stringify(latest)}\`);
console.log(latest.container_id);
NODE
}

before_id="$(acquire_container_id | tail -n1)"
[[ -n "$before_id" ]] || fail "did not obtain a container id after acquiring the smoke surface"

before_started_at="$(docker inspect -f '{{.State.StartedAt}}' "$before_id")"

# The core falsification: an ordinary redeploy shape, no special flags.
"${DC[@]}" down
"${DC[@]}" up -d neko-allocator

deadline=$((SECONDS + 90))
until "${DC[@]}" exec -T neko-allocator node -e "fetch('http://127.0.0.1:${PDPP_NEKO_ALLOCATOR_PORT}/surfaces').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; do
  if (( SECONDS >= deadline )); then
    fail "allocator did not become reachable after compose down/up"
  fi
  sleep 2
done

after_state="$(docker inspect -f '{{.State.Running}} {{.State.StartedAt}}' "$before_id" 2>&1)" \
  || fail "the pre-redeploy container id ($before_id) no longer exists after compose down/up"
after_running="$(awk '{print $1}' <<<"$after_state")"
after_started_at="$(awk '{print $2}' <<<"$after_state")"

[[ "$after_running" == "true" ]] || fail "container $before_id is no longer running after compose down/up"
[[ "$after_started_at" == "$before_started_at" ]] \
  || fail "container $before_id restarted (StartedAt changed from $before_started_at to $after_started_at) — process identity was not preserved"

reachable_after="$("${DC[@]}" exec -T neko-allocator node --input-type=module - <<NODE
const baseUrl = "http://127.0.0.1:${PDPP_NEKO_ALLOCATOR_PORT}";
const response = await fetch(new URL("/surfaces/${SMOKE_SURFACE}", baseUrl));
if (!response.ok) {
  console.log("unreachable");
  process.exit(0);
}
const body = await response.json();
console.log(body.surface?.container_id === "${before_id}" && body.surface?.health === "ready" ? "reachable" : "unreachable");
NODE
)"
[[ "$(tail -n1 <<<"$reachable_after")" == "reachable" ]] \
  || fail "surface is not reachable/ready through the allocator after compose down/up"

echo "n.eko network durability Docker smoke passed: container $before_id survived 'docker compose down' + 'up -d' with unchanged StartedAt and remains reachable, for project $PROJECT_NAME."
