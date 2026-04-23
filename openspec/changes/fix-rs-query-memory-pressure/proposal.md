## Why

The reference server crashes (SIGSEGV) under concurrent dashboard load. We have a frozen reproduction (`repro-crash.sh` on branch `repro/scavenger-crash-2026-04-23`, against a 3.3 GB SQLite snapshot) that crashes non-deterministically within 1–10 rounds of hitting `/dashboard/records`, `/dashboard/search`, and `/planning/changes` concurrently. 2-of-2 early runs: one survived 10 rounds, one crashed on round 9. The crash signature is `SIGSEGV` inside V8's parallel scavenger (`v8::internal::HeapObject::SizeFromMap`) during a `better-sqlite3` result marshaling call.

We investigated and ruled out three hypotheses:

- **Driver bug.** Reproduces on both `sqlite3@5.1.7` (legacy async) and `better-sqlite3@12.9.0` (synchronous). Not driver-specific.
- **Node version regression.** Reproduces on Node 24.14 LTS and Node 25.8.2. Not version-specific.
- **DB corruption.** `PRAGMA integrity_check` returns `ok`. Not a corruption issue.

What `--trace-gc --trace-gc-verbose` showed right before a crash:
- Allocation rate peaks near **1 GB / second** inside handler code.
- V8 old-space sits at `503 MB used / 509 MB committed`, **5 MB available** — effectively full.
- Parallel scavenger runs every ~30–45 ms, thrashing between allocation pressure and concurrent handler iteration over huge arrays.
- Final scavenge moves zero bytes between generations, then SIGSEGV.

The root cause is **us**, not V8. Four query sites in the RS use `.all()` to materialize entire table scans of JSON-column rows into a single in-memory array before any filtering, pagination, or streaming. Measured against the real substrate:

- `gmail/message_bodies`: 17,826 rows × 20.8 KB avg = **370 MB** of JSON per `.all()` call.
- `slack/messages`: 196,518 rows × 775 B avg = **152 MB**.
- `claude-code/messages`: 235,273 rows × 435 B avg = **102 MB**.
- `record_changes`: 1.4 M rows × 843 B avg = **1.2 GB** (cumulative).
- `spine_events`: 92 K rows × 234 B avg = **21 MB** (scanned 3× in distinct handlers).

Under the dashboard workload, Next.js SSR fans a single page request into many concurrent RS calls. Multiple copies of these result arrays live simultaneously, which is what drives V8 to the corner.

This change replaces the four unbounded `.all()` sites with streaming / filter-push-down, and adds the standing defenses (concurrency cap, response-size budget, process supervisor) that keep V8 out of the corner even when application logic is imperfect.

## What Changes

Four primary code changes, each scoped to one query site:

1. **`server/records.js::fetchVisibleRecordRows`** — currently `db.prepare('SELECT record_json FROM records WHERE connector_id = ? AND stream = ? AND deleted = 0').all(...)`, then filters / sorts / paginates in JS. Replace with:
   - Push `time_range` and `resources` filters into SQL WHERE.
   - Stream rows via `.iterate(...)` and stop early once `limit + 1` visible rows are collected.
   - Sort is handled by a SQL `ORDER BY` derived from the stream's `cursor_field` + primary key.
2. **`server/records.js::listStreams`** — currently `.all()`s every record for every granted stream to count visible rows. Replace with a **single aggregate SQL query** per stream that applies time_range + resources in WHERE and returns `{record_count, last_updated}` — no JSON parse per row.
3. **`lib/spine.js::listSpineCorrelations` and `searchSpine`** — currently `SELECT * FROM spine_events ORDER BY rowid`, loading the entire spine table (92 K rows, growing unbounded over a session). Replace with:
   - A per-correlation-key SQL that groups/aggregates inside SQL (`SELECT trace_id, MIN(occurred_at) AS first_at, MAX(occurred_at) AS last_at, COUNT(*) AS event_count ... FROM spine_events GROUP BY trace_id ...`).
   - Pagination at the SQL level.
   - Search filter pushed into SQL `WHERE` with `LIKE` / `=` on indexed columns.
4. **`server/records.js::getRealWorldTimeBounds`** — already bounded (per-stream MIN/MAX) but issues O(~50) queries in a loop; coalesce into one UNION ALL query or cache the result.

Three standing defenses:

5. **Fastify concurrency cap per route**: limit inflight large-result handlers to N (start N=4) via Fastify's built-in connection count or a small per-handler semaphore. Reject with 503 when exceeded so dashboard load can't fan out unboundedly.
6. **Response-size budget**: declare a per-handler max response size (e.g. 20 MB for `/v1/streams/*/records`). If a handler exceeds, log and return an error envelope instead of serializing gigabytes.
7. **Process supervisor**: add a PM2 or systemd unit (or `node --max-old-space-size=1536 ...` + an exit-zero restart wrapper) so production recovers on SIGSEGV — even if our fix is incomplete, the reference doesn't go permanently down.

One validation artifact:

8. **Extend `repro-crash.sh`** into an N-run harness (`--runs=5`) that reports PASS (0 crashes) / FAIL (any crash) so a fix is checked against a consistent bar.

## Capabilities

### Modified Capabilities

- `reference-implementation-architecture`: the RS read-path SHALL not materialize unbounded result arrays; it SHALL stream rows and apply access-control + user filters in SQL before application code sees them.

## Impact

- `reference-implementation/server/records.js` (4 query sites, plus the helpers they feed)
- `reference-implementation/lib/spine.js` (2 query sites + grouping helpers)
- `reference-implementation/server/transport.js` (concurrency cap, response-size budget hooks)
- `reference-implementation/package.json` or a new systemd unit (supervisor)
- `repro-crash.sh` (extend to N-run mode)
- `openspec/specs/reference-implementation-architecture/spec.md` (new Requirement)
- `openspec/changes/fix-rs-query-memory-pressure/audit-report.md` (the supporting audit — query surface, handler allocation, concurrency, memory budget, connector ingest, safety)

No protocol change. No web-app change (unless the concurrency cap forces SSR to retry on 503 — if so, a small guard in `apps/web`'s RS client).

## Follow-ups

- Upstream a minimal reproducer (to be extracted after the fix lands) as a Node.js issue documenting "parallel scavenger can SIGSEGV under sustained native-addon string allocation pressure." Even with our code fixed, V8 should not SIGSEGV — it should OOM-throw. Filing is a gift to the ecosystem, not a blocker for us.
- Dashboard query latency work. The dashboard currently pulls full streams and filters in JS — there are several streams where this is slow (10–30 s p50). Server-side filter pushdown and streaming (this change) is the structural fix; the next change should add SQL-level pagination UI and make search index-backed rather than full-scan-backed.
- `audit-report.md` will list every finding with severity; items not addressed in this change become follow-ups.

## Acceptance

- `repro-crash.sh --runs=5` passes 5/5 runs on the frozen DB snapshot on branch `repro/scavenger-crash-2026-04-23`.
- Response times for `/dashboard/records` and `/dashboard/search` under the same workload are no worse than current (and expected to improve substantially — ~10 s → single-digit seconds).
- `openspec validate fix-rs-query-memory-pressure --strict` passes.
- Existing test suite (596 tests across 16 files) passes. The pre-existing `composed-origin.test.js` flake is out of scope.
