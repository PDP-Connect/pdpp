## ADDED Requirements

### Requirement: Same-instance writers SHALL share one re-entrant coordinator

Every path that writes authoritative record state or lexical/semantic state for
a connector instance SHALL hold the same opaque, re-entrant instance ownership
capability for its complete durable-plus-derived critical section. This includes
device batches, owner/provider/webhook ingest, direct record/stream/bulk delete,
connection purge, and startup/manifest/drift/repair/operator lexical and
semantic backfills. Nested record/index calls SHALL receive ownership and SHALL
not reacquire it; route-local lookalikes are forbidden.

SQLite SHALL use a keyed single-process coordinator and remove idle entries in
`finally`. PostgreSQL SHALL use one domain-separated collision-safe advisory
key encoding and a separate capped session lock pool. Every path SHALL unlock
in `finally`; uncertain unlock/session integrity SHALL destroy the connection.
Backfills SHALL enumerate instances in stable order, acquire/release one fence
at a time, and never hold multiple instance locks. Different instances may
overlap.

#### Scenario: An old device attempt cannot overwrite a direct writer

- **WHEN** a device attempt and a direct update target the same instance and key
- **THEN** one complete durable-plus-derived section SHALL finish before the other
- **AND** authoritative and every derived final representation SHALL agree

#### Scenario: Advisory capacity cannot starve record work

- **WHEN** PostgreSQL lock acquisition is saturated or a session disconnects
- **THEN** bounded retryable admission or background retry SHALL occur
- **AND** the main record/index pool capacity SHALL not be consumed by lock sessions
