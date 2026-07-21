#!/usr/bin/env bash
set -euo pipefail

if [[ "${PDPP_DOCKER_DYNAMIC_NEKO_ALLOCATOR_SMOKE:-}" != "1" ]]; then
  echo "SKIP dynamic n.eko allocator Docker smoke: set PDPP_DOCKER_DYNAMIC_NEKO_ALLOCATOR_SMOKE=1 to run."
  exit 0
fi

PROJECT_NAME="${COMPOSE_PROJECT_NAME:-pdppdynsmoke}"
PROFILE_ROOT="${PDPP_NEKO_PROFILE_STORAGE_ROOT:-/tmp/pdpp-neko-profiles-smoke}"
HOST_PORT_START="${PDPP_NEKO_WEBRTC_HOST_PORT_START:-59101}"
HOST_PORT_END="${PDPP_NEKO_WEBRTC_HOST_PORT_END:-59102}"
LABEL_OWNER="org.pdpp.reference.neko.owner=pdpp-reference"
SURFACE_LABEL="org.pdpp.reference.neko.surface_id"
SMOKE_SURFACE_A="dynamic-smoke-surface-a"
SMOKE_SURFACE_B="dynamic-smoke-surface-b"

export COMPOSE_PROJECT_NAME="$PROJECT_NAME"
export PDPP_NEKO_PROFILE_STORAGE_ROOT="$PROFILE_ROOT"
export PDPP_NEKO_WEBRTC_HOST_PORT_START="$HOST_PORT_START"
export PDPP_NEKO_WEBRTC_HOST_PORT_END="$HOST_PORT_END"
export PDPP_NEKO_ALLOCATOR_PORT="${PDPP_NEKO_ALLOCATOR_PORT:-7331}"
export NEKO_PASSWORD="${NEKO_PASSWORD:-pdpp-dynamic-smoke}"
export NEKO_USERNAME="${NEKO_USERNAME:-operator}"

DC=(docker compose -f docker-compose.yml -f docker-compose.neko.yml --profile neko-dynamic)

