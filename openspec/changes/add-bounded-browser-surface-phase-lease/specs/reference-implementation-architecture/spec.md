## ADDED Requirements

### Requirement: `BrowserSurfaceManager` SHALL grant and fence a bounded mid-run phase lease independently of the run's own lease

`BrowserSurfaceManager` SHALL provide
`acquireManagedBrowserSurfaceForPhase(ctx): Promise<PhaseAcquireResult>` and
`releaseManagedBrowserSurfaceForPhase(runId): Promise<void>`. A phase lease
SHALL use the derived session id `${runId}#browser-phase`, never the run's
own `run_id`, so it is independent lease-manager state that does not collide
with the run's own non-terminal lease lookup and is not terminated as a side
effect of run-level `cancel(runId)` / `cancelAndPump(runId)`.

A phase lease SHALL NOT set `retainSurfaceProcess`. It SHALL be an ordinary
transient lease subject to the same capacity cap, fair queue, idle-TTL, and
promotion rules as any other managed-surface lease — no new capacity
mechanism SHALL be introduced for phase leases, and
`assertRetainedManagedConnectorReserve` SHALL require no change for this
capability.

The manager SHALL track phase-lease ownership as a fenced
`{leaseId, fencingToken}` pair per `runId`. `releaseManagedBrowserSurfaceForPhase`
SHALL be a no-op when the tracked fencing token does not match the lease
being released, so a stale or duplicate release cannot free a lease it no
longer owns.

On queue-full or lease-wait-timeout, an acquire SHALL resolve with a typed
`unavailable` outcome (reason one of `capacity_full`, `not_managed`,
`surface_failed`, `timeout`, `cancelled`) rather than blocking the run or
waiting indefinitely.

#### Scenario: Phase lease is independent of the run's own lease

- **WHEN** a run holds no run-level surface lease (its connector declares
  `surfaceScope: "phase"`) and calls `acquireManagedBrowserSurfaceForPhase`
- **THEN** the manager SHALL acquire a lease keyed on
  `${runId}#browser-phase`
- **AND** this SHALL NOT return, reuse, or otherwise collide with any
  lease keyed on the bare `runId`.

#### Scenario: Run-level cancellation does not implicitly terminate a phase lease

- **WHEN** a run has an in-flight phase lease
- **AND** `cancel(runId)` / `cancelAndPump(runId)` is invoked
- **THEN** the phase lease SHALL NOT be terminated as a side effect of that
  call keyed on the bare `runId`.

#### Scenario: Phase lease competes for capacity like any other transient lease

- **WHEN** the managed-surface cap is fully consumed by other leases
- **AND** a phase lease is requested
- **THEN** it SHALL queue behind capacity using the existing fair queue
- **AND** it SHALL NOT bypass the cap or be granted ahead of its fair
  position.

#### Scenario: Stale fencing token cannot release a newer phase lease

- **WHEN** a phase lease for a run is released and a new phase lease is
  subsequently acquired for the same run
- **AND** a release message carrying the original (now stale) fencing token
  arrives
- **THEN** that release SHALL be a no-op
- **AND** the newer phase lease SHALL remain held.

#### Scenario: Bounded queue resolves unavailable rather than blocking the run

- **WHEN** a phase-lease acquire cannot be granted before the lease-wait
  timeout, or the queue is full
- **THEN** the acquire SHALL resolve with a typed `unavailable` outcome
- **AND** the run SHALL continue rather than being blocked on the acquire.

### Requirement: Phase-lease cleanup SHALL be idempotent across every exit path and SHALL survive controller restart

Process exit, run cancellation, and `finalizeRunCleanup` SHALL each call
`releaseManagedBrowserSurfaceForPhase(runId)` as a backstop, using the same
fenced release call as an explicit in-connector release. This backstop SHALL
be idempotent (a lease already released or never acquired SHALL produce no
error and SHALL NOT double-release the run's own spawn-time
`browserSurfaceLease`).

The active-run-id set that boot/restart reconciliation consumes
(`reconcileAfterRestart`'s `activeRunIds` input and
`windowSettleReconciliation.reconcileAtBoot`) SHALL include each active run's
derived phase session id (`${runId}#browser-phase`) alongside its real
`run_id`. A controller restart during an in-flight phase SHALL NOT release
that phase's lease.

#### Scenario: Every cleanup path releases an in-flight phase lease exactly once

- **WHEN** a run with an in-flight phase lease exits, is cancelled, or
  reaches `finalizeRunCleanup`
- **THEN** the phase lease SHALL be released
- **AND** if more than one of these paths runs for the same lease, only the
  first SHALL have an effect — subsequent calls SHALL be no-ops via the
  fence, with no leaked lease and no double-release error.

#### Scenario: Controller restart mid-phase does not release a live phase lease

- **WHEN** the controller restarts while a run holds an in-flight phase
  lease
- **THEN** the derived phase session id for that run SHALL be present in the
  `activeRunIds` set consumed by `reconcileAfterRestart` and
  `windowSettleReconciliation.reconcileAtBoot`
- **AND** boot reconciliation SHALL NOT release that still-live phase lease.

### Requirement: Run-scoped (non-phase) connectors SHALL be unaffected by the phase-lease capability

A connector whose `BrowserSurfacePolicy.surfaceScope` is `"run"` (the
default) SHALL continue to acquire its managed surface at spawn exactly as
before this capability existed. No phase-lease code path SHALL be invoked
for such a connector, and its readiness, capacity accounting, and cleanup
SHALL be unchanged.

#### Scenario: Run-scoped connector's pre-spawn acquire is unchanged

- **WHEN** a connector declares `surfaceScope: "run"` (or omits the field)
- **THEN** its surface is acquired at spawn via the existing pre-spawn path
- **AND** `acquireManagedBrowserSurfaceForPhase` /
  `releaseManagedBrowserSurfaceForPhase` are never invoked for that run.
