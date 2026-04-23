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

Six code changes covering every unbounded-read path the audit found. If any is deferred, the architecture invariant in §spec-delta must be narrowed or the whole change blocks.

1. **`server/records.js::fetchVisibleRecordRows`** — currently `db.prepare('SELECT record_json FROM records WHERE connector_id = ? AND stream = ? AND deleted = 0').all(...)`, then filters / sorts / paginates in JS. Replace with:
   - Push `time_range` and `resources` filters into SQL WHERE.
   - Stream rows via `.iterate(...)` and stop early once `limit + 1` visible rows are collected.
   - Sort is handled by a SQL `ORDER BY` derived from the stream's `cursor_field` + primary key.
2. **`server/records.js::listStreams`** — currently `.all()`s every record for every granted stream to count visible rows. Replace with a **single aggregate SQL query** per stream that applies time_range + resources in WHERE and returns `{record_count, last_updated}` — no JSON parse per row.
3. **`server/records.js::hydrateExpandedRelations`** — currently calls `fetchVisibleRecordRows` over the entire child stream for every parent page, then groups by foreign key in JS, then slices per-parent. Replace with:
   - Collect parent foreign-key values (at most `parent_limit` of them) into an `IN (?, …)` clause.
   - Push `WHERE child.foreign_key IN (…parent keys…)` plus the child stream's grant filters into SQL.
   - For `has_many` expansions, use a window-function query (`ROW_NUMBER() OVER (PARTITION BY foreign_key ORDER BY …)`) to fetch at most `expansion.limit + 1` rows per parent, preserving the `has_more` signal.
   - For `has_one`, `LIMIT parent_count` is sufficient.
   - Child visibility checks (time_range, resources on the child grant) remain enforced in SQL alongside the foreign-key filter.
4. **`lib/spine.js::listSpineCorrelations` and `searchSpine`** — currently `SELECT * FROM spine_events ORDER BY rowid`, loading the entire spine table (92 K rows, growing unbounded over a session). Replace with:
   - A per-correlation-key SQL that groups/aggregates inside SQL (`SELECT trace_id, MIN(occurred_at) AS first_at, MAX(occurred_at) AS last_at, COUNT(*) AS event_count ... FROM spine_events GROUP BY trace_id ...`).
   - Pagination at the SQL level.
   - Search filter pushed into SQL `WHERE` with `LIKE` / `=` on indexed columns.
5. **`server/ref-control.js::listRecordsTimeline`** — currently `SELECT … FROM records WHERE deleted = 0` (plus optional connector_id/stream filters) with no LIMIT, then parses every row and filters by time window in JS. Called by `/planning/changes` and other timeline surfaces. Replace with:
   - Push the `since`/`until` window into SQL as `WHERE json_extract(record_json, '$.<consent_time_field>') BETWEEN ? AND ?` — this requires a per-connector join with the manifest's `consent_time_field`, built at statement-prepare time per (connector, stream) pair, since that field is manifest-authored.
   - Apply SQL `LIMIT ?` bounded by the handler's `limit` param.
   - Stream via `.iterate()`; stop after `limit` visible rows.
6. **`server/records.js::getRealWorldTimeBounds`** — already bounded (per-stream MIN/MAX) but issues O(~50) queries in a loop; coalesce into one UNION ALL query or cache the result.

Three standing defenses (and one coordinated client change):

