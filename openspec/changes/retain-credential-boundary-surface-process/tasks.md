## 1. Generic retention in the surface layer

- [x] Add a `retained` boolean to `BrowserSurface` and a `retainProcess`/`retainSurfaceProcess` flag to the acquire request in the remote-surface lease layer. The lease layer reads a boolean only; it never inspects connector id or manifests.
- [x] Carry `retained` from the acquire request onto the lease and into the created surface (initial resolve and queue promotion).
- [x] Preserve the surface's `retained` flag across `#mergeAllocatorSurface`, `#clearSurfaceLease`, `#leaseSurface`, and allocator status sync so it is not dropped on reuse or reconcile.

## 2. Single-source connector-runtime policy

- [x] Add `packages/polyfill-connectors/src/browser-surface-policy.ts` (side-effect-free, not in the runner barrel) declaring `preservePageOnSuccess`, `preservePageOnFailure`, and `retainSurfaceProcess` together per connector runtime name.
- [x] ChatGPT's `runConnector` browser config consumes the page flags from the policy (`browserConfigPreservationFor("chatgpt")`).
- [x] Thin RI adapter (`runtime/browser-surface/retained-surface-connectors.ts`) maps connector-id/URL forms to the bare runtime name and delegates to the policy; holds no policy data.
- [x] Resolve `retainSurfaceProcess` from that adapter in the run-coordinator lease-acquire path (no manifest reader, no branching in remote-surface).

## 3. Non-evictable retained process

- [x] `cleanupIdleSurfaces` excludes retained surfaces from the idle-expired set; ordinary surfaces still stop past idle TTL.
- [x] `planCapacityPressureReclaim` excludes retained surfaces and still returns the oldest idle ordinary incompatible surface, or nothing (leaving the lease queued) when only retained surfaces are idle.
- [x] `release`/`deferLeasedRun` still release a retained surface's lease (retention is not a permanent lease) and the surface stays reusable.
- [x] `invalidateSurface` still evicts a retained surface with a proven-dead CDP target (surface-wedge recycle preserved).

## 4. Rehydration gate (deterministic, before any reap)

- [x] Reconstruct retention at boot in `server/index.js`: map every rehydrated surface AND every rehydrated non-terminal lease through the RI registry before constructing the `BrowserSurfaceLeaseManager`, so no idle/capacity reap can run in a window where the flag is missing — including a queued/starting lease that has no surface row yet and would otherwise materialize a non-retained (evictable) surface. Fail-closed for unregistered connectors.
- [x] Keep `#leaseSurface` re-heal as a secondary safety net, documented as non-primary.

## 5. Restart / reconcile posture

