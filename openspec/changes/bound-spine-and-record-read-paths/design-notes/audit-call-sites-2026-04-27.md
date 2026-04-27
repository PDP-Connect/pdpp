# Audit: every `db.prepare(...)` chain in `reference-implementation/`

**Date**: 2026-04-27
**Scope**: `reference-implementation/{lib,server,runtime,cli}/`. Excluded: tests, scripts, examples, node_modules, .cache.
**Method**: ripgrep across the scope, manual walk of multi-line `.prepare(...)` chains, classification per call site.

## Summary

| Bucket | Count | Notes |
|---|---|---|
| Mutations (`.run()`) | ~110 | `INSERT`/`UPDATE`/`DELETE`/`CREATE`/`ALTER`/`DROP`. Bounded by SQL semantics; through-the-wrapper for consistency only. |
| Single-row PK lookup (`.get()` on `WHERE pk = ?`) | ~30 | Bounded by construction. |
| Bounded by domain knowledge (small enumeration tables) | ~25 | `connectors`, `oauth_clients`, `version_counter`, `connector_state`, `grant_connector_state`, `lexical_search_meta`, `semantic_search_meta`. Use `allowUnboundedReadAcknowledged`. |
| Explicit `LIMIT ?` in SQL | 4 | Use `getMany`. |
| Already streaming (`.iterate()`) | 4 | The four sites the archived 2026-04-24 fix migrated. Pass through wrapper unchanged. |
| **Unbounded-pathological** | **15** | **Need real bounded-read rewrites in §2 of `tasks.md`.** |
| Unclear (flag for review) | 1 | `runtime/controller.ts:642`'s `listPersistedActiveRuns` — bounded by `controller_active_runs` table size (small in practice) but no explicit cap; likely `bounded_by: small_enumeration_table`. |
| **Total** | **177** | |

## The 15 unbounded-pathological sites

| # | File:line | Function | SQL shape | Why pathological |
|---|---|---|---|---|
| 1 | `lib/spine.ts:367` | `listSpineEventsSync` | `WHERE trace_id = ?` `.all()` | One trace can span thousands of events |
| 2 | `lib/spine.ts:371` | `listSpineEventsSync` | `WHERE grant_id = ?` `.all()` | Long-lived grants accumulate |
| 3 | `lib/spine.ts:375` | `listSpineEventsSync` | `WHERE run_id = ?` `.all()` | One run = up to 2,500+ events (current substrate) |
| 4 | `lib/spine.ts:393` | `listSpineEvents` | `WHERE trace_id = ?` `.all()` | Same |
| 5 | `lib/spine.ts:397` | `listSpineEvents` | `WHERE grant_id = ?` `.all()` | Same |
| 6 | `lib/spine.ts:401` | `listSpineEvents` | `WHERE run_id = ?` `.all()` | The original 9.5 GB-core trigger on 2026-04-27 |
| 7 | `lib/spine.ts:405` | `listSpineEvents` | `WHERE event_type = ?` `.all()` | Most event types have many thousands of rows |
| 8 | `lib/spine.ts:407` | `listSpineEvents` | full table scan, no `WHERE` | Worst case — all 96,972 rows |
| 9 | `lib/spine.ts:778` | `listSpineCorrelations` (per-row) | `listSpineEventsSync` per page item | **Hidden quadratic.** N events × M page items |
| 10 | `server/index.js:1472` | blob bindings | `WHERE blob_id = ?` `.all()` | Could be many bindings per blob |
| 11 | `server/records.js:1936` | `deleteAllRecords` distinct-stream scan | `WHERE connector_id = ?` `.all()` | Whole-connector scan |
| 12 | `server/records.js:1968` | re-ingest helper | `WHERE connector_id = ? AND stream = ?` `.all()` | Full stream scan |
| 13 | `server/records.js:2218` | `getTopConnectorsByRecordCount` | `GROUP BY connector_id` `.all()` | Whole-records GROUP BY |
| 14 | `server/search.js:803` | `buildCandidateRecordKeys` | dynamic builder `.all()` | Full-records scan when grant is wide |
| 15 | `server/search-semantic.js:1392` | `buildCandidateRecordKeys` | dynamic builder `.all()` | Full-records scan when grant is wide |

## Tables most frequently touched

| Table | Read sites | Mutation sites | Total | Notes |
|---|---|---|---|---|
| `records` | 19 | 15 | 34 | Large; scans guarded by `WHERE connector_id = ?` mostly |
| `spine_events` | 6 | 1 | 7 | **Pathological at lines 405, 407 (no narrowing) and 778 (quadratic)** |
| `semantic_search_*` | 20 | 18 | 38 | Mostly small tables |
| `lexical_search_*` | 10 | 7 | 17 | Mostly small tables |
| `connectors` | 4 | 1 | 5 | Small; `allowUnboundedReadAcknowledged` candidate |
| `grants` | 8 | 4 | 12 | Mostly by `WHERE grant_id = ?` |
| `tokens` | 3 | 4 | 7 | Mostly by `WHERE token_id = ?` |
| `connector_state` / `grant_connector_state` | 2 | 2 | 4 | Small |
| `pending_consents` / `owner_device_auth` | 4 | 5 | 9 | Mostly by `WHERE device_code = ?` |

## Observations relevant to wrapper design

**Repeated SQL shapes that warrant a higher-level helper later** (out of scope for this change but worth noting):

- `getOneByColumn(table, column, value)` would collapse ~20 single-row PK lookups into one primitive.
- `countByConnectorId(table)` appears repeatedly across `records`, `lexical_search_*`, `semantic_search_*`.
- The dynamic-WHERE-builder pattern (`server/records.js`, `server/search.js`, `server/search-semantic.js`) is consistent enough that a typed builder primitive (`db.iterate(query, dynamicWhere([...]))`) could replace string concatenation. Defer.

**Hot-loop preparation**: no `db.prepare(...)` calls were found inside loops that re-prepare the same SQL. better-sqlite3's transparent caching plus the project's existing pattern of preparing once and binding many means the wrapper does not need an extra caching layer.

**Cross-cutting**: every `.prepare()` chain uses `getDb()` from `server/db.js`. The migration to `lib/db.ts` does not require touching transactions or savepoints; the wrapper's `transaction()` helper preserves the existing better-sqlite3 idiom.
