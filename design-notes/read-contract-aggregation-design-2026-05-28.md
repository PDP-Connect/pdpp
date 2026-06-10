# Canonical read-contract aggregation: date buckets, facets, frequency

Status: decided-promote
Owner: reference implementation owner (RI aggregation lane)
Created: 2026-05-28
Updated: 2026-05-28
Related: `openspec/specs/reference-implementation-architecture/spec.md` (Public aggregations requirements, lines ~794-833 and `rs.streams.aggregate` operation, lines ~1651-1674), `openspec/changes/canonicalize-public-read-contract`, `openspec/changes/polish-assistant-query-api-discovery`, `reference-implementation/server/records.js` (`aggregateRecords`), `packages/reference-contract/src/public/index.ts` (`AggregateQuerySchema`, `AggregationResponseSchema`), `packages/mcp-server/src/tools.js`, `design-notes/research/read-contract-aggregation-prior-art-2026-05-28.md`, `design-notes/external-gemini-flash-promises-audit-triage-2026-05-28.md`

## Question

What is the minimal canonical read-contract shape for aggregation, faceting, and
date bucketing that lets agents and a future data explorer get date histograms,
top-N values, term/emoji/value frequency, and counts without paginating an entire
corpus? Which parts are protocol-facing read contract versus reference-only
acceleration?

## Context

Aggregation is not greenfield. The reference already ships a canonical
single-stream aggregate operation:

- Endpoint: `GET /v1/streams/:stream/aggregate`
  (`reference-implementation/server/records.js`, `aggregateRecords`).
- Operations: `count`, `sum`, `min`, `max`, and `group_by` (single scalar field,
  returning grouped counts).
- `group_by` already supports `limit` (1-100, default 10) and deterministic
  ordering: count descending, then key ascending. Grouped counts are capped and
  sorted.
- Manifest-declared: only operations and fields listed in the stream manifest
  under `query.aggregations` (`count`, `sum[]`, `min[]`, `max[]`, `group_by[]`)
  are evaluable. Undeclared, non-scalar, array, object, blob, or high-cardinality
  fields are rejected.
- Grant-safe: input, grouping, and filter fields must be authorized under the
  caller's grant. Filters reuse record-list exact + declared `range_filters`
  validation, so `filter[date][gte]=...` already produces date-windowed
  aggregations.
- Capability discovery: per-stream metadata exposes `query.aggregations` and
  per-field `aggregation.{sum,min,max,group_by}.{declared,usable,reason}`.
- Contract: `AggregateQuerySchema` and `AggregationResponseSchema` in
  `@pdpp/reference-contract` define the wire shape; the OpenAPI artifacts are
  generated from them.
- Normative spec: `reference-implementation-architecture` already states the four
  durable requirements (single-stream and grant-safe; manifest-declared;
  reuse record-list filter semantics; grouped results bounded and deterministic)
  and an operation-owned `rs.streams.aggregate` requirement with byte-equivalence
  scenarios.

So the lane's real question is narrow: **what minimal extension closes the
date-bucket / facet / frequency / distinct gaps without inventing a BI engine,
and where does each piece belong.**

Verified current gaps (net-new, not already shipped):

1. No date bucketing. You can date-*window* an aggregation with a range filter,
   but you cannot get a per-day/week/month histogram in one call. To build a
   30-day histogram today an agent must issue 30 windowed counts or paginate all
   records. This is the single highest-value gap.
2. No `count_distinct`. "How many distinct senders?" requires paginating every
   record.
3. No MCP tool. The REST aggregate endpoint is not exposed as an MCP tool, so the
   agent surface that most needs token-efficient aggregation cannot reach it.
   `query_records`, `search`, `fetch`, `fetch_blob`, `schema`, `list_streams`
   exist; `aggregate` does not.

Findings that correct over-broad assumptions:

- "Top-N values" and "term/emoji/value frequency" are **already supported** for a
  single scalar field: `group_by=<field>&limit=N` returns the top-N values by
  count, descending. Emoji/term frequency is just `group_by` on the field that
  holds the term. The gap is not frequency-as-a-feature; it is (a) date as a
  groupable dimension and (b) discoverability/MCP reach.
