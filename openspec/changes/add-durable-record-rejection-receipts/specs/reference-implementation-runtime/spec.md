## ADDED Requirements

### Requirement: Hosted record ingest SHALL preserve permanent rejection evidence before success

The reference hosted record ingest path SHALL persist owner-bound durable receipts for permanent per-line record rejections before returning a successful response that counts those rejections. Each receipt SHALL bind the owner, connection, connector instance, stream, exact rejected line bytes, typed rejection reason, and opaque receipt id. The successful response SHALL include attempted, accepted, rejected, and metadata-only rejection-vector evidence sufficient for the runtime to identify every rejected input index without exposing rejected payload bytes.

#### Scenario: Permanent line rejection is acknowledged
- **WHEN** hosted ingestion permanently rejects one non-empty input line in a batch
- **THEN** the reference implementation SHALL commit a durable rejection receipt for that exact line before returning a 2xx response
- **AND** the response SHALL include a metadata-only rejection vector entry for the rejected input index
- **AND** the response SHALL NOT include rejected payload bytes or parser/storage exception text

#### Scenario: Rejection persistence fails
- **WHEN** hosted ingestion cannot commit the durable rejection receipt for a permanently rejected line
- **THEN** the reference implementation SHALL return a non-2xx retryable failure
- **AND** it SHALL NOT claim the line as receipt-backed rejected
- **AND** the runtime SHALL NOT treat the batch as complete for cursor checkpoint progress

### Requirement: Hosted record ingest SHALL keep durable-prefix replay safe

The reference hosted record ingest path SHALL allow accepted sibling records and already committed rejection receipts to remain durable when a later sibling fails systemically, but it SHALL make exact replay idempotent for both accepted records and rejection receipts. A failed response SHALL NOT expose a successful receipt claim or cursor-commit claim for an uncompleted batch.

#### Scenario: Later systemic sibling failure follows durable prefix effects
- **WHEN** a hosted batch accepts one sibling record and commits one permanent-rejection receipt before a later sibling fails systemically
- **THEN** the accepted record and rejection receipt MAY remain durable
- **AND** the response SHALL be non-2xx
- **AND** the response SHALL NOT claim the batch as successfully receipted or cursor-committable
- **AND** an exact replay SHALL reuse the existing receipt and SHALL NOT duplicate the already accepted sibling

#### Scenario: Response is lost after receipt commit
- **WHEN** the server commits a permanent-rejection receipt but the successful response is lost before the runtime observes it
- **THEN** an exact retry SHALL return the same receipt handle for the same rejected line
- **AND** the retry SHALL NOT consume duplicate quota for the replayed receipt

### Requirement: Hosted rejection receipt transactions SHALL re-check connection and run authority

The reference implementation SHALL re-check connection writability and the exact run/connection fence inside the backend transaction that inserts or replays a hosted rejection receipt. Cancellation, revocation, deletion, terminalization, quota exhaustion, and injected transaction failures that win before receipt admission SHALL produce non-2xx failure without creating receipt, quota, or audit effects.

#### Scenario: Connection or run authority changes before receipt admission
- **WHEN** cancellation, revocation, deletion, or terminalization wins before the hosted rejection receipt transaction admits the write
- **THEN** the receipt transaction SHALL fail without creating or replaying a receipt
- **AND** it SHALL leave no receipt, quota, or audit mutation for the losing ingest attempt

#### Scenario: Quota is exhausted
- **WHEN** durable rejection receipt quota would be exceeded by a new pending receipt
- **THEN** hosted ingestion SHALL fail non-2xx
- **AND** it SHALL NOT acknowledge the rejected line as receipt-backed
- **AND** exact replay of an existing receipt SHALL remain allowed without duplicate quota consumption

### Requirement: Owner inspection of hosted rejection receipts SHALL be bounded and private

The reference implementation SHALL expose hosted rejection receipts only through owner-session, connection-scoped, read-only inspection routes. List responses SHALL be paginated with a bounded page size and SHALL expose metadata only. Detail responses SHALL require the owner to prove access through the owning connection before returning bounded payload data. Cross-owner, missing, and unauthorized receipt lookups SHALL use non-disclosing error surfaces. Connection deletion SHALL remove associated pending rejection receipt state and quota accounting on SQLite and PostgreSQL.

#### Scenario: Owner lists rejection receipts
- **WHEN** an owner lists rejection receipts for a connection they own
- **THEN** the response SHALL enforce the maximum page size and stable cursor pagination
- **AND** it SHALL return metadata only
- **AND** it SHALL NOT include rejected payload bytes, payload text, or parser/storage exception text

#### Scenario: Retained-size accounting includes rejected payload bytes
- **WHEN** a hosted rejection receipt is committed for a rejected input line
- **THEN** owner-facing retained-size global, connection, and stream accounting SHALL include that receipt's rejected payload byte count exactly once
- **AND** exact replay of the same rejected input SHALL NOT increase retained-size byte or count measures
- **AND** audit events, quota rows, hashes, and receipt metadata SHALL NOT be double-counted as retained payload bytes

#### Scenario: Owner fetches rejection receipt detail
- **WHEN** an owner fetches a rejection receipt detail through its owning connection
- **THEN** the response MAY include bounded payload retrieval data for that receipt
- **AND** a fresh server process SHALL be able to retrieve the committed payload from durable storage

#### Scenario: Non-owner or wrong-connection lookup occurs
- **WHEN** a caller requests a receipt through a connection they do not own or through the wrong connection
- **THEN** the reference implementation SHALL reject the request without disclosing whether the receipt exists

#### Scenario: Connection is deleted
- **WHEN** the owning connection is deleted
- **THEN** SQLite and PostgreSQL storage SHALL remove the associated pending rejection receipts
- **AND** associated quota accounting SHALL no longer retain those deleted receipts
