## Context

Verified against `4bd59e689`, no new subsystems, derived only from primitives
that already exist:

1. **Leases are session-keyed on `run_id`.** `BrowserSurfaceLeaseManager.acquire()`
   calls `#findNonTerminalRunLease(request.runId, ...)` first
   (surface-lease-manager.js:260-264) and returns the run's existing lease if
   one is non-terminal. A phase lease that reused the run's own `runId` would
   therefore not get independent capacity, and the run-level `cancel(runId)` /
   `cancelAndPump(runId)` would terminate it as a side effect. The derived
   session id `${runId}#browser-phase` avoids both failure modes and limits a
   run to one in-flight phase lease at a time, which matches Slack's
   sequential gap-stream usage.
2. **The lease layer is generic today.** `AcquireSurfaceLeaseRequest` already
   takes `surfaceKind` + `retainProcess`; capacity, fairness, queueing,
   promotion, fencing, idle-TTL, and restart reconciliation are implemented
   once in the lease layer and never inspect connector identity. The phase
   primitive is therefore a lifecycle wrapper around the existing acquire/
   release calls, not new capacity math. Omitting `retainSurfaceProcess`
   means `assertRetainedManagedConnectorReserve` needs no change — a phase
   lease is an ordinary transient slot.
3. **Release authority is per-lease and fenced.** `release({leaseId,
   fencingToken})` already returns `{released, stale, promoted}`, with
   `stale: true` on a fencing mismatch. `finalizeRunCleanup` today releases
   only the spawn-time `browserSurfaceLease` local
   (controller.ts:3018-3060). Tracking the phase lease separately (its own
   `leaseId`/`fencingToken` pair) and releasing it through the same fenced
   call from the same backstop means there is no double release authority.
4. **The protocol has no timeout/stdin-close/cancellation on round-trips
   today.** Both `sendInteraction` and `requestDetailGapPage` hang forever
   if the controller never replies. The new `BROWSER_SURFACE_REQUEST` round
   trip must not inherit this — it needs an explicit timeout, a stdin-close
   rejection, and listener cleanup on every exit path (resolve, reject,
   timeout, close).
5. **`resolveBrowserLaunchSource` reads only `process.env`**
   (connector-runtime.ts:1577-1593) and fails closed when
   `PDPP_BROWSER_SURFACE_REQUIRED=neko` is set without a URL. The granted
   `remote_cdp_url` must reach the connector as an explicit value passed
   through the existing injected-`env` seam (`withResolvedRemoteCdpUrl`
   already accepts one), not by mutating `process.env` — mutation would leak
   across phases/connectors sharing a process and bypass the fail-closed
   check's intent.

## Decision

### Session id: derived, not reused

Phase leases key on `${runId}#browser-phase`, never the bare `runId`. This is
the only shape available under fact 1 that gets independent lease-manager
bookkeeping without colliding with run-level cancel semantics. One phase
lease per run at a time (no phase-lease pooling within a run) matches Slack's
actual usage (sequential gap streams) and keeps the ownership map in
`BrowserSurfaceManager` a simple `Map<runId, {...}>` rather than a multi-slot
structure.

### Lifecycle wrapper, not new capacity primitive

`acquireManagedBrowserSurfaceForPhase` / `releaseManagedBrowserSurfaceForPhase`
call the existing lease manager `acquire`/`release` with a derived session id
and `retainSurfaceProcess` omitted. Cap, fair queue (`waiting_for_browser_surface`),
`leaseWaitTimeoutMs`, and idle-TTL are all inherited for free. This is the
generic reuse fact 2 establishes — building a second capacity mechanism for
phase leases would duplicate logic the lease layer already owns and risk the
two mechanisms disagreeing about the cap.

### Bounded queue resolves to `unavailable`, never blocks the run

On queue-full or lease-wait-timeout, the phase acquire resolves the connector
round trip with `status: "unavailable"` rather than leaving the connector
process waiting indefinitely or blocking run progress. The typed `reason`
(`capacity_full`, `not_managed`, `surface_failed`, `timeout`, `cancelled`)
lets the connector decide how to degrade (Slack skips the affected gap
streams) instead of the controller making that product decision.

### No local-Chromium fallback on `unavailable` (AM-3)

Under `surfaceScope: "phase"`, the connector subprocess's env carries no
`PDPP_BROWSER_SURFACE_REQUIRED`/`_REMOTE_CDP_URL` by default (there is no
run-level reservation to seed it from). If Slack's `requestBrowserSurfacePhase`
call resolved `unavailable` and the connector then fell through to a default/
reflexive browser acquire, `resolveBrowserLaunchSource` would resolve
`isolated_local` — a silent local-Chromium fallback that violates the
existing "no local fallback when a managed surface is required" invariant
(I7). The contract is explicit: `unavailable` must produce the connector's
existing honest failure handle (transport rejects, gap streams skipped), not
a fallback acquire.

### Phase-aware capability replaces the Slack-only allowlist hack

