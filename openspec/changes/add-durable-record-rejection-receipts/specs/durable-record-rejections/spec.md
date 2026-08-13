## Purpose

Defines the durable, owner-bound evidence that permits hosted collection progress to move past a permanently rejected record without silently losing the record or the ability to recover it.

## ADDED Requirements

### Requirement: Permanent hosted-ingest rejection SHALL create durable quarantine evidence
The hosted ingest operation SHALL index inputs by their zero-based position in the ordered sequence of non-empty NDJSON lines. It SHALL preserve the exact bounded line and index through parsing and storage admission. The reference SHALL classify malformed JSON as typed permanent reason `malformed_ndjson` and SHALL classify only an explicit allowlist of typed storage-level per-record data failures as permanent. Before a hosted ingest response counts either class as rejected, the reference SHALL durably persist an owner-bound pending quarantine entry containing the exact rejected line, its digest and byte count, connector and connection identity, stream, run identity when supplied, input index, typed reason code, and timestamps. Unknown, storage, coordination, quota, timeout, and persistence failures SHALL remain retryable systemic failures and SHALL NOT be converted into terminal rejection receipts.

#### Scenario: Typed permanent record defect is quarantined
- **WHEN** one record in a hosted ingest batch fails with an allowlisted permanent per-record data error
- **THEN** the reference SHALL commit its quarantine entry before returning that record as rejected
- **AND** the response SHALL identify the rejection receipt and its input index

#### Scenario: Non-empty NDJSON line is malformed
- **WHEN** one non-empty line in an admitted hosted ingest body cannot be parsed as JSON
- **THEN** the reference SHALL quarantine its exact bounded bytes with reason `malformed_ndjson` before returning it as rejected
- **AND** its receipt `input_index` SHALL be the line's position after blank lines are removed

#### Scenario: Unknown failure occurs while ingesting a record
- **WHEN** a record write fails without an allowlisted permanent per-record error code
- **THEN** the reference SHALL fail the ingest request with a retryable non-2xx response
- **AND** it SHALL NOT issue a permanent rejection receipt for that failure

#### Scenario: Quarantine persistence cannot complete
- **WHEN** a permanent record defect is classified but its quarantine entry cannot be durably committed because of storage failure, quota, cancellation, or a terminal run fence
- **THEN** the reference SHALL fail the ingest request with a retryable non-2xx response
- **AND** the hosted runtime SHALL NOT treat the affected batch as progress-complete

#### Scenario: Run or connection becomes unwritable before quarantine commit
- **WHEN** cancellation, terminalization, revocation, or deletion makes the admitted run or connection unwritable after record classification but before quarantine persistence
- **THEN** the quarantine transaction SHALL re-check the same run and connection admission facts inside its transaction and refuse the receipt
- **AND** the ingest request SHALL fail retryably instead of acknowledging progress

### Requirement: Rejection receipts SHALL be replay-safe and batch-complete
The server SHALL derive a rejection replay key from the admitted owner, connection, stream, exact rejected input digest, and typed rejection generation, and SHALL bind that key to a persisted non-enumerable opaque receipt identity generated with sufficient random entropy. A receipt id SHALL NOT expose a database row id, timestamp, digest prefix, or sequence. Replaying the same rejected input in the same binding SHALL return the existing receipt without duplicating quarantine data. A successful hosted-ingest response SHALL satisfy `records_attempted = records_accepted + records_rejected`, and SHALL include exactly one receipt entry for every rejected input index and no receipt entry for an accepted input. Input indexes SHALL be unique; duplicate exact inputs MAY produce entries with different indexes that refer to the same receipt identity. Receipt identifiers SHALL be opaque outside the server.

#### Scenario: Identical rejected input is replayed
- **WHEN** the same exact rejected record input is submitted again for the same owner, connection, stream, and rejection generation
- **THEN** the server SHALL return the prior receipt identity
- **AND** it SHALL NOT create a second pending quarantine item

#### Scenario: Successful response omits rejection evidence
- **WHEN** a hosted-ingest response would report a rejected count that is not matched by exactly one entry for each unique rejected input index
- **THEN** the server SHALL fail the request instead of returning that response as progress-complete

#### Scenario: A batch mixes accepted and permanently rejected records
- **WHEN** a batch contains both durably accepted records and durably quarantined permanent rejections
- **THEN** the successful response SHALL report attempted, accepted, and rejected counts that balance exactly
- **AND** its receipt input indexes SHALL identify only the rejected records

#### Scenario: Prior runtime receives the additive response
- **WHEN** a prior runtime ignores the additive receipt fields and commits progress from the accepted/rejected counts
- **THEN** the new server SHALL already have committed every reported rejection payload
- **AND** the pending receipt SHALL remain visible through the owner inspection surface independently of legacy runtime accounting

### Requirement: Unresolved quarantine payloads SHALL remain recoverable and bounded
Each pending quarantine payload SHALL respect the hosted ingest per-line and request limits and SHALL count against an owner or deployment storage quota. Quota admission SHALL serialize competing inserts: SQLite SHALL acquire its write transaction before reading and updating quota usage, and PostgreSQL SHALL lock or conditionally update the quota owner in the same transaction. Exact replay SHALL NOT consume quota again. A pending entry SHALL NOT expire automatically while committed source progress may depend on it. The reference SHALL refuse progress-complete rejection acknowledgement when the applicable quota cannot admit the entry. Connection deletion SHALL delete its quarantine rows inside the existing connection-deletion transaction or through a proven active foreign-key cascade on both backends.

#### Scenario: Quarantine quota is exhausted
- **WHEN** a permanently rejected record cannot fit within the applicable quarantine quota
- **THEN** the ingest request SHALL fail retryably
- **AND** the response SHALL NOT claim that record is durably rejected

#### Scenario: Unresolved rejection ages past a maintenance interval
- **WHEN** a pending quarantine entry remains unresolved after routine cleanup runs
- **THEN** the reference SHALL preserve its recovery payload and pending status
- **AND** it SHALL continue to expose the item through the bounded owner inspection surface

#### Scenario: Owning connection is deleted
- **WHEN** an owner deletes the connection that owns quarantined records
- **THEN** the reference SHALL delete those quarantine entries with the connection's other owner data

### Requirement: Owners SHALL be able to inspect quarantined records safely
The reference SHALL expose owner-session-only, read-only reference routes to list bounded quarantine metadata and retrieve one rejected payload for an owned connection. The list route SHALL enforce a configured maximum page size and a stable opaque cursor ordered by durable logical fields. List results, run timelines, audit events, mutation events, logs, and health projections SHALL NOT include rejected payload bytes or underlying parser/storage exception text. Quarantine audit facts MAY contain only receipt id, connection id, stream, typed reason, payload byte count and digest, timestamps, and actor. Retry, discard, and payload replacement SHALL NOT be added in this tranche.

#### Scenario: Owner lists pending rejections
- **WHEN** an authenticated owner lists quarantine entries for one owned connection
- **THEN** the reference SHALL return bounded, paginated metadata including receipt identity, stream, reason code, timestamps, and pending status
- **AND** it SHALL omit the rejected record body from the list response and run timeline

#### Scenario: Owner requests one pending rejection
- **WHEN** an authenticated owner requests one receipt under its owning connection
- **THEN** the reference SHALL return the exact retained payload and bounded receipt metadata
- **AND** the response SHALL remain subject to the hosted per-line byte limit

#### Scenario: Wrong owner requests a rejection receipt
- **WHEN** a caller requests a receipt outside its owner and connection binding
- **THEN** the reference SHALL reject the request without disclosing whether that receipt exists
