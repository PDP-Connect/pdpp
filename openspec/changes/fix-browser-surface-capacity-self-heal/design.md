## Context

Root cause (`~/.tmp/browser-surface-capacity-0710.md`, read-only diagnosis,
verified live): capacity was genuinely exhausted, not miscounted. The
capacity predicate (`#surfaceConsumesCapacity`) already correctly excludes
`stopping` and (dynamic-mode) `unhealthy` surfaces — that is not the bug. The
bug is that once capacity genuinely fills and one reclaim attempt fails
transiently, nothing in the system revisits it: no retry, no independent
wall-clock expiry, no periodic allocator reconciliation outside boot.

## Goals / Non-goals

**Goals**
- A single transient allocator failure during capacity reclaim must not
  permanently strand a queued lease.
- A past-TTL waiting lease must terminalize on its own clock, independent of
  whether any other run happens to acquire a surface.
- A `ready` surface whose container has already exited must stop poisoning
  the capacity count before the next full process restart.
- All of the above must be idempotent, bounded, single-owner (no overlapping
  sweep), restart-safe, and must never touch an active leased run.
- Preserve retained (credential-boundary) surfaces exactly as today — this
  change does not touch retention semantics at all.

**Non-goals**
- No generic scheduler/job framework. `run-target-registry.js` already
  proves the right-sized idiom for this codebase: an owned `setInterval`,
  `unref()`'d, cleared by an explicit `shutdown()`/`stop()` — not a cron
  system, not a distributed lock, not a new queue.
- No change to the capacity-counting predicate, the static/dynamic mode
  split, or the fair-slot retained-demand reserve — all confirmed correct in
  the incident diagnosis.
- No change to how a static-mode placeholder (`neko-static`) is created;
  `#isCompatibleInitialSurface` already filters it out of a dynamic-mode
  manager's surfaces map at construction. (Its presence in the live incident
  was a leftover row from a prior static-mode boot rehydrated only because
  `#isCompatibleInitialSurface` runs on the CURRENT mode; a fresh dynamic-mode
  boot with a persisted static row already excludes it as unrelated. Verified
  by reading the guard; not something this change needs to touch.)

## Design

### 1. Bounded retry/backoff on capacity-pressure reclaim's allocator call

`reclaimCapacityAndPromoteLease` (`run-coordinator.ts:615`) currently makes one
`browserSurfaceAllocator.stopSurface(...)` call and gives up on any throw
(including a timeout). Wrap that one call in a small bounded retry (e.g. 3
attempts, short fixed/backoff delay measured in the surrounding test's fake
clock, not wall time) local to this function. No new abstraction: the retry
loop lives inline where the call already is. On exhaustion, behavior is
unchanged from today (log a warning, return `reclaimed: false`) — the
periodic sweep (below) is the backstop that keeps trying on a longer cadence,
not this function looping forever.

### 2. One owned periodic sweep composing three existing operations

Add `sweepBrowserSurfaceLeases()` to the `BrowserSurfaceManager` returned by
`createBrowserSurfaceManager` (`run-coordinator.ts`). It does not introduce
new lease-manager methods; it composes three that already exist and are
already independently correct in isolation:

1. `browserSurfaceLeaseManager.reconcileSurfacesWithAllocator(allocator)` —
   already used once at boot (`reconcileBrowserSurfacesWithAllocatorAtBoot`).
   Calling it again on a timer is the whole fix for gap 3 (stale `ready` row
   over an exited container) — no new eviction logic, just a second call site.
2. `browserSurface.expireBrowserSurfaceWaits()` — already implemented, already
   exported on the controller, currently has zero non-test callers. Wiring it
   to the timer is the whole fix for gap 2 (lazy, side-effect-only expiry).
   This is the *promoting* variant: it calls
   `expireBrowserSurfaceWaitsWithoutPromotion()` (unchanged) and then
   `pumpQueuedLeases()`, so a freed slot is immediately offered to the next
   waiting lease in the same tick, not left for a future unrelated acquire.
3. For any lease still `waiting_for_browser_surface` / `capacity_full` after
   (1) and (2), call `reclaimCapacityAndPromoteLease` for it (same function
   the acquire path already uses, now with its own retry from step 1). This
   is the whole fix for gap 1 as a *cross-run* trigger: capacity reclaim is no
   longer gated on the stranded run's own request path ever running again.