7. **Fastify concurrency cap per route**: limit inflight large-result handlers to N (start N=4) via a small per-handler semaphore. Reject with `503 Service Unavailable` when exceeded so dashboard load can't fan out unboundedly.
8. **Dashboard 503 coordination (coupled to #7, non-optional)**: `apps/web/src/app/dashboard/{search,lib/timeline}.ts` currently fire `Promise.all` across all streams and swallow per-target failures as empty record sets (`apps/web/src/app/dashboard/search/page.tsx:102`, `apps/web/src/app/dashboard/lib/rs-client.ts:80`). With #7 in place, 503s would silently degrade to missing search hits. This change adds:
   - Bounded-parallelism helper (`pMap`-style) in the RS client that fires at most N requests at a time (default 3) to match the server cap with headroom.
   - Explicit 503 handling: on 503, retry with bounded backoff (up to 2 retries with 100 ms / 400 ms delay) before considering the target failed.
   - Surface partial-failure state to the page: return `{records, missing}` so the dashboard can distinguish "zero results" from "some streams couldn't be queried."
9. **Response-size budget**: declare a per-handler max response size (e.g. 20 MB for `/v1/streams/*/records`). If a handler exceeds, log and return an error envelope instead of serializing gigabytes.
10. **Process supervisor**: add a PM2 or systemd unit (or `node --max-old-space-size=1536 ...` + an exit-zero restart wrapper) so production recovers on SIGSEGV — even if our fix is incomplete, the reference doesn't go permanently down.

One validation artifact:

11. **Extend `repro-crash.sh`** into an N-run harness (`--runs=5`) that reports PASS (0 crashes) / FAIL (any crash) so a fix is checked against a consistent bar.

## Capabilities

### Modified Capabilities

- `reference-implementation-architecture`: for the read paths enumerated in the spec delta, the RS SHALL not materialize unbounded result arrays; it SHALL stream rows and apply access-control filters (`time_range`, `resources`) and pagination bounds in SQL. Request-level user filters (`filter[field]=…`) stay in application code for this tranche.

## Impact

- `reference-implementation/server/records.js` — rewrites for `fetchVisibleRecordRows`, `hydrateExpandedRelations`, `listStreams`, `getRealWorldTimeBounds`
- `reference-implementation/server/ref-control.js` — rewrite for `listRecordsTimeline`
- `reference-implementation/lib/spine.js` — rewrites for `listSpineCorrelations` and `searchSpine`
- `reference-implementation/server/transport.js` — per-route concurrency cap hook, response-size budget hook
- `reference-implementation/package.json` — `--max-old-space-size=1536`, ops hints for systemd unit / PM2 ecosystem file
- `apps/web/src/app/dashboard/lib/rs-client.ts` — 503-aware retry wrapper
- `apps/web/src/app/dashboard/lib/timeline.ts` — bounded-parallelism + partial-failure shape
- `apps/web/src/app/dashboard/search/page.tsx` — bounded-parallelism + partial-failure banner
- `apps/web/src/lib/p-limit.ts` (new) — `pMapLimit` helper
- `repro-crash.sh` — extend to N-run mode
- `openspec/changes/fix-rs-query-memory-pressure/specs/reference-implementation-architecture/spec.md` — three new Requirements
- `openspec/changes/fix-rs-query-memory-pressure/audit-report.md` — the supporting audit

No protocol change. Web-app changes are **part of this tranche**, not optional: per-route concurrency cap + dashboard 503 handling must land together or the crash fix trades one failure mode (SIGSEGV) for another (silent under-reporting of search/timeline results).

## Follow-ups

- Upstream a minimal reproducer (to be extracted after the fix lands) as a Node.js issue documenting "parallel scavenger can SIGSEGV under sustained native-addon string allocation pressure." Even with our code fixed, V8 should not SIGSEGV — it should OOM-throw. Filing is a gift to the ecosystem, not a blocker for us.
- Dashboard query latency work. The dashboard currently pulls full streams and filters in JS — there are several streams where this is slow (10–30 s p50). Server-side filter pushdown and streaming (this change) is the structural fix; the next change should add SQL-level pagination UI and make search index-backed rather than full-scan-backed.
- `audit-report.md` will list every finding with severity; items not addressed in this change become follow-ups.

## Acceptance

- `repro-crash.sh --runs=5` passes 5/5 runs on the frozen DB snapshot on branch `repro/scavenger-crash-2026-04-23`.
- Response times for `/dashboard/records` and `/dashboard/search` under the same workload are no worse than current (and expected to improve substantially — ~10 s → single-digit seconds).
- `openspec validate fix-rs-query-memory-pressure --strict` passes.
- Existing test suite (596 tests across 16 files) passes. The pre-existing `composed-origin.test.js` flake is out of scope.
