# reference-implementation-architecture (delta)

## ADDED Requirements

### Requirement: Startup migrations are bounded and large data backfills are explicit maintenance

Normal reference startup SHALL perform only bounded, idempotent schema
migrations. This covers both Postgres-mode startup and the SQLite migration
runner. Startup SHALL NOT run an unbounded full-table data backfill, and SHALL
NOT hold a long-running transaction or a table-level lock that blocks owner
reads of runtime tables such as `spine_events`.

Bounded idempotent schema work is permitted at startup: adding columns,
creating indexes, dropping superseded columns, and replacing constraints, as
long as each step is `IF NOT EXISTS`/guarded and does not scan-and-rewrite an
entire large runtime table.

Backfilling derived or denormalized values across an existing large runtime
table SHALL be one of: (a) an explicit operator maintenance script run off the
boot path, or (b) a tiny, capped, non-blocking batch at boot that uses short
transactions, makes progress without holding reader-blocking locks, and never
loops over rows it cannot resolve. Option (a) is the default for the disclosure
spine source columns.

Denormalized cache columns SHALL NOT be treated as the source of truth. When a
denormalized column (such as `spine_events.source_kind`/`source_id`) is NULL
for legacy rows, reads that do not filter on that column SHALL still return
correct results by deriving the value from the canonical payload
(`spine_events.data_json`). Dashboards and unfiltered correlation/timeline reads
SHALL remain honest when legacy denormalized columns are NULL.

#### Scenario: Normal Postgres startup does not backfill the spine table

- **WHEN** the reference boots in Postgres mode against a database whose
  `spine_events` table already has the `source_kind` and `source_id` columns
- **THEN** startup SHALL NOT issue a full `SELECT` of every `spine_events` row
  and SHALL NOT issue per-row `UPDATE spine_events SET source_kind …`
- **AND** startup SHALL complete without holding a transaction that blocks
  concurrent owner reads of `spine_events`

#### Scenario: Startup still applies bounded schema DDL

- **WHEN** the reference boots against a database whose `spine_events` table
  lacks the `source_kind`/`source_id` columns or the source index
- **THEN** startup SHALL add the columns and create the source index
  idempotently
- **AND** startup SHALL drop a superseded `provider_id` column if present,
  without scanning and rewriting the full table for value backfill

#### Scenario: Source backfill is explicit, bounded, and resumable

- **WHEN** an operator runs the spine-source backfill maintenance script
- **THEN** it SHALL default to dry-run, require direct database access
  (`PDPP_DATABASE_URL` or `PDPP_TEST_POSTGRES_URL`) as its authorization, and
  apply writes only with an explicit `--apply` flag
- **AND** it SHALL select only rows whose source columns are NULL, process them
  in bounded batches each in its own short transaction, be safe to re-run, and
  report the count of genuinely-sourceless rows it leaves unresolved rather than
  reprocessing them on every run

#### Scenario: Reads derive source for NULL legacy rows

- **WHEN** a `spine_events` row has NULL `source_kind`/`source_id` columns but a
  resolvable source in its `data_json` payload
- **THEN** a correlation or timeline read that does not filter on source SHALL
  still surface the correct source for that row
- **AND** any limitation of source-*filtered* reads over not-yet-backfilled
  legacy rows SHALL be a documented, operator-repairable condition rather than a
  behavior that startup silently changes
