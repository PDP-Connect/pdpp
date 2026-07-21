## Why

A live incident proved the managed n.eko browser-surface lease lifecycle cannot
self-heal from a transient reclaim failure. Capacity was genuinely exhausted
(`surfaceCap=3`, 4 `ready`/`starting` neko surfaces counted, including a stale
`ready` row over an already-exited container). The controller made exactly one
capacity-pressure reclaim attempt to free a slot; the allocator's
`stopSurface` (`DELETE /surfaces/:id`) timed out once; nothing retried it. The
queued lease then sat `waiting_for_browser_surface` **more than 5 minutes past
its own `expires_at`** — proven live, read-only — because expiry-to-terminal
only happens as a side effect of some *other* run's next acquire attempt
(`expireBrowserSurfaceWaitsWithoutPromotion`), and even then only demotes the
lease to `deferred` without re-attempting promotion for the capacity that
freed up. There is no independent periodic sweep anywhere in the tree; a
second manual attempt after a restart succeeded, proving the blocker was
reclaim/expiry mechanics, not the requesting run's auth.

Three concrete, exhaustively-grepped gaps, none protocol-level:

1. `reclaimCapacityAndPromoteLease` (`run-coordinator.ts`) has one call site,
   invoked only from the *same* run's own acquire attempt. A single allocator
   timeout permanently strands that run's queued lease — no retry, no
   cross-run trigger.
2. The promoting expiry path, `expireBrowserSurfaceWaits()`
   (`run-coordinator.ts:1176`, exposed on the controller), has **zero
   non-test callers**. Only the non-promoting variant
   (`expireBrowserSurfaceWaitsWithoutPromotion`) runs, and only as a
   side-effect of some other run's acquire — never on a wall clock, never
   re-offering freed capacity to the next queued lease.
3. Allocator-aware reconciliation (`reconcileSurfacesWithAllocator`), which
   evicts/downgrades surfaces the allocator no longer backs, runs exactly
   once, at boot. A surface whose container exits mid-uptime (the observed
   `usaa` row) stays `ready` in memory until the next process restart.

## What Changes

- Add bounded retry/backoff to the capacity-pressure reclaim's allocator
  `stopSurface` call, so one transient DELETE failure does not permanently
  strand a queued lease.
- Add a single owned periodic sweep (mirroring the existing
  `setInterval` + `unref()` + explicit `shutdown()` idiom already used by
  `server/streaming/run-target-registry.js`, not a new scheduler
  abstraction) that, once per tick and reentrancy-guarded against overlap:
  - reconciles in-memory surfaces against the live allocator
    (`reconcileSurfacesWithAllocator`) so a `ready` row over a dead container
    stops poisoning capacity between restarts;
  - calls the existing *promoting* expiry (`expireBrowserSurfaceWaits`) so a
    past-TTL waiting lease is terminalized on its own wall clock, not only as
    a side effect of an unrelated run's acquire;
  - retries the capacity-pressure reclaim for any lease still queued on
    `capacity_full` after expiry, so freed capacity is actually re-offered
    rather than only demoting the old lease to `deferred`.
- Emit one new typed event, `run.browser_surface_reclaim_retry`, for a retry
  attempt distinct from the existing `run.browser_surface_deferred` (terminal
  expiry/defer) and `run.browser_surface_leased`/`starting` (successful
  promotion) events, so operators can tell retry, expiry, and promotion apart
  from evidence alone.
- No new manifest field, no generic scheduler/framework, no protocol change.
  Reuses the existing `BrowserSurfaceLeaseManager` / run-coordinator lease
  lifecycle seam end to end.

## Capabilities

- Modified: `polyfill-runtime`

## Impact

- `packages/remote-surface/src/leases/surface-lease-manager.ts`: retry/backoff
  wrapper around the allocator `stopSurface` call inside capacity-pressure
  reclaim; no change to the capacity-counting predicate itself (confirmed
  correct in the incident diagnosis).
- `reference-implementation/runtime/browser-surface/run-coordinator.ts`: a new
  exported sweep entry point composing the three existing reconcile/expire/
  reclaim operations; one new typed event.
- `reference-implementation/server/index.js`: owns the sweep timer's
  start/stop lifecycle alongside the existing scheduler-manager and
  streaming-registry timer patterns.
- Backwards compatible: static-mode deployments and healthy dynamic
  deployments observe no behavior change; only a stranded queued lease or a
  stale allocator-vs-memory mismatch is now self-healed instead of requiring
  an owner restart.
