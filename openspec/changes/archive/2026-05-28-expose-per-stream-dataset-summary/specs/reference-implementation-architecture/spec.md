## MODIFIED Requirements

### Requirement: Reference-only surfaces are explicit
Debugging, replay, trace, dashboard summary, and operator-control surfaces that are useful for the reference implementation but are not part of core PDPP SHALL be explicitly marked as reference-only.

#### Scenario: A trace or timeline endpoint is exposed
- **WHEN** the implementation exposes trace, timeline, or similar introspection surfaces
- **THEN** those surfaces SHALL be clearly described as reference-only artifacts rather than as core PDPP protocol requirements

#### Scenario: The current `_ref` read surface is treated as stable substrate
- **WHEN** the implementation exposes the current reference-designated event-spine readers
- **THEN** the durable `_ref` read surface SHALL stay limited to:
  - `GET /_ref/traces/:traceId`
  - `GET /_ref/grants/:grantId/timeline`
  - `GET /_ref/runs/:runId/timeline`
  - `GET /_ref/traces` (list, filter, paginate)
  - `GET /_ref/grants` (list, filter, paginate)
  - `GET /_ref/runs` (list, filter, paginate)
  - `GET /_ref/search?q=...` (id-aware read-only jump helper)
  - `GET /_ref/dataset/summary` (dashboard overview dataset summary)
  - `GET /_ref/dataset/summary/streams` (per-`(connector_id, stream)` dataset-summary projection rows)

#### Scenario: The dashboard summarizes dataset credibility
- **WHEN** the reference dashboard renders a dataset summary or credibility overview
- **THEN** it MAY consume `GET /_ref/dataset/summary`
- **AND** that route SHALL remain documented as a reference-only read surface rather than as a public PDPP API

#### Scenario: A later control-plane phase widens `_ref` mutation narrowly
- **WHEN** a later control-plane phase needs a truthful operator mutation surface for a live bounded collection run
- **THEN** the reference MAY add an owner-only `_ref` mutation endpoint limited to:
  - `POST /_ref/runs/:runId/interaction`
- **AND** that route SHALL be documented as reference-only control-plane behavior rather than as a public PDPP API
- **AND** the reference SHALL NOT widen `_ref` into broader mutation/control endpoints in the same tranche without a further explicit OpenSpec change

#### Scenario: Run timelines expose checkpoint staging separately from checkpoint commit
- **WHEN** the reference runtime receives `STATE` during a bounded collection run
- **THEN** the `_ref` run timeline SHALL distinguish checkpoint staging from checkpoint commit so the checkpointed-streaming model is visible in reference artifacts rather than implied only by runtime internals

#### Scenario: Runtime validation failures remain inspectable in the reference substrate
- **WHEN** a bounded collection run fails because the runtime rejects connector output or an interaction handler response before `DONE`
- **THEN** the durable `_ref` run timeline SHALL still record `run.failed` with an explicit machine-readable reason instead of leaving that failure visible only as a thrown local error

## ADDED Requirements

### Requirement: The dashboard summary stream rows are exposed as a reference-only read
The reference implementation SHALL expose the per-`(connector_id, stream)` rows already maintained by the dataset-summary read model as a reference-only read endpoint so the dashboard can render a per-stream retained-size breakdown without re-scanning canonical records, record changes, or blobs.

#### Scenario: The endpoint returns every projection row
- **WHEN** an authorized owner requests `GET /_ref/dataset/summary/streams` with no query parameters
- **THEN** the reference SHALL return one row per `(connector_id, stream)` from the dataset-summary stream projection
- **AND** each row SHALL carry `connector_id`, `stream`, `record_count`, `record_json_bytes`, `earliest_ingested_at`, `latest_ingested_at`, `earliest_record_time`, `latest_record_time`, `computed_at`, and `dirty_record_time_bounds`
- **AND** the response SHALL be bounded by the projection rows rather than by the size of the canonical records substrate
- **AND** the response envelope SHALL carry the same projection-freshness metadata block (`computed_at`, `state`, `stale_since`, `rebuild_status`, `last_error`, optional `source_high_watermark`) that `GET /_ref/dataset/summary` exposes

#### Scenario: The optional connector_id filter narrows the response
- **WHEN** an authorized owner requests `GET /_ref/dataset/summary/streams?connector_id=<id>`
- **THEN** the reference SHALL return only the projection rows whose `connector_id` matches the supplied value
- **AND** the response envelope SHALL still carry the same projection-freshness metadata block, unchanged by the filter
- **AND** an empty result set SHALL be returned as an empty `streams` array rather than as a 404

#### Scenario: NULL and dirty time bounds are surfaced honestly
- **WHEN** a projection row has no manifest-declared `consent_time_field`, has never been reconciled, or carries the dirty-bound flag set
- **THEN** `earliest_record_time` and `latest_record_time` SHALL be returned as `null` for that row rather than zero-filled, empty-string, or fabricated values
- **AND** `dirty_record_time_bounds` SHALL be returned as a boolean indicating whether the projection believes the record-time bounds are no longer trustworthy
- **AND** the dashboard SHALL be able to distinguish a row whose record-time bounds are honestly unknown from a row whose bounds are known and fresh

#### Scenario: The endpoint stays an owner-gated reference-only surface
- **WHEN** the reference implementation mounts `GET /_ref/dataset/summary/streams`
- **THEN** that route SHALL be gated by the same owner-session check that gates `GET /_ref/dataset/summary`
- **AND** that route SHALL remain documented as a reference-only read surface rather than as a public PDPP API
