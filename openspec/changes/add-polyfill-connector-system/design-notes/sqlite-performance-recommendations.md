# SQLite performance recommendations for the reference runtime

**Status:** implemented 2026-04-19 (the owner authorized optimistic config change)
**Raised:** 2026-04-19
**Trigger:** the Claude Code ingest wrote 9.8 GB to disk from 2.2 GB of source jsonl. 4.5× write amplification. Observed rate ~1 MB/s sustained. This was ~10× slower than it should be for a single-writer workload.

## What landed

- `reference-implementation/server/db.js` — file-backed `initDb` now sets WAL, synchronous=NORMAL, temp_store=MEMORY, mmap_size=256 MB, cache_size=64 MB. In-memory paths untouched (WAL doesn't apply).
- `reference-implementation/runtime/index.js` — `BATCH_SIZE` default bumped from 50 → 500, overridable via `PDPP_RUNTIME_BATCH_SIZE`.
- Currently-running ingests (Claude Code / Codex) don't benefit — their DBs opened with old pragmas. Next orchestrator invocation will pick up the faster config.

## Root cause analysis

Current config (`reference-implementation/server/db.js`):

- Default journal mode is `DELETE` (not `WAL`) — every COMMIT rewrites a journal file
- Default `synchronous=FULL` — two fsyncs per commit
- `@databases/sqlite` opens one connection; no per-table bulk-insert pragmas
- Runtime batch size is 50 records per `/v1/ingest` call (runtime/index.js:420)
- Each batch flush emits a `spine_events` row — double-writes per batch

## Recommendations (in priority order)

### 1. Enable WAL mode (biggest win, ~10× speedup on write-heavy workloads)

In `initDb()`, immediately after `db = createDatabase(path)`:

```js
await db.query(sql`PRAGMA journal_mode = WAL`);
await db.query(sql`PRAGMA synchronous = NORMAL`);
await db.query(sql`PRAGMA temp_store = MEMORY`);
await db.query(sql`PRAGMA mmap_size = 268435456`);  // 256 MB
await db.query(sql`PRAGMA cache_size = -65536`);     // 64 MB cache (negative = KiB)
```

Durability trade-off: `synchronous=NORMAL` with WAL fsyncs the WAL file at checkpoint, not every commit. A power loss between commit and checkpoint can lose the last ~second of writes. For personal-server workloads this is acceptable; if not, keep `synchronous=FULL` and accept a smaller speedup.

### 2. Increase runtime batch size

`runtime/index.js:420` → `const BATCH_SIZE = 500;` (was 50).

Batch size of 50 meant ~220 round-trips per 11k-record file. At 500, it's ~22. This is a Node<->SQLite micro-optimization; the real cost is the per-batch HTTP round trip over localhost when using the embedded orchestrator. Bigger batches amortize that cost.

### 3. Consider dropping per-batch spine_events

Every `flushBatch` inserts a `spine_events` row (`run.batch_ingested`). For a large ingest this doubles write volume. Options:

- Aggregate: one spine_events row per run-completion rather than per batch
- Move spine_events to a separate DB file (attached) so its writes don't contend with `records` WAL
- Make it opt-in via a `spine_granularity` config

### 4. Run `PRAGMA optimize` at connection close

```js
await db.query(sql`PRAGMA optimize`);
```

Tells SQLite to update stats based on actual query patterns; next open benefits.

### 5. Consider prepared statement reuse

`@databases/sqlite` prepares each `db.query(sql\`…\`)` call. For hot paths (every INSERT into `records`), a cached prepared statement would avoid re-parsing. This is a library-level concern; may require switching from `@databases/sqlite` to `node:sqlite` or `better-sqlite3` where prepared-statement caching is explicit.

## What the impact would be on today's workload

Claude Code ingest at ~1 MB/s → 10 MB/s = same data in 15 minutes instead of 2.5 hours. Codex similarly.

## Why we're not doing this today

1. `db.js` is owned by the reference-implementation track; changing it mid-ingest would break live writers.
2. The speedup is irrelevant to correctness — we're just slower than we could be.
3. Proper fix belongs with the runtime/reference agent who can adjust tests + durability-mode trade-offs deliberately.

## Action items for the runtime agent

- [ ] Add WAL pragmas to `initDb`
- [ ] Bump `BATCH_SIZE` to 500 (or make it configurable via env)
- [ ] Decide spine_events granularity policy
- [ ] Add a perf regression test with a known-size fixture so write amplification is visible in CI

## Related

- `rs-storage-topology-open-question.md` — topology choice interacts with WAL (WAL doesn't federate across attached DBs cleanly)
- `connector-configuration-open-question.md` — `BATCH_SIZE` is a tuning knob; belongs in the options surface we're proposing
