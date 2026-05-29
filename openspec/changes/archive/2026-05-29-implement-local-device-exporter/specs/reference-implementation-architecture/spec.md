## ADDED Requirements

### Requirement: Local device exporters remain reference-only
The reference implementation SHALL support local device exporters as a reference-only ingestion mechanism and SHALL NOT present their enrollment, credential, or ingest routes as PDPP Core client API or Collection Profile protocol surface.

#### Scenario: Device exporter routes are exposed
- **WHEN** the reference implementation exposes local device exporter enrollment, heartbeat, or ingest routes
- **THEN** those routes SHALL be documented and implemented as reference-only surfaces
- **AND** they SHALL NOT be exposed under the public client `/v1` query/read contract

#### Scenario: Public grant artifacts are emitted
- **WHEN** records pushed by a local device exporter are later queried through existing grant-scoped RS routes
- **THEN** public artifacts SHALL continue to identify the data source as `{ kind: "connector", id: <connector_id> }`
- **AND** they SHALL NOT expose a public `source_instance_id` unless a later accepted protocol or profile change adds that contract

### Requirement: Device exporter credentials are narrowly scoped
The reference implementation SHALL use a dedicated device-scoped ingest credential for local device exporters. Device credentials SHALL be revocable and SHALL authorize only the enrolled device's heartbeat and ingest operations.

#### Scenario: Owner enrolls a device
- **WHEN** an owner-authenticated operator creates a local device exporter enrollment
- **THEN** the reference implementation SHALL issue a short-lived one-time enrollment code
- **AND** exchanging that code SHALL create a server-assigned `device_id` and a device-scoped ingest credential

#### Scenario: Device credential is used outside ingest
- **WHEN** a caller presents a device-scoped ingest credential to owner routes, public client read/query routes, consent approval routes, grant mutation routes, or other devices' ingest routes
- **THEN** the reference implementation SHALL reject the request

#### Scenario: Device is revoked
- **WHEN** an owner revokes an enrolled device
- **THEN** subsequent heartbeat or ingest attempts using that device credential SHALL fail
- **AND** existing grant/query behavior for already-ingested records SHALL remain unchanged

### Requirement: Device ingest is source-instance isolated
The reference implementation SHALL store local device exporter records with source-instance-aware identity before they enter existing record query and index maintenance paths.

#### Scenario: Two devices push the same connector record key
- **WHEN** two enrolled devices push records for the same `connector_id`, stream, and record key under different source instances
- **THEN** the reference implementation SHALL preserve both records without silently overwriting or conflating them

#### Scenario: Device submits an unknown source instance
- **WHEN** a device submits a batch for a `source_instance_id` not assigned to that device
- **THEN** the reference implementation SHALL reject the batch
- **AND** it SHALL record a machine-readable rejection reason for diagnostics

### Requirement: Device ingest batches are idempotent
The reference implementation SHALL make local device exporter batch ingest idempotent by storing outcomes keyed by `(device_id, batch_id, body_hash)`.

#### Scenario: Device retries the same batch
- **WHEN** a device submits the same `batch_id` with the same `body_hash` after a prior successful or rejected attempt
- **THEN** the reference implementation SHALL return the original stored outcome without duplicating records

#### Scenario: Device reuses a batch id with different content
- **WHEN** a device submits a previously seen `batch_id` with a different `body_hash`
- **THEN** the reference implementation SHALL reject the request as a batch conflict
- **AND** it SHALL NOT ingest records from the conflicting body

### Requirement: Local exporter agents retry durably
The local device exporter agent SHALL keep a bounded durable retry queue for batches that could not be delivered, preserve per-source-instance ordering, and report permanent failures through device diagnostics.

#### Scenario: Remote server is temporarily unavailable
- **WHEN** the local exporter cannot deliver a batch because the reference server is unavailable or returns a retryable error
- **THEN** the exporter SHALL keep the batch in its local durable queue
- **AND** it SHALL retry later without reordering batches for the same source instance

#### Scenario: Batch is permanently invalid
- **WHEN** the reference server rejects a batch with a permanent validation error
- **THEN** the exporter SHALL stop retrying that batch indefinitely
- **AND** it SHALL report the failure in local state and device heartbeat diagnostics

### Requirement: Device exporter diagnostics are owner-visible
The reference implementation SHALL expose owner/operator diagnostics for local device exporters without weakening dashboard owner authentication.

#### Scenario: Owner views device exporters
- **WHEN** an owner opens the live dashboard device exporter surface
- **THEN** the dashboard SHALL show enrolled devices, source instances, last heartbeat, last successful ingest, accepted and rejected counts, stale or revoked state, and last error

#### Scenario: Owner auth is enabled
- **WHEN** owner authentication is configured for the reference instance
- **THEN** local device exporter diagnostics and enrollment controls SHALL require owner access
