## Context

### Verified root-cause chain

Two connection-scoped ChatGPT runs succeed on usable live surfaces, then the next
hourly ticks acquire freshly-created dynamic n.eko containers, probe
`api_session_user=false`, log a DOM logged-out page, decide
`credential_login_required`, and each schedule performs three rapid failed attempts.
Both connections then project `browser_session` reauth. Container `Created`
timestamps match the first failing acquisition exactly, and the persisted profile
holds device/CSRF/Cloudflare cookies but no durable authenticated session cookie.

The chain, confirmed from current code (`origin/main` 9f13b2490):

1. `BrowserConfig.preservePageOnSuccess`/`preservePageOnFailure`
   (`packages/polyfill-connectors/src/connector-runtime.ts:152`) preserve only the
   Chromium **page/tab** within a live surface. ChatGPT sets both
   (`connectors/chatgpt/index.ts:3972`). No signal from these flags reaches the
   surface-lease or allocator layer — surface **container** survival is governed
   entirely by the lease layer.
2. After a run, `release` frees the lease but leaves the surface `ready` and idle
   for reuse. The container is not stopped by release.
3. The surface is later stopped by capacity pressure or idle TTL:
   - Capacity pressure (`planCapacityPressureReclaim` /
     `completeCapacityPressureReclaim`, wired per-run at
     `run-coordinator.ts:1003`) stops the oldest idle **incompatible** surface to
     free a slot when the cap is full. With `surfaceCap=3` and five managed
     connectors (2 ChatGPT + Chase/USAA/Amazon/Reddit), an hourly non-ChatGPT run
     that finds the cap full reclaims a retained-but-idle ChatGPT surface.
   - Idle TTL (`cleanupIdleSurfaces`, default 10 min) stops any ready idle surface.
     It is defined but currently has no production timer/route caller; capacity
     pressure is the live driver today. This change must neutralize **both** so a
     later wiring of idle cleanup cannot reintroduce the failure.
   - At the container level, the idle-TTL and capacity-pressure `stopSurface`
     paths stop but do not remove the container
     (`neko-surface-allocator-server.ts:383`) — intending "restart cheaply."
4. That intent is unreachable. `surface_id = bs_${crypto.randomUUID()}`
   (`surface-lease-manager.ts:537`) is minted fresh on every acquire and is not
   derived from the connection. The allocator matches containers by the
   `surface_id` label (`#findOwnedContainer`), so the next ChatGPT acquire's new
   `surface_id` never matches the stopped container. `ensureSurface` finds no owned
   container and **creates a brand-new one**. The stopped container becomes an
   orphan carcass, later removed by port reclaim or boot reconcile.
5. A fresh container is a fresh Chromium process. Per the archived residual risk,
   ChatGPT's authenticated API session lives in process-scoped browser state that
   the persistent profile and `RestoreOnStartup` do not restore. Auth is lost.
6. The scheduled run then decides `credential_login_required`, and the run-executor
   retry loop (`shouldRetryRunFailure`) retries the browser-session auth failure
   because it is not classified as terminal `authentication_error`, producing the
   three-attempt burst.

The essential defect is a boundary mismatch: **surface identity is ephemeral and
random, but the container and profile are durable and connection-scoped, and for
credential-boundary connectors the live process is the auth boundary.** Reaping a
healthy retained surface destroys exactly the state that made collection work.

### Why not the existing page-preservation fix

`preservePageOnSuccess` keeps the page alive *if the surface lives*. It does nothing
when the surface itself is stopped. The archived change explicitly logged this as a
residual risk. This change closes the gap at the surface-process layer.

## Decision

### A generic `retained` surface property, decided at the RI boundary

The remote-surface lease layer gains a generic `retained` boolean on
`BrowserSurface` and a `retainProcess` flag on the acquire request. The lease layer
never inspects connector identity or manifests — it only honours the boolean its
caller passes. This keeps the surface substrate reusable and free of PDPP/ChatGPT
leakage.

Retention and page preservation are the same fact seen from two layers, so they
are declared **once** in a single side-effect-free connector-runtime policy module,
`packages/polyfill-connectors/src/browser-surface-policy.ts`. Each entry states
`preservePageOnSuccess`, `preservePageOnFailure`, and `retainSurfaceProcess`
together. ChatGPT's `runConnector({ browser: ... })` config consumes the page flags
from it; the reference lease caller consumes `retainSurfaceProcess` from the same
record (via a thin RI adapter that maps connector-id/URL forms to the bare runtime
name). There is no "set the page flags here and register retention there" trap —
a connector's browser policy is one edit in one place.

