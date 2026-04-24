## Context

The reference can list records, filter records, search records, and expose operator-only dataset summaries. It does not provide public grant-scoped aggregations, so clients must over-fetch and compute summaries themselves. This is especially poor for finance, communications volume, alert-fatigue, and timeline analysis.

## Goals / Non-Goals

Goals:

- Add a narrow, auditable public aggregation floor.
- Reuse existing grant enforcement and filter validation.
- Make supported aggregate fields discoverable.
- Keep v1 single-stream and explicitly bounded.

Non-goals:

- Cross-stream joins, entity resolution, SQL expressions, arbitrary `GROUP BY`, window functions, percentiles, or dashboards.
- Making `_ref/dataset/summary` public or protocol-like.
- Optimizing every large aggregation path before the semantics are correct.

## Decisions

### Use a single-stream aggregate endpoint

Prefer `GET /v1/streams/:stream/aggregate` because it keeps source identity and grant enforcement aligned with record-list routes. Owner polyfill mode still requires `connector_id` where record-list routes do.

### Declare aggregate fields

Do not infer aggregatable fields from schema alone. Add a stream-level `query.aggregations` declaration so manifests choose which scalar fields are safe for grouping or numeric/date aggregation. This prevents accidental grouping on high-cardinality identifiers or sensitive free-text fields.

Aggregation discoverability uses `query.aggregations` as the source of truth. When stream metadata also exposes field-level capabilities, the reference projects per-field aggregation flags from that same declaration so clients can plan without reading two unrelated shapes. This projection is not a second source of truth.

### Reuse filters

Aggregation requests should accept existing exact and range filters. A query like "sum amount where date >= X" should use the same filter validation as record listing so behavior does not fork.

### Bound group cardinality

Grouped results need a limit and deterministic ordering. The first version should default to count-desc ordering for group buckets and reject requests likely to produce unbounded or unstable results.

## Acceptance Checks

- A client can count records in one granted stream without fetching pages.
- A client can sum a declared numeric field under a date filter.
- A client can group by a declared scalar field with a bounded result set.
- Unauthorized, undeclared, text-heavy, and cross-stream aggregation attempts fail loudly.