- The current in-process scan (`records.js:2095` comment: "in-process ... it is a
  semantic floor") is deliberately the *semantic floor*, with a separate Postgres
  pushdown path for acceleration. That split is exactly the
  protocol-facing-vs-reference-acceleration boundary the lane was asked to draw.

## Stakes

- Agents are context-budget-bound. The prior-art synthesis (persisted in
  `design-notes/research/read-contract-aggregation-prior-art-2026-05-28.md`) is
  unambiguous: server-side aggregation is a token primitive, not an analytics
  nicety. A `count by sender` returning 12 rows instead of 4,000 records is the
  difference between a task that fits in context and one that does not.
- This must stay a canonical read-contract question (REST + MCP + CLI consistent),
  not an Explorer-only UI workaround. The active `canonicalize-public-read-contract`
  change makes exactly this point and explicitly excludes "arbitrary BI/facet
  features" from the public contract. Date bucketing and `count_distinct` are not
  arbitrary BI; they are the same class as the already-canonical `group_by`/`sum`.
  But faceted multi-field cross-tabs, percentiles, and sub-aggregations *are* the
  BI tail and must stay out.
- Over-building couples the backend to one explorer UI and breaks the SLVP bar.
  Under-building forces agents to paginate corpora, which a tool-call-capped agent
  cannot do.

## Current Leaning

Adopt a **measure + dimension** generalization of the existing aggregate
operation, keeping every current invariant (single-stream, grant-safe,
manifest-declared, filter-reuse, bounded/deterministic). Add the minimum that
closes the three real gaps. This is an extension of `query.aggregations`, not a
new query language.

### Proposed canonical shape (SLVP)

The existing flat query params stay valid (backward compatible). The
generalization is: a `group_by` *dimension* may be either a scalar field (today)
or a **time bucket** over a date/date-time field; and `metric` gains
`count_distinct`.

REST (additive query params on the same endpoint):

```
GET /v1/streams/:stream/aggregate
  ?metric=count                         # count|sum|min|max|count_distinct
  &field=<field>                        # required for sum|min|max|count_distinct
  &group_by=<scalar_field>              # existing: group by scalar value
  &group_by_time=<date_field>           # NEW: group by a time bucket
  &granularity=day                      # NEW: minute|hour|day|week|month|quarter|year
  &time_zone=America/New_York           # NEW: optional; default UTC
  &limit=N                              # existing bucket cap (1-100)
  &filter[...]=...                      # existing record-list filter semantics
```

Constraints (preserve construction quality):
- Exactly one grouping dimension in v1: `group_by` XOR `group_by_time`. No
  multi-dimension cross-tabs (that is the deferred BI tail).
- `granularity` is required when `group_by_time` is present, and forbidden
  otherwise. Units are exactly the SQL `date_trunc` set
  `{minute,hour,day,week,month,quarter,year}` (calendar-aware).
- `count_distinct` requires `field`, must be manifest-declared
  (`query.aggregations.count_distinct: [fields]`), and is documented as
  potentially approximate at scale (the reference floor computes it exactly; an
  accelerated path MAY approximate and MUST then set `approximate: true`).
- `group_by_time` field must be manifest-declared time-bucketable
  (`query.aggregations.group_by_time: [date_fields]`) and authorized under grant.
- Buckets remain bounded by `limit` and deterministically ordered. Time buckets
  order by bucket start ascending (a histogram is a series, not a top-N); scalar
  `group_by` keeps count-desc-then-key-asc.

Response (extends `AggregationResponseSchema`, additive):

```jsonc
{
  "object": "aggregation",
  "stream": "messages",
  "metric": "count",
  "field": null,
  "group_by": null,
  "group_by_time": "occurred_at",      // NEW, null when not a time grouping
  "granularity": "day",                // NEW, null when not a time grouping
  "time_zone": "UTC",                  // NEW, echo of effective zone
  "filtered_record_count": 4123,
  "limit": 100,
  "approximate": false,                // NEW; true only when an accelerated path estimates
  "groups": [
    { "key": "2026-05-01", "count": 87 },   // time-bucket key = ISO bucket start
    { "key": "2026-05-02", "count": 91 }
  ]
}
```

Null/missing handling (decide once, document):
- Scalar `group_by`: a single explicit `null` key bucket (current behavior;
  preserve). Never silently drop null-valued records.
- `group_by_time`: records whose time field is null/unparseable go to a single
  `{ "key": null }` bucket, never silently dropped.
- `count_distinct`: null is NOT counted as a distinct value (avoids the
  Elasticsearch cardinality off-by-one).
- Zero-fill is **out of scope for v1**: the reference returns only non-empty
  buckets. A `fill_empty` option that emits zero buckets across a range is a
  documented v2 nicety; a client/agent can derive gaps from the granularity and
  filter range. (Rationale: zero-fill needs an explicit bounded range to avoid
  unbounded bucket counts; deferring keeps responses bounded by construction.)

Capability discovery (extends existing per-stream metadata, no second model):
- `query.aggregations` gains `count_distinct: [fields]` and
  `group_by_time: [date_fields]`.
- Per-field `aggregation` descriptor gains `count_distinct` and `group_by_time`
  `{declared, usable, reason}` entries, plus a stream/global advertisement of the
  supported `granularity` set.
- The existing/planned `/v1/schema` discovery surface
  (`polish-assistant-query-api-discovery`) aggregates this; no new capability
  source.

Error semantics: identical classes to today (`invalid_request`, `unknown_field`,
`field_not_granted`, `grant_stream_not_allowed`). New rejections
(`group_by` + `group_by_time` together, missing/forbidden `granularity`,
undeclared time-bucket or distinct field) use the existing `invalid_request`
class with clear messages.

### MCP / REST / CLI parity

- Add an `aggregate` MCP tool that forwards exactly these parameters to the RS
  aggregate endpoint and mirrors the response into `structuredContent` per the
  `canonicalize-public-read-contract` MCP-mirror requirement. The tool schema
  encodes the allowed metrics, granularities, and the single-dimension rule so an
  agent self-discovers without trial and error. The MCP adapter requirement
  ("forward supported arguments, reject unsupported") already constrains this.
- CLI is optional for v1; if added it is a thin wrapper over the same operation.
  The lane does not block on a CLI command.

### Protocol-facing vs reference-only split

| Concern | Layer |
| --- | --- |
| Aggregate request/response wire shape, grant enforcement, manifest declaration, bounded/deterministic buckets, error classes, capability discovery | **Protocol-facing read contract** (reference-implementation-architecture spec + reference-contract schemas + MCP mirror). This is the canonical surface. |
| `date_trunc`-style time bucketing semantics, `count_distinct` semantics, single-dimension rule | **Protocol-facing** (it is observable contract behavior). |
| In-process scan vs Postgres pushdown; HLL/approximate distinct; aggregate indexes; bucket materialization | **Reference-only acceleration.** Implementation detail behind the contract. The `approximate` flag is the only place acceleration is allowed to surface, and only to tell the truth about estimation. |
| Explorer facet chips, multi-field cross-tabs, charts | **Explorer/UI** (out of this lane and out of the canonical contract). |

This keeps the `records.js:2095` "semantic floor" framing intact: the contract
defines *what* the aggregate means; the reference is free to accelerate *how* it
computes it as long as results match the floor (or honestly flag approximation).

### Does PDPP Core change?

No. Aggregation stays a reference-implementation / stream-`query`-capability
concern, consistent with the triage note's ruling that aggregation/read-plane
enhancements are "canonical read-contract work, not explorer-only UI features"
but are *reference* read-contract, not new Core grant/disclosure semantics. Core
already owns grant-scoped disclosure and the durable base query surface; the
aggregate endpoint is declared, stream-specific query power under
`streams[].query`, which Core already delegates to stream metadata. Nothing here
touches grant shape, manifest consent semantics, or selection-request structure.

## Strongest counterargument

**"Even this is BI creep. Follow Stripe: keep the live read API to list + filter +
cursor, and push any histogram/distinct work to a separate analytical surface or
let the client compute it."**

Weight: real, and it is why the active canonicalize change excludes arbitrary
facets. The rebuttal is the consumer. Stripe's clients are servers that can
paginate cheaply and run their own SQL/Sigma. PDPP's primary read consumer is a
context-budget-bound agent that *cannot* paginate a corpus into its window and
has no separate analytical store. For that consumer, date-bucket counts and
distinct counts are not analytics; they are the difference between answerable and
unanswerable within budget. The discipline the counterargument demands is honored
by keeping the surface to one grouping dimension, two new metrics-worth of power
(`group_by_time`, `count_distinct`), bounded/deterministic buckets, and an
explicit deferral of cross-tabs, percentiles, sub-aggs, disjunctive facets, and
zero-fill. That is the SLVP line: extend the already-canonical aggregate by the
minimum the agent consumer requires, and stop.

A secondary counterargument -- "fold this straight into
`canonicalize-public-read-contract`" -- is plausible but rejected for sequencing:
that change is deliberately scoped to *consolidating existing* identity/envelope/
count semantics and explicitly excludes facet features. Adding a new grouping
dimension and metric is a distinct, separately-reviewable contract delta. It
should be its own change that the owner can sequence after or alongside the
canonicalization, not smuggled into it.

## Implementation needed now?

No implementation in this lane (scope: read-only research + design note; no
runtime query-engine code). The design conclusion is clear enough to promote, but
promotion sequencing against the two active read-contract changes is an owner
decision, so this note stops at `decided-promote` with a ready-to-spec shape.

When promoted, the smallest safe first slice is **date bucketing + MCP exposure**
(the two highest-leverage gaps), with `count_distinct` as a fast follow:

1. Extend `query.aggregations` manifest schema and per-field capability descriptor
   with `group_by_time` and `count_distinct`.
2. Extend `AggregateQuerySchema` / `AggregationResponseSchema` and regenerate
   OpenAPI; add `group_by_time`/`granularity`/`time_zone`/`approximate`.
3. Implement `group_by_time` in the in-process floor (bucket by `date_trunc`
   semantics over the consent/declared time field) and in the Postgres path;
   add byte-equivalence/parity tests mirroring the existing aggregate tests.
4. Add the `aggregate` MCP tool with a schema that teaches the single-dimension
   rule and granularity set; mirror into `structuredContent`.
5. Add `count_distinct` to the floor (exact) and Postgres path; document the
   `approximate` contract for any future estimating path.

## Promotion Trigger

This note is `decided-promote`. Promote into an OpenSpec change (proposed name:
`add-aggregate-time-buckets-and-distinct`, modifying
`reference-implementation-architecture` and the generated reference contract)
before writing runtime code, because it changes a durable read-contract surface
(new request parameters, new response fields, new manifest declaration, new MCP
tool) that future reviewers must be able to audit. The owner sequences it against
`canonicalize-public-read-contract` and `polish-assistant-query-api-discovery`.

## Decision Log

- 2026-05-28: Verified current aggregate surface in code, contract, MCP tools,
  and the `reference-implementation-architecture` spec. Found aggregation is
  already canonical and shipped (`count/sum/min/max/group_by`, manifest-declared,
  grant-safe, bounded, discoverable). Net-new gaps are date bucketing,
  `count_distinct`, and MCP exposure; top-N and term/emoji frequency are already
  covered by `group_by`+`limit`. Persisted prior-art synthesis to
  `design-notes/research/read-contract-aggregation-prior-art-2026-05-28.md`.
  Concluded the SLVP extension is a single time-bucket grouping dimension plus
  `count_distinct`, single grouping dimension only, with cross-tabs / percentiles
  / sub-aggs / disjunctive facets / zero-fill explicitly deferred. Marked
  decided-promote; left promotion sequencing to the owner.
