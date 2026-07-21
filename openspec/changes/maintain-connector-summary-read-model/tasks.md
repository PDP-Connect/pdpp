## 1. Projection Model

- [ ] Refactor connector-summary projection into durable evidence extraction plus read-time synthesis.
- [x] Add SQLite and Postgres connector-summary evidence tables and migrations. (`connector_summary_evidence` in `server/db.js` + `server/postgres-storage.js`; durable evidence only — no synthesized columns.)
- [x] Add dirty-marking and reconcile helpers mirroring the retained-size read-model pattern. (`markConnectorSummaryEvidenceDirty`, `markAllConnectorSummaryEvidenceDirty`, `reconcileDirtyConnectorSummaryEvidence` in `server/connector-summary-read-model.js`.)
- [x] Add a full rebuild/repair path for connector-summary evidence. (`rebuildConnectorSummaryEvidence` derives from `connector_instances` + maintained `retained_size_stream`; no connector re-run, no credentials.)
- [x] Persist retained stream and byte evidence needed by overview rows. (`stream_records_json`, `retained_bytes_json`, and `total_retained_bytes` are derived from the maintained retained-size projection in both rebuild and dirty reconcile; no freshness, verdict, health, or UI copy is stored.)

## 2. Write Hooks

- [x] Mark connector-summary evidence dirty from existing owner mutation seams. Every owner mutation route that calls `invalidateConnectorSummariesCache` now also awaits a scoped `markConnectorSummaryEvidenceDirty({ connectorInstanceId })` right after it, with the known connection id (no `markAll` fallback is needed — every seam knows its connection): the bearer owner-agent routes `revoke` (prior slice), `reactivate`, `run`, `schedule` pause/resume + delete, `delete`, and `PATCH /v1/owner/connections/:id` rename (`server/routes/owner-connection-{reactivate,run,schedule,delete}.ts`, `owner-connections.ts`), plus all cookie-authed `/_ref` mutations sharing one `refConnectorsContext` — set-display-name, connector/connection run, schedule upsert/pause/resume/delete, revoke, delete, reactivate (`server/routes/ref-connectors.ts`). Each route declares an injected optional `markConnectorSummaryEvidenceDirty?` in its context interface; the marker is wired through `server/index.js` (7 context objects).
- [x] Mark connector-summary evidence dirty from record ingest hooks that already update retained-size evidence. Scoped hooks colocated with the retained-size delta and scoped to the known `connector_instance_id` now cover `ingestRecord` (prior slice), `deleteRecord` (Postgres + SQLite arms, only on a changed delete), `deleteAllRecords` (Postgres + SQLite arms, only when rows were cleared), and `deleteAllRecordsForConnector` (per-instance in the post-commit loop) in `server/records.js`. No-op deletes (missing record / empty stream) do not dirty evidence, pinned by tests.
- [ ] Mark connector-summary evidence dirty from run lifecycle and gap/backlog changes. PARTIAL: the run-*start* seam is covered — the owner run-now routes (bearer `owner-connection-run.ts` and cookie `/_ref/connectors|connections/:id/run`) dirty the connection's evidence when a run begins (counted under the owner-mutation task above), because that is the only run-lifecycle seam that already had a known connection id at a summary-invalidation point. RESIDUAL: there is no existing controller-level run *finish/fail* or gap/backlog-drain seam that invalidates connector summaries or marks retained-size dirty today, so hooking those would mean introducing a NEW seam in the controller/run pipeline rather than mirroring an existing one. Left for a follow-up slice that adds those controller hooks deliberately (run finish/fail evidence and gap-drain completion), since record-ingest dirtying already covers the count/stream changes a run produces.

## 3. Read Paths

- [ ] Make unscoped `/_ref/connectors` read maintained evidence plus read-time synthesis.
- [ ] Preserve exact scoped connection/detail diagnostics with deep run evidence.
- [ ] Remove or gate the short TTL cache once the maintained read model owns the hot path.

## 4. Validation

- [ ] Add SQLite tests for dirty marking, lazy reconcile, and time-relative synthesis. Storage evidence tests exist in `test/connector-summary-read-model.test.js` (rebuild, dirty→stale, lazy reconcile of only-dirty rows, drop-on-delete, synthesis-free-columns guard). Write-hook seam tests now exist in `test/connector-summary-dirty-hooks.test.js`: record ingest dirties the matching connection and only that connection; no-op re-ingest does not dirty; `deleteRecord` and `deleteAllRecords` dirty the matching/cleared connection and only that one, while no-op deletes (missing record / empty stream) do not dirty; the owner revoke route AND a non-revoke owner mutation (the `PATCH /v1/owner/connections/:id` rename route) each dirty the targeted connection end-to-end. Time-relative synthesis remains deferred until task 1.1/3.x wires the read path.
- [x] Add Postgres parity tests for the storage fixtures. (Same file, gated on `PDPP_TEST_POSTGRES_URL`; same rebuild/dirty/reconcile shape as SQLite.)
- [ ] Add a query-count or dependency-injection test proving the full-list path avoids per-connection evidence fan-out.
- [ ] Run reference and console type checks.
- [ ] Run browser perf harness on dashboard, records list, exact source detail, and runs.
- [ ] Deploy in a declared live-stack window and verify `/_ref/connectors` latency plus owner-journey acceptance.
