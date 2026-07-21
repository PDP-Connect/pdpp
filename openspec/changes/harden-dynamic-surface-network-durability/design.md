## Context

Investigated the current (post-07-14) code, not just the forensic doc.
`neko-surface-allocator-server.ts#labelsForRequest` never sets
`com.docker.compose.*` labels — only `org.pdpp.reference.neko.*`. Docker
Compose only stamps its own `com.docker.compose.*` labels on containers it
creates itself; the allocator creates containers via a raw `POST
/containers/create` call, so no accidental inheritance occurs either. The
07-14 doc's label-collision premise does not describe this repo's current
state. Verified this holds by reading the file directly and cross-checking
`reference-implementation/test/neko-surface-allocator-server.test.js`, which
asserts the label set explicitly.

The still-live gap is network ownership. `docker-compose.neko.yml` passes
`PDPP_NEKO_DOCKER_NETWORK=${COMPOSE_PROJECT_NAME:-pdpp}_default` to the
allocator — Compose's own implicit default network, created by `up` and
unconditionally torn down by `down` (not gated on `--remove-orphans`). No
compose file declares `networks:` or `external: true` anywhere in this repo
today. `docker network rm` (which `down` calls per-project-network) fails
when a container is still attached — verified against documented Docker
behavior and indirectly against this repo's own
`scripts/docker-neko-dynamic-allocator-smoke.sh`, whose `cleanup()`
force-removes allocator-owned containers via `docker rm -f` immediately
*before* `down --remove-orphans`, which is only necessary if a live
container would otherwise block/degrade that removal.

## Goals / Non-goals

**Goals**
- Ordinary `docker compose down` + `docker compose up` (any flag
  combination in current use in this repo) SHALL NOT destroy dynamic n.eko
  containers or break their network reachability.
- The fix SHALL generalize to any future teardown/redeploy call site, not
  just the two `down` invocations that exist today — network ownership, not
  a per-script workaround.
- Genuine explicit container loss (host reboot, OOM-kill, manual `docker rm`
  of a specific container, image change forcing recreate) SHALL still yield
  exactly the existing one-clean-`session_required`-repair behavior. This
  change does not touch that path.
- No `@opendatalabs/remote-surface` change — Docker/network specifics stay
  reference-owned per the existing "Dynamic n.eko allocation SHALL consume
  package seams without owning streaming extraction" requirement.

**Non-goals**
- No boot-time discovery/adopt sweep. Investigated: `reconcileSurfacesWithAllocator`
  (`packages/remote-surface/src/leases/surface-lease-manager.ts:1020-1071`,
  called from `run-coordinator.ts:910` at boot) already re-validates every
  lease-store row against `allocator.getSurfaceStatus(surfaceId)`. This
  change keeps containers alive across `down`/`up` and their lease-store
  rows survive (Postgres named volume, untouched without `-v`), so existing
  per-row reconcile has rows to reconcile against — nothing is orphaned for
  a sweep to discover. Not adding one; would be speculative complexity with
  no demonstrated gap.
- No re-litigating retention/lease semantics from `retain-credential-boundary-surface-process`
  — this change is entirely below that layer, in the allocator's Docker
  orchestration.
- No change to genuine-loss repair semantics (`session_required` classification,
  retry-classifier terminal handling, scheduler owner-action gate) — already
  correct and out of scope.

## Design

### Why an allocator-owned `external: true` network, not a second Compose-declared network

A second network declared under `docker-compose.neko.yml`'s `networks:` key
(without `external: true`) would still be a Compose-owned resource for the
`pdpp` project — `down` tears down every project network unconditionally,
so this reproduces today's exact failure one layer removed: more networks,
same ownership defect. The defect is Compose ownership + Compose-triggered
removal, not "one network is doing double duty as inter-service DNS and
dynamic-surface attachment." An `external: true` declaration tells Compose
"attach my services to this network but never create or destroy it" — this
is Docker's own documented pattern for a network whose lifecycle needs to
outlive one project's `up`/`down` cycle (e.g. shared reverse-proxy networks
in typical multi-compose-project deployments). Applying that same pattern
here is not a novel construction; it is the standard tool for exactly this
kind of cross-lifecycle-boundary requirement.

### Who creates the network, and when

`external: true` requires the network to exist *before* `docker compose up`
attaches any service to it — Compose does not create externally-declared
networks and errors if one is missing. Two creators, covering different
startup orders:

1. **`scripts/reference-stack.sh`**: an idempotent `docker network create
   --driver bridge <name> || true`-shaped pre-step ahead of `docker compose
   up`, covering cold start (no allocator container exists yet to run
   allocator code).
