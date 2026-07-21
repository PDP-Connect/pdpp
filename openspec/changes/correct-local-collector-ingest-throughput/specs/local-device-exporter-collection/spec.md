## ADDED Requirements

### Requirement: Device batch identity SHALL be canonical and server verified

The device-exporter route SHALL server-verify the supplied lowercase hexadecimal
SHA-256 against a canonical representation. Canonical JSON SHALL recursively
sort object keys and omit undefined object members exactly as
`local-device-envelope.ts`. The primary representation is the raw received
`records` array. For compatibility with the shipped durable collector, the
route SHALL also reconstruct and verify its full `LocalDeviceRecordEnvelope[]`
representation from request identity plus the transmitted record projection.
No opaque or otherwise unverifiable hash is accepted. The verified supplied
hash remains the immutable reservation identity, so switching representations
for an existing device/batch id is a conflict. The route SHALL parse
`canonical_records` from the raw representation before preflight, reserved
durability, collapse, or repair. Object-member order is non-semantic only at
this device boundary; ordinary callers retain their existing representation
contract.

The route SHALL reject a missing, malformed, or unequal supplied `body_hash`
with a safe 400 and no reservation. Define `verified_body_hash` as the supplied
hash after it matches one of the two reconstructable representations. A
reservation identity SHALL include
`(device_id, batch_id, verified_body_hash, source_instance_id,
connector_instance_id, canonical_connector_id, batch_seq)` while admission
remains unique at `(device_id, batch_id)`.

#### Scenario: A different identity conflicts before effects

- **WHEN** a reservation exists for a device and batch id and any identity
  member differs
- **THEN** the route SHALL return a safe 409
- **AND** it SHALL not mutate records, indexes, outcomes, or diagnostics

#### Scenario: Existing identity owns connector-validation precedence

- **WHEN** a validly hashed request reuses an existing device and batch id but
  supplies a different connector identity
- **THEN** coordinated reservation lookup SHALL return the identity conflict as
  409 before applying new-candidate connector validation
- **AND** the equivalent request under a new batch id SHALL remain a safe 400

#### Scenario: Canonically equivalent retry resumes safely

- **WHEN** nested object keys are reordered in an otherwise equal processing
  retry
- **THEN** SQLite and PostgreSQL SHALL apply the same canonical durable values
- **AND** neither SHALL allocate a new prefix version for an already committed input

#### Scenario: Shipped collector hash remains server-verifiable

- **WHEN** the durable collector uses the shared shipped request builder to hash
  its full stored record envelopes and transmit their record projection
- **THEN** the server SHALL reconstruct and verify that exact envelope hash
- **AND** an unrelated or malformed hash SHALL still leave no reservation

### Requirement: Device batches SHALL use a durable processing reservation

The outcome substrate SHALL expose only `processing` and terminal `accepted`
for this protocol. A reservation SHALL store immutable complete identity,
`created_at`, nullable `accepted_at`, nullable HTTP status/response,
`record_count`, and monotonic `durable_prefix_count` with
`0 <= durable_prefix_count <= record_count`. New processing starts at zero;
accepted requires equality. Existing outcome rows SHALL migrate to accepted
facts with recoverable counts, never resumed work, and `accepted_at=created_at`.

Legal transitions SHALL be absent to processing and processing to accepted.
The latter SHALL compare-and-set processing state, complete prefix, manifest
fingerprint, semantic capability identity, `accepted_at`, HTTP 201, and the
canonical response before sending 201. `accepted_at` SHALL be written only by
that transition.

#### Scenario: Accepted replay is a stored terminal fact

- **WHEN** an equal accepted reservation is retried after manifest drift
- **THEN** the route SHALL replay the stored status and body without current
  manifest validation, durable work, index work, or mutation

#### Scenario: Execution failure is sticky processing

- **WHEN** a new request passes pure preflight and later durable or required
  derived work fails
- **THEN** its reservation SHALL remain processing for safe retry
- **AND** it SHALL not become a rejected terminal row

### Requirement: Device admission SHALL preserve replay and validation precedence

The route SHALL authenticate and perform bounded structural checks, verify the
canonical hash, enter bounded active-batch admission and the shared target
fence, reread/create the reservation, reject conflicts, and replay accepted
same-identity facts before manifest-dependent validation. A new candidate SHALL
complete pure preflight and create an immutable attempt context before inserting
processing. Same-identity processing resumes SHALL leave manifest/backend drift
as a safe retryable stage failure, never a permanent client rejection.

