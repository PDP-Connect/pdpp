## Why

The reference server crashed (SIGSEGV) under concurrent dashboard load. We had a frozen reproduction (`repro-crash.sh` on branch `repro/scavenger-crash-2026-04-23`, against a 3.3 GB SQLite snapshot) that crashed non-deterministically within 1–10 rounds of hitting `/dashboard/records`, `/dashboard/search`, and `/planning/changes` concurrently. Baseline crash rate: ~50% per 10-round run. The crash signature was `SIGSEGV` inside V8's parallel scavenger (`v8::internal::HeapObject::SizeFromMap`) during a `better-sqlite3` result marshaling call.

We investigated and ruled out three hypotheses:

- **Driver bug.** Reproduces on both `sqlite3@5.1.7` (legacy async) and `better-sqlite3@12.9.0` (synchronous). Not driver-specific.
- **Node version regression.** Reproduces on Node 24.14 LTS and Node 25.8.2. Not version-specific.
- **DB corruption.** `PRAGMA integrity_check` returns `ok`. Not a corruption issue.

What `--trace-gc --trace-gc-verbose` showed right before a crash:
- Allocation rate peaks near **1 GB / second** inside handler code.
- V8 old-space sits at `503 MB used / 509 MB committed`, **5 MB available** — effectively full.
- Parallel scavenger runs every ~30–45 ms, thrashing between allocation pressure and concurrent handler iteration over huge arrays.
- Final scavenge moves zero bytes between generations, then SIGSEGV.

The root cause was **us**, not V8. Four query sites in the RS used `.all()` to materialize entire table scans of JSON-column rows into a single in-memory array before any filtering, pagination, or streaming. Measured against the real substrate:

- `gmail/message_bodies`: 17,826 rows × 20.8 KB avg = **370 MB** of JSON per `.all()` call.
- `slack/messages`: 196,518 rows × 775 B avg = **152 MB**.
- `claude-code/messages`: 235,273 rows × 435 B avg = **102 MB**.
- `record_changes`: 1.4 M rows × 843 B avg = **1.2 GB** (cumulative).
- `spine_events`: 92 K rows × 234 B avg = **21 MB** (scanned 3× in distinct handlers).

Under the dashboard workload, Next.js SSR fans a single page request into many concurrent RS calls. Multiple copies of these result arrays lived simultaneously, which is what drove V8 to the corner.

This change replaces the unbounded `.all()` read paths with streaming + filter push-down. The substantive fix is the rewrite; standing defenses (per-route concurrency cap, response-size budget, supervisor) are deferred to follow-ups because the rewrite alone eliminated the pathology.

## What Changes

Four code changes covering every unbounded-read path the audit found. The architecture invariant in §spec-delta constrains exactly these read paths.

1. **`server/records.js::fetchVisibleRecordRows` → `fetchVisibleRecordRowsPaginated`** — replaced. `time_range` and `resources` filters push into SQL WHERE. Rows stream via `.iterate(...)` and stop once `limit + 1` visible rows are collected. Sort is handled by SQL `ORDER BY` derived from the stream's `cursor_field` + primary key, with a parity guard that rejects cursor_fields whose JS collation would drift from SQL BINARY collation. Cursor-based pagination seeks at the SQL layer.
2. **`server/records.js::hydrateExpandedRelations`** — replaced by `fetchExpansionChildrenGroupedByForeignKey`. Collects parent foreign-key values from the current page into an `IN (?, …)` clause. One window-function query per expansion: `ROW_NUMBER() OVER (PARTITION BY foreign_key ORDER BY child_sort) AS rn`, clipped to `rn <= limit + 1` for `has_many` or `rn = 1` for `has_one`. Child grant filters (`time_range`, `resources`) ride in on the same WHERE.
3. **`lib/spine.js::listSpineCorrelations` and `searchSpine`** — replaced. `listSpineCorrelations` issues a SQL `GROUP BY <correlation_column>` with `since`/`until` in HAVING and `status`/`client_id`/`provider_id`/`grant_id` in WHERE, SQL `ORDER BY` + cursor seek on `(last_at DESC, id DESC)`. The page-scope JS pass handles the JSON-derived `connector_id` and the fuzzy `q` match against secondary fields, bounded by an over-fetch multiplier (`limit * 4`) rather than corpus size. `searchSpine` uses indexed equality for exact match across the three correlation columns plus a small-cardinality fallback on `request_id`; LIKE-then-summarize for fuzzy matches, bounded to 10 ids per kind.
4. **`server/ref-control.js::listRecordsTimeline`** — replaced. Enumerates candidate `(connector_id, stream)` pairs from the indexed `records` columns, narrowed by the caller's `connectorId`/`stream` filters. Per pair, builds a prepared statement that pushes `since`/`until` into SQL against `COALESCE(NULLIF(json_extract(record_json, '$.<semantic_field>'), ''), emitted_at)` in native mode (preserving the legacy fallback to `emitted_at` when the semantic field is missing on a row) or against `emitted_at` in emitted mode. `expandBoundary()` normalizes bare `YYYY-MM-DD` inputs to day start/end so the legacy date-only window semantics are preserved. Each per-pair query streams via `.iterate()` with SQL `LIMIT perPairLimit`.