2. **The allocator itself**, at its own process startup, before serving
   requests: inspect-then-create, tolerating a 409 (a concurrent creator —
   e.g., the script above raced with an allocator restart) as success. This
   covers any path that does not go through `reference-stack.sh` (e.g., a
   raw `docker compose up neko-allocator` during local dev, or a future
   redeploy tool), and makes the allocator self-sufficient rather than
   silently depending on an external script always running first.

Both are idempotent and cheap (a single inspect call in the steady-state
case), so having both is not meaningfully more complex than one — it
removes a startup-ordering footgun instead of documenting one.

### Container-create wiring is unchanged

`HostConfig.NetworkMode: this.#options.network` already just takes a
network name string sourced from `PDPP_NEKO_DOCKER_NETWORK`. The network
that name now points to is allocator/script-created instead of
Compose-created; no change to the container-create call itself.

### Label-based fix: not needed, not added

Confirmed via direct code read that the current label set
(`org.pdpp.reference.neko.*` only) already prevents Compose's
`com.docker.compose.service`-keyed container sweep from matching allocator
containers. No label change is included in this change — there is nothing
to fix at that layer today. (If a future refactor ever added a
`com.docker.compose.*` label to these containers, `docker compose down`'s
container-removal step, independent of the network fix here, would again be
able to match and remove them — that is a distinct risk from the one this
change addresses and would need its own regression guard if it ever became
relevant; not adding a preemptive guard for a mechanism not present in
current code.)

## Failure semantics after this change

- **Ordinary `reference-stack.sh up` redeploy**: unaffected either way —
  already did not call `down`, already did not touch these containers.
- **`docker compose down` (any flags) + `up`**: dynamic containers are not
  swept (already true today, unchanged by this fix) AND the network they
  depend on is not swept (new). `reference`/`neko-allocator` reconnect to
  the same live, externally-managed network on `up`; lease-store rows
  survive in Postgres; existing boot reconciliation confirms the surfaces
  are still live. Zero ChatGPT re-auth required.
- **`docker compose down -v` or explicit volume/network deletion**: still
  destroys everything, including Postgres and (if the operator explicitly
  targets it) the external network itself — out of scope, already a known
  destructive operation.
- **Genuine host reboot / OOM-killed container / manual `docker rm` of a
  specific dynamic n.eko container**: unchanged — one clean
  `session_required` repair, as designed.

## Tests / acceptance

1. **Unit** (`reference-implementation/test/neko-surface-allocator-server.test.js`):
   - Network-ensure: inspects first, only calls create on 404; treats
     create-409 as success.
   - Regression guard: the network name passed to `NetworkMode` is not
     derived from `COMPOSE_PROJECT_NAME` (stays fixed regardless of project
     name env), preventing a future refactor from silently reintroducing
     project-scoping.
2. **Docker-level acceptance, throwaway/opt-in** (new script, same
   `PDPP_DOCKER_*_SMOKE=1`-gated convention as
   `scripts/docker-neko-dynamic-allocator-smoke.sh`): acquire a dynamic
   surface, capture its container ID, run `docker compose down` with no
   flags, run `docker compose up -d`, confirm via `docker inspect` that the
   SAME container ID is still running, healthy, and reachable through the
   allocator's HTTP API. This directly falsifies or confirms the fix
   without needing real ChatGPT credentials, and is the closest safe analog
   to the actual failure shape.
3. **Owner-run live acceptance on the real host** (residual, not run by
   this change — no live-stack mutation permitted): with both ChatGPT
   connections healthy, run an ordinary redeploy and confirm zero
   `session_required` events and unchanged container IDs; separately,
   force genuine container loss directly (bypassing Compose) and confirm
   exactly one clean repair. Left as an owner follow-up, documented in the
   report.

## Rejected alternatives

- **Label-only fix (07-14 doc's proposal)**: moot against current code (no
  colliding label exists) and, even where it would apply, does not address
  network teardown at all.
- **Second Compose-declared (non-external) network**: still Compose-owned,
  still swept by `down` — reproduces the defect one layer removed.
- **Forbid bare `docker compose down` by convention/documentation only**:
  rejected as insufficient on its own, same reasoning as the 07-14 doc —
  a process/discipline fix with no enforcement is a landmine for the next
  script or operator action that runs `down` for any reason, as two scripts
  in this repo already do today.
- **Boot-time allocator discovery/adopt sweep**: investigated, found
  unnecessary given this fix's approach — see Non-goals.