Admission and lock waiters SHALL be bounded. Excess new work SHALL receive a
retryable 503 plus `Retry-After` without reservation mutation; a matching
processing retry receives bounded retryable admission rather than bypassing a
cap.

#### Scenario: Invalid new input leaves no durable fact

- **WHEN** a new request fails complete pure preflight
- **THEN** it SHALL receive its safe client error before processing insertion
- **AND** a later corrected request may use the same batch id

### Requirement: Device durability SHALL be ordered and cursor atomic

Reserved records SHALL execute in canonical input order. For input `i`, the
existing backend authoritative transaction SHALL lock and verify the matching
processing reservation, apply or no-op the record using the immutable attempt
context, and compare-and-set `durable_prefix_count` from `i` to `i + 1` in the
same SQLite/PostgreSQL transaction. A route-level cursor update is forbidden.
Resume SHALL begin exactly at the durable prefix and never reapply an earlier
input, including duplicate-key `A -> B` and upsert-to-delete sequences.

After durability, the route SHALL collapse by `(connector_instance_id, stream,
encoded_key)`, retain the final input occurrence including a no-op, reread final
authoritative state where needed, sort by final input index, and complete every
required index operation before acceptance. Retrying a processing batch SHALL
repair all collapsed final keys without prefix versions, changes, or
notifications growing.

#### Scenario: Partial durable prefix resumes without history churn

- **WHEN** a duplicate-key batch fails after authoritative record `N`
- **THEN** retry SHALL start at the stored cursor
- **AND** no earlier record version, change, or notification SHALL be added

#### Scenario: Fresh no-op suffix repairs current attempt facts

- **WHEN** a remaining input is byte-identical to an anchored current row after
  the processing attempt context changes
- **THEN** its record transaction SHALL repair current manifest-derived durable
  facts before advancing the prefix
- **AND** it SHALL allocate no version, change, or notification

### Requirement: Accepted device batches SHALL satisfy a pinned required-index plan

Preflight SHALL compile an immutable context containing canonical records,
canonical manifest snapshot and persisted fingerprint, stream validation,
semantic-time and consent facts, required lexical/semantic plan, and capability
identity. Durable and derived calls SHALL consume it rather than ambient
manifest facts. Required semantic backend absence or identity drift SHALL be a
safe retryable failure; legitimate empty declared fields may require zero rows.

The processing-to-accepted transition SHALL verify persisted manifest fingerprint
and semantic capability identity. A mismatch SHALL retain processing, compile a
current context, and repair final state without replaying its prefix. An update
before the fence prevents old acceptance; an update after acceptance leaves its
serialized registration backfill as final writer.

#### Scenario: Generation drift repeats only derived work

- **WHEN** a manifest or semantic capability changes after durable completion
  but before accepted transition
- **THEN** processing SHALL remain sticky and repair under a current context
- **AND** its durable prefix SHALL not be replayed

### Requirement: Device changed-record notifications SHALL retain immediate parity

For each changed reserved durable result on both backends, the existing
best-effort after-commit notification attempt SHALL run immediately after its
record/cursor transaction and before input `i + 1`. Later durable/index failure
shall not suppress it; no-op resume SHALL add none. This requirement does not
provide crash-safe at-least-once delivery or add an event outbox.
The notification SHALL carry the exact version allocated by that backend's
authoritative transaction; zero/null substitution is forbidden for a changed
result.

#### Scenario: A later durable failure retains prefix notification attempts

- **WHEN** inputs before `N` commit changed records and input `N` fails
- **THEN** each changed prefix record SHALL already have one notification attempt
- **AND** resuming SHALL not create another for that prefix

### Requirement: Device diagnostics and failures SHALL be safe

Processing rows SHALL not affect accepted/rejected counts, ordinary terminal
outcome lists, heartbeat last-ingest, or freshness. Both stores SHALL derive
last ingest only from accepted `accepted_at`. Public errors and logs SHALL use
only stable code, bounded stage, and relevant input index; they SHALL not expose
payloads, semantic text, SQL, raw error messages, credentials, paths, request
metadata, or raw error objects.

#### Scenario: Processing does not advance health

- **WHEN** a reservation is stranded while processing
- **THEN** accepted counts and last-ingest/freshness SHALL remain unchanged
