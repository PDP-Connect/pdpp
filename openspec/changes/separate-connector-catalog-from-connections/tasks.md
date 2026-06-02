## 1. Investigation (done — this lane)

- [x] 1.1 Prove the root cause: dashboard read materializes + persists default-account rows for the whole public catalog when owner has zero connections. (Repro in `tmp/workstreams/ri-zero-record-connection-lifecycle-v1-report.md`; `ref-control.ts` `listConnectorInstanceRowsForDashboard` → `ensureDefaultAccountConnection` upsert.)
- [x] 1.2 Audit blast radius: which surfaces read the phantom rows and the grant fan-in resolution risk. (Audit summarized in the design note.)
- [x] 1.3 Confirm catalog completeness is owned by the `connectors` table + `GET /_ref/connectors`, not `connector_instances`. (Architecture spec "Reference connector catalog SHALL be complete"; completeness test asserts `connector_id` only.)

## 2. Core fix — a read never persists a connection

- [ ] 2.1 Remove the `ensureDefaultAccountConnection` fan-out from `listConnectorInstanceRowsForDashboard` in `reference-implementation/server/ref-control.ts`. Project not-connected catalog entries from registered connector rows instead, without writing `connector_instances` rows.
- [ ] 2.2 Add a not-connected catalog representation to `listConnectorSummaries` output: `connection_state: "not_connected"`, `connector_instance_id: null`, no `connection_id`, `total_records: 0`. Do not fabricate an instance id.
- [ ] 2.3 Regression test: on a fresh DB with listed connectors and zero owner connections, `listConnectorSummaries()` returns not-connected catalog entries AND `store.listByOwner(owner)` returns zero rows after the read (no persistence side effect).
- [ ] 2.4 Confirm `connector-public-catalog-completeness.test.js` still passes unchanged.
- [ ] 2.5 Grant-safety test: fan-in resolution for a connector with no connection resolves to "no active connection" (fails closed), not to a phantom binding.

## 3. Owner projection / console (depends on §2; owner-decision on shape)

- [ ] 3.1 Console: render not-connected catalog entries as "Available — not connected" with an Add action; do not offer Sync / pause / resume / revoke / delete on them. (Decide B1 separate add-surface vs B2 inline not-connected marker per design note.)
- [ ] 3.2 Update `shouldShowInPrimaryConnections` / "No data yet" classification so "No data yet" means a real connection that hasn't collected, never a catalog connector.
- [ ] 3.3 Console tests pin: zero real connections → zero connections listed + complete catalog of addable connectors; pinned add-connection guidance preserved.

## 4. Spec + docs

- [ ] 4.1 Fold the spec deltas into `reference-connector-instances` and `reference-implementation-architecture` on archive.
- [ ] 4.2 `openspec validate separate-connector-catalog-from-connections --strict`.

## Acceptance checks

- Fresh DB: zero owner connections → `listConnectorSummaries` returns catalog entries marked not-connected, `connector_instances` table empty after the read; catalog complete on `GET /_ref/connectors`.
- Grant fan-in for an unconnected connector does not bind to a phantom row.
- After one real connection exists, it appears as a connection; remaining catalog connectors stay not-connected.
- `connector-public-catalog-completeness.test.js` green; focused console + reference projection tests green; `git diff --check` clean.
