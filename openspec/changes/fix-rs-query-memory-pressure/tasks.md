## 1. Finish the audit (in-progress)

- [ ] 1.1 Query surface audit — 88 `db.prepare()` sites classified by WHERE boundedness and JSON-column presence. Top-4 offenders identified (see `audit-report.md`).
- [ ] 1.2 Handler allocation audit — ~10 heaviest endpoints traced end-to-end for intermediate array sizes and `JSON.parse`/`stringify` on large payloads.
- [ ] 1.3 Concurrency audit — Next.js SSR fan-out mapped; unbounded `Promise.all` sites enumerated.
- [ ] 1.4 Memory-budget audit — largest single response and largest under max-concurrency measured; recommended `--max-old-space-size` derived.
- [ ] 1.5 Connector ingest audit — runtime + scheduler checked for the same `.all()`-then-`JSON.parse` pathology.
- [ ] 1.6 Safety/resilience audit — request timeouts, max concurrent requests, max response size, process supervisor expectation.
- [ ] 1.7 Write `audit-report.md` with severity-ranked findings, each backed by a concrete measurement.

## 2. Fix the unbounded read paths (all in scope this tranche)

- [ ] 2.1 `server/records.js::fetchVisibleRecordRows` — replace `.all()` with `.iterate()`, push `time_range` into `WHERE json_extract(record_json, $.field) BETWEEN ? AND ?`, push `resources` into `WHERE record_key IN (?, ?, ...)`, emit SQL `ORDER BY` + `LIMIT` + cursor.
- [ ] 2.2 `server/records.js::listStreams` — replace per-stream `.all()` + JS count with one aggregate SQL per stream that applies `time_range`/`resources` in WHERE.
- [ ] 2.3 `server/records.js::hydrateExpandedRelations` — replace per-child `fetchVisibleRecordRows` with a single SQL per expansion that narrows by parent foreign keys:
  - `has_many`: `WITH ranked AS (SELECT ..., ROW_NUMBER() OVER (PARTITION BY json_extract(record_json, '$.<fk>') ORDER BY <order>) AS rn FROM records WHERE ... AND json_extract(record_json, '$.<fk>') IN (?, ?, ...) AND <grant_filters>) SELECT * FROM ranked WHERE rn <= ?`
  - `has_one`: similar, `WHERE rn = 1`
  - Parent keys arity is bounded by page size (limit + 1); cache prepared statements per (parent_stream, child_stream, relation_name, parent_arity).
- [ ] 2.4 `server/ref-control.js::listRecordsTimeline` — push `since`/`until` window into SQL as `WHERE json_extract(record_json, '$.<consent_time_field>') BETWEEN ? AND ?` per (connector, stream) pair. Emit prepared statements per (connector, stream, timestamp-mode). Apply SQL `LIMIT`. Stream via `.iterate()`.
- [ ] 2.5 `lib/spine.js::listSpineCorrelations` — replace `SELECT * FROM spine_events` + JS group/sort with SQL `GROUP BY <correlation_key>` + SQL pagination. Handle `status` derivation and `kinds`/`connector_id` fields via a second page-scope pass on the already-paginated set.
- [ ] 2.6 `lib/spine.js::searchSpine` — replace full-scan + JS filter with SQL `WHERE trace_id LIKE ? OR grant_id LIKE ? ...` (or `=` for exact match) on indexed columns.
- [ ] 2.7 `server/records.js::getRealWorldTimeBounds` — coalesce the per-stream MIN/MAX loop into a single UNION ALL, or cache the result (manifest-stream set changes rarely).

## 3. Add standing defenses (server) and coordinated client backpressure

