## Why

A 2026-07-14 forensic pass (`tmp/workstreams/2026-07-14-health-regression/chatgpt-deploy-durability-design.md`)
diagnosed dynamic n.eko browser-surface containers — which hold the live,
credential-bearing ChatGPT Chromium process the `retain-credential-boundary-surface-process`
change deliberately keeps alive — as vulnerable to an ordinary `docker compose
down`/`up` redeploy. Its proposed fix (stop the allocator from emitting a
colliding `com.docker.compose.service` label) targeted a container-removal
mechanism that is not present in current code: `neko-surface-allocator-server.ts`
only ever sets `org.pdpp.reference.neko.*` labels, confirmed by
`reference-implementation/test/neko-surface-allocator-server.test.js`. Compose's
`down` container sweep matches on `com.docker.compose.service`, so allocator
containers were never matched by that mechanism as currently written.

The durability gap that remains is one layer down, at the network. Dynamic
surfaces attach to `PDPP_NEKO_DOCKER_NETWORK` (`docker-compose.neko.yml:97`),
currently set to `${COMPOSE_PROJECT_NAME:-pdpp}_default` — Compose's own
implicit default project network. No compose file in this repo declares a
`networks:` top-level key or any `external: true` network. `docker compose
down` unconditionally attempts to remove every project network as part of
its teardown, not gated on `--remove-orphans`. Docker refuses to remove a
network with an attached container (`network has active endpoints`); this
repo's own `scripts/docker-neko-dynamic-allocator-smoke.sh` demonstrates the
failure mode indirectly — its `cleanup()` force-removes allocator-owned
containers *before* calling `down --remove-orphans`, specifically so that
network-remove step succeeds, which only makes sense if a live-attached
container would otherwise block or degrade it.

So today: an ordinary `docker compose down` does not destroy the ChatGPT
browser containers (labels already protect them), but it does attempt to
tear down the network those containers and the `reference`/`neko-allocator`
services depend on for reachability, leaving a broken or partially-removed
network and an unpredictable subsequent `up`. The canonical deploy path,
`scripts/reference-stack.sh`, never calls `down`, so this is not the exact
mechanism of the 07-11 incident — but `docker-smoke.sh` and
`railway-sqlite-restart-smoke.sh` already call `down --remove-orphans`
against project-scoped compose invocations, and nothing prevents a future
teardown/redeploy path or manual operator action from doing the same against
the live project. Ordinary deploy/down-up SHALL preserve both dynamic
surface container identity and networking; only genuine explicit container
loss (host reboot, OOM, manual `docker rm`) should yield the existing
one-clean-`session_required`-repair behavior.

## What Changes

- Give dynamic n.eko surfaces a dedicated Docker network that the allocator
  creates and owns (idempotent create-if-missing at allocator startup),
  declared in compose files as `external: true` so Compose attaches
  `reference`/`neko-allocator` to it for service-DNS reachability but never
  creates or removes it. `docker compose down`, with or without
  `--remove-orphans`, only ever manages networks it created itself; an
  externally-managed network is invisible to that teardown regardless of
  what remains attached to it.
- Change `PDPP_NEKO_DOCKER_NETWORK`'s default from a `COMPOSE_PROJECT_NAME`-
  interpolated value to a fixed, project-independent name, since the
  network's whole purpose is to sit outside any one Compose project's
  lifecycle.
- Add an idempotent `docker network create` pre-step to `scripts/reference-stack.sh`
  ahead of `docker compose up`, because `external: true` networks must exist
  before Compose can attach any service to them, including on a cold start
  before any allocator code has run.
- Add Docker-level acceptance coverage (throwaway, opt-in smoke script)
  proving the same container ID survives a real `docker compose down` +
  `docker compose up -d` cycle and remains reachable afterward.
- No change to `@opendatalabs/remote-surface` — this is Docker/Compose
  orchestration, entirely reference-owned per the existing "Dynamic n.eko
  allocation SHALL consume package seams without owning streaming
  extraction" requirement.
