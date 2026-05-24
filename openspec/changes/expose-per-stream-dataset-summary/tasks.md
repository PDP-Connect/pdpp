# Tasks

## 1. Spec

- [x] 1.1 Add the new `_ref/dataset/summary/streams` route to the stable `_ref` read surface enumeration in `reference-implementation-architecture/spec.md` via the change's `ADDED Requirements` delta, with scenarios for the full-row response, the optional `connector_id` filter, and honest NULL/dirty-bound passthrough.

## 2. Read-model helper

- [x] 2.1 Add `listStreamProjections({ connectorId } = {})` to `reference-implementation/server/dataset-summary-read-model.js`. The helper SELECTs `connector_id, stream, record_count, record_json_bytes, earliest_ingested_at, latest_ingested_at, earliest_record_time, latest_record_time, consent_time_field, dirty_record_time_bounds, computed_at` from `dataset_summary_stream_projection`, optionally filtered by `connector_id`, sorted by `connector_id, stream`.
- [x] 2.2 Return rows as plain objects with `dirty_record_time_bounds` coerced to a boolean and NULL time bounds preserved as `null`.

## 3. Operation

- [x] 3.1 Create `reference-implementation/operations/ref-dataset-summary-streams/index.ts` exporting `executeRefDatasetSummaryStreams(dependencies)`.
- [x] 3.2 Dependencies: `listStreamProjections({ connectorId })` and `getProjectionMetadata()` (returns the same `RefDatasetSummaryProjectionMetadata` shape used by `ref.dataset.summary`).
- [x] 3.3 Operation owns the envelope: `{ object: 'dataset_summary_streams', streams: [...], projection: <metadata> }`, including normalization of the `connector_id` input filter (trim, null when empty) and `null`/boolean coercion for the per-row fields.
- [x] 3.4 Module obeys the operation-boundary rule (no Fastify/Express/Next/SQL/sandbox/process imports).

## 4. Route mount

- [x] 4.1 Import `listStreamProjections` and `executeRefDatasetSummaryStreams` in `reference-implementation/server/index.js`.
- [x] 4.2 Mount `app.get('/_ref/dataset/summary/streams', ownerAuth.requireOwnerSession, ...)` near the existing `/_ref/dataset/summary` route. The handler:
  - reads the optional `connector_id` query parameter,
  - wires `listStreamProjections({ connectorId })` for SQLite and `listRetainedSizeStreams({ connectorId })` for Postgres — both filter the same canonical `connector_id` column, never the `connector_instance_id` column,
  - resolves the metadata block from the existing dataset-summary projection (SQLite) or retained-size global (Postgres),
  - returns the operation's envelope.

## 5. Tests

- [x] 5.1 Extend `reference-implementation/test/dataset-summary-read-model.test.js` with cases for `listStreamProjections`:
  - returns all rows for all connectors sorted deterministically,
  - filters to a single `connector_id` when supplied,
  - passes NULL `earliest_record_time` / `latest_record_time` through as `null`,
  - exposes `dirty_record_time_bounds` as a boolean.
- [x] 5.2 Add `reference-implementation/test/ref-dataset-summary-streams-operation.test.js` mirroring the structure of `ref-dataset-summary-operation.test.js`:
  - envelope carries `object: 'dataset_summary_streams'` and the projection metadata block,
  - filter passthrough,
  - NULL/dirty-bound passthrough,
  - boundary rule still holds via the shared operation-boundary helper.

## 6. Validation

- [x] 6.1 `pnpm exec openspec validate expose-per-stream-dataset-summary --strict`
- [x] 6.2 `cd reference-implementation && node --test test/dataset-summary-read-model.test.js test/ref-dataset-summary-streams-operation.test.js test/ref-dataset-summary-operation.test.js`

## 7. Postgres connector_id filter fix

A revision of this change fixed a Postgres-path defect: the route was
forwarding the `connector_id` query parameter into the
`connectorInstanceId` filter slot of `listRetainedSizeStreams`, which
made the filter silently match against the wrong column. The route
contract (filter by `connector_id`) and the storage helper now agree.

- [x] 7.1 Extend `listRetainedSizeStreams` in `reference-implementation/server/retained-size-read-model.js` to accept `{ connectorId, connectorInstanceId, stream }`. Both backends now expose both columns as filterable; existing callers that pass `connectorInstanceId` are unchanged.
- [x] 7.2 Update the Postgres branch of `/_ref/dataset/summary/streams` in `reference-implementation/server/index.js` to pass `{ connectorId }` instead of `{ connectorInstanceId: connectorId }`. Inline comment pins the invariant.
- [x] 7.3 Add helper-level tests in `reference-implementation/test/retained-size-read-model.test.js` proving that `listRetainedSizeStreams({ connectorId })` narrows by `connector_id`, that `listRetainedSizeStreams({ connectorInstanceId })` does NOT match a `connector_id` value, and that `connectorId` and `stream` filters compose. SQLite-backed; the same helper signature is exercised on the Postgres path.
- [x] 7.4 Add a route-shape regression test asserting that the `connector_id` query parameter flows through `executeRefDatasetSummaryStreams` as `{ connectorId }` on the `listStreams` dependency and never as `connectorInstanceId`.
- [x] 7.5 Postgres route-level coverage is deferred: the helper signature on which the Postgres path depends is pinned by 7.3 / 7.4. Adding a dedicated Postgres test would require a `PDPP_TEST_POSTGRES_URL`-gated fixture; the narrower helper/operation tests catch the regression at the same call shape the host adapter uses.
