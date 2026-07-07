---
title: "Extension Profile: Aggregation"
description: "Optional companion profile to the Personal Data Portability Protocol (PDPP) core spec defining a discoverable, grant-safe, single-stream aggregation surface."
---

<Callout type="info" title="Spec status">
  Status: **Draft extension profile**

  Optional; not required for PDPP Core conformance. Implementations advertise support via declared metadata (per Core §11 Extensions).

  Date: 2026-07-06
</Callout>

Companion to the Personal Data Portability Protocol (PDPP) core spec. This is an optional extension profile: it defines an additive capability and does not alter Core semantics.

---

## 1. Scope

This profile defines an optional aggregation capability exposed at `GET /v1/streams/{stream}/aggregate`: the per-stream aggregation declaration, the request surface, the response envelope, grant-enforcement obligations, and error semantics. It defines single-stream, manifest-declared aggregation only — counts, sums, extrema, distinct counts, and bounded grouping over declared scalar and calendar fields.

Core's exclusion of aggregation from the v0.1 base query surface is **unchanged**. This profile is additive and optional: a resource server that does not declare aggregation support on a stream is fully Core-conformant and MAY return `404` / `not_found` for the endpoint. A grant issued under Core authorizes exactly what Core Sections 6 and 8 define; this profile does not widen that authorization. It does **not** define cross-stream aggregation, aggregation over undeclared/non-scalar fields, or an arbitrary metric algebra; those are out of scope and, if requested, MUST be rejected (§5).

## 2. Capability advertisement

Aggregation is declared **per stream**, in the stream's existing metadata at `GET /v1/streams/{stream}`, under `query.aggregations`. A stream that does not participate omits `query.aggregations` entirely. The declaration enumerates exactly which operations are permitted over which fields; the server MUST evaluate only declared operations and fields. Aggregation is advertised in stream metadata under `query` because it is a stream-scoped capability — the available operations and fields depend on each stream's declared schema; server-scoped capabilities (such as lexical search, one endpoint spanning streams) are instead advertised in the resource server's top-level `capabilities` object.

```json
{
  "query": {
    "aggregations": {
      "count": true,
      "sum": ["amount"],
      "min": ["amount"],
      "max": ["amount"],
      "group_by": ["merchant", "category"],
      "group_by_time": ["transacted_at"],
      "count_distinct": ["merchant"]
    }
  }
}
```

| Operation | Declarable over | Requirement |
|-----------|-----------------|-------------|
| `count` | (whole stream) | Counts records visible under the grant. |
| `sum` | declared numeric scalar fields | Sums the field over grant-visible records. |
| `min` / `max` | declared scalar fields | Extrema of the field over grant-visible records. |
| `group_by` | declared scalar fields | Groups counts by the field's distinct values. |
| `group_by_time` | declared date / date-time fields | Groups counts into calendar buckets. A declared `group_by_time` field's schema MUST be a `string` with `format` `date` or `date-time` (or the nullable variant). |
| `count_distinct` | declared top-level scalar fields | Counts distinct values of the field. |

Undeclared fields, non-scalar fields, arrays, objects, blobs, and undeclared high-cardinality fields MUST NOT be aggregable and MUST be rejected (§5).

## 3. Interface

### `GET /v1/streams/{stream}/aggregate`

Single-stream aggregation. The server aggregates over exactly one stream per request.

