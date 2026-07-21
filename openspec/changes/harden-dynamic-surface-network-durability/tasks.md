## 1. Allocator: idempotent network ownership

- [x] Add `ensureNetworkExists()` to `neko-surface-allocator-server.ts`, called once at allocator startup before serving requests: inspect `GET /networks/{name}`, create via `POST /networks/create` on 404, treat a 409 race as success (re-inspect to confirm).
- [x] No change to `NetworkMode: this.#options.network` container-create wiring — same option, now pointing at an allocator/script-owned network.

## 2. Compose + deploy script wiring

- [x] `docker-compose.neko.yml`: declare the dynamic-surface network `external: true`, attach `reference` and `neko-allocator` to it in addition to their existing network(s).
- [x] Change `PDPP_NEKO_DOCKER_NETWORK` default from `${COMPOSE_PROJECT_NAME:-pdpp}_default` to a fixed, project-independent name.
- [x] `scripts/reference-stack.sh`: add an idempotent `docker network create` pre-step ahead of `docker compose up`.

## 3. Tests

- [x] Unit: `ensureNetworkExists` inspects first, creates only on 404, treats 409 as success.
- [x] Unit: regression guard — the configured network name is never derived from `COMPOSE_PROJECT_NAME`.
- [x] Unit: compose file regression guard — `pdpp_neko_dynamic` is declared `external: true` and its env default is not `COMPOSE_PROJECT_NAME`-derived.
- [x] Docker acceptance (opt-in smoke script): acquire a dynamic surface, run `docker compose down` (no flags) then `docker compose up -d`, confirm same container ID (and unchanged `StartedAt`) survives and remains reachable through the allocator. Run live: PASSED.

## 4. Docs

- [x] `tmp/workstreams/2026-07-14-health-regression/chatgpt-deploy-fix.md`: design decision, rejected alternatives, tests, residual live oracle, HEAD SHA.

## 5. Validation

- [x] `openspec validate harden-dynamic-surface-network-durability --strict`
- [x] `openspec validate --all --strict`
- [x] Focused allocator unit test file green (33/33).
- [x] `docker compose config` clean against modified compose files (no daemon mutation).
- [x] `tsc --noEmit` clean.
- [x] Docker acceptance smoke run locally against a throwaway project name (not the live host) — passed.

## 6. Revision (independent review 2026-07-14, commit eea1689ab): REVISE findings fixed

Independent review found two regressions in the first cut:

- [x] **High**: `docker-neko-network-durability-smoke.sh` inherited `COMPOSE_PROJECT_NAME`/`PDPP_NEKO_DOCKER_NETWORK` from the caller's shell, so a caller whose environment already pointed at the live project could make the "throwaway" smoke's `down --remove-orphans` and unconditional `network rm` mutate the LIVE stack. Fixed: the script no longer reads either variable from the inherited environment at all — both identifiers are always synthesized fresh (PID + random suffix) and cross-checked against a denylist of known live/default names (`pdpp`, `pdpp_default`, `pdpp-reference`) as defense in depth.
- [x] **Medium**: `scripts/reference-stack.sh`'s `ensure_dynamic_surface_network` used a plain `inspect || create` pattern, not race-tolerant against a concurrent creator (a parallel deploy invocation, or the allocator's own startup check) creating the network between the inspect and the create. Fixed: create-then-tolerate-failure-then-confirm-via-inspect, mirroring the allocator's own `ensureNetworkExists` create-then-tolerate-409 idiom; fails closed only if the network can neither be found nor created after that.
- [x] Added `reference-implementation/test/reference-stack-network-durability.test.js` (5 tests, fake-`docker`-on-`PATH` harness, no real daemon required): proves the smoke never emits a live/default identifier to any docker call even when the caller's environment is poisoned with `COMPOSE_PROJECT_NAME=pdpp`/`PDPP_NEKO_DOCKER_NETWORK=pdpp_default`; proves two invocations synthesize distinct names; proves `ensure_dynamic_surface_network` tolerates a losing create-race, is a no-op when the network already exists, and fails closed on a genuine (non-race) failure.
- [x] Rerun full suite (38/38, up from 33), `tsc --noEmit`, `docker compose config`, and the real live Docker acceptance smoke — all green. Manually reproduced the reviewer's exact poisoned-env attack against a faked-unreachable docker on this machine (which has the real live `pdpp` stack running) and confirmed zero calls referenced `pdpp`/`pdpp_default`; confirmed the live stack (`pdpp-reference-1`, `pdpp_default`, live `pdpp-neko-chatgpt-*` containers) was untouched before and after.