One validation artifact:

5. **Extend `repro-crash.sh`** into an N-run harness (`--runs=5`) that reports PASS (0 crashes) / FAIL (any crash) so a fix is checked against a consistent bar.

## Capabilities

### Modified Capabilities

- `reference-implementation-architecture`: for the read paths enumerated in the spec delta, the RS SHALL not materialize unbounded result arrays; it SHALL stream rows and apply access-control filters (`time_range`, `resources`) and pagination bounds in SQL. Request-level user filters (`filter[field]=…`) stay in application code for this tranche.

## Impact

- `reference-implementation/server/records.js` — rewrites for `fetchVisibleRecordRows`/`queryRecords` and `hydrateExpandedRelations`; remove dead helpers `compareLogicalPositions`, `fetchVisibleRecordRows`, `compareComparableValues`, `passesGrantVisibility`.
- `reference-implementation/server/ref-control.js` — rewrite for `listRecordsTimeline` with `expandBoundary()` and per-pair prepared statements.
- `reference-implementation/lib/spine.js` — rewrites for `listSpineCorrelations` and `searchSpine` (plus a synchronous `listSpineEventsSync` helper).
- `repro-crash.sh` — extend to N-run mode.
- `openspec/changes/fix-rs-query-memory-pressure/specs/reference-implementation-architecture/spec.md` — one Requirement covering the read-path invariant.
- `openspec/changes/fix-rs-query-memory-pressure/audit-report.md` — the supporting audit.

No protocol change. No dashboard or transport layer changes.

## Follow-ups

- **Per-route concurrency cap + dashboard 503 coordination** (originally Slice 5/6 in this change). Deferred because the read-path rewrite eliminated the pathology that motivated the cap. File a new change if and when a measured remaining problem justifies the scope. Any future cap must ship together with the dashboard's `pMapLimit` + 503-retry + partial-failure banner so the cap doesn't silently degrade into empty-result under-reporting.
- **Response-size budget** (originally #9). Same reasoning: no evidence of oversized responses after the rewrite. Trivially addable later if a handler accidentally assembles a large payload.
- **Process supervisor** (originally #10). Deployment-local concern; reference systemd/PM2 artifacts can land as a documentation change when the reference gets a reference deployment.
- Upstream a minimal reproducer as a Node.js issue documenting "parallel scavenger can SIGSEGV under sustained native-addon string allocation pressure." Even with our code fixed, V8 should not SIGSEGV — it should OOM-throw. Filing is a gift to the ecosystem.
- Dashboard query latency work. The dashboard's slower paths (10–30 s p50) are addressed structurally by this change; follow-on work can add SQL-level pagination UI and index-backed search.
- `audit-report.md` lists every finding with severity; items not addressed here are tracked there.

## Acceptance

- `repro-crash.sh --runs=5` passes 5/5 runs on the frozen DB snapshot on branch `repro/scavenger-crash-2026-04-23`.
- Response times for `/dashboard/records` and `/dashboard/search` under the same workload are substantially better than baseline.
- `openspec validate fix-rs-query-memory-pressure --strict` passes.
- Existing test suite (596+ tests) passes. The pre-existing `composed-origin.test.js` failure is out of scope (fails identically on main without this change).
