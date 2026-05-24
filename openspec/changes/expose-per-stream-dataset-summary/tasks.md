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
  - wires `listStreamProjections` for SQLite and adapts `listRetainedSizeStreams({ connectorInstanceId })` for Postgres,
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
