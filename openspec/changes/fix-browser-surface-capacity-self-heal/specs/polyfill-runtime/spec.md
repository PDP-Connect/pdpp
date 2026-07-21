## ADDED Requirements

### Requirement: Managed browser-surface capacity reclaim SHALL retry a transient allocator failure
A capacity-pressure reclaim attempt that fails because the allocator's stop call throws or times out SHALL be retried a bounded number of times before being treated as failed.
A single transient allocator failure SHALL NOT permanently strand a queued lease's only reclaim attempt.

#### Scenario: Allocator stop call times out once, then succeeds
- **WHEN** a capacity-pressure reclaim's allocator `stopSurface` call fails on
  its first attempt
- **AND** a subsequent retry attempt succeeds before the queued lease's
  `expires_at`
- **THEN** the reclaimed capacity SHALL be used to promote the queued lease
- **AND** the retry attempt SHALL be observable as a distinct
  `run.browser_surface_reclaim_retry` event before promotion

#### Scenario: Allocator stop call fails on every retry attempt
- **WHEN** every bounded retry attempt for a capacity-pressure reclaim fails
- **THEN** the reclaim SHALL be treated as failed for that attempt, exactly as
  before this change
- **AND** the queued lease SHALL remain eligible for a later independent sweep
  attempt rather than throwing out of the acquire request path

### Requirement: Managed browser-surface lease wait expiry SHALL be enforced by an owned periodic sweep
Past-TTL waiting leases and allocator-vs-memory surface drift SHALL be
reconciled by an independent periodic sweep owned by the reference
implementation, not only as a side effect of some other run's next
browser-surface acquisition attempt.

#### Scenario: A queued lease outlives its wait timeout with no other run acquiring a surface
- **WHEN** a lease has been `waiting_for_browser_surface` past its
  `expires_at`
- **AND** no other run has attempted a browser-surface acquisition since
- **THEN** the periodic sweep SHALL terminalize the lease to `deferred` with
  `lease_wait_timeout` on its own schedule

#### Scenario: Capacity frees up after a lease's expiry within the same sweep tick
- **WHEN** the periodic sweep's allocator reconciliation or expiry step frees
  capacity within one tick
- **THEN** the sweep SHALL re-attempt promotion for any other lease still
  queued on `capacity_full` in that same tick, rather than leaving freed
  capacity unclaimed until a future unrelated acquisition

#### Scenario: A ready surface's backing container has already exited
- **WHEN** the allocator no longer reports a surface the manager still holds
  as `ready` or reports it as unhealthy, discovered between server restarts
- **THEN** the periodic sweep SHALL evict or downgrade that surface the same
  way boot-time reconciliation already does
- **AND** the stale surface SHALL stop counting toward capacity

### Requirement: The periodic browser-surface sweep SHALL be idempotent, bounded, single-owner, and restart-safe
The sweep SHALL never run two overlapping executions concurrently, SHALL be
safe to invoke redundantly, SHALL NOT reclaim, expire, or otherwise mutate a
`leased` lease whose surface the allocator confirms is still live, and SHALL
start and stop cleanly with the owning server process. This does NOT
exempt a `leased` lease whose surface the allocator reports gone or
unhealthy: reconciling that lease to a terminal state is the sweep's
deliberate, existing dead/unhealthy-surface reconciliation behavior (the
same behavior boot-time reconciliation already performs), not a violation
of this requirement.

#### Scenario: Two sweep ticks overlap
- **WHEN** a sweep tick is still in flight (e.g. waiting on a slow allocator
  round trip)
- **AND** the timer fires again before the first tick completes
- **THEN** the second tick SHALL be a no-op rather than running concurrently
  with the first

#### Scenario: Sweep runs while a run holds an active, allocator-confirmed leased surface
- **WHEN** the periodic sweep executes while a run's lease is `leased` with a
  live surface the allocator confirms
- **THEN** the sweep SHALL NOT reclaim, expire, or otherwise mutate that
  lease or surface

#### Scenario: Sweep runs while a leased surface's container is confirmed dead or unhealthy
- **WHEN** the periodic sweep executes while a run's lease is `leased` but
  the allocator reports the surface's container gone or unhealthy
- **THEN** the sweep SHALL reconcile that lease to a terminal state (the
  same dead/unhealthy-surface reconciliation boot-time reconciliation
  already performs), rather than treating the lease as untouchable

#### Scenario: Server starts and stops repeatedly in the same process
- **WHEN** the reference server process starts and stops multiple times (for
  example in a test harness)
- **THEN** exactly one sweep timer SHALL be active per running server
  instance
- **AND** stopping the server SHALL clear its sweep timer so no timer or
  sweep executes after shutdown

#### Scenario: A programmatic caller closes the HTTP servers directly, bypassing the CLI shutdown path
- **WHEN** a caller of `startServer()` closes the returned authorization or
  resource server directly (for example a test harness's `closeServer`
  helper), without invoking the CLI-only stop function
- **THEN** the sweep timer SHALL still stop, bound to the closing server's
  own lifecycle rather than only to the CLI shutdown path
- **AND** closing the other server afterward, or invoking the CLI stop
  function in either order, SHALL be a safe no-op rather than a double-stop
  error