`BrowserSurfacePolicy.surfaceScope` is a generic, declared field on the same
side-effect-free policy module that already carries
`retainSurfaceProcess`/`preservePageOn*` (established by
`retain-credential-boundary-surface-process`), not a Slack-specific branch
inside the scheduler or controller. `"run"` is the default so every
connector that does not declare `"phase"` is byte-for-byte unaffected —
including ChatGPT, whose retained/credential-boundary status is unrelated
to this axis and stays `"run"`. `scheduler-readiness.ts`'s readiness check
is already presence-only, so a phase-scoped connector reads ready the same
way a run-scoped one does; no readiness regression to reconcile.

### AM-1: boot reconciliation must not release a live phase lease

`reconcileAfterRestart` releases any non-terminal leased lease whose
`run_id` is absent from `activeRunIds` (surface-lease-manager.js:553-560).
`activeRunIds` is built at `run-coordinator.ts:1797` solely from
`listPersistedActiveRuns()`, which returns real DB `run_id` values — a phase
lease's derived session id is structurally never a member of that set. Left
unfixed, any controller restart during an in-flight phase would release a
surface still in active use by a live connector process. The fix is a single
addition at both call sites that build or consume `activeRunIds`
(`run-coordinator.ts`'s construction and
`windowSettleReconciliation.reconcileAtBoot`'s consumption): add the derived
phase session id alongside each real run id before either reconciliation
path runs. This is deliberately not a change to `#findNonTerminalRunLease`
or the lease store schema — the fix stays at the boundary where the active
set is assembled, matching the "generic layer, RI-derived facts" pattern
already established for the `retained` boolean.

### AM-2: pre-existing protocol-guard exposure, not fixed here

`failPendingInteraction` rejects and `terminateChild()`s on ANY connector
message received while an `INTERACTION_RESPONSE` is outstanding, not only a
duplicate `INTERACTION`. `DETAIL_GAPS_PAGE_REQUEST` already carries this
exact exposure today, and Slack emits no `INTERACTION` at all (verified: the
only match for the token in `slack/index.ts` is a comment), so a phase
request can never overlap a pending interaction in the shipped path. Making
the guard message-type-aware would change existing `INTERACTION` semantics
and is out of this slice's boundary; it is recorded as a residual for the
protocol owner rather than fixed here.

## Alternatives

- **Reuse the bare `run_id` for the phase lease**: rejected per fact 1 — it
  collides with the run's own non-terminal lease lookup and couples
  phase-lease lifetime to run-level cancel, which is wrong (a run should be
  able to cancel its phase lease independently, e.g. on phase timeout,
  without the phase lease's fencing racing the run's own lease teardown).
- **New capacity/queue mechanism scoped to phase leases**: rejected. The
  lease layer already implements cap, fairness, queueing, and fencing
  generically (fact 2); a parallel mechanism would duplicate that logic and
  risk cap disagreement between the two paths.
- **Mutate `process.env` with the granted CDP URL**: rejected per fact 5 —
  the existing injected-`env` seam (`withResolvedRemoteCdpUrl`) already
  supports passing an overlay without global mutation, and mutation would
  leak across sequential phases in the same process.
- **Fall back to local Chromium on `unavailable`**: rejected (AM-3) — would
  silently violate the "no local fallback under a required managed surface"
  invariant for a phase-scoped connector, which by construction never seeds
  `PDPP_BROWSER_SURFACE_REQUIRED` at spawn.
- **Fix `failPendingInteraction`'s type-agnostic guard as part of this
  slice**: rejected (AM-2) — it changes existing `INTERACTION` semantics
  system-wide, is not reachable by the shipped Slack phase-request path, and
  is out of this change's boundary. Recorded as a residual instead.
- **Persist phase-lease ownership only in the lease store, no separate
  fenced map in `BrowserSurfaceManager`**: rejected — release-authority
  fencing (fact 3) needs the caller to hold the `{leaseId, fencingToken}`
  pair it was granted so a stale/duplicate release message can be recognized
  as stale without an extra round trip to the lease store; the map is the
  minimal state to do that at the manager boundary.

## Acceptance Checks

- I1: A phase lease's session id is `${runId}#browser-phase`, distinct from
  the run's own lease; acquiring a phase lease does not return or reuse the
  run's own non-terminal lease, and does not collide when both exist
  concurrently.
- I2: A phase request settles (resolves or rejects) on timeout and settles on
  stdin close; no code path leaves the round trip pending indefinitely.
- I3: A release carrying a stale `fencingToken` (a token that does not match
  the currently tracked lease for that `runId`) is a no-op and does not free
  the current lease.
- I4: Process exit, run cancellation, and `finalizeRunCleanup` each release
  an in-flight phase lease exactly once (idempotent via the fence — no leak,
  no double-release error).
- I5: A phase lease queues behind capacity exactly like any other transient
  lease and never bypasses the cap or jumps the fair queue.
- I6: A `surfaceScope: "run"` connector (e.g. ChatGPT) is unaffected —
  identical pre-spawn acquire path, no phase-lease code invoked.
- I7: When a managed surface is required and a phase acquire resolves
  `unavailable`, the connector does not fall back to a local browser.
- I8: A controller restart while a phase lease is live does not release that
  lease — `activeRunIds` used by `reconcileAfterRestart` and
  `windowSettleReconciliation.reconcileAtBoot` includes the derived phase
  session id for every active run.