Reentrancy: a boolean `sweeping` flag guards the whole function body so an
overlapping tick (slow allocator round-trip on a small interval) is a no-op,
not a concurrent second sweep — the same class of guard `client-event-
delivery-worker.ts` already uses for its own tick. Idempotent by
construction: every underlying operation (reconcile, expire, reclaim) is
already idempotent and safe to call redundantly, because they only act on
`waiting_for_browser_surface` leases past TTL, or surfaces the allocator
disagrees with — repeating on an already-settled lease/surface is a no-op.

Active leased runs are untouched: none of the three composed operations acts
on a `leased` lease with a live surface unless the allocator itself reports
that surface as gone/unhealthy (which is the existing, deliberate
`reconcileSurfacesWithAllocator` contract, unchanged here).

### 3. Timer lifecycle

The timer's own `setInterval`/`unref()`/start/stop contract, INCLUDING its
external-close binding, lives entirely in one dedicated module,
`runtime/browser-surface-lease-sweep-timer.ts`
(`createBrowserSurfaceLeaseSweepTimer({ sweep, intervalMs, onSweepError,
setIntervalFn?, clearIntervalFn? }) → { start, stop, stopWhenAllClosed }`),
mirroring the `setInterval` + `unref()` idiom already used by
`server/streaming/run-target-registry.js`. Interval length: reuse
`PDPP_NEKO_LEASE_WAIT_TIMEOUT_MS`-scale cadence (a fraction of the wait
timeout, e.g. 30s default, overridable) — bounded and no new env surface
required beyond one optional override, matching the existing
`browser-surface-leases.ts` env-shape pattern.

**Stop-until-all-closed, not first-closed.** The sweep's `sweep()` closure
operates on a `controller` reachable through EITHER `asServer` or
`rsServer` — neither one exclusively owns the controller's lifetime, and
closing only one of the two does NOT mean the controller's HTTP surface is
gone; the other server may still serve it. The timer's binding method is
named `stopWhenAllClosed(sources)` (not the earlier draft's
`stopOnCloseOf`, which stopped on the FIRST close — an earlier, incorrect
design this revision replaces) precisely to state that contract: it stops
the sweep only once EVERY given source has emitted its own `'close'`
event, tracking a countdown internally. Closing `asServer` alone (or
`rsServer` alone) leaves the sweep running; closing both stops it exactly
once. The explicit CLI `stopBrowserSurfaceLeaseSweep()` call is retained
for defense-in-depth (it can fire before either server finishes
draining/closing, giving the fastest possible stop on a genuine process
shutdown) and composes safely with `stopWhenAllClosed` regardless of
ordering — `stop()` is idempotent, so an explicit stop racing the
all-closed countdown, or firing before it, never double-schedules or
throws.

This was deliberately NOT implemented as a standalone function living in
`server/index.js` (an earlier draft of this change did exactly that, then
left it as dead, unused code after the call site migrated): that would
force any test of the binding to import the ~150-dependency
`server/index.js` module just to reach one pure, server-agnostic helper
with zero actual dependency on anything `server/index.js`-specific, and
would scatter "who can stop this timer, and under what condition" away
from the timer's own lifecycle contract. `stopWhenAllClosed` lives on the
timer object itself; `server/index.js` only calls it with the concrete
servers.

