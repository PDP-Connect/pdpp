## Context

`withConnectorInstanceWrite` establishes ordering, but it cannot prove that a
connection remains writable after a delete or revoke has committed. The
admission read must share the durable transaction with the mutation it admits.

## Decision

`ingestRecord` accepts an opt-in `requireConnectionAdmission` option. Omitted
callers preserve connector-agnostic storage behavior. The owner record-ingest
route opts in only after resolving a concrete connector instance.

SQLite reads lifecycle status inside its synchronous write transaction.
PostgreSQL reads the row with `FOR UPDATE` inside its write transaction, so a
concurrent lifecycle update or delete has one serial order with the record
write. Both backends reject a missing row as `connector_instance_not_found`
and a revoked row as `connector_instance_not_writable`. The owner NDJSON
batch route keeps its established behavior: it reports either failure as a
rejected line in its HTTP 200 `{ records_accepted, records_rejected, errors }`
envelope. This change does not add a public error-status mapping for these
per-line failures.

`active` and `draft` remain writable because first successful ingest activates
a draft connection. `paused` remains a scheduler policy, not a write-admission
state.

## Out of Scope

- Blob, state, webhook, and device-exporter write paths.
- Changing the Collection Profile protocol surface.
- Derived-index or UAT work.

## Acceptance Checks

- SQLite proves delete-first writes cannot create records.
- SQLite proves a revoke between an early check and transaction start is
  refused.
- A dedicated local PostgreSQL lane proves the equivalent revoke race.
- Existing non-opt-in callers still ingest without a connector-instance row.