cleanup() {
  set +e
  local surface ids
  for surface in "$SMOKE_SURFACE_A" "$SMOKE_SURFACE_B"; do
    ids="$(docker ps -aq --filter "label=$LABEL_OWNER" --filter "label=$SURFACE_LABEL=$surface" 2>/dev/null || true)"
    if [[ -n "$ids" ]]; then
      docker rm -f $ids >/dev/null 2>&1 || true
    fi
  done
  "${DC[@]}" down --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() {
  echo "dynamic n.eko allocator Docker smoke failed: $1" >&2
  "${DC[@]}" logs --tail=180 neko-allocator >&2 || true
  exit 1
}

command -v docker >/dev/null 2>&1 || fail "docker is not installed"
docker info >/dev/null 2>&1 || fail "docker daemon is not reachable"

cleanup
mkdir -p "$PROFILE_ROOT"

"${DC[@]}" build neko neko-allocator
"${DC[@]}" up -d neko-allocator

deadline=$((SECONDS + 90))
until "${DC[@]}" exec -T neko-allocator node -e "fetch('http://127.0.0.1:${PDPP_NEKO_ALLOCATOR_PORT}/surfaces').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; do
  if (( SECONDS >= deadline )); then
    fail "allocator did not become reachable"
  fi
  sleep 2
done

# `docker compose exec -T` reading a heredoc on stdin can report exit 0 even
# when the inner node process throws and exits non-zero (a compose-v2 quirk),
# which would let a real allocation failure masquerade as a pass. So we don't
# trust the exec exit code alone: the node block prints an explicit sentinel as
# its very last action, and we require that sentinel to appear. A thrown
# assertion never reaches the sentinel, so the smoke fails closed.
SMOKE_ASSERT_OK="PDPP_NEKO_DYNAMIC_SMOKE_ASSERTIONS_OK"
# Capture without letting `set -e` abort on a non-zero exec: the sentinel grep
# below is the authoritative pass/fail signal, and it must always run.
node_assert_output="$("${DC[@]}" exec -T neko-allocator node --input-type=module - <<'NODE' || true
import assert from "node:assert/strict";

const baseUrl = `http://127.0.0.1:${process.env.PDPP_NEKO_ALLOCATOR_PORT ?? "7331"}`;
const surfaces = [
  {
    surface_id: "dynamic-smoke-surface-a",
    connector_id: "chatgpt",
    profile_key: "pdpp-smoke://profile/a",
  },
  {
    surface_id: "dynamic-smoke-surface-b",
    connector_id: "chatgpt",
    profile_key: "pdpp-smoke://profile/b",
  },
];

async function request(path, init = {}) {
  const response = await fetch(new URL(path, baseUrl), init);
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} returned HTTP ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function ensure(surface) {
  await request("/surfaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(surface),
  });
  const deadline = Date.now() + 180_000;
  let latest;
  while (Date.now() < deadline) {
    latest = (await request(`/surfaces/${encodeURIComponent(surface.surface_id)}`)).surface;
    if (latest.health === "ready") {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`${surface.surface_id} did not become ready; latest=${JSON.stringify(latest)}`);
}

const allocated = [];
for (const surface of surfaces) {
  allocated.push(await ensure(surface));
}

assert.equal(allocated.length, 2);
assert.equal(new Set(allocated.map((surface) => surface.surface_id)).size, 2);
assert.equal(new Set(allocated.map((surface) => surface.profile_key)).size, 2);
assert.equal(new Set(allocated.map((surface) => surface.container_id)).size, 2);
assert.equal(new Set(allocated.map((surface) => surface.allocator_metadata.container_name)).size, 2);
assert.equal(new Set(allocated.map((surface) => surface.allocator_metadata.host_port)).size, 2);
assert.deepEqual(
  allocated.map((surface) => surface.allocator_metadata.host_port).sort(),
  ["59101", "59102"],
);
assert.equal(new Set(allocated.map((surface) => surface.allocator_metadata.profile_path)).size, 2);
for (const surface of allocated) {
  assert.equal(surface.backend, "neko");
  assert.equal(surface.connector_id, "chatgpt");
  assert.equal(surface.health, "ready");
  assert.equal(surface.allocator_metadata.resource_owner, "pdpp-reference");
}

for (const surface of surfaces) {
  await request(`/surfaces/${encodeURIComponent(surface.surface_id)}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason: "dynamic_allocator_smoke_complete" }),
  });
}

// Scope the post-DELETE assertion to the surfaces THIS smoke created. The
// allocator's /surfaces listing is owner-label-global, not compose-project
// scoped, so a shared Docker host with other PDPP sessions' surfaces present
// would make a bare `remaining.length === 2` flake (it counts every labeled
// surface across all projects). We assert on our own two surface_ids instead.
const smokeSurfaceIds = new Set(surfaces.map((surface) => surface.surface_id));
const remaining = (await request("/surfaces")).surfaces;
const remainingOurs = remaining.filter((surface) => smokeSurfaceIds.has(surface.surface_id));
assert.equal(
  remainingOurs.length,
  2,
  `allocator DELETE should leave this smoke's stopped surfaces visible until Docker cleanup; saw ${remainingOurs.length} of our 2 (total listed: ${remaining.length})`,
);
console.log(
  `dynamic allocator allocated distinct surfaces: ${allocated
    .map((surface) => `${surface.allocator_metadata.container_name}:${surface.allocator_metadata.host_port}`)
    .join(", ")}`,
);
// Sentinel: only reached if every assertion above passed. Bash requires it.
console.log("PDPP_NEKO_DYNAMIC_SMOKE_ASSERTIONS_OK");
NODE
)"
printf '%s\n' "$node_assert_output"
if ! printf '%s' "$node_assert_output" | grep -q "$SMOKE_ASSERT_OK"; then
  fail "allocator assertion block did not reach its success sentinel (an assertion threw or the exec was interrupted)"
fi

cleanup
trap - EXIT

for surface in "$SMOKE_SURFACE_A" "$SMOKE_SURFACE_B"; do
  if [[ -n "$(docker ps -aq --filter "label=$LABEL_OWNER" --filter "label=$SURFACE_LABEL=$surface")" ]]; then
    fail "labeled dynamic n.eko smoke container $surface remains after cleanup"
  fi
done

if docker network ls --filter "label=$LABEL_OWNER" --format '{{.Name}}' | grep -q .; then
  fail "labeled dynamic n.eko networks remain after cleanup"
fi

if docker network ls --filter "label=com.docker.compose.project=$PROJECT_NAME" --format '{{.Name}}' | grep -q .; then
  fail "Compose network for $PROJECT_NAME remains after cleanup"
fi

echo "Dynamic n.eko allocator Docker smoke passed for project $PROJECT_NAME."