The policy lives in the polyfill-connectors package (the connector-runtime layer),
is side-effect-free, and is intentionally not re-exported from the runner barrel,
matching the existing `credential-probe` convention. It is not PDPP Core, not a
Collection Profile / manifest field, and the generic `@opendatalabs/remote-surface`
layer never learns any of it — the RI passes a boolean and the generic layer obeys.
This respects the boundary rules: no manifest schema field, no browser-auth taxonomy
on the consent/protocol surface, no connector-id branching inside remote-surface.

### Retained surfaces are exempt from routine reap, never from failure recycle

- `cleanupIdleSurfaces` SHALL skip surfaces marked retained. Their `last_used_at`
  ageing past idle TTL is expected and MUST NOT stop them.
- `planCapacityPressureReclaim` SHALL never select a retained surface as the
  reclaim victim. It still reclaims the oldest idle **ordinary** incompatible
  surface. If no ordinary surface is reclaimable, the waiting lease stays queued
  (existing `capacity_full` wait), which is why the operator cap is raised so the
  retained pair cannot monopolize capacity.
- Retention exempts only a **healthy** surface. `invalidateSurface` (the typed
  attach-exhaustion / dead-CDP recycle at `run-coordinator.ts:474`) still evicts a
  retained surface whose CDP target is proven dead, and `ensureSurface` still
  replaces a Docker-`unhealthy` running container. Retention never keeps a poisoned
  renderer alive.
- The lease is still **released** after each run. Retention is a surface-process
  property, not a permanent lease. A released retained surface is idle-and-reusable
  and can be reacquired by the same connection; it simply is not stopped.

### Capacity fairness is an enforced invariant, not operator tuning

`surfaceCap=3` is the explicit current operating invariant: two retained ChatGPT
surfaces (one per connection) plus one fair transient slot for the other managed
connectors (Chase/USAA/Amazon/Reddit), which contend for that slot via the existing
lease queue and priority ordering. The cap is not auto-raised, and the owner is not
asked to tune routine operation; instead the fair-slot guarantee is enforced
fail-closed at two layers so a misconfiguration or excess retained demand cannot
silently starve non-retained work:

- **Env-level guard** (`readNekoEnvShape`): the cap MUST strictly exceed the number
  of retained managed *connectors*, guaranteeing at least one non-retained slot. A
  retained connector with `cap=1` fails config at parse.
- **Creation-time reserve** (lease manager): retained surfaces are capped at
  `surfaceCap - 1`, so at least one transient slot always remains. A retained
  surface creation that would consume the reserve is refused with a typed terminal
  deferral (`retained_capacity_reserved`), not an indefinite `capacity_full` queue.

The reserve is enforced at retained-surface **creation**, not by counting observed
surfaces at boot. Counting rehydrated surfaces would be **fail-open**: a configured
retained connection that has never acquired a surface is absent from the store, so a
third ChatGPT connection at `cap=3` would pass a boot count and then consume the last
slot at runtime. Enforcing at creation catches the true demand the moment a retained
connection first materializes — including the never-materialized case — without
coupling boot to owner-scoped connection enumeration (which would be a bad
server/bootstrap dependency: the connection store is request/owner-scoped).

The creation-time check counts total nonterminal retained **demand**, not just
materialized surfaces: a retained lease that is already queued
(`waiting_for_browser_surface`, no surface yet) counts once, alongside every
materialized retained surface. Counting surfaces alone has a race — two retained
leases can each queue on ordinary `capacity_full` before either has a surface, so a
surface-only count sees zero reserve pressure for both and lets both slip past the
check, deferring the overcommit discovery to whichever one `#pumpQueue` happens to
promote first. Demand-counting closes this at acquire, before either lease enters
the queue past the point the reserve should have caught it.

The same overcommit is possible across a restart: leases persisted queued before the
process stopped rehydrate into the manager's constructor before any acquire runs, so
the acquire-time check never sees them. `reconcileAfterRestart` therefore re-checks
rehydrated queued retained leases explicitly, walking them in the same priority/FIFO
order `#pumpQueue` would serve them and tracking a running granted-count against
`surfaceCap - 1` (starting from the count of already-materialized retained
surfaces). This is deliberately an **ordered grant calculation**, not another
total-demand count: checking every queued lease against total demand (including
lower-priority leases not yet decided) would make a lease look reserve-blocked
because of leases that haven't been decided yet, and could keep the wrong lease
depending on rehydration order rather than deterministically keeping the
highest-priority one. Leases beyond the reserve terminalize with
`retained_capacity_reserved` through the existing `result.deferred` path — no second
queue-result channel.

