## ADDED Requirements

### Requirement: Record persistence SHALL expose durable and derived seams

The reference SHALL retain one backend-specific authoritative record transaction
whose durable outcome reports accepted/changed/no-op and, for a changed result,
the allocated version to the internal notification-composition seam. HTTP ingest
outcomes SHALL NOT expose that internal version. Its atomic unit remains record/tombstone state,
version allocation, history pruning, and existing transaction deltas. The device
route owns the compact final-input plan (including duplicate-key collapse) and
passes the authoritative record payload to the derived seam; the durable seam
does not add a per-input descriptor or cross-layer immutable plan object.
Postgres retained-size/disclosure dirty-repair behavior remains post-commit.

`maintainRecordIndexes` SHALL idempotently consume final committed state plus
the immutable plan without allocating record versions. Compatibility
`ingestRecord` SHALL compose existing durable behavior, projections, derived
maintenance, and best-effort notification for non-device callers.

#### Scenario: A derived failure preserves authoritative completion

- **WHEN** index maintenance fails after a record transaction commits
- **THEN** the authoritative transaction SHALL remain committed
- **AND** reserved device replay SHALL repair the derived final state without
  allocating a version for an already committed prefix

### Requirement: Accepted device ingest SHALL be backend-parity constrained

SQLite and PostgreSQL SHALL have equivalent public accepted, replay, conflict,
retryable failure, cursor, version, final-index, notification-attempt, and
safe-diagnostic behavior. The route SHALL not branch on store backend. Strict
OpenSpec validation plus deterministic SQLite and real-Postgres conformance,
crash/failure, direct-table, and privacy checks are required before acceptance.

#### Scenario: A backend conformance check observes the same reservation result

- **WHEN** the same canonical batch, conflict, partial prefix, and retry are
  exercised against SQLite and real PostgreSQL
- **THEN** both SHALL expose the same public outcome and final durable/index state
