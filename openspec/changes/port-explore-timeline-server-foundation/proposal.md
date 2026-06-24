# Port the explore-timeline server foundation to main

## Why

The live site's fast merged cross-source timeline feed and the Explore over-time
chart run on **deploy-branch-only** server code that was never merged to `main`:
`explore-timeline-substrate.ts` (dual-dialect merged-timeline queries), the
`rs.explore.timeline` operation, the `GET /_ref/explore/records` route, and the
`semantic_time` column plus its `idx_records_semantic_time` /
`idx_pg_records_semantic_time` expression index. On fresh `origin/main` none of
these exist: the records table carries only `emitted_at` (ingest time), and the
only timeline reader is `GET /_ref/records/timeline` (the `ref-records-timeline`
operation), which orders by ingest time rather than authored/semantic time.

This is the server analog of the already-landed frontend foundation port. It
brings the **same semantic-time feed substrate the live site uses** onto `main`,
so `main` orders the merged timeline by when things actually happened (the
manifest-declared semantic field) instead of when they were ingested.

It also unblocks the **separate, later** bucket-aggregate PR (the indexed
over-time-chart `date_trunc/strftime , COUNT(*) GROUP BY`), which depends on the
`semantic_time` column, the expression index, and the substrate's multi-stream
scope plumbing — none of which exist on `main` today. Per the Codex gate, a
migration was discovered necessary, so the foundation must land first as its own
change before the bucket endpoint can build on it. This change is the foundation
port; it does **not** add the bucket-aggregate endpoint.

## What Changes

- Add an additive, idempotent `records.semantic_time` column (`TEXT NOT NULL
  DEFAULT ''`) on both backends, with a dual-dialect migration that runs on a
  pre-existing records table without a bulk `UPDATE`.
- Add the expression keyset index `idx_records_semantic_time` (SQLite) /
  `idx_pg_records_semantic_time` (Postgres) on
  `(connector_instance_id, stream, COALESCE(NULLIF(semantic_time,''), emitted_at) DESC, record_key DESC)`,
  created `IF NOT EXISTS` after the column is guaranteed present.
- Write `semantic_time` at ingest via the record upsert (`ON CONFLICT ... DO
  UPDATE SET semantic_time = excluded.semantic_time`); existing rows are read
  through `COALESCE(NULLIF(semantic_time,''), emitted_at)` so they fall back to
  `emitted_at` until a real value is written. No mass backfill in this change.
- Port `explore-timeline-substrate.ts` and the `rs.explore.timeline` operation
  (k-way merge across `(connector_instance_id, stream)` partitions, ingest-id
  snapshot anchor, semantic-time ordering, dual-dialect deps factory).
- Add `direction=asc` to the merged timeline route so oldest-first paging is a
  server keyset traversal from the genuinely-oldest record, with direction pinned
  in the cursor.
- Mount the reference-only route `GET /_ref/explore/records` that the operator
  console's Explore feed consumes.

## Capabilities

### Modified

- `reference-implementation-architecture` — the reference `_ref` read surface
  gains the explore-timeline merged-feed route; the records storage schema gains
  the additive `semantic_time` column and its expression index on both backends.

## Impact

- Reference server: `reference-implementation/server/db.js`,
  `postgres-storage.js`, `explore-timeline-substrate.ts` (new),
  `operations/rs-explore-timeline/` (new), `server/routes/ref-admin.ts`,
  `queries/records/ingest/upsert-record.sql`, plus dual-dialect substrate tests.
- Storage: one additive column + one expression index per dialect. No protocol
  surface change; `_ref` routes are reference-only artifacts, not core PDPP API.
- Downstream: unblocks the separate bucket-aggregate PR (not in this change).
- The bucket-aggregate / over-time-chart count endpoint is explicitly **out of
  scope** here and lands as its own follow-up change on top of this foundation.
