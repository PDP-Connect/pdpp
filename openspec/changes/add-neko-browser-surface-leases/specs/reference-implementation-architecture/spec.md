## ADDED Requirements

### Requirement: n.eko browser surfaces SHALL be leased before connector launch

When a connector run requires an n.eko-backed browser surface, the reference implementation SHALL acquire or queue a browser-surface lease before spawning the connector child process. The connector SHALL receive the selected surface through controller-owned launch metadata rather than discovering an arbitrary unmanaged browser surface as the production path.

#### Scenario: A connector is configured for managed n.eko

- **WHEN** reference configuration declares a connector id as requiring managed n.eko
- **THEN** each run for that connector SHALL request a browser-surface lease before connector spawn
- **AND** the reference SHALL fail fast on invalid managed n.eko capacity or static-profile configuration rather than silently falling back to unmanaged browser launch

#### Scenario: A connector is not configured for managed n.eko

- **WHEN** a connector is not declared as requiring managed n.eko
- **THEN** the reference MAY use the existing local browser launch or development remote-CDP override paths
- **AND** the connector SHALL NOT be placed into browser-surface queueing solely because n.eko support exists

#### Scenario: A compatible surface is available

- **WHEN** a connector run requires n.eko and a ready idle surface with a compatible profile key is available
- **THEN** the reference SHALL lease that surface before spawning the connector process
- **AND** the connector process SHALL receive lease-scoped browser metadata including a remote CDP URL
- **AND** the run SHALL NOT use an unrelated browser profile or surface

#### Scenario: Capacity is available but no surface exists

- **WHEN** a connector run requires n.eko, no compatible ready surface exists, and the active n.eko surface count is below the configured cap
- **THEN** the reference MAY start or allocate a compatible n.eko surface before connector launch
- **AND** the run SHALL remain in a surface-starting or waiting state until the surface is ready and leased

#### Scenario: The surface cap is full

- **WHEN** a connector run requires n.eko and the configured active-surface cap is already full
- **THEN** the reference SHALL queue the run before connector launch with an operator-visible waiting state
- **AND** the reference SHALL NOT spawn the connector child process until a compatible surface is leased
- **AND** the reference SHALL NOT silently fall back to headless, local, or shared-profile browser launch

#### Scenario: A queued run has not been promoted

- **WHEN** a connector run is waiting for a browser surface before connector spawn
- **THEN** the reference SHALL represent it as a queued launch request or pending browser-surface lease
- **AND** the reference SHALL NOT persist it in the active-run registry used for spawned connector children
- **AND** the reference SHALL NOT create active child-process state, active interaction state, a streaming nonce, or a `run.started` event

#### Scenario: A legacy remote-CDP override exists for a managed run

- **WHEN** a connector run requires managed n.eko and no lease-scoped CDP URL has been issued
- **THEN** the connector browser launch SHALL fail closed with runtime-resource classification
- **AND** it SHALL NOT satisfy the managed requirement by using `PDPP_<PROFILE>_REMOTE_CDP_URL`, headless launch, or local launch

### Requirement: n.eko browser-surface leasing SHALL be atomic and fenced

The reference implementation SHALL enforce browser-surface cap, lease ownership, queued-run uniqueness, and release behavior atomically so concurrent run starts cannot over-allocate n.eko surfaces or corrupt profile isolation.

#### Scenario: Concurrent runs request the final available surface

- **WHEN** two managed n.eko runs concurrently request browser-surface capacity and only one compatible surface slot is available
- **THEN** exactly one run SHALL receive or start a leased surface
- **AND** the other run SHALL remain queued or deferred according to policy
- **AND** the configured active-surface cap SHALL NOT be exceeded

#### Scenario: A surface is already leased

- **WHEN** a browser surface has a non-terminal leased row
- **THEN** the reference SHALL NOT issue a second active lease for that same surface
- **AND** any waiting run SHALL be queued, deferred, or rejected according to profile compatibility and wait policy

#### Scenario: A run already has a pending lease

- **WHEN** a run id already has a non-terminal browser-surface lease
- **THEN** the reference SHALL NOT create a duplicate non-terminal lease for the same run
- **AND** a duplicate launch request for the same connector/profile SHALL return or reference the existing pending run rather than enqueue unbounded duplicate work

#### Scenario: A stale release arrives after a newer lease

