## ADDED Requirements

### Requirement: Record reset generation SHALL prevent version-checkpoint ABA

Each canonical `connector_instances` row SHALL carry a non-null integer
`record_reset_generation` initialized to zero. Whenever a supported stream or
connector-wide reset changes a live connection's record namespace, the reset
path SHALL increment that connection's generation by the number of distinct
stream namespaces whose pre-reset state has either a `version_counter` row or at
least one live canonical record. It SHALL compute that union and apply the
increment in the same canonical transaction as the deletes. The generation
SHALL survive stream reset and connector-wide invalidation and SHALL be erased
only when the connection row itself is deleted.

Record-summary checkpoint readers SHALL combine this generation with the exact
per-stream version-counter vector. Both values SHALL cross the storage boundary
as unsigned base-10 text and SHALL NOT be coerced through JavaScript floating-
point numbers. The vector SHALL be sorted by UTF-8 byte order of the exact
stream name so SQLite and Postgres produce the same normalized representation.

This requirement is additive to the existing reset contract: reset SHALL still
remove `version_counter` rows. The surviving connection generation is the
namespace epoch that makes a later recreated counter distinguishable.

#### Scenario: Per-stream reset and reinsertion changes the composite checkpoint

- **GIVEN** a live connection has stream `s` at version 1 and reset generation R
- **WHEN** the supported per-stream reset removes that counter and a later insert recreates stream `s` at version 1
- **THEN** `record_reset_generation` SHALL be greater than R
- **AND** the composite summary checkpoint SHALL not equal its pre-reset value.

#### Scenario: Connector-wide invalidation advances once per affected stream namespace

- **GIVEN** connector-wide invalidation affects N distinct per-connection stream namespaces that have a counter row or a live canonical record before reset
- **WHEN** the canonical invalidation transactions commit
- **THEN** each affected connection's generation SHALL advance by the number of its affected stream namespaces
- **AND** equivalent SQLite and Postgres fixtures SHALL reach the same per-connection generation.

#### Scenario: Counterless live-record reset still advances the checkpoint

- **GIVEN** a live connection/stream has at least one live canonical record but its version-counter row is deliberately absent
- **WHEN** a supported reset deletes that record namespace
- **THEN** it SHALL increment `record_reset_generation` once for that stream
- **AND** summary reconciliation SHALL observe a different composite checkpoint.

#### Scenario: Empty counterless reset is a checkpoint no-op

- **WHEN** a reset finds neither a version-counter row nor any live canonical record for the requested live connection/stream
- **THEN** it SHALL preserve `record_reset_generation`
- **AND** summary reconciliation SHALL NOT infer a record-source change from that true no-op.

#### Scenario: Connection deletion erases the generation with the canonical row

- **WHEN** a connection deletion atomically removes its canonical instance and record namespace
- **THEN** its reset generation SHALL be removed with the connection
- **AND** scoped/full summary orphan cleanup SHALL rely on canonical connection absence rather than a surviving generation row.

#### Scenario: Values above JavaScript safe integer range remain distinct

- **WHEN** a backend stores adjacent generation or maximum-version integers above `2^53 - 1`
- **THEN** checkpoint reads SHALL return distinct decimal strings
- **AND** SQLite/Postgres normalized checkpoint JSON SHALL be byte-identical for equivalent values and stream names.

### Requirement: Derived connection repair SHALL use the shared writer coordination domain

After the local-ingest-throughput coordinator lands, any connector-summary
repair candidate that reads canonical records and stamps a source checkpoint
SHALL acquire the same connector-instance writer fence used by authoritative
record, reset, manifest/backfill, and index writers. SQLite SHALL perform the
candidate re-read and evidence upsert in one immediate transaction under its
process-local fence. Postgres SHALL perform them in one transaction while the
same domain-separated session advisory lock remains held.

Discovery of current/candidate rows MAY be batched without locks. The repair
SHALL re-read after acquiring the fence and synthesis SHALL use that returned
row. A pass SHALL acquire at most one connection fence at a time and SHALL NOT
make derived repair part of record/device acceptance.

#### Scenario: Discovery snapshot loses to a writer

- **WHEN** discovery selects a candidate from checkpoint A and a canonical writer commits checkpoint B before repair acquires the fence
- **THEN** repair SHALL read and stamp B under the shared fence
- **AND** SHALL NOT stamp discovery snapshot A as current.

#### Scenario: Repair failure cannot reject accepted records

- **WHEN** connector-summary fence admission, read, or upsert fails after canonical record acceptance
- **THEN** the record SHALL remain accepted
- **AND** the connection summary SHALL expose closed stale/failed projection evidence for later repair.
