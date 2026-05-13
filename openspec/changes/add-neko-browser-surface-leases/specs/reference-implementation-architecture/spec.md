## ADDED Requirements

### Requirement: n.eko browser surfaces SHALL be leased before connector launch

When a connector run requires an n.eko-backed browser surface, the reference implementation SHALL acquire or queue a browser-surface lease before spawning the connector child process. The connector SHALL receive the selected surface through controller-owned launch metadata rather than discovering an arbitrary unmanaged browser surface as the production path.

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

### Requirement: n.eko surface queueing SHALL preserve operator clarity

The reference implementation SHALL expose queued, leased, released, deferred, expired, and cancelled browser-surface lease states through reference-only run/operator artifacts so the owner can distinguish resource backpressure from connector failure.

#### Scenario: A queued run is inspected

- **WHEN** the owner inspects a run waiting for an n.eko surface
- **THEN** the reference SHALL show that the run is waiting for browser-surface capacity
- **AND** the status SHALL NOT be reported as a connector authentication failure, protocol failure, or invisible hang

#### Scenario: A queued run times out

- **WHEN** a queued browser-surface run exceeds the configured wait policy
- **THEN** the reference SHALL mark the run or lease as deferred or expired with retry metadata
- **AND** the failure SHALL be classified as runtime resource backpressure rather than as connector output failure

#### Scenario: An owner cancels a queued run

- **WHEN** the owner cancels a run that is waiting for a browser surface
- **THEN** the reference SHALL mark the browser-surface lease as cancelled
- **AND** it SHALL NOT spawn the connector after cancellation

### Requirement: n.eko surface leases SHALL preserve profile isolation

The reference implementation SHALL associate each n.eko surface with a stable profile key and SHALL NOT share a live browser surface across incompatible profile keys. The profile key MAY initially be connector-scoped, but the architecture SHALL leave room for account-scoped profile keys.

#### Scenario: Two connectors require browser surfaces

- **WHEN** two connector runs have different profile keys
- **THEN** the reference SHALL NOT reuse the same live n.eko browser surface for both runs
- **AND** any queueing decision SHALL preserve the profile boundary rather than trading it for throughput

#### Scenario: Multi-account support is added later

- **WHEN** the reference gains multiple accounts for one browser-backed connector
- **THEN** the browser-surface lease model SHALL support account-distinct profile keys without requiring a new browser-surface concept

### Requirement: n.eko surface leases SHALL reconcile after restart

The reference implementation SHALL persist enough browser-surface lease state to reconcile queued, starting, and leased runs after reference restart without deleting browser profile state.

#### Scenario: A leased run is not active after restart

- **WHEN** the reference starts and finds a persisted leased browser surface whose run is no longer active
- **THEN** the reference SHALL expire or release the stale lease
- **AND** it SHALL preserve the associated browser profile volume or directory

#### Scenario: A surface is missing after restart

- **WHEN** the reference starts and finds a persisted lease whose n.eko surface is no longer live or healthy
- **THEN** the reference SHALL mark the lease expired, deferred, or failed with runtime-resource classification
- **AND** it SHALL free capacity for future runs

#### Scenario: A queued run is recovered after restart

- **WHEN** the reference starts and finds a queued browser-surface run that has not expired or been cancelled
- **THEN** the reference MAY keep it queued or defer it according to policy
- **AND** it SHALL NOT report it as an already-running connector child