| Parameter | Type | Requirement |
|-----------|------|-------------|
| `metric` | string | The aggregation operation: `count`, `sum`, `min`, `max`, or `count_distinct`. MUST be declared for the stream (and, for `sum`/`min`/`max`/`count_distinct`, declared over `field`). |
| `field` | string | REQUIRED for `sum`, `min`, `max`, `count_distinct`. MUST be present in the corresponding `query.aggregations` declaration and authorized under the grant. |
| `group_by` | string | OPTIONAL. A declared scalar field to group counts by. Mutually exclusive with `group_by_time`: combining both MUST be rejected with `invalid_request` (400, `invalid_request_error`). |
| `group_by_time` | string | OPTIONAL. A declared date/date-time field to bucket counts by. Mutually exclusive with `group_by` (same rejection). |
| `granularity` | string | REQUIRED when `group_by_time` is present — omitting it MUST be rejected with `invalid_request`. FORBIDDEN otherwise: supplying it without `group_by_time` MUST be rejected, not ignored. MUST be one of `minute`, `hour`, `day`, `week`, `month`, `quarter`, `year`. |
| `time_zone` | string | OPTIONAL with `group_by_time`; FORBIDDEN otherwise — supplying it without `group_by_time` MUST be rejected, not ignored. MUST be an IANA time zone name; fixed offsets such as `+05:00` MUST be rejected with `invalid_request` ("Unknown time_zone"). Defaults to `UTC` when omitted. |
| `limit` | integer | OPTIONAL on grouped requests only; supplying `limit` on an ungrouped request MUST be rejected. Defaults to `10`; MUST be an integer between 1 and 100. |
| `filter[{field}][{op}]` | string | OPTIONAL. Same exact and declared range-filter validation as record-list requests (`query.range_filters`); applied **before** aggregation. |

Aggregation requests reuse record-list filter semantics exactly: unsupported, unauthorized, or malformed filters fail with the same error class as record-list filtering, and declared range filters apply the same coercion and comparison semantics.

Parameter validation is strict: an out-of-range or non-integer `limit` MUST be rejected with `invalid_request` rather than clamped — unlike Core's record-list `limit`, which clamps to the maximum and warns (`limit_clamped`), this profile treats it as an error.

### Response envelope

Every aggregation response is an `aggregation` object with a fixed base envelope — `object`, `stream`, `metric`, `field`, `group_by`, `group_by_time`, `granularity`, `time_zone`, `approximate`, `filtered_record_count` — followed by exactly one result shape: an ungrouped aggregation carries a scalar `value` and MUST NOT include `other_count`; a grouped aggregation (`group_by` or `group_by_time`) carries `limit` (the applied group limit), bounded and deterministically ordered `groups[]` of `{key, count}` objects, and `other_count`. Parameters unused by the request appear as `null` rather than being omitted. `approximate` is currently always `false`; it is reserved for future approximate metrics. Responses are wrapped in the canonical envelope, which adds `links.self` and `meta` (`meta.count`, `meta.warnings`) — that wrapper metadata is defined by Core, not this profile.

Ungrouped example (`metric=sum&field=amount`):

```json
{
  "object": "aggregation",
  "stream": "transactions",
  "metric": "sum",
  "field": "amount",
  "group_by": null,
  "group_by_time": null,
  "granularity": null,
  "time_zone": null,
  "approximate": false,
  "filtered_record_count": 312,
  "value": 10428.55
}
```

Grouped example (`group_by=merchant&limit=3`):

```json
{
  "object": "aggregation",
  "stream": "transactions",
  "metric": "count",
  "field": null,
  "group_by": "merchant",
  "group_by_time": null,
  "granularity": null,
  "time_zone": null,
  "approximate": false,
  "filtered_record_count": 312,
  "limit": 3,
  "groups": [
    { "key": "amazon", "count": 128 },
    { "key": "netflix", "count": 44 },
    { "key": "spotify", "count": 31 }
  ],
  "other_count": 109
}
```

**Bounded, deterministic grouping.** A grouped response MUST enforce a maximum bucket limit and deterministic ordering. Scalar `group_by` buckets MUST be ordered by count descending, then key ascending. Calendar `group_by_time` buckets MUST be returned in ascending calendar order. When more distinct groups/buckets exist than `limit`, the response MUST contain exactly `limit` groups and set `other_count` to the sum of counts for all truncated groups (a positive integer). When all groups fit, `other_count` MUST be `0`. `other_count` MUST be present on every grouped response and absent on ungrouped responses.

## 4. Grant enforcement