**Bind before start; start only after the ENTIRE fallible boot succeeds.**
`startServer`'s body has many fallible `await`s between where the
controller (and therefore the sweep's `sweep()` closure) becomes
constructible and where `startServer` actually returns a server object:
`buildAsApp`, `asApp.listen`, `buildRsApp`, `rsApp.listen`,
`schedulerManager.start()`, auto-enroll, the optional startup-backfill
await, and more. If the timer were started as soon as the controller
existed (the shape both earlier drafts of this change used), a later
`await` throwing — a real, ordinary failure mode (e.g. `rsApp.listen`
hitting `EADDRINUSE`) — would reject `startServer()`'s promise before ever
returning `asServer`/`rsServer` to the caller. The caller then has no
reference to anything that could stop the timer, yet the timer, `unref()`'d
and already running, keeps firing `sweepBrowserSurfaceLeases()` against a
controller whose HTTP surface never came up — a structural leak, not a
merely-missed cleanup call, because no code path anywhere could reach the
timer to stop it.

The fix splits construction from arming into two exported functions in
`server/index.js`, so this ordering is a structural property of the code,
not a comment:

- `createBrowserSurfaceLeaseSweepTimerFor(controller, browserSurfaceControllerOptions, logger)`
  constructs the timer and returns it WITHOUT calling `.start()`. Called
  early (right after `controller.reconcileBrowserSurfaceLeasesAfterBoot()`),
  because the sweep closure needs `controller`, which exists at that point.
- `armBrowserSurfaceLeaseSweepAfterBoot(timer, browserSurfaceControllerOptions, asServer, rsServer)`
  is the ONLY place in this module that calls `timer.start()`. It calls
  `timer.stopWhenAllClosed([asServer, rsServer])` first, then `timer.start()` —
  bind before start, so there is never a window where the timer is running
  with no stop path bound to it. It is a no-op (never starts) when no
  dynamic-mode allocator is configured, matching every other
  browser-surface manager method's guard.

`startServer` calls `armBrowserSurfaceLeaseSweepAfterBoot` as the LAST
statement before its `return`, after the optional
`awaitStartupBackfill`-gated await — i.e. after every other fallible step in
the function has already succeeded. A boot failure anywhere before that
line means the timer was constructed but never started; there is nothing
running to leak, because nothing was ever started. Both functions are
exported specifically so this exact production sequencing (not a
reimplementation of it) is directly testable without a real HTTP boot —
see `test/browser-surface-lease-sweep-boot-gating.test.js`.

### 4. Evidence

New typed event `run.browser_surface_reclaim_retry`, emitted once per retry
attempt inside the bounded retry loop (step 1) and once when the periodic
sweep (step 2.3) re-attempts reclaim for a lease still queued after expiry.
Reuses `emitBrowserSurfaceLeaseEvent`'s existing shape (`browser_surface:
projectBrowserSurfaceLease(lease)`), so it composes with existing consumers
without a new schema. Distinguishing evidence end to end:
- Retry attempted, not yet resolved: `run.browser_surface_reclaim_retry`.
- Past-TTL, no reclaim possible: `run.browser_surface_deferred` (existing,
  now reachable on a real wall clock instead of only via another run's
  acquire).
- Reclaim succeeded, lease promoted: existing `run.browser_surface_starting`
  / `run.browser_surface_leased`.
No diagnostic is exposed as an owner-facing instruction; these are the same
internal spine events every other browser-surface transition already emits.

## Alternatives considered

- **Generic cron/scheduler subsystem for all periodic reference-implementation
  work.** Rejected: no other subsystem in this tree needs one; `scheduler.ts`
  already owns connector-run scheduling, `run-target-registry.js` already owns
  its own sweep. Introducing a shared scheduler here would be a new
  architectural boundary the incident does not require.
- **Make `#surfaceConsumesCapacity` also check allocator liveness inline on
  every acquire.** Rejected: that call is synchronous and per-request; it
  would make every acquire's capacity check network-bound and would not
  actually resolve the reclaim-retry or expiry-promotion gaps, only the
  stale-surface gap. The periodic sweep resolves all three gaps together
  through one seam.
- **Uncap retry attempts on the reclaim call (retry forever).** Rejected: an
  unbounded retry inside the acquire request path would make a single run's
  acquire hang indefinitely on a wedged allocator. Bounded retry + periodic
  sweep as backstop keeps both paths bounded.

## Acceptance checks

- Dynamic-mode capacity accounting ignores a static-mode placeholder row and
  a stale `ready`/dead-container row (already true for the placeholder by
  construction; newly true for dead-container via periodic
  `reconcileSurfacesWithAllocator`).
- A first reclaim attempt that times out, followed by a successful retry
  before the lease's TTL, promotes the queued lease without owner
  intervention.
- A queued lease past `expires_at` terminalizes (`deferred`,
  `lease_wait_timeout`) without requiring another run's acquisition attempt.
- An active `leased` run whose surface the allocator confirms is still live
  is never touched by the sweep; a `leased` run whose surface the allocator
  confirms is gone/unhealthy IS reconciled (the deliberate, pre-existing
  dead-surface behavior) — these are two distinct scenarios, not one
  unconditional exemption.
- Two overlapping sweep ticks cannot run concurrently.
- Sweep timer starts once per server instance and is fully cleared on stop
  (no leaked timers across repeated `startServer`/`stop` cycles in tests).
- A programmatic `startServer()` caller that closes `asServer` and/or
  `rsServer` directly (the common test-harness pattern; never calling the
  CLI-only `stopBrowserSurfaceLeaseSweep`) also stops the timer — but only
  once ALL bound servers have closed, not on the first; closing one while
  the other remains open must keep the sweep running.
- A boot failure between timer construction and the final arming step (the
  last statement before `startServer` returns) leaves the timer
  constructed but never started — nothing is left running to leak.
