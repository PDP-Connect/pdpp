## Why

The reference already ships a canonical single-stream aggregate operation
(`count`, `sum`, `min`, `max`, scalar `group_by`), manifest-declared, grant-safe,
bounded, and discoverable. Three gaps remain for the read surface that most needs
them — a context-budget-bound agent that cannot paginate a corpus into its window:

- No date bucketing. You can date-*window* an aggregation with a range filter,
  but a per-day/week/month histogram requires N windowed calls or paginating
  every record.
- No `count_distinct`. "How many distinct senders?" requires paginating every
  record.
- No MCP aggregate tool. The REST endpoint is not exposed to the agent surface
  that benefits most from token-efficient aggregation.

These are the same class as the already-canonical `group_by`/`sum`, not a BI
engine. The decision and prior art are recorded in
`design-notes/read-contract-aggregation-design-2026-05-28.md` (status
`decided-promote`) and
`design-notes/research/read-contract-aggregation-prior-art-2026-05-28.md`.

## What Changes

- Add `group_by_time=<date_field>` with `granularity=minute|hour|day|week|month|quarter|year`
  and optional `time_zone` (UTC default, echoed) to the aggregate request.
- Enforce exactly one grouping dimension in v1: `group_by` XOR `group_by_time`.
- Add a `count_distinct` metric over a declared field; null is not counted; exact
  in the reference floor; an accelerated path MAY estimate and MUST then set
  `approximate: true`.
- Add additive response fields: `group_by_time`, `granularity`, `time_zone`,
  `approximate`. Time-bucket keys are ISO bucket starts; null/unparseable time
  values go to a single `{ key: null }` bucket. Time buckets order by bucket
  start ascending; scalar `group_by` keeps count-desc-then-key-asc.
- Extend manifest `query.aggregations` with `group_by_time: [date_fields]` and
  `count_distinct: [fields]`, and the per-field `aggregation` capability
  descriptor with `group_by_time` and `count_distinct` flags.
- Add an `aggregate` MCP tool that forwards these parameters verbatim and mirrors
  the response into `structuredContent`; its input schema teaches the allowed
  metrics, granularities, and the single-dimension rule.
- Reject unsupported combinations (`group_by` + `group_by_time`, missing/forbidden
  `granularity`, undeclared time-bucket or distinct field) with the existing
  `invalid_request` error class.

Explicitly out of scope (the deferred BI tail): multi-field cross-tabs,
sub-aggregations, percentiles, `width_bucket`, disjunctive facets, bucket
pagination, and zero-fill.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `reference-implementation-architecture`: extend the public-aggregation
  requirements and the operation-owned `rs.streams.aggregate` requirement with
  time-bucket grouping, the single grouping dimension rule, `count_distinct`,
  additive response fields, manifest/capability discovery additions, MCP
  aggregate parity, and strict rejection of unsupported combinations.

## Impact

- Affects the `aggregateStream` public read operation, the generated
  `@pdpp/reference-contract` schemas and OpenAPI artifacts, manifest validation
  (`server/auth.js`), capability discovery (`server/index.js`,
  `GET /v1/schema` / stream metadata), the in-process aggregate floor
  (`server/records.js`), the `rs.streams.aggregate` operation instrumentation,
  and the MCP server tool set.
- The reference computes both date bucketing and `count_distinct` in the same
  in-process semantic floor used by `count/sum/min/max/group_by`; there is no
  separate Postgres aggregate pushdown engine in this reference, so the floor is
  the single parity-preserving path for both SQLite and Postgres backends. The
  `approximate` flag is reserved for any future accelerated estimator and is
  always `false` on the exact floor.
- No PDPP Core change. No grant shape, manifest consent semantics, or
  selection-request structure changes.
