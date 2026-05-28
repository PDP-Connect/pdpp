# Design: aggregate time buckets and distinct

## Context

Promotion of `design-notes/read-contract-aggregation-design-2026-05-28.md`
(`decided-promote`). The aggregate operation is already canonical; this change is
the minimal measure + dimension generalization that closes the date-bucket,
distinct, and MCP-reach gaps without inventing a query language. Read the design
note for the full prior-art synthesis and the protocol-facing-vs-acceleration
table; this file records the decisions that bind the implementation.

## Decisions

### One grouping dimension: `group_by` XOR `group_by_time`

A `group_by` dimension is either a scalar field (today) or a time bucket over a
declared date/date-time field. The request carries at most one. Supplying both is
rejected (`invalid_request`). Multi-field cross-tabs are the deferred BI tail.

### Time bucket semantics

- `granularity` units are exactly the SQL `date_trunc` calendar set:
  `minute, hour, day, week, month, quarter, year`. Required when `group_by_time`
  is present, forbidden otherwise.
- `time_zone` is an optional IANA zone name; default and echo is `UTC`. Bucket
  boundaries are computed in the effective zone; bucket-start keys are emitted as
  ISO-8601 strings (date-only `YYYY-MM-DD` for day/week/month/quarter/year,
  full timestamp for minute/hour) interpreted as the start instant.
- Week starts Monday (ISO 8601), matching Postgres `date_trunc('week', ...)`.
- Records whose time field is null or unparseable bucket into a single
  `{ key: null }` bucket. Never silently dropped — an agent reasoning about
  completeness must see them.
- Buckets are bounded by `limit` and ordered by bucket start ascending (a
  histogram is a series, not a top-N). The null bucket sorts last. Scalar
  `group_by` is unchanged: count-desc then key-asc.
- Zero-fill is out of scope. The reference returns only non-empty buckets; a
  client derives gaps from granularity + filter range. Zero-fill needs a bounded
  range to stay bounded, which is a v2 nicety.

The reference computes buckets in JS over the same row scan that powers the other
metrics. The implementation is calendar-correct via `Intl.DateTimeFormat` with
the effective `timeZone`, so day/week/month/quarter/year boundaries respect the
zone and DST without a SQL `date_trunc` round trip. This keeps the in-process
semantic floor authoritative.

### `count_distinct`

- A metric, not a dimension. Requires `field`; the field must be manifest-declared
  under `query.aggregations.count_distinct` and authorized under the grant.
- Null is NOT counted as a distinct value (avoids the Elasticsearch cardinality
  off-by-one). Distinctness is by canonical JSON serialization of the raw value,
  matching the scalar `group_by` keying.
- Exact in the reference floor. The response always carries `approximate: false`
  from the floor. A future accelerated estimator (e.g. HLL) MAY set
  `approximate: true`; the contract reserves the field so acceleration can tell
  the truth, but the reference never estimates.
- `count_distinct` does not combine with grouping in v1 (it is a single scalar
  measure over the filtered set), consistent with the single-measure shape of
  `sum/min/max`.

### Response shape (additive)

`group_by_time`, `granularity`, `time_zone`, `approximate` are added to
`AggregationResponseSchema`. They are `null`/absent for non-time, non-distinct
calls so existing responses stay byte-compatible. `time_zone` is echoed only for
time groupings; `approximate` is present whenever the response reflects a metric
that could be estimated (`count_distinct`) and is `false` on the floor.

### Manifest + capability discovery

- `query.aggregations` gains `group_by_time: [date_fields]` (each must be a
  declared date/date-time field) and `count_distinct: [fields]` (each a declared
  scalar field). Manifest validation rejects undeclared or wrong-typed entries
  with the existing `invalid_connector_manifest` error.
- The per-field `aggregation` descriptor gains `group_by_time` and
  `count_distinct` `{declared, usable}` flags, surfaced through
  `GET /v1/schema` and stream metadata. The supported `granularity` set is a
  fixed, documented constant; it is advertised in the design note and the tool
  schema rather than re-emitted per field.

### MCP parity

A new `aggregate` MCP tool forwards `metric`, `field`, `group_by`,
`group_by_time`, `granularity`, `time_zone`, `limit`, `filter`, and
`connection_id` verbatim to `GET /v1/streams/{stream}/aggregate` and mirrors the
RS body into `structuredContent.data`. The tool input schema encodes the metric
enum (`count|sum|min|max|count_distinct`), the granularity enum, and documents the
single grouping dimension rule so an agent self-discovers without trial and error.
MCP forwards supported arguments and never silently drops one the RS would reject.

## Reference-only vs protocol-facing

Per the design note table: the request/response wire shape, grant enforcement,
manifest declaration, bounded/deterministic buckets, error classes, the
`date_trunc`-style time bucket and `count_distinct` semantics, and capability
discovery are protocol-facing read contract. The choice to compute in-process
versus push down, and any future approximate-distinct estimator, are
reference-only acceleration that surface only through `approximate`.

## Alternatives considered

- Fold into `canonicalize-public-read-contract`: rejected for sequencing — that
  change consolidates existing identity/envelope/count semantics and explicitly
  excludes facet features. A new grouping dimension and metric is a distinct,
  separately-reviewable delta.
- SQL `date_trunc` pushdown: deferred. No separate aggregate pushdown engine
  exists in this reference; the row scan is already backend-agnostic. Adding a
  pushdown would be a parallel acceleration path that must match the floor, which
  is exactly what `approximate`/floor-parity is designed to govern later.

## Acceptance checks

- `pnpm exec openspec validate add-aggregate-time-buckets-and-distinct --strict`.
- Reference aggregate/read tests cover: scalar `group_by` unchanged; date bucket
  grouping at day granularity; `time_zone` default + echo; null/unparseable time
  bucket; granularity required/forbidden/invalid-unit rejection; single grouping
  dimension rejection; exact `count_distinct` with null excluded and
  `approximate: false`; manifest validation of the new declarations.
- MCP aggregate tool schema + handler tests (forwarding, `structuredContent`
  mirror, error passthrough).
- `@pdpp/reference-contract` generated OpenAPI regenerated and `check:generated`
  clean.