## 7. Migration gap (owner review 2026-07-14): existing legacy-network surfaces fixed forward

Owner review of PR #301 found a critical gap the "no boot-time adopt-sweep
needed" reasoning in §Why missed: once `pdpp_neko_dynamic` becomes the
*expected* network, an existing container still attached only to the old
Compose default network reads as `missing_expected_network` /
`health: "unhealthy"` from `#readiness`, and `reconcileSurfacesWithAllocator`
(`packages/remote-surface/src/leases/surface-lease-manager.ts:1049`) treats
allocator `unhealthy` as terminal — it evicts the in-memory surface and fails
any active lease (`surface_failed`), even though the allocator's own
`ensureSurface` replace-vs-reuse logic (keyed only on Docker's own
`Health.Status`) would never have touched that container. Net effect: the
first health check after deploying this change would fail every live
credential-bearing session's lease, and the underlying container would still
never gain the new network (nothing was ever wired to attach it) — so
`docker compose down` would still be unable to cleanly remove the legacy
network even after "fixing" durability.

- [x] Add `legacyNetwork` (`PDPP_NEKO_LEGACY_DOCKER_NETWORK`, defaulting to this repo's own pre-fix Compose default `${COMPOSE_PROJECT_NAME:-pdpp}_default`) to `NekoSurfaceAllocatorServerOptions`/`readNekoSurfaceAllocatorOptionsFromEnv` — explicit, never inferred beyond that one documented default, so the allocator can never be tricked into detaching an arbitrary/user network.
- [x] Add `#migrateContainerNetworkIfNeeded` to `neko-surface-allocator-server.ts`: idempotent connect-then-verify-then-detach against Docker's `/networks/{name}/connect` and `/networks/{name}/disconnect`, called from every access path that returns a live container (`ensureSurface`'s existing-running and existing-restarted branches, and `#readiness` for `getSurfaceStatus`/`listSurfaces`). A failed attach preserves the container and reports health `starting`/reason `legacy_network_migration_pending` (never `unhealthy` — `reconcileSurfacesWithAllocator` treats `unhealthy` as terminal, which would fail the lease over a condition the allocator itself can still fix). A failed detach (post successful attach) reports `ready` and simply retries the detach on the next access. Never touches any network on the container other than the one explicitly configured as legacy.
- [x] `docker-compose.neko.yml`: pass `PDPP_NEKO_LEGACY_DOCKER_NETWORK` to `neko-allocator`, defaulting to the exact pre-fix Compose default network name so an in-place upgrade needs no manual operator config.
- [x] Unit tests (11 new, in `reference-implementation/test/neko-surface-allocator-server.test.js`, extending `FakeDocker` with multi-network container state + `/networks/*/connect`/`/disconnect`): successful migration (attach + detach, same container id); idempotent no-op once already migrated; never detaches an unrelated/unconfigured network even when present alongside the legacy one; no detach attempted when `legacyNetwork` is unconfigured; attach failure preserves the container and reports the bounded pending state; detach failure still reports `ready` and is retried on next access; migration also runs on the restart-not-replace path; `getSurfaceStatus`/`listSurfaces` migrate without going through `ensureSurface`; compose regression guard for the new env line; env-parsing default derivation test.
- [x] Add throwaway Docker acceptance smoke `scripts/docker-neko-network-migration-smoke.sh` (opt-in via `PDPP_DOCKER_NEKO_NETWORK_MIGRATION_SMOKE=1`, same live/default denylist + synthesized-identifier discipline as the existing durability smoke): acquires a surface under an old config where the expected network equals the legacy network, restarts the allocator into the new config with an explicit legacy network configured, proves the SAME container id/`StartedAt` survives the in-place migration, the expected network is attached and the legacy network detached, the surface is reachable/ready, and `docker compose down` afterward succeeds and leaves the container running.
- [x] Extended the ADDED requirements in `specs/reference-implementation-architecture/spec.md` with a new "Existing surfaces SHALL migrate in-place to the externally-managed network" requirement covering the successful-migration, attach-failure, detach-failure, no-legacy-configured, and post-migration-`down`-succeeds scenarios.
- [x] Does not touch `@opendatalabs/remote-surface` — bounded to the allocator (`reference-implementation/server/neko-surface-allocator-server.ts`) and Compose wiring, consistent with the existing "reference-owned Docker/Compose orchestration" scope note above.

