# Design — port the explore-timeline server foundation to main

## Context

`main` already has the dual-dialect storage plumbing this port needs — the
`storage-backend.js` abstraction, `isPostgresStorageBackend()`, the `records`
table, the `emitted_at` column, and `idx_records_lookup`. What it lacks is the
**semantic-time** layer: the `semantic_time` column, its expression index, the
`explore-timeline-substrate.ts` merged-timeline queries, the `rs.explore.timeline`
operation, and the `GET /_ref/explore/records` route. Those live only on the
deploy branch, so the live fast feed runs on un-merged server code. This change
ports that layer onto `main` verbatim in contract.

The bucket-aggregate over-time-chart endpoint depends on this layer (the
expression index and the substrate's scope plumbing). Per the Codex gate, when a
migration is discovered necessary the build stops and re-gates; it was, so the
foundation lands first as its own change and the bucket endpoint builds on it
later. **No bucket-aggregate requirement appears in this change.**

## Migration safety rationale

The whole point of this design is that the migration is **safe to run against a
live, multi-million-row records table at boot** — no lock-bloat, no mass rewrite,
no assumption of an empty database, and identical semantics across SQLite and
Postgres.

### 1. `semantic_time` is an ADDITIVE column

The column is `TEXT NOT NULL DEFAULT ''`. Adding it is metadata-only on both
engines (no per-row rewrite, because the default is a constant empty string, not
a computed expression). It does not touch any existing column, index, or
constraint, and nothing reads it as authoritative until a real value is written.

### 2. The migration is IDEMPOTENT and does not assume an empty DB

- SQLite: `migrateRecordSemanticTimeColumn(raw)` guards with
  `hasTableColumn(raw, 'records', 'semantic_time')` and only then runs
  `ALTER TABLE records ADD COLUMN semantic_time TEXT NOT NULL DEFAULT ''`.
  The inline `CREATE TABLE IF NOT EXISTS records (...)` schema is a no-op on a
  pre-existing table, so the `ALTER` (not the table DDL) is what adds the column
  on an already-populated database.
- Postgres: `ALTER TABLE records ADD COLUMN IF NOT EXISTS semantic_time TEXT NOT
  NULL DEFAULT ''`.
- Re-running the migration on a DB that already has the column is a no-op on both
  backends. The migration is correct whether the records table is empty or holds
  millions of rows.

### 3. Backfill is LAZY — no bulk UPDATE of records

- The read path COALESCEs: `COALESCE(NULLIF(semantic_time, ''), emitted_at)`.
  Existing rows keep `''`, so they fall back to `emitted_at` and the merged
  timeline sort is **no worse than the prior `emitted_at` order** until real
  semantic values land. This is the honesty guarantee: pre-migration rows are not
  mis-attributed; they sort exactly as they did before.
- New and re-emitted rows get a real `semantic_time` at write time via the upsert
  (`ON CONFLICT(connector_instance_id, stream, record_key) DO UPDATE SET ...
  semantic_time = excluded.semantic_time`). No batch job rewrites old rows in
  this change; a chunked per-record semantic backfill (Step B) is deliberately
  out of scope and can run later without changing this contract.
- This keeps the boot migration `O(1)` against the live table — the documented
  reason for `DEFAULT ''` over a computed default or a mass `UPDATE`.

### 4. The keyset index is an EXPRESSION index matching the read ORDER BY EXACTLY

- The merged-timeline read sorts by `COALESCE(NULLIF(semantic_time, ''),
  emitted_at) DESC, record_key DESC`. A plain `semantic_time` index does **not**
  back that expression, so the planner would seq-scan + sort the whole records
  table on every page. The index is therefore an **expression index** over the
  exact `COALESCE(NULLIF(...))` ordering key.
- Created `IF NOT EXISTS` and only **after** the column is guaranteed present
  (the inline schema block intentionally does not create it, because on a
  pre-existing table the `semantic_time` column may not exist yet and a
  `CREATE INDEX` referencing it would fail with `no such column`). It is created
  in the post-migration index block.
- Dual-dialect: SQLite `idx_records_semantic_time`, Postgres
  `idx_pg_records_semantic_time`. Both index the same expression key. The
  Postgres expression index is verified via `EXPLAIN` to produce an Index Scan
  with no Sort on the hot path **before** any backfill.

### 5. Dual-dialect throughout

Every piece is implemented for both SQLite and Postgres: the column add, the
expression index, the upsert write, and the substrate read deps
(`sqliteExploreTimelineDeps` / `postgresExploreTimelineDeps`, dispatched by
`buildExploreTimelineDeps()`). The substrate speaks directly to storage and uses
only parameterized placeholders for values; column/table names come from the
fixed schema. Dual-backend substrate tests pin parity.

## Merged-timeline contract (ported verbatim)

- k-way merge across all `(connector_instance_id, stream)` partitions, **no
  partition cap** (every record reachable — a silent cap would violate the
  feed's full-visibility contract).
- The composite cursor anchors to `MAX(id)` (the monotonic ingest sequence) at
  first-page time, so records backfilled with an old `emitted_at` after the
  snapshot do not leak into already-returned pages; they are surfaced via
  `new_since_snapshot` instead. Membership/pagination stays anchored on the
  monotonic id; only the **sort** uses semantic time.
- Paging forward yields strictly non-increasing semantic time with no duplicates;
  each record carries both `connector_id` (type) and `connector_instance_id`
  (instance). The O(partition-count) cursor blob is held server-side behind a
  short opaque handle (URL-length / HTTP 431 avoidance), unchanged from deploy.

## Alternatives considered

- **Bucket on `emitted_at` on main today** (avoid `semantic_time`/substrate
  entirely): rejected. `emitted_at` is ingest time, so the feed and any future
  chart would mis-attribute records to ingest dates rather than authored dates —
  an honesty problem (the chart would not match the feed's semantic-time
  grouping). Sub-SLVP; this is why the migration is necessary.
- **Bundle the bucket endpoint into this PR**: rejected. Mixing foundation with
  a new feature violates the semantic-boundary rule; the bucket aggregate gets
  its own change on top of this foundation.

## Direction follow-on

`direction=asc` is the server half of the Explore sort cell. It is a real
keyset traversal over the same semantic-time key, not a reversal of one loaded
page. The substrate flips the partition seek predicate and `ORDER BY` for both
SQLite and Postgres. The operation flips the k-way merge comparator and stores
the direction in the composite cursor, so every page of an oldest-first walk
continues ascending from the same snapshot. The existing `nowCeiling` clamp stays
in force in both directions; future records remain in the Upcoming projection.

## Out of scope

- The bucket-aggregate / over-time-chart count endpoint (separate, later change).
- Any chunked per-record semantic backfill (Step B) of historical rows.
- Frontend consumption / chart wiring (separate frontend change).

## Acceptance checks

- Both backends: adding the column is idempotent (re-running the migration is a
  no-op) and works on a non-empty records table without a bulk `UPDATE`.
- Both backends: the expression index exists after migration; Postgres `EXPLAIN`
  of the merged-timeline read shows an Index Scan, no Sort.
- A row with `semantic_time = ''` sorts by `emitted_at`; a row with a real
  `semantic_time` sorts by that value (COALESCE fallback proven).
- New writes set `semantic_time` via the upsert; no historical row is rewritten.
- `GET /_ref/explore/records` returns a merged cross-source feed ordered by
  semantic time with a composite/handle cursor; paging forward is strictly
  non-increasing, non-duplicated, and uncapped across partitions.
- Dual-backend substrate conformance tests pass.
- `openspec validate port-explore-timeline-server-foundation --strict` passes.
