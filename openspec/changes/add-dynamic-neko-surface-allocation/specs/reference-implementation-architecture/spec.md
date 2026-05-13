## ADDED Requirements

### Requirement: Dynamic n.eko surfaces SHALL be allocated behind the lease boundary

The reference implementation SHALL allocate dynamic n.eko browser surfaces through a controller-owned allocator boundary when configured for dynamic managed n.eko mode. Connectors SHALL receive only lease-scoped browser metadata and SHALL NOT create, select, or stop n.eko containers directly.

#### Scenario: Dynamic mode has capacity

- **WHEN** a managed n.eko connector run requests a profile key with no compatible ready idle surface
- **AND** the active n.eko surface count is below the configured cap
- **THEN** the reference SHALL create or ensure a dynamic surface for that profile key before connector launch
- **AND** the connector child SHALL NOT be spawned until the dynamic surface is ready and leased

#### Scenario: Dynamic mode is not configured correctly

- **WHEN** managed n.eko dynamic mode is enabled without allocator configuration, valid capacity, profile storage policy, or stream proxy configuration
- **THEN** reference startup SHALL fail fast with a runtime configuration error
- **AND** managed connectors SHALL NOT silently fall back to static, local, headless, or unmanaged remote-CDP browser launch

#### Scenario: Connector code runs with a dynamic surface

- **WHEN** a dynamic n.eko surface is leased for a connector run
- **THEN** the connector process SHALL receive lease-scoped surface metadata including the lease id, surface id, profile key, remote CDP URL, and stream base URL
- **AND** the connector SHALL NOT receive Docker lifecycle authority as part of the browser binding

### Requirement: Dynamic n.eko surfaces SHALL preserve browser profile isolation

The reference implementation SHALL associate each dynamic n.eko surface with persistent profile storage derived from the lease profile key. A live dynamic surface SHALL NOT be shared across incompatible profile keys.

#### Scenario: Two managed connectors use different profile keys

- **WHEN** two managed n.eko connector runs request different profile keys
- **THEN** the reference SHALL allocate or reuse separate dynamic surfaces for those profile keys
- **AND** it SHALL NOT satisfy either run by sharing the other run's live browser profile

#### Scenario: A dynamic surface becomes idle

- **WHEN** a dynamic n.eko surface has no active lease
- **THEN** the reference MAY keep the surface warm until idle TTL expires
- **AND** idle cleanup SHALL stop the container without deleting the persistent profile storage

#### Scenario: Docker resources are named

- **WHEN** the allocator creates containers, volumes, or directories for a profile key
- **THEN** it SHALL derive resource names from a sanitized or hashed representation
- **AND** it SHALL NOT embed raw connector URLs, account identifiers, or owner data directly in Docker resource names

### Requirement: Dynamic n.eko lease promotion SHALL be readiness gated

The reference implementation SHALL classify a dynamic n.eko surface as leaseable only after container, n.eko HTTP, CDP, browser process, and stream proxy readiness checks pass.

#### Scenario: Surface startup is in progress

- **WHEN** a dynamic n.eko surface has been requested but readiness checks have not passed
- **THEN** the corresponding lease SHALL remain in a pre-spawn starting or waiting browser-surface state
- **AND** the reference SHALL NOT emit `run.started` for that connector run

#### Scenario: Readiness succeeds

- **WHEN** the allocator reports that container, n.eko HTTP, CDP, browser process, and stream proxy readiness checks have passed
- **THEN** the reference SHALL mark the lease `leased`
- **AND** it SHALL emit browser-surface lease events before spawning the connector child

#### Scenario: Readiness fails

- **WHEN** a dynamic surface fails startup or readiness checks before connector launch
- **THEN** the reference SHALL mark the lease as `surface_failed` or `deferred` with runtime-resource classification
- **AND** it SHALL NOT report the failure as connector authentication failure, connector protocol failure, or connector output failure

### Requirement: Dynamic n.eko capacity SHALL include starting and idle surfaces

The reference implementation SHALL enforce the configured active n.eko surface cap across starting, ready idle, leased, and unhealthy dynamic surfaces until those surfaces are stopped or reconciled out of the active set.

#### Scenario: A surface is starting

- **WHEN** a dynamic surface container has been requested but is not yet ready
- **THEN** it SHALL count against the configured active-surface cap
- **AND** another run SHALL NOT over-allocate capacity by ignoring the starting surface

#### Scenario: Capacity is full with idle surfaces

- **WHEN** the configured active-surface cap is full because of ready idle dynamic surfaces
- **THEN** the reference MAY stop idle surfaces according to idle TTL policy
- **AND** runs that still cannot obtain compatible capacity SHALL remain queued or deferred according to wait policy

#### Scenario: Capacity becomes available

- **WHEN** a dynamic surface is released, stopped after idle TTL, or reconciled as expired
- **THEN** the reference SHALL run the browser-surface queue pump
- **AND** queued runs SHALL be promoted by priority class and FIFO order only after compatible capacity is available

### Requirement: Dynamic n.eko surfaces SHALL reconcile after restart

The reference implementation SHALL reconcile persisted browser-surface leases and surface rows with allocator/container state after reference restart and before accepting new managed n.eko launches.

#### Scenario: A live healthy surface exists after restart

- **WHEN** the reference starts and finds a live healthy dynamic n.eko container for a persisted surface
- **THEN** it SHALL retain that surface if it is under cap and profile-compatible
- **AND** it SHALL release stale leases whose connector run is no longer active without deleting profile storage

#### Scenario: A starting surface exists after restart

- **WHEN** the reference starts and finds a persisted `starting_surface` lease
- **THEN** it SHALL resume readiness reconciliation if the allocator still has the corresponding container
- **AND** it SHALL fail or defer the lease with runtime-resource classification if the container is missing or unhealthy

#### Scenario: A dynamic container is missing after restart

- **WHEN** the reference starts and a persisted non-terminal lease references a missing dynamic container
- **THEN** it SHALL mark the lease expired or surface-failed according to policy
- **AND** it SHALL preserve the profile volume or directory for future runs

### Requirement: Dynamic n.eko allocation SHALL be constrained to reference-owned resources

The reference implementation SHALL restrict dynamic allocator operations to reference-owned n.eko containers, networks, and profile volumes identified by explicit configuration and labels.

#### Scenario: The allocator lists containers

- **WHEN** the allocator discovers existing Docker containers or volumes
- **THEN** it SHALL manage only resources carrying the expected reference-owned labels
- **AND** it SHALL ignore or reject operations against unlabeled or foreign resources

#### Scenario: The n.eko image is selected

- **WHEN** dynamic mode starts an n.eko container
- **THEN** it SHALL use the configured pinned image or locally built tagged image
- **AND** it SHALL NOT pull or run an arbitrary image name supplied by connector code or run input

#### Scenario: A stream descriptor is produced

- **WHEN** the allocator returns stream metadata for a dynamic surface
- **THEN** the descriptor SHALL route through reference-approved proxy or WebRTC configuration
- **AND** it SHALL NOT expose arbitrary allocator/container hostnames to the owner-facing client