## 8. Validation (migration gap fix)

- [x] `tsc --noEmit` clean.
- [x] Focused allocator unit test file: 45/45 (up from 33).
- [x] `openspec validate harden-dynamic-surface-network-durability --strict` and `openspec validate --all --strict` — both clean.
- [x] `docker compose config` clean against the updated compose file (no daemon mutation); confirmed nested `${VAR:-${COMPOSE_PROJECT_NAME:-pdpp}_default}` interpolation resolves correctly.
- [x] Docker acceptance migration smoke run locally against a throwaway project name (not the live host) — passed.
- [x] Live stack untouched (never referenced `pdpp`/`pdpp_default`/`pdpp-reference` in any docker call; no live command run against the running host stack).

## 9. ISOLATION INCIDENT (2026-07-14) and structural fix

While validating §7/§8 by running the migration Docker acceptance smoke
directly against this machine's real Docker daemon (which also runs the
live production `pdpp` stack), the smoke's own throwaway `neko-allocator`
instance connected the REAL LIVE `pdpp-neko-chatgpt-*` and
`pdpp-neko-amazon-*` containers to 4 of the smoke's own throwaway networks
across 3 iteration runs. Root cause: `#listOwnedContainers` filtered ONLY by
the generic `org.pdpp.reference.neko.owner=pdpp-reference` label — every
allocator instance on the Docker host, including a throwaway smoke instance
with no notion of "which deployment am I", shared and matched that same
label, so the throwaway instance's `ensureSurface`/network-migration logic
enumerated and mutated network attachments on containers it had no business
touching. The containers themselves were never removed/replaced/restarted
(StartedAt unchanged, still healthy) — only extra network attachments were
added. Owner (Tim) manually restored live state (verified exact container
IDs/StartedAt unchanged, `pdpp_default` intact, 4 smoke networks removed)
before any further Docker execution was permitted.

Structural fix — deployment-scoped ownership:

