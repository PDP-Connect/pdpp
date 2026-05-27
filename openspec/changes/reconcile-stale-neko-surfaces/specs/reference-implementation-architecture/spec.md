## ADDED Requirements

### Requirement: Dynamic n.eko surfaces SHALL be reconciled against the allocator before serving acquires

After reference restart, the lease manager SHALL prove every in-memory dynamic n.eko surface still corresponds to a live, healthy allocator container before the first managed acquire can lease it.

#### Scenario: Allocator does not know a persisted surface

- **WHEN** the reference boots and a persisted dynamic n.eko surface row marked `health: "ready"` has no corresponding container reported by the allocator
- **THEN** the lease manager SHALL evict that surface row from the in-memory map before accepting any acquire request
- **AND** the persisted surface row SHALL be updated to reflect the eviction
- **AND** any active lease referencing the evicted surface SHALL transition to `surface_failed` with `wait_reason = "surface_unhealthy"`

#### Scenario: Allocator reports a persisted surface as not ready

- **WHEN** the reference boots and a persisted dynamic n.eko surface row marked `health: "ready"` is reported by the allocator with health `"starting"`, `"stopping"`, or `"unhealthy"`
- **THEN** the lease manager SHALL downgrade the in-memory health to match the allocator's report
- **AND** the persisted surface row SHALL be updated to reflect the downgrade
- **AND** the next acquire SHALL NOT treat that surface as a ready idle candidate

#### Scenario: Static n.eko mode boots

- **WHEN** the reference boots in static n.eko surface mode
- **THEN** allocator-aware reconciliation SHALL be a no-op
- **AND** the configured static surface SHALL remain available unchanged

### Requirement: Readiness-probe failure SHALL invalidate the in-memory surface

When the controller's pre-spawn readiness probe fails for a leased managed n.eko surface, the lease manager SHALL invalidate the surface row in addition to releasing the lease, so the next acquire cannot reuse the surface in a tight loop.

#### Scenario: Probe failure on a leased surface

- **WHEN** the controller's readiness probe returns a typed failure code for a leased managed n.eko surface
- **THEN** the lease manager SHALL evict the surface row from the in-memory map
- **AND** the controller SHALL release the lease and emit `run.browser_surface_released`
- **AND** the eviction SHALL be persisted by upserting the surface row with `health: "unhealthy"`

#### Scenario: Probe failure with a dynamic allocator configured

- **WHEN** the readiness probe fails and a dynamic allocator is configured
- **THEN** the controller SHALL call `allocator.stopSurface({ reason: "surface_failed" })` for the failing surface
- **AND** the allocator SHALL remove the underlying container so the next `ensureSurface` request creates a fresh one
- **AND** persistent profile storage for the surface SHALL be preserved

#### Scenario: Probe failure with no dynamic allocator

- **WHEN** the readiness probe fails and only static n.eko mode is configured
- **THEN** the lease manager SHALL still evict the in-memory surface row
- **AND** no allocator stop request SHALL be issued

### Requirement: The n.eko allocator SHALL replace stale exited containers rather than restart them

When `ensureSurface` finds an existing reference-owned n.eko container that is not currently running, the allocator SHALL remove and recreate that container before returning a surface. The allocator SHALL NOT silently restart an exited carcass whose CDP, network, or browser-process state may be unrecoverable.

#### Scenario: An exited container exists for a requested surface

- **WHEN** the allocator's `ensureSurface` request matches an existing reference-owned container that is not in `running` state
- **THEN** the allocator SHALL remove that container via the Docker engine before creating a fresh one
- **AND** persistent profile storage for the surface SHALL be preserved across replacement
- **AND** the returned surface SHALL describe the fresh container, not the removed carcass

#### Scenario: A running container exists for a requested surface

- **WHEN** the allocator's `ensureSurface` request matches an existing reference-owned container that is in `running` state
- **THEN** the allocator SHALL reuse that container without removal

#### Scenario: stopSurface is called with reason surface_failed

- **WHEN** the allocator receives `stopSurface({ reason: "surface_failed" })`
- **THEN** it SHALL stop the underlying container and then remove it via the Docker engine
- **AND** the returned surface description SHALL indicate the container has been removed

#### Scenario: stopSurface is called with a non-failure reason

- **WHEN** the allocator receives `stopSurface({ reason: "idle_ttl" })`, `"capacity_pressure"`, `"reconcile"`, or `"operator"`
- **THEN** it SHALL stop the underlying container but SHALL NOT remove it
- **AND** a subsequent `ensureSurface` call for the same surface SHALL be allowed to replace the stopped container according to the stale-carcass rule above