- **WHEN** a release request uses an old lease id or fencing token for a surface that has since been leased again
- **THEN** the reference SHALL ignore or reject the stale release
- **AND** it SHALL NOT release the newer lease or unblock another queued run from stale state

### Requirement: n.eko surface queueing SHALL preserve operator clarity

The reference implementation SHALL expose queued, leased, released, deferred, expired, and cancelled browser-surface lease states through reference-only run/operator artifacts so the owner can distinguish resource backpressure from connector failure.

#### Scenario: A queued run is inspected

- **WHEN** the owner inspects a run waiting for an n.eko surface
- **THEN** the reference SHALL show browser-surface status such as queued, starting, leased, deferred, expired, or cancelled
- **AND** active-run status SHALL remain reserved for spawned connector children
- **AND** the status SHALL NOT be reported as a connector authentication failure, protocol failure, or invisible hang

#### Scenario: A queued run times out

- **WHEN** a queued browser-surface run exceeds the configured wait policy
- **THEN** the reference SHALL mark the run or lease as deferred with retry metadata and runtime-resource classification
- **AND** the failure SHALL be classified as runtime resource backpressure rather than as connector output failure

#### Scenario: An owner cancels a queued run

- **WHEN** the owner cancels a run that is waiting for a browser surface
- **THEN** the reference SHALL mark the browser-surface lease as cancelled
- **AND** it SHALL NOT spawn the connector after cancellation

#### Scenario: Browser-surface capacity becomes available

- **WHEN** a leased surface is released and compatible queued runs exist
- **THEN** the reference SHALL select the next run by priority class and FIFO order
- **AND** it SHALL promote the selected queued run through the normal active-run spawn path
- **AND** it SHALL emit browser-surface lease events before any connector `run.started` event

### Requirement: n.eko surface leases SHALL preserve profile isolation

The reference implementation SHALL associate each n.eko surface with a stable profile key and SHALL NOT share a live browser surface across incompatible profile keys. The profile key MAY initially be connector-scoped, but the architecture SHALL leave room for account-scoped profile keys.

#### Scenario: Two connectors require browser surfaces

- **WHEN** two connector runs have different profile keys
- **THEN** the reference SHALL NOT reuse the same live n.eko browser surface for both runs
- **AND** any queueing decision SHALL preserve the profile boundary rather than trading it for throughput

#### Scenario: Static single-surface mode receives an incompatible profile key

- **WHEN** the first tranche static n.eko mode is configured with one fixed profile key
- **AND** a managed run requests a different profile key
- **THEN** the reference SHALL defer or reject the run with runtime-resource classification
- **AND** it SHALL NOT wait forever, reprofile the static surface, or reuse the incompatible profile

#### Scenario: Multi-account support is added later

- **WHEN** the reference gains multiple accounts for one browser-backed connector
- **THEN** the browser-surface lease model SHALL support account-distinct profile keys without requiring a new browser-surface concept

### Requirement: n.eko surface leases SHALL reconcile after restart

The reference implementation SHALL persist enough browser-surface lease state to reconcile queued, starting, and leased runs after reference restart without deleting browser profile state.

#### Scenario: A leased run is not active after restart

- **WHEN** the reference starts and finds a persisted leased browser surface whose run is no longer active
- **THEN** the reference SHALL release the stale lease if the surface is healthy, or expire it if the surface is missing
- **AND** it SHALL preserve the associated browser profile volume or directory

#### Scenario: A surface is missing after restart

- **WHEN** the reference starts and finds a persisted lease whose n.eko surface is no longer live or healthy
- **THEN** the reference SHALL mark a missing-surface lease expired and an unhealthy-surface lease surface-failed with runtime-resource classification
- **AND** it SHALL free capacity for future runs

#### Scenario: A queued run is recovered after restart

- **WHEN** the reference starts and finds a queued browser-surface run that has not expired or been cancelled
- **THEN** the reference SHALL keep it queued if it is within wait policy, defer it if it exceeded wait policy, or defer it if static profile compatibility cannot ever satisfy it
- **AND** it SHALL NOT report it as an already-running connector child

#### Scenario: Reconciliation runs before new launches

- **WHEN** the reference process boots with persisted browser-surface leases
- **THEN** it SHALL reconcile those leases after storage initialization and before routes or schedules can start new connector runs
- **AND** queued-but-not-started runs SHALL NOT be classified as abandoned active connector runs
