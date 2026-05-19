## 1. Read-Model Contract

- [x] 1.1 Define global and per-stream dataset-summary read-model storage for counts, bytes, ingest bounds, record-time bounds, freshness, stale, rebuild, and sanitized error metadata.
- [x] 1.2 Extend the `GET /_ref/dataset/summary` response contract with projection metadata while preserving existing summary fields.
- [x] 1.3 Update `GET /_ref/dataset/summary` to read from bounded read-model rows rather than computing the dashboard overview by raw record/blob/change scans.
- [x] 1.4 Ensure the summary response preserves reference-only status and does not expose secrets, raw connector payloads, or raw local paths.

## 2. Projection Maintenance

- [x] 2.1 Add transactional or idempotent update hooks for record upsert/delete changes that affect record counts, record JSON bytes, change-history bytes, ingest bounds, top connectors, and stream summaries.
- [ ] 2.2 Add update hooks for blob byte totals at blob insert/delete call sites. Blob insert is implemented; no blob delete call site exists in the current server path.
- [x] 2.3 Mark stream/global record-time bounds dirty when an overwrite or delete may have removed the current extremum.
- [x] 2.4 Mark or report the summary as stale when a write cannot be projected safely.
- [x] 2.5 Add targeted tests for duplicate/no-op record handling, upsert deltas, delete deltas, blob deltas, dirty extrema, and failed projection handling.

Maintenance note: record deltas, blob insert deltas, unsafe-write staleness, failed projection metadata, and non-empty rebuild stream seeds are implemented. Blob delete remains open because the server currently has no blob delete call site.

## 3. Reconciliation And Rebuild

- [x] 3.1 Add stream-scoped reconciliation for dirty record-time bounds from durable records.
- [x] 3.2 Add a full rebuild path that regenerates the dashboard summary without connector reruns, credential reads, or destructive canonical-data changes.
- [x] 3.3 Surface rebuild in-progress and failed states through summary metadata.
- [x] 3.4 Add tests for rebuilding from empty/missing projection rows, older databases, dirty extrema, and rebuild failure.

Rebuild note: tests cover missing projection rows, successful full rebuild, non-empty stream seed rebuild, dirty record-time reconciliation, rebuild failure, last-known preservation, and sanitized errors. Older-database coverage is represented by missing/empty projection state rebuilt from durable record tables.

## 4. Dashboard UX

- [x] 4.1 Split `/dashboard` so the shell/header and honest loading placeholders are not blocked by dataset-summary refresh.
- [x] 4.2 Render summary states as fresh, refreshing, stale, rebuilding, failed-with-cache, or failed-without-cache.
- [x] 4.3 Ensure the dashboard never renders `0 records` as a loading or error fallback; only a successful summary with `record_count === 0` may show an empty dataset state.
- [x] 4.4 Keep web-push settings and attention lists from blocking initial shell/header render.

## 5. Checks

- [x] 5.1 Run targeted tests for the dashboard summary read path.
- [x] 5.2 Run relevant reference implementation tests.
- [x] 5.3 Run dashboard rendering/loading-state tests.
- [ ] 5.4 Measure `/dashboard` and `/_ref/dataset/summary` before/after on the Docker deployment with active ingest or injected delay.
- [x] 5.5 Run `openspec validate add-dashboard-summary-read-model --strict`.