- [x] `reconcileSurfacesWithAllocator` and `reconcileAfterRestart` do not stop a healthy retained container for being idle (they already never stop healthy containers; retained surfaces rehydrate re-marked).
- [ ] A genuinely lost retained container process flows to the connection as one browser-session `session_required` repair (owned jointly with `complete-connection-repair-action-surfaces`; see that change's tasks).

## 6. Capacity — fair-slot invariant enforced fail-closed

- [x] Keep `PDPP_NEKO_SURFACE_CAP=3` as the explicit operating invariant (two retained ChatGPT surfaces + one fair transient slot); document it in `.env.docker.example`.
- [x] Env-level guard (`readNekoEnvShape`): cap MUST strictly exceed the retained managed-connector count; fail config otherwise.
- [x] Creation-time reserve (lease manager): retained surfaces capped at `surfaceCap - 1`; a retained surface creation that would consume the last transient slot is refused with a typed terminal deferral (`retained_capacity_reserved`), not an indefinite `capacity_full` queue. Enforced at CREATION against total nonterminal retained DEMAND — materialized surfaces plus any other retained lease already queued without a surface yet, not just observed surfaces — so two retained leases cannot both slip past the check before either materializes a surface. Also enforced deterministically at restart reconciliation: rehydrated queued retained leases are walked in priority/FIFO order (the same order promotion would serve them) with a running granted-count against `surfaceCap - 1`, so excess retained demand persisted from before a restart terminalizes immediately rather than racing `#pumpQueue`'s promotion-time guard. Not by counting observed surfaces alone at either point — a configured-but-never-materialized retained connection is absent from surfaces, so counting surfaces alone would be fail-open.
- [x] Do NOT auto-raise the cap or ask the owner to tune routine operation.

## 7. Tests (mutation-killing)

- [x] Idle cleanup: retained surface past idle TTL is NOT stopped; ordinary surface past idle TTL IS stopped.
- [x] Capacity pressure: reclaim never selects a retained surface; selects oldest idle ordinary; returns nothing when only retained are idle.
- [x] Retained surface releases lease and is reacquired by the same connection without a new surface/container.
- [x] Proven-dead CDP retained surface is still recycled by `invalidateSurface`.
- [x] Two same-connector ChatGPT connections keep independent retained surfaces; neither reclaimed to serve the other or an ordinary connector.
- [x] Reused surface rehydrated without the flag is re-healed on the retaining caller's next lease.
- [x] Policy: ChatGPT retains + preserves both pages; non-retaining connectors do not; invariant "retained ⇒ preserves both pages"; RI adapter resolves URL/canonical forms.
- [x] Fair-slot: retained connector with cap=1 fails config (env guard); with cap=3 two retained connections create surfaces and a third (never-materialized) retained connection is terminally deferred with `retained_capacity_reserved` while a non-retained connection still acquires the reserved slot (creation-time reserve; all mutation-verified).
- [x] Fair-slot demand-counting race: a second retained lease that queues on ordinary `capacity_full` (before any retained surface exists) still terminally defers a third retained lease at acquire, because queued retained demand counts even without a materialized surface; the sole reserve-eligible queued retained lease still promotes once a transient slot is genuinely freed by capacity-pressure reclaim (mutation-verified).
- [x] Boot reconciliation: rehydrated non-terminal retained leases exceeding the fair-slot reserve are walked in priority/FIFO order and deterministically terminalized with `retained_capacity_reserved` via `result.deferred`, keeping exactly `surfaceCap - 1` retained demand queued (mutation-verified against a naive total-demand check, which non-deterministically keeps the wrong lease).
- [x] Boot rehydration: a persisted queued/starting ChatGPT lease with no `retained` column and no surface row yet is re-derived retained by connector id before the manager is constructed, and the surface it later materializes into is retained too (mutation-verified).
- [x] Lease-store persistence: SQLite current rows and upgrade rebuilds round-trip `retained_capacity_reserved` while preserving `surface_subject_id`, and the Postgres bootstrap DDL/constraint path admits the same reason (with the executable integration test retained and skipped locally when `PDPP_TEST_POSTGRES_URL` is unset).
- [x] `reauthSatisfaction`: `stored_credential` is satisfied by `credential_present_and_unrejected`; `browser_session` (and any other non-stored-credential reauth surface) is satisfied by `confirming_run_succeeded`.

## 8. Validation

- [x] `openspec validate retain-credential-boundary-surface-process --strict`.
- [x] Focused remote-surface lease-manager suite.
- [x] Focused run-coordinator / controller browser-surface suites + RI registry pure test.
- [x] Relevant typechecks (remote-surface package + reference-implementation runtime).
- [x] `git diff --check`.

## 9. Live acceptance (owner-only)

- [ ] Deploy from clean `main`; declare a live-stack window.
- [ ] Verify both ChatGPT surfaces persist across at least two hourly ticks with no new container `Created` and no `session_required` between successful runs.
- [ ] Verify Chase/USAA/Amazon/Reddit hourly runs still acquire surfaces; record whether cap=3 produces routine `lease_wait_timeout` (informs the capacity residual).
- [ ] Force a container-process loss (restart that recreates the retained container) and verify exactly one connection-scoped browser-session repair appears, no retry burst, and that owner repair + one bounded confirmation resumes the prior schedule on the same `connection_id`.