Tradeoff: the reserve refuses the excess retained connection's *run* (typed
terminal deferral surfaced as a repair/health condition) rather than blocking
startup. This is the honest choice given the demand source is not enumerable at
boot; the alternative (owner-scoped connection enumeration at bootstrap) was
rejected for coupling. The manager never assumes a specific cap value and never
evicts a retained surface.

### Restart / host-loss posture

Ordinary reference restart SHALL reconstruct retained surfaces without intentionally
stopping their containers. Boot reconcile
(`reconcileSurfacesWithAllocator` + `reconcileAfterRestart`) already releases idle
leases while leaving healthy containers in place; retention adds that a reconcile
pass SHALL NOT stop a retained surface's container for being idle.

Genuine container-process loss (host reboot, image change forcing container
recreate) cannot be papered over: a fresh container may lose ChatGPT API auth, but
process loss does not itself prove provider invalidation. It is surfaced as
non-green continuity-indeterminate evidence with no owner action, not a silent
failure, false-healthy state, retry storm, or immediate browser-session repair.

The RI records this through the shared append-only two-phase replacement ledger.
The one closed cause enum is exactly `capacity_pressure`, `idle_ttl`,
`operator_requested`, `restart_reconcile`, `readiness_invalidated`,
`allocator_internal_ensure_surface`, `same_container_browser_generation_change`,
and `external_or_host_loss`. It losslessly maps public stop reasons:
`capacity_pressure`, `idle_ttl`, `operator` -> `operator_requested`, `reconcile` ->
`restart_reconcile`, and `surface_failed` -> `readiness_invalidated`. Unknown
causality is `external_or_host_loss`, never a policy label; the current allocator
does not justify narrower exited/missing claims. Luna's six-literal fixture is
provisional compatibility input and must be updated to this eight-cause enum. The
ledger records `started` then `completed` only after the new generation is observed,
or a truthful terminal outcome. Its one-way generation hashes and correlation
fields are non-secret and the RI exposes them through its own metadata/projection
adapter, without changing the remote-surface package API.

Only a typed verified `ProviderInvalidationProof` — provider-originated,
connection-bound, auditable, and non-secret — may create the existing
connection-scoped repair action. Replacement receipt, process-loss inference,
false/indeterminate exact probe, and DOM/URL/profile evidence are not that proof;
one proof creates at most one repair for its connection. This change does not
attempt to persist provider session tokens outside the browser process (rejected
below).

### Rehydration is reconstructed at boot, not left to the next run

`retained` is not a persisted `browser_surfaces` or lease column. It is a pure
function of the connector via the RI registry, so the reference **re-derives it
deterministically at boot** — in `server/index.js`, mapping every rehydrated
surface AND every rehydrated non-terminal lease through
`connectorRetainsSurfaceProcess(connector_id)` before the
`BrowserSurfaceLeaseManager` is constructed. Both re-derivations are required: a
surface-only re-derivation misses a queued or `starting_surface` lease that has no
surface row yet — that lease would rehydrate non-retained and, once it later
materializes a surface, create it without the retained flag, reproducing the exact
evictable-process defect this change fixes. Because both run before the manager
exists, no idle-cleanup or capacity-reclaim can stop a retained surface in a window
where its flag was missing. The mapping is fail-closed: a surface or lease whose
connector is not registered simply stays non-retained.

The typed terminal wait reason `retained_capacity_reserved` is admitted in both
lease-store backends and remains upgrade-safe across SQLite rebuilds and Postgres
constraint recreation; that schema compatibility is independent of the retained
flag remaining non-persistent.

`#leaseSurface` additionally re-applies the flag whenever a retaining caller leases
a surface. That is a secondary safety net (covering any mid-process flag loss), not
the primary rehydration path; boot re-derivation is the load-bearing gate.

### Retry-burst suppression

The three-attempt burst is a run-executor retry-classifier gap, not a surface-layer
concern: a browser-session `session_required` / `credential_login_required` failure
is definitive for that run and SHALL classify as non-retryable so `runWithRetries`
breaks after the first attempt. The scheduler owner-action gate (built in
`complete-connection-repair-action-surfaces`) then suppresses subsequent scheduled
ticks. That classification work belongs to the repair-action change's open tasks;
this change depends on it but does not duplicate it.

