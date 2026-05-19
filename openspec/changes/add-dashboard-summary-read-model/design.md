## Context

`GET /_ref/dataset/summary` is already part of the reference-only read surface. Today it computes the dashboard hero directly from raw storage on every request: live `records` counts/bytes/ingest bounds, `record_changes` bytes, `blobs` bytes, top connector counts, and per-manifest-stream JSON `MIN/MAX` over `consent_time_field` values. On the current Docker deployment this route has taken roughly 15-18s during active Gmail ingest, while the other dashboard calls are sub-second.

This change defines the architecture contract for a derived dataset-summary read model and corresponding dashboard loading semantics. It does not change public PDPP protocol semantics or prescribe a distributed event-processing system.

## Decision

Back `GET /_ref/dataset/summary` with a derived dataset-summary read model owned by the reference implementation. The read model is a reference-only projection of durable record/blob/change state. It may be stored in the existing reference database or an equivalent local reference store, but it must remain derived and rebuildable from canonical reference state.

The first read model should be narrow:

- a single global totals row for the existing summary envelope fields;
- per `(connector_id, stream)` rows for record counts, byte counts, ingest bounds, and record-time bounds where the stream has a manifest-declared `consent_time_field`;
- summary metadata for freshness, stale/error state, rebuild status, and sanitized failure details.

The reference should update exact counters and ingest bounds from durable write paths where doing so is safe and cheap. The narrowest hook is the record write transaction, which already knows whether a record changed, whether it was an upsert/delete, its connector/source identity, stream, JSON bytes, emitted time, and record key. Blob bytes should be maintained from blob insert/delete paths. Historical change bytes should be maintained from record-change append/prune paths.

Record-time `MIN/MAX` needs special care: writes can cheaply update maxima/minima when a new value extends the bounds, but an overwrite or delete of the current extremum may require a stream-scoped repair. The read model should therefore support marking a stream or global summary stale/dirty and reconciling that bounded slice from canonical records.

`GET /_ref/dataset/summary` should preserve the existing summary fields for compatibility and add projection metadata. The metadata should let the UI present freshness honestly:

- `computed_at`: when the returned summary values were produced.
- `state`: `fresh`, `refreshing`, `stale`, `rebuilding`, or `failed`.
- `stale_since` when the projection is known behind canonical evidence.
- `rebuild_status`: `idle`, `running`, or `failed`.
- `last_error`: sanitized diagnostic when rebuild/reconciliation fails.
- optional `source_high_watermark` when the implementation has a cheap canonical version/cursor.

The rebuild path should regenerate the summary from durable reference state without requiring connector reruns, credential access, or destructive data changes. Rebuilds may be manual/operator-triggered or startup/maintenance-triggered, but the dashboard must be able to show that a rebuild is in progress or failed.

The dashboard should not block shell/header rendering on summary refresh. It should show last-known facts when available, and otherwise show an honest loading/error placeholder. It must not render `0 records` unless a successfully computed summary says the true count is zero.

## Rationale

A derived read model keeps the dashboard fast while preserving canonical records, record changes, blobs, and manifests as evidence. Treating the summary as rebuildable avoids making it a new source of truth. Requiring stale/error metadata prevents the dashboard from hiding projection lag behind apparently authoritative counts.

The design intentionally avoids introducing a generalized projection framework. The first implementation only needs the dataset-summary projection, targeted write hooks, stream-scoped reconciliation, and a rebuild operation. If more projections appear later, the code can factor common pieces after the second concrete use case.

## Out Of Scope

- A public PDPP summary API.
- A generic event-sourcing framework or multi-projection platform.
- Real-time dashboard push updates.
- Changing canonical run, grant, trace, or record storage contracts.
- Requiring connector reruns to rebuild dashboard summary data.
- Reworking connector health, run timelines, grants, or trace list endpoints in this tranche.

## Implementation Notes

- The read model should contain only aggregate/dashboard-safe data, not credentials, OTP values, cookies, tokens, raw connector payloads, or interaction answers.
- Summary reads should be bounded by the read-model row(s), not by raw record, record-change, blob, timeline, or JSON-column scans.
- Write-path updates should be idempotent or transactionally coupled to canonical writes so duplicate processing does not corrupt counts.
- Reconciliation should be safe to run repeatedly and should either atomically replace the summary slice or mark the existing summary stale/failed until replacement succeeds.
- Rebuild diagnostics should be sanitized for dashboard display and logs should not leak secret runtime payloads.
- The first implementation may use synchronous projection maintenance for exact cheap counters and async/manual reconciliation for dirty time-bound extrema.

## Acceptance Checks

- `GET /_ref/dataset/summary` can return the dashboard overview without scanning raw `records`, `record_changes`, `blobs`, timelines, or JSON payload fields.
- New record/blob/change writes update or invalidate the summary projection safely.
- A reconciliation run catches the projection up after missed writes, dirty extrema, or an older database missing projection rows.
- A rebuild can regenerate the summary from durable reference state without connector reruns or credential access.
- The dashboard can distinguish fresh, stale, rebuilding, and failed summary states from response metadata.
- Projection failures preserve the existing canonical evidence and surface sanitized error metadata rather than silently serving apparently fresh old data.
- Initial dashboard shell/header and non-summary placeholders render without waiting for a fresh dataset-summary recomputation.

## Open Questions

- Should the first rebuild trigger be owner-manual only, startup-driven only, or both?
- Should projection metadata use a projection revision only, or also expose the newest observed canonical record/change/blob version where cheap?
