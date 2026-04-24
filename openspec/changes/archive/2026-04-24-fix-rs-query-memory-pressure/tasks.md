## 1. Audit

- [x] 1.1 Query surface audit — `db.prepare()` sites classified by WHERE boundedness and JSON-column presence; top offenders identified.
- [x] 1.2 Handler allocation audit — heaviest endpoints traced end-to-end for intermediate array sizes and `JSON.parse`/`stringify` on large payloads.
- [x] 1.3 Concurrency audit — Next.js SSR fan-out mapped.
- [x] 1.4 Memory-budget audit — largest single response and peak under dashboard load measured.
- [x] 1.7 Write `audit-report.md` with findings backing the enumerated rewrites.

## 2. Fix the unbounded read paths (in scope, shipped)

- [x] 2.1 `server/records.js::queryRecords` — replaced `fetchVisibleRecordRows` + JS sort/filter/slice with `fetchVisibleRecordRowsPaginated`: `.iterate()`, `time_range` and `resources` pushed into `WHERE`, SQL `ORDER BY` + `LIMIT` + cursor seek with a parity guard that rejects cursor_fields whose collation would drift.
- [x] 2.3 `server/records.js::hydrateExpandedRelations` — replaced with `fetchExpansionChildrenGroupedByForeignKey`: single window-function query per expansion narrowed by parent foreign keys, with child grant filters in SQL. `has_many` uses `ROW_NUMBER() OVER PARTITION BY fk` + `rn <= limit + 1`; `has_one` uses `rn = 1`.
- [x] 2.4 `server/ref-control.js::listRecordsTimeline` — enumerates candidate `(connector, stream)` pairs, builds per-pair prepared statements that push `since`/`until` into SQL against `COALESCE(NULLIF(json_extract(record_json, '$.<semantic_field>'), ''), emitted_at)` (native) or `emitted_at` (emitted). `expandBoundary()` normalizes bare `YYYY-MM-DD` values to day start/end. Each per-pair query streams via `.iterate()` with SQL `LIMIT`.
- [x] 2.5 `lib/spine.js::listSpineCorrelations` — replaced with SQL `GROUP BY <correlation_column>` + HAVING for `since`/`until` + WHERE for `status`/`client_id`/`provider_id`/`grant_id` + cursor seek on `(last_at DESC, id DESC)`. Page-scope JS pass handles JSON-derived `connector_id` and fuzzy `q` match on secondary fields, bounded by `limit * 4` over-fetch.
- [x] 2.6 `lib/spine.js::searchSpine` — indexed equality for exact match on trace_id/grant_id/run_id plus small-cardinality fallback on request_id; LIKE-then-summarize for fuzzy matches, bounded to 10 ids per kind.

## 3. Extend the reproduction oracle

- [x] 3.1 Extend `repro-crash.sh` to accept `--runs=N`. Reports PASS (all runs survived 10 rounds) or FAIL (any crash), with per-run result.

## 4. Validate

- [x] 4.1 `openspec validate fix-rs-query-memory-pressure --strict` passes.
- [x] 4.2 `pnpm --filter pdpp-reference-implementation test` — all suites green except the pre-existing `composed-origin.test.js` failure (documented as out of scope; fails identically on main without this change).
- [x] 4.3 `./repro-crash.sh --runs=5` passes 5/5 on the frozen DB snapshot with fixes applied.
- [x] 4.4 Dashboard wall-clock: `/dashboard/records` and `/dashboard/search` response times recorded before/after.
- [x] 4.5 Peak RSS during the 5-run test stays well below 1 GB.

## 5. Capability spec update

- [x] 5.1 Add the read-path invariant Requirement to `openspec/changes/fix-rs-query-memory-pressure/specs/reference-implementation-architecture/spec.md`: "the RS read-path SHALL not materialize unbounded result arrays; it SHALL stream rows and apply access-control + pagination bounds in SQL."

## 6. Follow-ups (not in this change)

- [ ] 6.1 File the upstream V8/Node issue with a minimal reproducer if/when we isolate one.
- [ ] 6.2 Per-route concurrency cap + dashboard 503 coordination (originally Slice 5/6). Deferred: read-path rewrite removed the pathology that motivated the cap. File a new change if a remaining problem justifies the coupled server+client scope.
- [ ] 6.3 Response-size budget hook. Deferred: no evidence of oversized responses after the rewrite; trivially addable later.
- [ ] 6.4 Process supervisor (systemd unit / PM2 ecosystem file). Deployment-local; can land as a separate documentation change when the reference gets a reference deployment.
- [ ] 6.5 Add generated-column indexes for hot stream cursor fields to make SQL ORDER BY cheap for very large streams.
- [ ] 6.6 Consider NDJSON streaming response for `/v1/streams/*/records`.
- [ ] 6.7 Dashboard query latency work — SQL-level pagination UI, index-backed search.
