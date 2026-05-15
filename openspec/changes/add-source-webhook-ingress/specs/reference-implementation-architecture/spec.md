## ADDED Requirements

### Requirement: Source webhook ingress is reference-only and source-authenticated

The reference implementation SHALL expose source webhook ingress only as reference-runtime behavior. It SHALL NOT advertise source webhooks as core PDPP support, SHALL NOT add event-driven grant semantics, and SHALL NOT accept source callbacks authenticated with owner bearer tokens, client grant tokens, or local collector device credentials.

#### Scenario: A source callback reaches the reference ingress endpoint
- **WHEN** a caller posts a source webhook callback to the reference endpoint
- **THEN** the reference SHALL authenticate the callback with a source-specific credential before processing the body
- **AND** the reference SHALL reject missing, malformed, stale, or invalid signatures before mutating records or scheduler state

#### Scenario: Metadata is requested
- **WHEN** a client reads public PDPP metadata
- **THEN** the reference SHALL NOT advertise the reference source webhook endpoint as a public PDPP capability

### Requirement: Source webhook ingress prevents replay before mutation

The reference implementation SHALL persist an idempotency decision for each accepted source webhook event before applying record mutations or scheduler signals. The idempotency key SHALL be bound to the source id and event id.

#### Scenario: A duplicate source event is received
- **WHEN** a source webhook event with a previously accepted source id and event id is received again
- **THEN** the reference SHALL return an idempotent duplicate outcome
- **AND** the reference SHALL NOT reapply record mutations or scheduler signals for that event

### Requirement: Source webhook record pushes use existing ingest semantics

Accepted source webhook record pushes SHALL be normalized into the existing record ingest path for the matching connector/source stream. The webhook path SHALL NOT bypass stream lookup, record validation, tombstone behavior, versioning, indexing, or grant-visible query behavior.

#### Scenario: A signed record-push callback is accepted
- **WHEN** an authenticated source callback carries records for a declared stream
- **THEN** the reference SHALL process those records through the existing record-ingest operation for that connector/source and stream
- **AND** the response SHALL report accepted and rejected record counts from that operation

### Requirement: Source webhook run triggers are scheduler input only

Accepted source webhook run-trigger callbacks SHALL be treated as scheduler input. They SHALL NOT directly execute connector runs or bypass scheduler-owned non-overlap, backoff, rate-limit, owner-attention, or diagnostics behavior.

#### Scenario: A signed run-trigger callback is accepted
- **WHEN** an authenticated source callback requests a connector/source refresh
- **THEN** the reference SHALL record a scheduler input signal for that connector/source
- **AND** the webhook handler SHALL NOT start the connector run inline
