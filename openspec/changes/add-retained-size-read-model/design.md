## Context

The reference implementation already has a dataset-summary read model for the
operator dashboard. That read model is derived, rebuildable from canonical
records, and designed to avoid corpus scans on the dashboard hot path. The live
Postgres deployment showed why this matters: accurate raw aggregation over
millions of retained records can take many seconds.

The owner also wants a future data explorer to be straightforward: not a full
BI product today, but a clear substrate for asking which connections, streams,
record families, records, or blobs account for retained size.

## Prior Art

- BigQuery `INFORMATION_SCHEMA.TABLE_STORAGE` distinguishes logical, physical,
  active, long-term, and time-travel bytes. The lesson is to label byte
  categories explicitly rather than presenting one opaque "size" number.
- PostgreSQL relation-size functions expose physical storage. Useful for ops,
  but not the owner-facing retained logical bytes this dashboard needs.
- PostgreSQL materialized views persist derived rows, but plain refresh is a
  full recompute. The reference should keep application-maintained projection
  tables with rebuild/reconcile, not switch to materialized views.
- Datadog separates qualitative facets from quantitative measures with units.
  Retained size should be a typed byte measure; connection and stream are
  finite dimensions.
- Kibana Discover field statistics and Metabase drill-through show useful
  future UX patterns, but field stats and arbitrary drill-through query
  builders are separate design problems.

## Decision

Extend the dataset-summary read model into a retained-size read model. Keep it
narrow and reference-only:

- canonical records, record history, blobs, and manifests remain the source of
  truth;
- retained-size rows are derived and rebuildable;
- hot reads are bounded by projection rows, not corpus size;
- rows carry freshness/staleness/error metadata;
- measures are logical retained bytes, not physical disk bytes;
- dimensions are finite and authored by the reference/manifest, not arbitrary
  JSON paths.

## Measures

The read model SHALL use one semantic definition for each measure everywhere:

- `current_record_json_bytes`: UTF-8 bytes of current non-deleted record JSON.
- `record_history_json_bytes`: UTF-8 bytes of retained `record_changes` JSON.
- `blob_bytes`: retained content-addressed blob bytes attributed to the grain.
- `total_retained_bytes`: server-computed sum of the above categories.
- `record_count`: current non-deleted records.
- `record_history_count`: retained `record_changes` rows when available.
- `blob_count`: blob bindings attributed to the grain.

All byte measures are logical bytes. Physical database bytes are out of scope
for this change and must be labeled separately if exposed later.

## Grains

The read model SHOULD support:

- global dataset;
- connection (`connector_instance_id`);
- stream (`connector_instance_id`, `connector_id`, `stream`);
- optional record family (`connector_instance_id`, `connector_id`, `stream`,
  `record_family`).

`record_family` is optional and must be manifest-authored or otherwise
bounded by a finite connector-authored enum. The server must not group by
arbitrary JSON paths in this change.

## Top-N Heavy Hitters

Add a bounded top-N projection for questions such as "largest connections",
"largest streams", "largest blobs", and "largest records". Top-N rows contain
identifiers and measures, not raw payloads. The server caps result sizes and
marks stale or approximate results honestly when needed.

## Reference Endpoints

Add two owner-only reference reads:

- `GET /_ref/dataset/size`
- `GET /_ref/dataset/top`

These endpoints are operator-console surfaces, not PDPP Core APIs. They expose
projection rows only. They must not expose credentials, raw connector payloads,
or user data beyond identifiers and aggregate measures needed for owner
introspection.

## Out Of Scope

- Full data explorer UI.
- Arbitrary query builder or group-by engine.
- Field-level statistics, top values, cardinality, or distributions.
- Time-series history of retained size.
- Physical database storage metrics.
- Generic projection framework.

## Acceptance Checks

- Global, connection, and stream retained-size reads are row-bounded.
- The sum of fresh connection rows matches the fresh global total.
- Top-N responses are capped and contain drill-down identifiers only.
- Rebuild can regenerate retained-size rows from canonical state without
  connector reruns.
- Unsafe or failed maintenance marks rows stale instead of silently presenting
  stale values as fresh.
- Existing SQLite default behavior remains valid, and Postgres mode uses
  Postgres-backed projection rows.
