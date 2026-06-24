# Explore merged timeline: order by SEMANTIC time, anchor by ingest id

Status: DESIGN (Claude RI, 2026-06-20). Tim chose "do it right" for the sorting bug
(docs/research/explore-chatgpt-three-bugs-2026-06-20.md bug 2): the merged timeline must
order by each record's SEMANTIC time (when the thing happened), not its INGEST time
(`emitted_at`, ~one value per backfill run). Pagination STABILITY stays anchored on the
monotonic ingest sequence `id` (NOT semantic time, which isn't monotonic).

## The split that makes this correct
- ORDER BY: semantic time DESC (newest conversation/transaction/message first).
- KEYSET SEEK: (semantic_time, record_key) DESC — the cursor position.
- SNAPSHOT MEMBERSHIP: `id <= snapshotSeq` — UNCHANGED. The snapshot anchor stays the
  monotonic ingest sequence so a record ingested after the snapshot can't leak in,
  regardless of its semantic time (a backfilled old conversation has an old semantic time
  but a NEW id, and is correctly excluded). This is why ordering and membership are
  DIFFERENT keys — and why semantic time can't be the snapshot anchor.

## What "semantic_time" is
Per the stream's manifest `consent_time_field` (preferred) then `cursor_field`, extracted
from `record_json`, coerced to an ISO instant — INCLUDING numeric Unix epochs (the
coerceTimestampValue logic just added in search-record-timestamps.ts: seconds <1e12, ms
>=1e12). FALLBACK: when a stream declares no semantic field, or the value is missing/
unparseable, semantic_time = emitted_at (so non-semantic data still sorts sanely and
nothing regresses). So semantic_time is ALWAYS populated (never null).

## The build (incremental, each step tested + reversible)
1. Schema: add `semantic_time TEXT NOT NULL DEFAULT ''` to the `records` table (SQLite +
   Postgres), with an EXPRESSION keyset index that matches the read ORDER BY EXACTLY:
   `(connector_instance_id, stream, (COALESCE(NULLIF(semantic_time,''), emitted_at)) DESC,
   record_key DESC)`. A PLAIN `semantic_time` index does NOT back the COALESCE read
   expression — before the backfill (rows with `''`) the planner would Seq Scan + Sort the
   whole table (proven via PG EXPLAIN). The expression index keeps the hot path index-backed
   both before and after the backfill (re-proven: PG Index Scan / SQLite `SEARCH USING
   INDEX`). Generated column is tempting but the source field is per-stream manifest-driven
   (not a fixed JSON path), so populate it in the INGEST path, not as a DB generated column.
2. Ingest: in records.js ingestRecord, compute semantic_time from the manifest
   consent_time_field/cursor_field of record_json (coerced, epoch-aware), fallback
   emitted_at. Write it alongside emitted_at. (The manifest is already available to the
   ingest path — confirm; it reads consent_time_field elsewhere, records.js:1342.)
3. Backfill: a migration/backfill script that, for every existing row, recomputes
   semantic_time from its record_json + manifest and UPDATEs it. Idempotent, batched,
   resumable (18GB live PG — must be chunked, not one transaction). Until backfilled, a
   row's semantic_time defaults to emitted_at (so the column is NOT NULL from creation).
4. Substrate: explore-timeline-substrate.ts fetchPartitionPage (both backends) — ORDER BY
   semantic_time DESC, record_key DESC; keyset seek on (semantic_time, record_key). The
   PartitionCursorPosition's `lastEmittedAt` becomes `lastSemanticTime` (cursor schema bump
   to v3, OR keep the field name but change its meaning + bump version). Snapshot anchor
   (id <= snapshotSeq) unchanged.
5. Cursor: bump CURSOR_VERSION to 3 (the keyset key changed; v2 cursors must be rejected as
   invalid_cursor so stale tabs re-anchor rather than mis-seek). decode/encode updated.
6. Conformance: the existing rs-explore-timeline-conformance + b1-b2-b3 + rewind tests must
   pass with the new sort; ADD a test proving records ORDER by semantic_time (seed records
   whose semantic time order DIFFERS from their ingest order — e.g. ChatGPT-shaped: ingest
   all at once with varied create_time — and assert the feed is semantic-time-ordered, not
   ingest-ordered). This is the reproduce-the-bug test for "bottom stays at bottom".

## Risk / sequencing (live 18GB Postgres)
- The column add + index is the migration; the backfill is the heavy part (chunked,
  resumable, runs in a declared live-data window). Until backfill completes, semantic_time
  = emitted_at for un-backfilled rows, so the feed is no WORSE than today during rollout.
- The cursor version bump means any open Explore tab's cursor 400s once -> reload. Acceptable.
- The keyset index is essential or deep pagination table-scans. Add it WITH the column.
- DO NOT change the snapshot anchor. Ordering != membership.

## Acceptance
- Merged timeline orders by semantic time; ChatGPT conversations sort by create_time, not
  the backfill clump. The reproduce-the-bug conformance test (semantic order != ingest
  order) passes; fails on the pre-fix emitted_at sort.
- Snapshot stability (b1-b2-b3, rewind) unchanged and green on both backends.
- Streams with no semantic field still sort (fallback to emitted_at) — no regression.
- Live backfill is chunked/resumable; the feed degrades gracefully (emitted_at order) until
  it completes, never worse than today.
