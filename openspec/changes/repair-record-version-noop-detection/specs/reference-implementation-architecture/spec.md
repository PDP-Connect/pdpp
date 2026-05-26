## MODIFIED Requirements

### Requirement: No-op writes do not allocate

The reference implementation SHALL evaluate no-op equivalence against the adapter's stored form in a way that does not depend on incidental layout differences (whitespace, key order) the adapter itself introduces. The SQLite adapter SHALL compare the stored TEXT `record_json` against the inbound serialized payload as a string. The Postgres adapter SHALL compare the stored `jsonb` `record_json` against the inbound payload structurally at the `jsonb` level. Both adapters SHALL satisfy the property that a byte-identical inbound payload following a successful prior ingest of the same payload is treated as a no-op.

When the reference processes a no-op re-ingest, an absent-record delete, or a repeated delete, it SHALL NOT invoke the atomic allocator, SHALL NOT advance `version_counter`, and SHALL NOT append a `record_changes` row.

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

## ADDED Requirements

### Requirement: The reference SHALL expose an owner-only record-derived-field repair tool

The reference implementation SHALL provide an owner-only operational tool that repairs current `records` rows whose payload is byte-equivalent (per the No-op equivalence definition above) to a prior `record_changes` row with strictly more complete derived fields, under a per-stream repair policy that is registered in code.

The tool SHALL refuse to run without an explicit `(connector_instance_id, stream)` scope. It SHALL default to a dry-run mode that prints the records that would be repaired, the prior `record_changes.version` each refill would be sourced from, and the field set each refill would write. It SHALL NOT mutate any row without an explicit `--apply` flag. It SHALL NOT mutate or delete any existing `record_changes` row. It SHALL allocate any repair write through the existing atomic allocator so the repair itself is observable in `record_changes` and `changes_since`.

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