Aggregation MUST respect the caller's grant scope before any values are computed.

- The server MUST evaluate only operations and fields declared in the stream's `query.aggregations` (§2). Undeclared operations/fields MUST be rejected (§5), never silently ignored.
- The metric input field, any grouping field, and any filter field MUST be authorized under the caller's grant (or owner scope) **before** aggregation evaluation. Fields outside the grant MUST NOT influence the result.
- A `count` for a client token authorized for the stream MUST count only records visible under that grant.
- Filters apply before aggregation, so grouped counts, sums, extrema, and distinct counts reflect only the grant-visible, filtered record set.
- Aggregation is single-stream: a request that spans multiple streams MUST be rejected unless a later accepted change defines cross-stream semantics.

## 5. Errors and warnings

Errors reuse Core's structured error envelope (`{ "error": { type, code, message, param?, request_id } }`). This profile introduces no new codes.

| Condition | Code | HTTP | Type |
|-----------|------|------|------|
| Endpoint requested but stream declares no `query.aggregations` | `not_found` | 404 | `not_found_error` |
| Aggregation over a field absent from the stream's declaration | `invalid_request` | 400 | `invalid_request_error` |
| `metric=count_distinct` over a field absent from `query.aggregations.count_distinct` | `invalid_request` | 400 | `invalid_request_error` |
| Cross-stream / multi-stream aggregation (no defined semantics) | `invalid_request` | 400 | `invalid_request_error` |
| Invalid parameter combination: `group_by` combined with `group_by_time`; `limit` without grouping; `granularity` or `time_zone` without `group_by_time`; `group_by_time` without `granularity`; unknown `granularity` or `time_zone`; out-of-range or non-integer `limit` | `invalid_request` | 400 | `invalid_request_error` |
| Filter targets a field outside the grant's authorized projection | `field_not_granted` | 403 | `permission_error` |
| Unsupported / malformed range filter | (same class as record-list filtering) | 400 | `invalid_request_error` |

Undeclared or unauthorized aggregations MUST fail with a clear query error; they MUST NOT be silently honored or coerced into a declared operation.

## 6. Conformance checklist

An implementation claiming this profile MUST satisfy:

1. Aggregation support is declared per stream under `query.aggregations` in `GET /v1/streams/{stream}` metadata; a non-participating stream omits it and the endpoint MAY return `404` / `not_found`.
2. `GET /v1/streams/{stream}/aggregate` aggregates exactly one stream per request; multi-stream requests are rejected.
3. Only the operations and fields enumerated in `query.aggregations` are evaluable; the declarable operations are exactly `count`, `sum`, `min`, `max`, `group_by`, `group_by_time`, and `count_distinct`.
4. `group_by_time` fields are declared date/date-time (`string` with `format` `date` or `date-time`, or nullable variant); `count_distinct` fields are declared top-level scalars.
5. The metric input field, grouping field, and filter fields are authorized under the grant before evaluation; fields outside the grant do not influence the result.
6. Filters reuse record-list exact/range validation and semantics and are applied before aggregation.
7. Grouped responses are bounded by `limit` and deterministically ordered — `group_by` by count desc then key asc, `group_by_time` by ascending calendar order.
8. Every grouped response includes `other_count` (positive when truncated, `0` when all groups fit); ungrouped responses omit `other_count`.
9. Undeclared, non-scalar, or unauthorized aggregation requests fail with a clear query error and are never silently honored.
10. Parameter validation is strict, not lenient: `granularity` is required with `group_by_time` (from the enum `minute`, `hour`, `day`, `week`, `month`, `quarter`, `year`) and rejected without it; `time_zone` is IANA-name-only, defaults to `UTC`, and is rejected without `group_by_time`; `limit` defaults to 10, is bounded 1–100, errors (never clamps) when out of range or non-integer, and is rejected on ungrouped requests; `group_by` + `group_by_time` together are rejected. All such rejections use `invalid_request` (400, `invalid_request_error`).