## Alternatives

- **Deterministic connection-scoped `surface_id`** so the stopped container is
  re-matched and restarted: rejected as the primary fix. Even a restarted container
  loses ChatGPT API auth (archived proof). Re-matching a stopped container only
  converts "create new" into "start old", and the old process is dead either way.
  Keeping the process alive is the only path that preserves auth.
- **Persist ChatGPT bearer/session tokens outside the browser profile**: rejected.
  It creates a second credential authority when the browser profile/process is the
  intended boundary (already rejected in the archived change), and does not solve
  server-side invalidation.
- **A ChatGPT-specific allocator branch**: rejected. Retention must be generic;
  the discriminator is a connector-neutral boolean the RI passes to the lease
  layer, which never inspects connector identity.
- **A manifest field (`capabilities.browser_surface.retain_process`)**: rejected on
  owner review — reference-only process-lifecycle policy does not belong on the
  manifest/consent surface, and it violates the Core/Collection/RI boundary and the
  no-manifest-taxonomy rule. Retention is decided in an RI-only registry instead.
- **Persist `retained` as a `browser_surfaces` column**: rejected as unnecessary.
  Retention is a pure function of the connector, so boot re-derivation reconstructs
  it deterministically without a two-backend migration.
- **Retain by never releasing the lease**: rejected. That would make the surface
  permanently active and break fair scheduling and the priority queue. Retention is
  release-lease-but-keep-process.
- **Auto-raise `PDPP_NEKO_SURFACE_CAP`**: rejected on owner review. `cap=3` is the
  explicit operating invariant (two retained ChatGPT surfaces + one fair transient
  slot); the fair-slot guarantee is enforced by fail-closed config rather than by
  asking the owner to tune routine operation.
- **A separate RI-only retention set duplicating the page-preservation flags**:
  rejected on owner review — it re-states one semantic across two edits ("set the
  page flags here AND add a key there"). Both facts are declared once in the shared
  connector-runtime policy module instead.

## Acceptance Checks

- A connector's page-preservation flags and surface-process retention are declared
  once in the shared policy; ChatGPT's `runConnector` config and the RI lease caller
  consume the same record, and any retained connector also preserves both pages.
- A surface whose connector retains is marked retained; a surface for a
  non-retaining connector is not retained.
- The fair-slot reserve fails closed when retained demand could consume all
  capacity: a retained connector with `cap=1` fails config at parse; with `cap=3`,
  two retained connections create surfaces and a third retained connection's surface
  creation is refused with a typed terminal deferral (including a
  never-previously-materialized connection), while a non-retained connection can
  still take the reserved transient slot.
- The reserve check counts queued (not-yet-materialized) retained demand, not just
  materialized surfaces: a second retained lease that queues on ordinary
  `capacity_full` before any retained surface exists still causes a third retained
  lease to terminally defer at acquire; the sole reserve-eligible queued retained
  lease still promotes once a transient slot genuinely frees.
- Boot reconciliation re-checks rehydrated non-terminal retained leases against the
  reserve in priority/FIFO order, deterministically keeping at most
  `surfaceCap - 1` retained demand queued and terminalizing the rest with
  `retained_capacity_reserved` through the existing reconcile deferral path — not
  left to race the next `#pumpQueue` call non-deterministically.
- A rehydrated queued or `starting_surface` lease with no persisted `retained`
  column and no surface row yet is re-derived retained at boot from its connector
  id, and the surface it later materializes into is retained too.
- `cleanupIdleSurfaces` does not stop a retained surface even after it ages past
  idle TTL; it still stops an ordinary idle surface past idle TTL.
- `planCapacityPressureReclaim` never returns a retained surface; it returns the
  oldest idle ordinary incompatible surface when one exists, and returns nothing
  (leaving the lease queued) when only retained surfaces are idle.
- A retained surface still releases its lease after a run and can be reacquired by
  the same connection without a new container.
- `invalidateSurface` still evicts a retained surface with a proven-dead CDP target,
  and `ensureSurface` still replaces a Docker-unhealthy retained container.
- Boot reconcile leaves a healthy retained container in place and does not stop it
  for being idle.
- Two same-connector ChatGPT connections keep independent retained surfaces
  (distinct `profile_key`/`surface_subject_id`) and neither is reclaimed to serve
  the other or an ordinary connector.
- Config validation: the manager honours any configured cap; retained surfaces are
  never evicted even when cap is below the retained count, and ordinary leases queue
  rather than deadlock.
