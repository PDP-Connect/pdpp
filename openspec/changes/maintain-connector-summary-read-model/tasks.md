## 1. Projection Model

- [ ] Refactor connector-summary projection into durable evidence extraction plus read-time synthesis.
- [x] Add SQLite and Postgres connector-summary evidence tables and migrations. (`connector_summary_evidence` in `server/db.js` + `server/postgres-storage.js`; durable evidence only — no synthesized columns.)
- [x] Add dirty-marking and reconcile helpers mirroring the retained-size read-model pattern. (`markConnectorSummaryEvidenceDirty`, `markAllConnectorSummaryEvidenceDirty`, `reconcileDirtyConnectorSummaryEvidence` in `server/connector-summary-read-model.js`.)
- [x] Add a full rebuild/repair path for connector-summary evidence. (`rebuildConnectorSummaryEvidence` derives from `connector_instances` + maintained `retained_size_stream`; no connector re-run, no credentials.)

## 2. Write Hooks

- [ ] Mark connector-summary evidence dirty from existing owner mutation seams.
- [ ] Mark connector-summary evidence dirty from record ingest hooks that already update retained-size evidence.
- [ ] Mark connector-summary evidence dirty from run lifecycle and gap/backlog changes.

## 3. Read Paths

- [ ] Make unscoped `/_ref/connectors` read maintained evidence plus read-time synthesis.
- [ ] Preserve exact scoped connection/detail diagnostics with deep run evidence.
- [ ] Remove or gate the short TTL cache once the maintained read model owns the hot path.

## 4. Validation

- [ ] Add SQLite tests for dirty marking, lazy reconcile, and time-relative synthesis. Storage evidence tests exist in `test/connector-summary-read-model.test.js` (rebuild, dirty→stale, lazy reconcile of only-dirty rows, drop-on-delete, synthesis-free-columns guard), but time-relative synthesis remains deferred until task 1.1/3.x wires the read path.
- [x] Add Postgres parity tests for the storage fixtures. (Same file, gated on `PDPP_TEST_POSTGRES_URL`; same rebuild/dirty/reconcile shape as SQLite.)
- [ ] Add a query-count or dependency-injection test proving the full-list path avoids per-connection evidence fan-out.
- [ ] Run reference and console type checks.
- [ ] Run browser perf harness on dashboard, records list, exact source detail, and runs.
- [ ] Deploy in a declared live-stack window and verify `/_ref/connectors` latency plus owner-journey acceptance.
