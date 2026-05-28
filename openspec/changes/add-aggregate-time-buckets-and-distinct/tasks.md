# Tasks: add-aggregate-time-buckets-and-distinct

## 1. Reference contract (schemas + generated OpenAPI)

- [x] 1.1 Extend `AggregateQuerySchema` with `group_by_time`, `granularity` (enum), and `time_zone`; add `count_distinct` to the `metric` enum.
- [x] 1.2 Extend `AggregationResponseSchema` with `group_by_time`, `granularity`, `time_zone`, `approximate`; add `count_distinct` to its `metric` enum.
- [x] 1.3 Extend `StreamMetadataResponseSchema` `query.aggregations` with `group_by_time` and `count_distinct` arrays, and the per-field `aggregation` descriptor with `group_by_time` and `count_distinct` flags.
- [x] 1.4 Update the `aggregateStream` manifest summary to describe the new parameters.
- [x] 1.5 Regenerate OpenAPI + docs and confirm `pnpm --filter @pdpp/reference-contract run check:generated` is clean.

## 2. Manifest validation + capability discovery

- [x] 2.1 `server/auth.js`: allow `group_by_time` and `count_distinct` keys in `query.aggregations`; validate `group_by_time` entries are declared date/date-time fields and `count_distinct` entries are declared scalar fields.
- [x] 2.2 `server/index.js`: extend `buildFieldAggregationCapabilities` with `group_by_time` and `count_distinct` flags.

## 3. REST aggregate parsing/validation + in-process floor

- [x] 3.1 `server/records.js`: add `group_by_time`/`granularity`/`time_zone` and `count_distinct` to top-level param validation and `normalizeAggregateRequest`, including the single-dimension (`group_by` XOR `group_by_time`) rule, granularity required/forbidden/enum check, and declared/granted checks for the new field references.
- [x] 3.2 `server/records.js`: implement a pure `bucketStartForGranularity(value, granularity, timeZone)` helper with calendar `date_trunc` semantics (UTC default, IANA zone via `Intl`, Monday week start) and a null/unparseable → `null` bucket.
- [x] 3.3 `server/records.js`: implement `group_by_time` bucketing and exact `count_distinct` (null excluded) in `aggregateRecords`; emit `group_by_time`, `granularity`, `time_zone`, `approximate` additive fields; order time buckets by bucket start ascending with the null bucket last.
- [x] 3.4 Confirm the in-process floor remains the single parity-preserving path for both SQLite and Postgres (no separate pushdown introduced); `approximate` is always `false` from the floor.

## 4. Operation instrumentation

- [x] 4.1 `operations/rs-streams-aggregate/index.ts` + `server/index.js`: additively carry `group_by_time` and `granularity` in the `query.received` data block; preserve `query_shape: 'stream_aggregate'`.

## 5. MCP aggregate tool

- [x] 5.1 `packages/mcp-server/src/tools.js`: add an `aggregate` tool forwarding `metric`/`field`/`group_by`/`group_by_time`/`granularity`/`time_zone`/`limit`/`filter`/`connection_id` to `GET /v1/streams/{stream}/aggregate` and mirroring the body into `structuredContent.data`. Input schema encodes the metric and granularity enums and documents the single grouping dimension rule.

## 6. Tests

- [x] 6.1 Reference: scalar `group_by` unchanged behavior (regression).
- [x] 6.2 Reference: date bucket grouping at day granularity; `time_zone` default + echo; explicit zone; null/unparseable bucket; granularity required/forbidden/invalid-unit rejection; single grouping dimension rejection.
- [x] 6.3 Reference: exact `count_distinct` with null excluded and `approximate: false`; undeclared/ungranted distinct field rejection.
- [x] 6.4 Reference: manifest validation accepts valid `group_by_time`/`count_distinct` and rejects wrong-typed/undeclared entries.
- [x] 6.5 Reference: stream metadata / schema advertises `group_by_time` and `count_distinct` declared lists and per-field flags.
- [x] 6.6 MCP: `aggregate` tool schema (metric/granularity enums, single-dimension doc) and handler (forwarding + `structuredContent` mirror + error passthrough).
- [x] 6.7 Contract: covered by the regenerated OpenAPI artifacts (verified to carry the new query params, response fields, and `count_distinct` metric enum) and the 47 passing `@pdpp/reference-contract` tests. The package has no aggregate-specific schema unit test; field-level behavior is proven by the reference and MCP suites.

## 7. Validation

- [x] 7.1 `pnpm exec openspec validate add-aggregate-time-buckets-and-distinct --strict`.
- [x] 7.2 Reference aggregate/read + operation tests pass.
- [x] 7.3 MCP server tests pass.
- [x] 7.4 `pnpm --filter @pdpp/reference-contract run check:generated` clean.
- [x] 7.5 `git diff --check`; grep changed public names for old/new consistency.

## Acceptance checks

Reproducible commands:

```
pnpm exec openspec validate add-aggregate-time-buckets-and-distinct --strict
pnpm --filter @pdpp/reference-contract run check:generated
node --test reference-implementation/test/query-contract.test.js
node --test reference-implementation/test/aggregate-time-buckets.test.js
node --test packages/mcp-server/test/*aggregate*.test.js
```

## Residual: HTTP owner-read harness baseline blocker

The end-to-end `GET /v1/streams/:stream/aggregate` HTTP tests in
`query-contract.test.js` (the owner-mode aggregate/records reads) currently
return `404 connection_not_found` ("No active connection is available for
connector 'undefined'") on this branch's HEAD **before any aggregation
change** — verified by stashing all runtime edits and re-running at clean
HEAD (13 pass / 29 fail, the same set). This is the in-flight
canonical-connector-keys / connection-identity migration affecting URL-form
`connector_id` resolution in owner-mode reads, not this lane. The aggregate
semantics here are fully validated through the deterministic storage-layer
path (`aggregate-time-buckets.test.js` drives `aggregateRecords` directly with
`initDb()` + `ingestRecord`, the same path the route's `aggregate` dependency
wires), the `rs.streams.aggregate` operation tests, the MCP tool tests, and
the (passing) stream-metadata capability HTTP test. The owner agent should
re-run the `query-contract.test.js` HTTP aggregate assertions once the
connector-key owner-read regression is resolved.
