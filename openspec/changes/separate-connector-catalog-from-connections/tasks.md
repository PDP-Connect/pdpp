## 1. Investigation (done — this lane)

- [x] 1.1 Prove the root cause: dashboard read materializes + persists default-account rows for the whole public catalog when owner has zero connections. (Repro in `tmp/workstreams/ri-zero-record-connection-lifecycle-v1-report.md`; `ref-control.ts` `listConnectorInstanceRowsForDashboard` → `ensureDefaultAccountConnection` upsert.)
- [x] 1.2 Audit blast radius: which surfaces read the phantom rows and the grant fan-in resolution risk. (Audit summarized in the design note.)
- [x] 1.3 Confirm catalog completeness is owned by the `connectors` table + `GET /_ref/connectors`, not `connector_instances`. (Architecture spec "Reference connector catalog SHALL be complete"; completeness test asserts `connector_id` only.)

## 2. Core fix — a read never persists a connection (B1 shape)

Owner decision (lane `ri-zero-record-lifecycle-runtime-v1`): use the **B1** shape — catalog connectors live in the add-connection picker, NOT as fake rows (not even `not_connected` rows) in the connections projection. The owner connection projection lists only real connections. This is strictly simpler than the earlier B2-flavored draft and avoids propagating null `connector_instance_id` ids into every action-routing consumer (records page, diagnostics, grant-request picker, schedules, explore facets).

- [x] 2.1 Remove the `ensureDefaultAccountConnection` fan-out from `listConnectorInstanceRowsForDashboard` in `reference-implementation/server/ref-control.ts`. It now returns only the owner's real (configured / ingest-materialized) active rows; it writes no `connector_instances` rows. (`ref-control.ts` ~750.)
- [x] 2.2 `listConnectorSummaries` (`GET /_ref/connectors`) now projects only real connections — no fabricated rows, no null `connector_instance_id`. Catalog completeness moves to a dedicated honest catalog primitive `listPublicCatalogConnectorIds()` (registered `connectors` table filtered by `isPublicReferenceConnector`, creates no connection row) and the existing disk-manifest add-connection picker.
- [x] 2.3 Regression: on a fresh DB with listed connectors and zero owner connections, `listConnectorSummaries()` returns zero connections AND `store.listByOwner(owner)` returns zero rows after the read (no persistence side effect). (`connector-public-catalog-completeness.test.js` — "a fresh-DB catalog read projects zero connections and persists no phantom connection rows".)
- [x] 2.4 `connector-public-catalog-completeness.test.js` retargeted to assert completeness on the honest catalog surface (`listPublicCatalogConnectorIds`) instead of the connection projection, plus the no-persistence assertion. The hidden/unproven complement is asserted against the same catalog surface.
- [x] 2.5 Grant-safety test: fan-in resolution (`resolveFanInBindings`) for a connector with no connection returns no binding (fails closed) and the dashboard read persisted zero rows. (`grant-fan-in-fail-closed-no-phantom.test.js`; proven to fail when the old fan-out is reintroduced.)

## 3. Owner projection / console

Under the B1 shape this falls out of the backend fix: the console records list maps whatever `listConnectorSummaries` returns, which is now only real connections. Catalog connectors are served by the already-shipped add-connection picker (built from disk manifests, independent of `listConnectorSummaries`). No null-id rows reach the console, so Sync/pause/resume/revoke/delete are structurally never offered for a catalog-only connector.

- [x] 3.1 No console change required: catalog-only connectors no longer appear in the connection projection, so the row-action surface (Sync/pause/resume/revoke/delete) cannot render for them. The add-connection picker remains the catalog/Add surface.
- [x] 3.2 N/A under B1: "No data yet" already classifies a real connection that hasn't collected; a catalog connector is no longer in the projection to be misclassified.
- [x] 3.3 Covered by the reference-side fresh-DB assertion (zero connections + complete catalog primitive). The picker catalog read is unchanged (disk manifests) and already pinned by the add-connection picker tests on `main`.

## 4. Spec + docs

- [ ] 4.1 Fold the spec deltas into `reference-connector-instances` and `reference-implementation-architecture` on archive.
- [x] 4.2 `openspec validate separate-connector-catalog-from-connections --strict`.

## Acceptance checks

- Fresh DB: zero owner connections → `listConnectorSummaries` returns zero connections and `connector_instances` table is empty after the read; the catalog stays complete via `listPublicCatalogConnectorIds()` and the add-connection picker.
- Grant fan-in for an unconnected connector does not bind to a phantom row (fails closed).
- After one real connection exists, it appears as a connection; remaining catalog connectors do not appear in the connection projection and stay available to add.
- `connector-public-catalog-completeness.test.js` green; `grant-fan-in-fail-closed-no-phantom.test.js` green; reference projection / store / grant tests green; `git diff --check` clean.
