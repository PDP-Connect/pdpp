## Context

`add-dashboard-summary-read-model` introduced `dataset_summary_stream_projection`, a per-`(connector_id, stream)` projection maintained synchronously from record-write deltas and rebuildable from canonical storage. The columns on that table are already exactly what an owner-facing "how big is each stream, when was it last ingested, when does the underlying record-time range say it spans" inspection needs:

```
connector_id, stream, record_count, record_json_bytes,
earliest_ingested_at, latest_ingested_at,
earliest_record_time, latest_record_time,
consent_time_field, dirty_record_time_bounds, computed_at
```

The global hero endpoint `GET /_ref/dataset/summary` aggregates and tops-three those rows. There is no surface that exposes the per-row data itself, so the dashboard cannot drill from "the corpus contains N records" to "this connector's `messages` stream contributes M of them and its record-time bounds are still considered dirty".

This change adds the thin read endpoint over the existing rows. It does not touch the projection's write path or maintenance machinery.

## Decision

Add `GET /_ref/dataset/summary/streams` as a reference-only read endpoint that returns the per-stream projection rows directly. The endpoint:

- Reads from `dataset_summary_stream_projection` via a new helper `listStreamProjections({ connectorId? })` on `reference-implementation/server/dataset-summary-read-model.js`. The helper returns the full row list sorted by `connector_id, stream`. When `connectorId` is supplied, the helper filters to that connector.
- Wraps the rows in a `ref.dataset.summary.streams` operation envelope so the host adapter is a thin Fastify route. The operation mirrors `ref.dataset.summary` in style: dependencies-shaped, no framework imports, owns response shape.
- Surfaces the dataset-summary projection metadata block (`computed_at`, `state`, `stale_since`, `rebuild_status`, `last_error`, optional `source_high_watermark`) so the dashboard can render fresh/refreshing/stale/rebuilding/failed states without inventing new UX semantics.
- Honors NULL and dirty time-bound values honestly. `earliest_record_time` / `latest_record_time` may be `null` (no manifest-declared `consent_time_field`, or the bounds have not been reconciled yet). `dirty_record_time_bounds` is exposed as a boolean per row so the dashboard can flag values the projection believes are no longer trustworthy.
- Routes through the same owner-session gate as `GET /_ref/dataset/summary` (`ownerAuth.requireOwnerSession`).
- Uses `isPostgresStorageBackend()` to short-circuit to the existing `listRetainedSizeStreams({ connectorInstanceId })` Postgres helper when the Postgres backend is selected; SQLite paths read from `dataset_summary_stream_projection` directly. This keeps the storage abstraction consistent with how `/_ref/dataset/summary` and `/_ref/dataset/size` already branch.

## Rationale

The hard work — durable per-stream projection, synchronous delta maintenance, dirty-bound reconciliation, rebuild fencing, sanitized error metadata — is already shipped. The smallest faithful slice for the "zoom-in" UX is a read endpoint, not a new projection. Reusing the existing freshness metadata block means the dashboard can reuse its existing health-state rendering rather than inventing a parallel per-stream freshness vocabulary.

Pushing per-stream rows behind the same `_ref` surface and owner-session gate preserves the existing security boundary. The endpoint does not enable any new mutation, does not expose any new field that is not already in the projection table, and does not change the global summary shape.

## Out of Scope

- Blob bytes per stream and record-change bytes per stream. The projection does not store these today; surfacing them is a separate change with write-hook work.
- Pagination. The projection holds one row per `(connector_id, stream)`. Even with thousands of streams the row count is bounded by manifest declarations and is small enough for a single response; if that ever changes, pagination is a follow-on slice.
- Dashboard UI consumers. The brief intentionally splits API and UI commits so the API can land and be validated before the dashboard wires it up.
- Promoting the surface into PDPP protocol semantics. The endpoint stays under `_ref` and `record_json_bytes` remains an adapter-native operator diagnostic.

## Acceptance Checks

- `GET /_ref/dataset/summary/streams` returns one row per `(connector_id, stream)` from the dataset-summary stream projection without scanning raw `records` or `blobs`.
- The optional `connector_id` query parameter filters the response to rows for that connector while leaving the projection metadata block intact.
- Rows with NULL `earliest_record_time` / `latest_record_time` are surfaced as `null` rather than `0`, the empty string, or a zero-filled ISO timestamp.
- Rows whose projection believes the record-time bounds are stale carry `dirty_record_time_bounds: true` in the response.
- The response envelope carries the same projection metadata block (`computed_at`, `state`, `stale_since`, `rebuild_status`, `last_error`) the dashboard already consumes from `GET /_ref/dataset/summary`.
- Owner-session gating matches `GET /_ref/dataset/summary` — the route is mounted with `ownerAuth.requireOwnerSession` so the existing owner-auth tests cover it.
- The new operation module obeys the operation-boundary rule (no framework, raw DB, sandbox, or `process.env` imports).
