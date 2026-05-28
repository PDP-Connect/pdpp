## Why

`add-dashboard-summary-read-model` already writes one row per `(connector_id, stream)` into `dataset_summary_stream_projection`, carrying record count, record JSON bytes, ingest bounds, record-time bounds, the manifest `consent_time_field`, a dirty flag, and `computed_at`. Those rows are never read by any HTTP surface. The dashboard hero reads aggregates over them via `GET /_ref/dataset/summary`, but the owner cannot zoom into the per-stream breakdown without re-scanning canonical storage.

A thin reference-only read endpoint over those rows lets the dashboard surface "how big each stream is, when it was last touched, and whether its bounds are still trustworthy" without re-implementing the maintenance machinery.

## What Changes

- Add a reference-only `GET /_ref/dataset/summary/streams` endpoint that returns the per-`(connector_id, stream)` projection rows already maintained by the dataset-summary read model.
- Optional `?connector_id=<id>` filter narrows the response to one connector while preserving the same row shape.
- Each row exposes `connector_id`, `stream`, `record_count`, `record_json_bytes`, `earliest_ingested_at`, `latest_ingested_at`, `earliest_record_time`, `latest_record_time`, `computed_at`, and `dirty_record_time_bounds` honestly — NULL/dirty values pass through rather than being zero-filled.
- The response envelope carries the same projection-freshness metadata block as `GET /_ref/dataset/summary` (`computed_at`, `state`, `stale_since`, `rebuild_status`, `last_error`, optional `source_high_watermark`) so the dashboard can reuse its fresh/refreshing/stale/rebuilding/failed rendering.
- Mount a new `ref.dataset.summary.streams` operation envelope alongside the existing `ref.dataset.summary` operation so the surface stays host-agnostic.

## Capabilities

Modified:

- `reference-implementation-architecture`

## Impact

- Read-only additive surface. No schema changes, no new write hooks, no behavior change to `GET /_ref/dataset/summary`, `/rebuild`, or `/reconcile`.
- Affects `reference-implementation/server/dataset-summary-read-model.js` (new `listStreamProjections` helper), `reference-implementation/operations/ref-dataset-summary-streams/index.ts` (new operation envelope), and `reference-implementation/server/index.js` (one new route mount near the existing `/_ref/dataset/summary` route).
- Does not promote per-stream retained-size data into a PDPP protocol surface. `record_json_bytes` remains a reference-only operator diagnostic, consistent with `define-reference-operation-environments` contract correction (4).
- Out of scope: blob bytes per stream, record-change bytes per stream, dashboard UI consumers. Those are separate follow-on slices.
