# reference-implementation-architecture — port-explore-timeline-server-foundation delta

## ADDED Requirements

### Requirement: Records carry an additive semantic-time column with a lazy backfill

The reference records storage SHALL carry a `semantic_time` column on the
`records` table on both the SQLite and Postgres backends, declared
`TEXT NOT NULL DEFAULT ''`. The column SHALL be added on a pre-existing,
possibly non-empty records table by an idempotent migration that performs no
bulk `UPDATE` of existing rows: on SQLite via a guarded
`ALTER TABLE records ADD COLUMN semantic_time TEXT NOT NULL DEFAULT ''` (guarded
by a `hasTableColumn` check), and on Postgres via
`ALTER TABLE records ADD COLUMN IF NOT EXISTS semantic_time TEXT NOT NULL DEFAULT ''`.
Existing rows SHALL retain `''` and SHALL be read through
`COALESCE(NULLIF(semantic_time, ''), emitted_at)`, so a row without a real
semantic value falls back to its `emitted_at` and is never mis-attributed. New
and re-emitted rows SHALL receive a real `semantic_time` at write time via the
record upsert (`ON CONFLICT ... DO UPDATE SET semantic_time = excluded.semantic_time`).
Re-running the migration SHALL be a no-op on both backends.

#### Scenario: The semantic-time migration runs on a non-empty database

- **WHEN** the reference server boots against a records table that already holds
  rows and does not yet have a `semantic_time` column
- **THEN** the migration SHALL add `semantic_time TEXT NOT NULL DEFAULT ''`
  without issuing a bulk `UPDATE` over existing rows
- **AND** existing rows SHALL hold `''` for `semantic_time` after the migration
- **AND** re-running the migration on a database that already has the column
  SHALL be a no-op on both the SQLite and Postgres backends

#### Scenario: Pre-migration rows fall back to emitted_at

- **WHEN** the merged-timeline read orders records and a row's `semantic_time`
  is `''`
- **THEN** that row SHALL be ordered by `COALESCE(NULLIF(semantic_time, ''), emitted_at)`,
  i.e. by its `emitted_at`, exactly as before the column existed
- **AND** a row whose `semantic_time` holds a real value SHALL be ordered by that
  value instead

#### Scenario: A new write populates semantic_time without rewriting history

- **WHEN** the reference runtime upserts a record whose manifest declares a
  semantic time field
- **THEN** the upsert SHALL set `semantic_time` for that row (via
  `ON CONFLICT ... DO UPDATE SET semantic_time = excluded.semantic_time`)
- **AND** the write SHALL NOT rewrite the `semantic_time` of unrelated
  historical rows

### Requirement: The records table is indexed for the semantic-time merged-timeline read

The reference records storage SHALL provide an expression index over the exact
merged-timeline ordering key so the read stays index-backed before any
per-record semantic backfill. On SQLite the index SHALL be
`idx_records_semantic_time` and on Postgres `idx_pg_records_semantic_time`, each
over
`(connector_instance_id, stream, (COALESCE(NULLIF(semantic_time, ''), emitted_at)) DESC, record_key DESC)`.
Each index SHALL be created `IF NOT EXISTS` and only after the `semantic_time`
column is guaranteed present (not in the inline `CREATE TABLE` schema block,
where the column may not yet exist on a pre-existing table). The index SHALL
match the read `ORDER BY` exactly so the merged-timeline query is served by an
index scan rather than a full scan plus sort.

#### Scenario: The merged-timeline read is index-backed before any backfill

- **WHEN** the merged-timeline read executes its
  `ORDER BY COALESCE(NULLIF(semantic_time, ''), emitted_at) DESC, record_key DESC`
  query against the Postgres backend before any semantic backfill has run
- **THEN** the query SHALL be served by `idx_pg_records_semantic_time` as an
  index scan with no sort step
- **AND** the equivalent SQLite read SHALL be served by
  `idx_records_semantic_time` over the same expression key

### Requirement: The reference exposes a semantic-time merged cross-source timeline read surface

The reference implementation SHALL expose a reference-only read surface that
returns a merged cross-source timeline of the owner's records ordered by
semantic time. The route SHALL be `GET /_ref/explore/records`, backed by the
`rs.explore.timeline` operation and a dual-dialect substrate
(`buildExploreTimelineDeps()` dispatching to a SQLite or Postgres
implementation). The feed SHALL k-way merge across every
`(connector_instance_id, stream)` partition with no partition cap, so every
record is reachable. Paging the returned cursor forward SHALL yield records of
strictly non-increasing semantic time
(`COALESCE(NULLIF(semantic_time, ''), emitted_at)`) with no duplicates. The
cursor SHALL anchor membership and pagination to the monotonic ingest sequence
(`MAX(id)`) captured at first-page time, so records ingested after the snapshot
(including backfilled rows with an old `emitted_at`) do not appear in
already-returned pages and are instead surfaced as a `new_since_snapshot` count.
Each returned record SHALL carry both `connector_id` (the connector type) and
`connector_instance_id` (the connection instance). This surface SHALL remain a
reference-only `_ref` read artifact rather than a core PDPP protocol API.

This requirement does not add a time-bucketed aggregate (over-time-chart count)
endpoint; that is a separate later change that builds on this foundation.

#### Scenario: A merged feed is requested across multiple sources

- **WHEN** a caller requests `GET /_ref/explore/records` for an owner whose
  records span multiple `(connector_instance_id, stream)` partitions
- **THEN** the response SHALL return a single page of records merged across all
  partitions ordered by `COALESCE(NULLIF(semantic_time, ''), emitted_at)` DESC,
  plus one opaque `next_cursor`
- **AND** each record SHALL carry both its `connector_id` and its
  `connector_instance_id`
- **AND** no partition SHALL be silently dropped by a cap

#### Scenario: Paging forward is stable, ordered, and non-duplicated

- **WHEN** the caller pages the merged feed forward using the returned cursor
- **THEN** subsequent pages SHALL yield strictly non-increasing semantic time
  with no duplicate records
- **AND** a record ingested after the first-page snapshot SHALL NOT appear in an
  already-returned page and SHALL instead be reflected in `new_since_snapshot`

#### Scenario: A stale or unknown cursor handle is rejected cleanly

- **WHEN** the caller presents a cursor handle that is stale, expired, or unknown
  to the server-side cursor store
- **THEN** the operation SHALL resolve the handle to null and return a typed
  `invalid_cursor` 400 rather than serving a corrupt or partial page

#### Scenario: Both backends conform to identical merged-feed behavior

- **WHEN** the dual-backend substrate conformance harness seeds the same records
  and runs the merged-timeline read against the SQLite substrate and a real
  Postgres substrate
- **THEN** both SHALL return identical observable ordering, cursor paging,
  `new_since_snapshot` counts, uncapped partition coverage, and dual identities
