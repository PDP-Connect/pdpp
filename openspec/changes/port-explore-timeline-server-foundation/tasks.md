# Tasks — port the explore-timeline server foundation to main

## 1. SQLite migration: additive `semantic_time` column + expression index

- [x] 1.1 Add `semantic_time TEXT NOT NULL DEFAULT ''` to the inline `records`
      `CREATE TABLE IF NOT EXISTS` schema in `server/db.ts` (with the
      semantic-time comment explaining COALESCE fallback).
- [x] 1.2 Add `migrateRecordSemanticTimeColumn(raw)` guarded by
      `hasTableColumn(raw, 'records', 'semantic_time')` that runs
      `ALTER TABLE records ADD COLUMN semantic_time TEXT NOT NULL DEFAULT ''` on a
      pre-existing table; verify it is a no-op on a DB that already has it.
- [x] 1.3 In the post-migration index block (after the column is guaranteed
      present), create
      `CREATE INDEX IF NOT EXISTS idx_records_semantic_time ON records(connector_instance_id, stream, (COALESCE(NULLIF(semantic_time, ''), emitted_at)) DESC, record_key DESC)`.
      Do NOT create it in the inline schema block (column may not exist yet).

## 2. Postgres migration: additive `semantic_time` column + expression index

- [x] 2.1 Add `semantic_time TEXT NOT NULL DEFAULT ''` to the Postgres `records`
      table definition in `server/postgres-storage.ts`.
- [x] 2.2 Run `ALTER TABLE records ADD COLUMN IF NOT EXISTS semantic_time TEXT
      NOT NULL DEFAULT ''` in the migration block (idempotent, O(1), no mass
      UPDATE).
- [x] 2.3 Create the expression index
      `CREATE INDEX IF NOT EXISTS idx_pg_records_semantic_time ON records(connector_instance_id, stream, (COALESCE(NULLIF(semantic_time, ''), emitted_at)) DESC, record_key DESC)`
      after the column is present.

## 3. Ingest write path (both dialects)

- [x] 3.1 Add `semantic_time` to the `INSERT` column list and the
      `ON CONFLICT ... DO UPDATE SET semantic_time = excluded.semantic_time` in
      `queries/records/ingest/upsert-record.sql`.
- [x] 3.2 Wire the record write to derive `semantic_time` (manifest
      consent_time_field / cursor_field, coerced ISO, falling back to
      `emitted_at` when absent/unparseable) on both backends; do NOT rewrite
      historical rows.

## 4. Port `explore-timeline-substrate.ts`

- [x] 4.1 Add `server/explore-timeline-substrate.ts` implementing
      `ExploreTimelineDependencies` for SQLite (`sqliteExploreTimelineDeps`) and
      Postgres (`postgresExploreTimelineDeps`), dispatched by
      `buildExploreTimelineDeps()`; reads ordered by
      `COALESCE(NULLIF(semantic_time, ''), emitted_at) DESC, record_key DESC`.
- [x] 4.2 Port the server-side composite-cursor store (short opaque handle for
      the O(partition-count) blob; stale/expired/unknown handle → typed
      `invalid_cursor` 400).
- [x] 4.3 Keep the storage boundary: substrate speaks only to storage,
      parameterized value placeholders only, fixed column/table names.

## 5. Port the `rs.explore.timeline` operation

- [x] 5.1 Add `operations/rs-explore-timeline/index.ts` with the k-way merge
      across `(connector_instance_id, stream)` partitions, NO partition cap,
      `MAX(id)` ingest-sequence snapshot anchor, `new_since_snapshot` count.
- [x] 5.2 Return both `connector_id` (type) and `connector_instance_id`
      (instance) on every record; one opaque `next_cursor`.

## 6. Mount the reference-only route

- [x] 6.1 Mount `GET /_ref/explore/records` in `server/routes/ref-admin.ts` using
      `buildExploreTimelineDeps()` + `executeExploreTimeline`.
- [x] 6.2 Keep it documented as a reference-only `_ref` read surface (not core
      PDPP API).

## 7. Tests (dual-dialect)

- [x] 7.1 Migration tests: column add is idempotent and works on a NON-EMPTY
      records table with no bulk UPDATE; expression index exists after migration
      (both backends).
- [x] 7.2 COALESCE fallback: a `''` row sorts by `emitted_at`; a real
      `semantic_time` row sorts by that value.
- [ ] 7.3 Postgres `EXPLAIN` of the merged-timeline read shows Index Scan, no
      Sort, before any backfill. NOT YET PROVEN as of 2026-07-30: no test file
      asserts a Postgres `EXPLAIN` plan for the semantic-time expression index
      (grepped all of `reference-implementation/test/` for `EXPLAIN`; only
      unrelated connector-identity-page-filter tests use it). Genuine gap, not
      stale tracking — leave unchecked until such a test exists.
- [x] 7.4 Substrate conformance: SQLite and Postgres return identical merged-feed
      observable results (ordering, cursor paging, `new_since_snapshot`,
      uncapped partitions, both identities). Proven by
      `test/rs-explore-timeline-conformance.test.ts` (`assertConformance`,
      `assertScopedConformance`), gated on `PDPP_TEST_POSTGRES_URL` for the
      Postgres leg.
- [ ] 7.5 Route test: `GET /_ref/explore/records` returns the merged feed with a
      handle/cursor; paging is strictly non-increasing semantic time, no
      duplicates, every partition reachable. NOT YET PROVEN as of 2026-07-30:
      existing coverage calls `executeExploreTimeline` directly (operation
      level), and `test/ref-admin-routes.test.ts` does not exercise the
      `/_ref/explore/records` route at all. No HTTP-level route test found —
      genuine gap, leave unchecked.

## 8. Validation

- [ ] 8.1 `tsc` clean; full reference-implementation suite green (dual-backend).
      `tsc --noEmit` verified clean at SHA `1392a386ffc85173fff9df0dade29558bdc24dda`
      plus this change's additions (2026-07-30). The full dual-backend suite
      was intentionally NOT run in this lane (scope excludes broad-suite runs;
      only the new/touched focused tests were run) — leave unchecked until a
      full-suite run confirms it.
- [x] 8.2 `openspec validate port-explore-timeline-server-foundation --strict`
      passes. Verified 2026-07-30.
- [x] 8.3 `openspec validate --all --strict` passes. Verified 2026-07-30
      (91/91 items green).

## Acceptance checks

- On a non-empty SQLite DB and a non-empty Postgres DB, boot runs the migration
  with no bulk `UPDATE`, adds the column idempotently, and creates the expression
  index; re-running boot is a no-op.
- `GET /_ref/explore/records` orders the merged cross-source feed by
  `COALESCE(NULLIF(semantic_time, ''), emitted_at)`; pre-migration rows fall back
  to `emitted_at` and are not mis-attributed.
- No bucket-aggregate endpoint is introduced by this change (out of scope).

## 9. Follow-on: server oldest-first direction

- [x] 9.1 Add `direction=asc` support to `rs.explore.timeline` and carry the
      direction inside the composite cursor so every page of one traversal uses
      the same keyset direction.
- [x] 9.2 Flip both SQLite and Postgres partition seek predicates and `ORDER BY`
      clauses for `direction=asc`, while preserving the `nowCeiling` past/future
      clamp.
- [x] 9.3 Parse `direction=asc` on `GET /_ref/explore/records`; default all other
      values to newest-first (`desc`).
- [x] 9.4 Add `rs-explore-timeline-oldest-ascending.test.js` proving oldest-first
      pages from the genuinely-oldest record across partitions to the end without
      client reversal.