- [x] Added required, NO-default `deploymentId` (`PDPP_NEKO_DEPLOYMENT_ID`) to `NekoSurfaceAllocatorServerOptions`/`readNekoSurfaceAllocatorOptionsFromEnv`. No default was a deliberate choice (confirmed with the owner): a shared literal default (even `"production"`) would let two independently-configured instances collide by omission, reproducing this exact incident in a different form. `assertAllocatorOptions` now rejects construction without it.
- [x] Added `#isOwnedByThisDeployment(labels)` — the sole source of truth for "does this allocator instance manage this container": true only if the container's `deployment_id` label exactly matches this instance's own, OR (only when `adoptUnnamespacedLegacyOwner` is explicitly enabled) the container has the generic owner label but NO `deployment_id` label at all. A container belonging to a DIFFERENT named deployment is never eligible, adoption enabled or not.
- [x] `#listOwnedContainers` now filters Docker's owner-label results through `#isOwnedByThisDeployment` in JS (Docker's label filter can't express "label absent", which the adoption case needs) — this is the actual isolation boundary that stops one instance from ever seeing another's containers.
- [x] `#ownedLabels` (used by `#surfaceFromInspect`/`#assertContainerMatchesRequest`) also enforces `#isOwnedByThisDeployment`, so even a direct inspect of a container ID cannot bypass deployment scoping.
- [x] Every newly created container is labeled with this instance's `deploymentId` at create time (`#labelsForRequest`).
- [x] Adoption is confirmed NOT persisted: Docker container labels are immutable after creation (no Engine API to relabel a running container) — confirmed via `docker container update --help` before implementing. `#isOwnedByThisDeployment` is a pure function re-evaluated fresh on every access from the container's actual current labels + this instance's live config; nothing is ever written back to an adopted container. This was confirmed as the correct approach with the owner rather than attempting a persisted-but-impossible relabel.
- [x] Added `adoptUnnamespacedLegacyOwner` (`PDPP_NEKO_ADOPT_LEGACY_UNNAMESPACED_OWNER=1`, default off) — explicit opt-in required to manage genuinely unnamespaced legacy containers (pre-existing owner label, no deployment_id at all); a container with a mismatched deployment_id is never eligible under any setting.
- [x] `docker-compose.neko.yml`: added `PDPP_NEKO_DEPLOYMENT_ID` (defaults to the reviewed, explicit literal `pdpp-reference-production` for this repo's one real deployment) and `PDPP_NEKO_ADOPT_LEGACY_UNNAMESPACED_OWNER` (defaults to `0`). `.env.docker.example` documents both with an explicit warning that a second deployment or smoke instance must never reuse the production default.
- [x] Unit tests (4 new): legacy container is invisible/untouched without the adoption flag (verified this test actually caught a real fixture-ID-collision bug in the test itself before being fixed — the fresh container Node ID generator and the manually-added legacy container ID collided); a container belonging to a DIFFERENT deployment id is never enumerated/migrated/touched even with adoption enabled; `readNekoSurfaceAllocatorOptionsFromEnv` requires `PDPP_NEKO_DEPLOYMENT_ID` with no default (throws `bad_request` if missing); env parsing of `deploymentId`/`adoptUnnamespacedLegacyOwner` defaults. All prior fixture helpers/tests updated to carry a `deployment_id` label matching the test's own `BASE_OPTIONS.deploymentId` so pre-existing test intent is preserved.
- [x] Negative-control proof (code-level, not Docker): temporarily disabled the network-connect call inside `#migrateContainerNetworkIfNeeded`, reran the full allocator unit suite, confirmed `listSurfaces` migration tests failed exactly as expected (health `starting` instead of `ready`), then restored the real code and reconfirmed 49/49 green — proves the test suite is a genuine falsifier for the deployment-scoped migration logic.
- [x] Rewrote `scripts/docker-neko-network-migration-smoke.sh` and updated `scripts/docker-neko-network-durability-smoke.sh` (which would otherwise now fail to start, since `PDPP_NEKO_DEPLOYMENT_ID` is required) to: synthesize a unique `PDPP_NEKO_DEPLOYMENT_ID` per run (PID + random suffix) in addition to the existing unique project/network names; hard-fail before any Docker call if the synthesized deployment id matches a denylist of production-like values (`pdpp-reference-production`, `production`, `default`, `prod`); the migration smoke additionally plants a `docker run`-created "foreign production-like" container (generic owner label, but a DIFFERENT synthesized deployment id, same legacy-network-only shape) via a path independent of the allocator under test, and asserts after the real migration that (a) `listSurfaces` never enumerated it, (b) its network attachments are byte-identical before/after, (c) it is still running — the concrete negative test the owner required.
- [x] **NOT RUN**: per explicit owner instruction, no Docker acceptance execution (`docker compose up`/`down`, `docker network connect/disconnect/rm`, `docker run`) was performed after the incident. The rewritten smoke scripts are syntax-checked (`bash -n`) only. All verification above this point is `tsc --noEmit`, the Node unit test suite (`node --test`), and `docker compose config` (a pure local YAML-merge/render, confirmed non-mutating), never a real Docker daemon call.
- [x] Extended `specs/reference-implementation-architecture/spec.md` with a new "Allocator container ownership SHALL be scoped to an explicit deployment identity" requirement covering: two instances sharing a host, no-deployment-label containers with adoption off/on, and every new container carrying its creator's deployment identity.

### Proposed acceptance command for an independent reviewer

Both Docker acceptance smokes now require a distinct, non-production
`PDPP_NEKO_DEPLOYMENT_ID` to even start, and hard-fail closed before any
`docker` command if that identity (or any project/network name) resembles a
production default. Recommended reviewer procedure, run from a host that
either has no live `pdpp` stack or where the reviewer has independently
confirmed the live stack's current container IDs/StartedAt beforehand so a
before/after diff is possible:

```
cd reference-implementation && npx tsc --noEmit && node --test test/neko-surface-allocator-server.test.js test/reference-stack-network-durability.test.js
cd .. && docker compose -f docker-compose.yml -f docker-compose.neko.yml --profile neko-dynamic config >/dev/null
PDPP_DOCKER_NEKO_NETWORK_DURABILITY_SMOKE=1 bash scripts/docker-neko-network-durability-smoke.sh
PDPP_DOCKER_NEKO_NETWORK_MIGRATION_SMOKE=1 bash scripts/docker-neko-network-migration-smoke.sh
```

Before running the two smoke scripts, the reviewer should independently
snapshot `docker ps -a --format '{{.Names}}\t{{.ID}}\t{{.Status}}'` and
`docker inspect -f '{{.State.StartedAt}}'` for every live `pdpp-neko-*`
container, then re-run the same snapshot after both smokes complete (they
self-clean via `trap cleanup EXIT`) and diff — the diff MUST be empty. This
is the same verification method that caught the original incident; it
should now catch a recurrence rather than a human noticing collateral
`docker network ls` output after the fact.

## 10. REVISE (owner code review, 2026-07-14): two real blockers found and fixed

Owner review of commit `015d4989a` (§9's fix) caught two gaps that would
have shipped:

**(1) `adoptUnnamespacedLegacyOwner=true` still reproduced the incident.**
`#isOwnedByThisDeployment` matched ANY container with `owner=pdpp-reference`
and no `deployment_id` label, globally — the flag added no per-instance
scoping at all, only a global on/off switch. A throwaway smoke instance with
adoption enabled would have adopted (and migrated the network of) every
unnamespaced legacy container on the Docker host, including a different
deployment's, exactly reproducing the original incident under a different
trigger condition.

- [x] Removed `adoptUnnamespacedLegacyOwner` entirely (option, env var
  `PDPP_NEKO_ADOPT_LEGACY_UNNAMESPACED_OWNER`, compose wiring, docs, tests) —
  once Compose-project scoping exists it adds no safety and only risks an
  operator forgetting to set it and permanently stranding an unlabeled
  legacy container (Docker labels are immutable post-create).
- [x] `deploymentId` is now REQUIRED TO EQUAL the Compose project identity
  (`COMPOSE_PROJECT_NAME`) — not a second, independently-chosen literal.
  `docker-compose.neko.yml`'s default changed from the unrelated literal
  `pdpp-reference-production` to `${PDPP_NEKO_DEPLOYMENT_ID:-${COMPOSE_PROJECT_NAME:-pdpp}}`.
- [x] `#isOwnedByThisDeployment` rewritten: recognizes an unnamespaced
  container (owner label present, no `deployment_id` label) ONLY if its
  Docker-Compose-assigned `com.docker.compose.project` label — set by
  Compose itself, never by this allocator's own label-writing code, so it
  cannot be spoofed by us — exactly matches `this.#options.deploymentId`.
  Automatic and unconditional: no opt-in flag. A container with an explicit,
  mismatched `deployment_id` label is never eligible regardless of its
  Compose project.
- [x] New unit test: an unnamespaced legacy container from a DIFFERENT
  Compose project is invisible and untouched (replaces the old
  "adoption disabled" test, which tested a concept that no longer exists).
  Existing "different deployment id" test retitled/reworded to clarify it
  covers explicit-mismatch, not Compose-project scoping.
- [x] `.env.docker.example` and `docker-compose.neko.yml` comments rewritten
  to explain the Compose-project-identity relationship and the removal of
  the flag.

**(2) Legacy detach happened after only proving network ATTACHMENT, never
REACHABILITY.** `hasNetwork()` (a Docker inspect field check) only proves
Docker created the network endpoint — it says nothing about whether the neko
process is actually reachable over that specific path yet (e.g. still
binding, bridge still initializing). Detaching legacy before confirming that
would risk cutting the only working path to a container whose new endpoint
exists but isn't functional yet.

- [x] Added `#isReachableOnExpectedNetwork(inspect)`: a bounded,
  non-recursive probe (does NOT call `#readiness`, which itself calls the
  migration method) that reads the container's own IP address on
  `this.#options.network` directly from the Docker inspect response
  (`NetworkSettings.Networks[network].IPAddress`) and issues a direct HTTP
  probe to `http://{ip}:{containerHttpPort}{nekoHealthPath}` — deliberately
  NOT container-name DNS, since this allocator is itself attached to both
  the expected and legacy networks and a name-based probe could silently
  resolve via either, proving nothing network-specific.
- [x] `#migrateContainerNetworkIfNeeded` now gates the legacy detach on this
  probe succeeding, in addition to the existing attachment-inspect check.
- [x] Extended `DockerContainerInspect.NetworkSettings.Networks` type from
  `Record<string, unknown>` to `Record<string, { IPAddress?: string } | undefined>`
  to type this correctly — the minimal shape extension needed, not a
  speculative broader typing.
- [x] New unit test: legacy network is NOT detached when the expected-network
  IP-specific probe fails, even though the attach step itself succeeded
  (`FakeDocker` extended with a deterministic per-container-per-network
  `ipAddressFor` so the test can target the fetch mock at the exact expected
  IP and assert the legacy network stays attached and no detach call is
  issued).
- [x] Negative-control proof (code-level): temporarily short-circuited the
  reachability gate (`if (false && ...)`), reran the suite, confirmed
  exactly the new reachability test failed (and only that test), restored
  the real code, reconfirmed 50/50 green.
- [x] Updated `docker-neko-network-migration-smoke.sh` comments: this is the
  one place the reachability gate is exercised against a real Docker
  network and a real neko process (not a fake `fetch`) — the surface
  reaching `ready` there is what actually proves the direct-IP probe
  succeeded before detach, not merely that the smoke script's own
  post-hoc network assertions happened to pass.

**Also fixed while here**: both Docker smoke scripts' `DEPLOYMENT_ID` is
now set equal to their own synthesized `PROJECT_NAME` (matching the
required Compose-project-identity relationship) instead of being a
separately synthesized string with its own denylist — removes duplicate
denylist logic. The migration smoke's foreign-container negative control now
plants an unnamespaced container (no `deployment_id` label) from a
DIFFERENT synthesized Compose project, which is the shape that actually
exercises the fixed `#isOwnedByThisDeployment` logic (the old version's
foreign container had an explicit mismatched `deployment_id`, which was
already covered by a separate unit test and never exercised the
Compose-project-scoping code path this REVISE round added).

- [x] `tsc --noEmit` clean.
- [x] Focused allocator unit test file: 50/50 (up from 49; +2 new, -1
  obsolete-concept test replaced, net +1).
- [x] `openspec validate --strict` (change + full corpus) clean.
- [x] `docker compose config` clean; confirmed `PDPP_NEKO_DEPLOYMENT_ID`
  resolves to `COMPOSE_PROJECT_NAME` by default via `docker compose config`.
- [x] **STILL NOT RUN**: no Docker acceptance execution. Both rewritten
  smoke scripts are `bash -n` syntax-checked only. Commit amended
  (`015d4989a` → new SHA after this revision), not force-pushed anywhere
  (branch was never pushed).

## 11. REVISE (owner static read, 2026-07-14): smoke-script cleanup was itself unscoped

Owner static read of the amended smoke scripts (after §10) found a third
gap, this time in the scripts' own cleanup/teardown logic, not the
allocator: `cleanup()` in both `docker-neko-network-durability-smoke.sh`
and `docker-neko-network-migration-smoke.sh` filtered candidate containers
for removal by the generic owner label PLUS a FIXED surface-id label
literal (`net-durability-smoke-surface` / `net-migration-smoke-surface` /
`net-migration-smoke-foreign-surface`) — the same literal string on every
invocation of the script. A concurrent run of the same smoke script (or, in
principle, any coincidentally-named live surface reusing that literal id)
could have its containers removed by a DIFFERENT run's cleanup — the same
class of isolation bug as §9/§10, just in the smoke harness's own
bookkeeping rather than the allocator under test. Separately, both scripts'
default `PROFILE_ROOT` was a single fixed `/tmp` path, so two concurrent
invocations would write to the same host directory and risk corrupting or
racing on each other's Chromium profile state.

- [x] `cleanup()` in both scripts now filters `docker ps -aq` by THIS RUN's
  own synthesized `org.pdpp.reference.neko.deployment_id` label (durability
  smoke) or, for the migration smoke's two container classes, the
  synthesized `deployment_id` (real smoke container) and the synthesized
  `com.docker.compose.project` (foreign-project negative-control container)
  — never the fixed surface-id literal alone.
- [x] Added `rm_if_labeled_exactly()` to both scripts: defense in depth
  beyond the `docker ps --filter` match itself — before any `docker rm`, it
  re-inspects the candidate container id and refuses to remove it unless
  the label value is BYTE-IDENTICAL to this run's own synthesized
  identifier, logging a refusal message (not silently skipping) if it
  isn't. Never trusts a filter match alone for a destructive operation.
- [x] `PROFILE_ROOT` in both scripts now defaults to
  `/tmp/pdpp-neko-profiles-${PROJECT_NAME}` (durability) /
  `/tmp/pdpp-neko-profiles-${PROJECT_NAME}` (migration) — scoped by this
  run's own synthesized project name, never a fixed shared path.
- [x] Added 2 fixture tests to
  `reference-implementation/test/reference-stack-network-durability.test.js`
  (fake-`docker`-on-`PATH` harness, no real daemon): (a) proves
  `cleanup()`'s `docker ps` filter call references this run's own
  synthesized `deployment_id`, not the fixed surface-id literal, and that a
  `docker inspect` verification call happens before any `docker rm`; (b)
  proves the default `PROFILE_ROOT` is scoped by `PROJECT_NAME` via a
  static source-text assertion.
- [x] Negative-control proof (code-level, not Docker): temporarily reverted
  the durability smoke's cleanup filter to the old fixed-literal form,
  reran the fixture test file, confirmed exactly the new cleanup-scoping
  test failed (and only that test), restored the real script, reconfirmed
  7/7 fixture tests and 50/50 allocator tests green.

- [x] `tsc --noEmit` clean.
- [x] Focused allocator unit test file: 50/50; fixture test file: 7/7 (up
  from 5) — 57/57 combined.
- [x] `openspec validate --strict` (change + full corpus) clean.
- [x] `docker compose config` clean.
- [x] `bash -n` syntax check on both rewritten smoke scripts — clean.
- [x] **STILL NOT RUN**: no Docker acceptance execution at any point since
  the original round-1 incident. Commit amended again after this round.