- [ ] 3.1 Per-route concurrency cap: Fastify `onRequest`/`onResponse` hooks with an in-memory semaphore keyed by `(method, routePath)`. Limit from env `PDPP_MAX_INFLIGHT_PER_ROUTE`, default 4. Return 503 on exceed.
- [ ] 3.2 **Dashboard 503 coordination (non-optional, ships with 3.1)**:
  - Add `pMapLimit(array, fn, {concurrency})` helper in `apps/web/src/app/dashboard/lib/` (or a shared `apps/web/src/lib/p-limit.ts`). Default concurrency 3 — below the server cap of 4 to leave headroom.
  - Update `apps/web/src/app/dashboard/lib/rs-client.ts` fetch wrapper to detect 503 responses and retry up to twice with 100 ms and 400 ms delays.
  - Update `apps/web/src/app/dashboard/search/page.tsx::searchRecords` and `apps/web/src/app/dashboard/lib/timeline.ts::loadTimeline` to use `pMapLimit` instead of `Promise.all` and to return `{records, failures}` or equivalent partial-failure shape.
  - Render partial-failure banner on search + records-timeline pages when `failures.length > 0`.
- [ ] 3.3 Response-size budget: `preSerialization` hook checks estimated response size against `PDPP_MAX_RESPONSE_BYTES` (default 20 MB). Log + 500 envelope on exceed. Exempt blob/binary routes.
- [ ] 3.4 Document supervisor expectation: add a section to `openspec/specs/reference-implementation-architecture/spec.md` stating that the reference, when deployed as a long-running service, SHALL run under a supervisor that restarts on non-zero exit. Provide a reference systemd unit file or PM2 ecosystem file as a supplementary artifact.

## 4. Extend the reproduction oracle

- [ ] 4.1 Extend `repro-crash.sh` to accept `--runs=N`. Report PASS (all runs survived 10 rounds) vs FAIL (any crash). Include the per-run result in the report.
- [ ] 4.2 Run `./repro-crash.sh --runs=5` on the unmodified frozen state and record baseline crash rate in `audit-report.md`.

## 5. Attempt minimal upstream reproducer

- [ ] 5.1 After 2.1–2.4 land, attempt a ~200-line standalone script that:
  - Opens the frozen DB snapshot
  - Fires N parallel `.all()` queries against the worst-offender stream (`slack/messages` or `gmail/message_bodies`)
  - Runs until crash or N=1000 iterations
- [ ] 5.2 If deterministic, file at `nodejs/node` with the crash pattern, GC trace, and our workaround. Link `nodejs/node#62515` as related (same ecosystem, different frame).
- [ ] 5.3 If not deterministic, note the result in `audit-report.md` as evidence the pathology requires the full handler stack.

## 6. Validate

- [ ] 6.1 `openspec validate fix-rs-query-memory-pressure --strict` passes.
- [ ] 6.2 `pnpm --filter pdpp-reference-implementation test` — all suites green except the pre-existing `composed-origin.test.js` flake (documented as out of scope).
- [ ] 6.3 `./repro-crash.sh --runs=5` passes on a fresh checkout with fixes applied, against the frozen DB snapshot.
- [ ] 6.4 Dashboard wall-clock: record `/dashboard/records`, `/dashboard/search`, `/planning/changes` response times before / after. Target ≥ 2× improvement on the two slow ones.
- [ ] 6.5 Peak RSS during the 5-run test stays below 1 GB.

## 7. Capability spec update

- [ ] 7.1 Add the new Requirement to `openspec/changes/fix-rs-query-memory-pressure/specs/reference-implementation-architecture/spec.md` (`ADDED Requirements` delta): "the RS read-path SHALL not materialize unbounded result arrays; it SHALL stream rows and apply access-control + user filters in SQL."
- [ ] 7.2 Add the supervisor Requirement: "the reference, when deployed as a long-running service, SHALL run under a process supervisor that restarts on non-zero exit."

## 8. Follow-ups (not in this change)

- [ ] 8.1 File the upstream V8/Node issue with the minimal reproducer (if we get one).
- [ ] 8.2 Add generated-column indexes for hot stream cursor fields to make SQL ORDER BY cheap for very large streams.
- [ ] 8.3 Consider NDJSON streaming response for `/v1/streams/*/records` for clients that want bytes-on-the-wire as they become available.
- [ ] 8.4 Dashboard query latency work — SQL-level pagination UI, index-backed search.
- [ ] 8.5 Revisit once upstream fixes the V8 side. If/when V8 makes parallel scavenger safe under sustained native-addon allocation, we can relax the defenses.
