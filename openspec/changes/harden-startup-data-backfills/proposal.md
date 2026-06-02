# Harden startup data backfills

## Why

`migratePostgresSpineSourceColumns()` runs on every Postgres-mode boot inside
`initPostgresStorage()`. It opens one transaction, `SELECT`s every row of
`spine_events`, loops in Node deriving a source per row, and runs per-row
`UPDATE`s — all inside that single long-running transaction.

On the owner's 2026-06-02 deployment this scanned ~361k rows and held the
transaction for ~90–120s after "database initialized". While the transaction
was open, owner reads against `spine_events` (runs, dashboard timelines,
spine correlations) blocked behind relation locks.

The backfill cannot converge to "no work" because ~8.9k rows are legitimately
sourceless events (`token.issued`, `request.submitted`, `consent.approved`,
`disclosure.served`, …) whose `actor_type` is `subject`/`client`/
`authorization_server`/`reference`. `deriveSpineSource()` correctly returns
`null` for them, so they stay NULL and the full-table scan repeats every boot
for zero steady-state writes.

The denormalized `spine_events.source_kind`/`source_id` columns are a
query-acceleration cache, not the source of truth: the read path
recovers the source from canonical event payloads or runtime actor fallback
when the columns are NULL. The same unbounded backfill exists in the SQLite path
(`migrateSpineSourceColumns` in
`reference-implementation/server/db.js`); it is far less harmful there
(embedded, single-process) but is still an unbounded boot scan with a dead
`user_version` write that gates nothing.

## What Changes

- Keep the cheap, bounded, idempotent **schema DDL** at boot: add
  `source_kind`/`source_id`, drop the legacy `provider_id` column, create the
  `(source_kind, source_id, …)` index. These remain in `initPostgresStorage()`
  and the SQLite migration runner.
- **Remove the unbounded per-row source backfill from boot** on both backends.
  Boot no longer scans or updates the full `spine_events` table.
- Add an explicit, operator-run, bounded, resumable maintenance script
  `backfill-spine-source` that fills the remaining NULL `source_*` rows in
  small short-transaction batches (`WHERE source_kind IS NULL`), reusing the
  canonical `deriveSpineSource()` derivation. Dry-run by default; `--apply`
  performs writes. It reports how many remaining rows are unresolvable
  (genuinely sourceless) rather than looping over them forever.
- Establish a durable reference-architecture requirement that normal
  startup performs only bounded idempotent schema migrations and never a
  full-table data backfill that holds a long transaction or reader-blocking
  locks.

Read behavior is unchanged for source-unfiltered correlation summaries: they
derive source from canonical event payloads or runtime actor fallback, so
leaving legacy `source_*` columns NULL does not make dashboard summaries
dishonest. The read affected by NULL columns — a source-*filtered* correlation
query for legacy rows — is documented as a known, operator-repairable limitation
rather than something boot silently papers over.

## Capabilities

### Modified

- `reference-implementation-architecture` — adds a startup-migration boundary
  requirement (bounded idempotent DDL at boot; large data backfills are
  explicit operator maintenance).

## Impact

- `reference-implementation/server/postgres-storage.js` — split schema DDL from
  the row backfill; boot keeps DDL only; export `deriveSpineSource`.
- `reference-implementation/server/db.js` — same split for SQLite; drop the
  dead `user_version` write or move it to gate the DDL.
- `reference-implementation/scripts/backfill-spine-source/` — new maintenance
  script (Postgres and SQLite), dry-run default, batched, resumable.
- New focused tests proving normal Postgres startup runs no unbounded source
  backfill when columns already exist, and that the maintenance script
  converges and leaves genuinely-sourceless rows untouched.
- Operators with large `spine_events` tables and NULL legacy `source_*` rows
  run `backfill-spine-source --apply` once if they want source-filtered spine
  correlations to include legacy rows. No action is required for correct
  unfiltered reads.
