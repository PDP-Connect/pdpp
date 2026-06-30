# Design

## Context

The existing Explore timeline endpoint already defines the authoritative owner-visible record set across `(connector_instance_id, stream)` partitions. The bucket endpoint uses the same set semantics and the same semantic timestamp expression, but returns aggregate counts instead of record bodies.

## Endpoint

`GET /_ref/explore/records/buckets` accepts the same connection and stream scope query parameters as `GET /_ref/explore/records`, plus optional `since`, `until`, `granularity`, and `time_zone`.

The response contains:
- `object: "explore_record_buckets"`
- `granularity`
- `time_zone`
- `extent: { start, end, count }`
- `buckets: [{ start, end, count }]`

`extent` is populated from matching records before bucket generation. If there are no matching records, the response returns `extent.start = null`, `extent.end = null`, `extent.count = 0`, and `buckets = []`.

## Granularity

When `granularity=auto` or no granularity is supplied, the server chooses from a calendar ladder:

`hour -> day -> week -> month -> quarter -> year`

The first granularity whose bucket count is at most 60 is selected. If none fits, `year` is selected. This keeps default full-extent charts calm without dropping zero buckets.

## Data Access

The implementation uses one aggregate query over `records`, scoped by the same filters as the merged timeline substrate:
- `deleted = 0/FALSE`
- optional connection and stream inclusion filters
- optional connection and stream exclusion filters
- semantic time is `COALESCE(NULLIF(semantic_time, ''), emitted_at)`

The query selects only timestamp/count data. It does not read `record_json`.

SQLite and Postgres use dialect-specific bucket expressions. Dense zero-fill is performed after the aggregate by walking the chosen calendar bucket range.

## Tradeoffs

Server-side dense fill keeps the client simple and makes the response directly renderable. It also avoids database-specific `generate_series` behavior and keeps the Postgres and SQLite implementations parallel.

The endpoint is owner-console reference behavior, not a new protocol primitive. Grant-scoped aggregate APIs are unchanged.

## Acceptance Checks

- `openspec validate add-explore-record-buckets --strict`
- Node tests prove SQLite and Postgres bucket responses are exact, dense, extent-aware, and do not read `record_json`.
- TypeScript checks pass.
