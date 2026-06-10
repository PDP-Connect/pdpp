## MODIFIED Requirements

### Requirement: Record version allocation SHALL be atomic with the durable mutation

The reference implementation SHALL allocate the next per-`(connector_id, stream)` record version with a single atomic store operation, executed inside the durable record mutation transaction, that simultaneously advances version state and returns the freshly-allocated version. The reference SHALL NOT compute the next version from a separately-observable read of `version_counter` followed by a later write.

This requirement strengthens, but does not weaken, the existing durable record ingest and direct delete atomicity requirements. Lexical, semantic, and disclosure-spine maintenance SHALL remain outside the durable record mutation transaction.

The reference implementation SHALL evaluate no-op equivalence against the adapter's stored form in a way that does not depend on incidental layout differences (whitespace, key order) the adapter itself introduces. The SQLite adapter SHALL compare the stored TEXT `record_json` against the inbound serialized payload as a string. The Postgres adapter SHALL compare the stored `jsonb` `record_json` against the inbound payload structurally at the `jsonb` level. Both adapters SHALL satisfy the property that a byte-identical inbound payload following a successful prior ingest of the same payload is treated as a no-op.

When the reference processes a no-op re-ingest, an absent-record delete, or a repeated delete, it SHALL NOT invoke the atomic allocator, SHALL NOT advance `version_counter`, and SHALL NOT append a `record_changes` row.

#### Scenario: Atomic allocation on first write

- **WHEN** the reference performs the first changed write for a `(connector_id, stream)` pair
- **THEN** the atomic allocator SHALL create the `version_counter` row at `max_version = 1` and return `1` in the same statement
- **AND** the appended `record_changes.version` SHALL equal the returned value

#### Scenario: Atomic allocation on subsequent writes

- **WHEN** the reference performs a subsequent changed write for an existing `(connector_id, stream)` pair
- **THEN** the atomic allocator SHALL advance `version_counter.max_version` by exactly one and return the advanced value in the same statement
- **AND** successive changed writes for the same `(connector_id, stream)` SHALL receive distinct, monotonically increasing versions

#### Scenario: SQLite byte-identical re-ingest

- **WHEN** the SQLite-backed reference receives two successive ingests for the same `(connector_id, stream, record_key)` whose inbound `JSON.stringify(data)` outputs are byte-identical
- **THEN** only the first call SHALL allocate a version and append a `record_changes` row
- **AND** the second call SHALL return `{ accepted: true, changed: false }` without advancing `version_counter`

#### Scenario: Postgres byte-identical re-ingest

- **WHEN** the Postgres-backed reference receives two successive ingests for the same `(connector_id, stream, record_key)` whose inbound `JSON.stringify(data)` outputs are byte-identical
- **THEN** only the first call SHALL allocate a version and append a `record_changes` row
- **AND** the second call SHALL return `{ accepted: true, changed: false }` without advancing `version_counter`
- **AND** the result SHALL NOT depend on whether Postgres' `jsonb` storage canonicalizes whitespace or key order differently from the inbound serialized form

#### Scenario: Repeated delete

- **WHEN** the reference processes a delete for a `(connector_id, stream, record_key)` whose current row is already deleted or absent
- **THEN** it SHALL NOT invoke the atomic allocator
- **AND** `version_counter` SHALL NOT advance
- **AND** `record_changes` SHALL NOT gain a row

#### Scenario: Contiguous change-log sequence

- **WHEN** consumers read `record_changes` for a `(connector_id, stream)` after a sequence of changed and no-op writes
- **THEN** the observed `version` sequence SHALL be contiguous and strictly increasing
- **AND** `changes_since` SHALL observe no gaps and no duplicates relative to `version_counter.max_version`

#### Scenario: Allocation failure rolls back the durable mutation

- **WHEN** the atomic allocation or any subsequent step inside the durable mutation transaction fails
- **THEN** the reference SHALL NOT leave `version_counter` advanced relative to `records` and `record_changes`
- **AND** a later changed write for the same `(connector_id, stream)` SHALL NOT collide with or skip around a partially allocated version

## ADDED Requirements

### Requirement: The reference SHALL expose an owner/operator-only record-derived-field repair tool

The reference implementation SHALL provide an owner/operator-only operational tool that repairs current `records` rows whose payload is byte-equivalent (per the No-op equivalence definition above) — *after removing the policy's registered derived fields from both sides* — to a prior `record_changes` row that carries strictly more complete derived fields, under a per-stream repair policy that is registered in code.

The tool SHALL be authorized by direct database access (`PDPP_DATABASE_URL`), not by an HTTP route or scheduler. It SHALL refuse to run without an explicit `(connector_instance_id, stream)` scope. It SHALL default to a dry-run mode that prints the records that would be repaired, the prior `record_changes.version` each refill would be sourced from, and the field set each refill would write. It SHALL NOT mutate any row without an explicit `--apply` flag. It SHALL NOT mutate or delete any existing `record_changes` row. It SHALL allocate any repair write through the existing atomic allocator so the repair itself is observable in `record_changes` and `changes_since`. It SHALL validate `--limit` (if supplied) as a positive integer and refuse to run otherwise.

The tool SHALL apply an equivalence guard: before treating a prior `record_changes` row as a refill source, the tool SHALL compare the current row's payload to that prior row's payload with every field in the policy's `derivedFields` removed from both sides, using jsonb structural equality. A prior row whose normalised payload is not equal to the current row's normalised payload SHALL NOT be used as a refill source even if some of its derived fields are non-null.

The tool SHALL NOT operate across distinct `(connector_instance_id, stream, record_key)` boundaries. It SHALL NOT operate on streams without a registered repair policy.

#### Scenario: Dry-run preview lists repairable rows

- **WHEN** the operator invokes the repair tool in dry-run mode for a `(connector_instance_id, stream)` scope where some current rows have byte-equivalent prior history with more complete derived fields
- **THEN** the tool SHALL print one preview line per repairable record with the source `record_changes.version` and the field set that would be refilled
- **AND** the tool SHALL NOT change any row, allocate any version, or append any `record_changes` row

#### Scenario: Apply repairs as new versions

- **WHEN** the operator invokes the repair tool with `--apply` against a scope that contains repairable rows
- **THEN** for each repaired record the tool SHALL allocate a new version through the atomic allocator and append exactly one `record_changes` row reflecting the merged derived fields
- **AND** the prior `record_changes` history rows SHALL remain byte-identical

#### Scenario: Repair refuses streams without a policy

- **WHEN** the operator invokes the repair tool against a `(connector_instance_id, stream)` pair whose stream has no registered repair policy
- **THEN** the tool SHALL refuse to run and SHALL exit non-zero with a message naming the missing policy

#### Scenario: Equivalence guard rejects a prior row whose non-derived fields have changed

- **WHEN** the operator runs the repair tool on a record whose current row has null derived fields, but the candidate prior `record_changes` row differs from the current row in some field outside the policy's `derivedFields`
- **THEN** the tool SHALL NOT use that prior row as a refill source
- **AND** if no other candidate prior row satisfies the equivalence guard, the record SHALL be skipped (no version allocated, no `record_changes` row appended)