- No boot-time adopt-sweep added: investigated and found unnecessary — the
  existing `reconcileSurfacesWithAllocator` boot reconciliation already
  re-validates every lease-store row against the allocator, and since this
  change keeps containers running (not destroyed) and their lease-store rows
  survive (Postgres is an untouched named volume across `down`/`up` without
  `-v`), there is no demonstrated identity gap requiring new adopt logic.

## Addendum (owner review 2026-07-14): existing surfaces need an explicit migration path

The "no boot-time adopt-sweep needed" reasoning above assumed containers
would simply keep running on their prior network forever, with no
expectation that they ever join the new externally-managed network. That
assumption does not hold: `#readiness` treats a running container missing
the *expected* network as `unhealthy`, and `reconcileSurfacesWithAllocator`
(`packages/remote-surface/src/leases/surface-lease-manager.ts:1049`) treats
allocator `unhealthy` as terminal — evicting the surface and failing any
active lease. So every container created under the pre-fix Compose default
network would have its live, credential-bearing lease killed by the very
first health reconcile after this deploy, without ever actually gaining the
new network (nothing was wired to attach it).

Fix-forward, not a revert: the allocator now performs a live-safe, general,
idempotent in-place network migration — enumerate only allocator-owned
containers, attach the missing expected network, verify via re-inspect, and
only then detach an explicitly-configured legacy network — on every access
path that returns a live container (`ensureSurface`, `getSurfaceStatus`,
`listSurfaces`). Failure at any step preserves the existing container
unchanged and reports a bounded, retryable pending state, never `unhealthy`
and never a replace. See tasks.md §7 for the itemized fix and §8 for
validation; spec.md gained a new "Existing surfaces SHALL migrate in-place
to the externally-managed network" requirement.

## Addendum 2 (isolation incident, 2026-07-14): container ownership was never deployment-scoped

Validating the addendum above by running its Docker acceptance smoke against
this machine's real Docker daemon exposed a structural gap that predates
both this change and the original PR #301: `#listOwnedContainers` filtered
containers by only the generic `org.pdpp.reference.neko.owner=pdpp-reference`
label. Every allocator instance on a Docker host — including a throwaway
smoke/test instance — shares that same label, so the smoke's own instance
enumerated and reconfigured network attachments on real live production
containers sharing the daemon. The containers themselves were never
destroyed (identity/StartedAt preserved throughout); the owner manually
verified and restored the pre-incident network attachments before further
work proceeded.

Fix: a required, no-code-default `deploymentId`
(`PDPP_NEKO_DEPLOYMENT_ID`) that scopes every ownership check
(`#isOwnedByThisDeployment`). See tasks.md §9 for the full incident record —
NOTE: §9's initial fix used an `adoptUnnamespacedLegacyOwner` opt-in flag
that a subsequent code review (tasks.md §10) found still reproduced the
incident under adoption=true; that flag was removed and replaced with
Compose-project-identity scoping, described in Addendum 3 below.

## Addendum 3 (REVISE, owner code review 2026-07-14): Compose-project scoping + reachability-before-detach

Code review of Addendum 2's fix found two real gaps before it shipped:

1. `adoptUnnamespacedLegacyOwner=true` matched ANY unnamespaced
   `owner=pdpp-reference` container globally, with no per-instance scoping —
   a throwaway smoke instance with adoption enabled would have adopted a
   different deployment's legacy containers too, reproducing the incident
   under a different trigger. Fixed: `deploymentId` is now REQUIRED TO EQUAL
   the Compose project identity (`COMPOSE_PROJECT_NAME`), and unnamespaced-
   container recognition requires the container's Docker-Compose-assigned
   `com.docker.compose.project` label (set by Compose itself, not
   spoofable by this allocator's own code) to match — unconditionally, no
   opt-in flag. The flag was removed entirely: it added no safety once the
   Compose-project check exists, and only risked an operator forgetting to
   set it and permanently stranding an unlabeled legacy container (Docker
   labels are immutable after creation).
2. `#migrateContainerNetworkIfNeeded` detached the legacy network as soon as
   Docker's inspect response showed the expected network attached —
   proving Docker created the endpoint, not that the container was actually
   reachable over it yet. Fixed: added `#isReachableOnExpectedNetwork`, a
   bounded, non-recursive probe against the container's own IP address on
   the expected network (read directly from Docker's inspect response,
   never via container-name DNS — this allocator is attached to both
   networks, so a name-based probe could silently succeed via the
   still-attached legacy network and prove nothing network-specific). The
   legacy detach is now gated on both attachment AND this reachability
   proof.

Both fixes are unit-tested with dedicated positive and negative-control
tests (see tasks.md §10), including a code-level negative control that
temporarily disabled each gate and confirmed the exact expected test
failures before restoring. No Docker acceptance execution has been
performed at any point since the original isolation incident.

## Addendum 4 (REVISE, owner static read 2026-07-14): the smoke scripts' own cleanup was still unscoped

A static read of the smoke scripts (after Addendum 3) found the same class
of isolation bug one layer down — in the smoke harnesses' own teardown, not
the allocator: `cleanup()` in both scripts filtered candidate containers for
removal by the generic owner label plus a FIXED surface-id literal shared by
every invocation of that script, so a concurrent run could remove
containers belonging to a different run. Both scripts also defaulted
`PROFILE_ROOT` to a single fixed `/tmp` path, risking concurrent-run
corruption. Fixed: `cleanup()` now filters by this run's own synthesized
`deployment_id` (and, for the migration smoke's foreign-control container,
`com.docker.compose.project`), with a `docker inspect` verification step
before every `docker rm` as defense in depth beyond the filter match itself;
`PROFILE_ROOT` now defaults to a project-scoped path. See tasks.md §11 for
the itemized fix, fixture tests, and negative-control proof.

## Capabilities

- Modified: `reference-implementation-architecture`

## Impact

- `reference-implementation/server/neko-surface-allocator-server.ts` —
  idempotent network-ensure step; `legacyNetwork` option and
  `#migrateContainerNetworkIfNeeded` in-place migration, gated on both
  network attachment AND `#isReachableOnExpectedNetwork` (direct-IP probe)
  before ever detaching legacy; required `deploymentId` option (equal to
  the Compose project identity) and `#isOwnedByThisDeployment` ownership
  scoping via the container's own `deployment_id` label or (unnamespaced
  containers only) a matching `com.docker.compose.project` label — no
  opt-in flag.
- `docker-compose.neko.yml` — `external: true` network declaration, service
  attachment, `PDPP_NEKO_DOCKER_NETWORK` default,
  `PDPP_NEKO_LEGACY_DOCKER_NETWORK` default, `PDPP_NEKO_DEPLOYMENT_ID`
  default (`COMPOSE_PROJECT_NAME` itself, not a separate literal).
- `.env.docker.example` — documents the deployment-identity var and its
  required relationship to `COMPOSE_PROJECT_NAME`.
- `scripts/reference-stack.sh` — idempotent pre-create step.
- Docker acceptance smoke scripts (opt-in, mirror
  `scripts/docker-neko-dynamic-allocator-smoke.sh` conventions), both now
  setting `PDPP_NEKO_DEPLOYMENT_ID` equal to their own synthesized project
  name: `docker-neko-network-durability-smoke.sh` (redeploy durability),
  `docker-neko-network-migration-smoke.sh` (legacy-to-expected migration,
  including a planted foreign-Compose-project negative-control container).
- `reference-implementation/test/neko-surface-allocator-server.test.js` —
  unit coverage for idempotent network-ensure, non-project-scoped naming,
  in-place migration, and deployment-scoped ownership isolation.
