# Read-Contract Aggregation Prior Art

Status: captured
Owner: reference implementation owner (RI aggregation lane)
Created: 2026-05-28
Updated: 2026-05-28
Related: `design-notes/read-contract-aggregation-design-2026-05-28.md`, `openspec/specs/reference-implementation-architecture/spec.md` (Public aggregations requirements), `openspec/changes/canonicalize-public-read-contract`, `openspec/changes/polish-assistant-query-api-discovery`

This is a persisted research record for the canonical read-contract aggregation
lane. It grounds the companion design note. Conclusions here are non-normative
prior art, not PDPP requirements.

## Sources consulted

- Elasticsearch / OpenSearch aggregations: `terms`, `date_histogram`,
  `cardinality`, `composite`.
  - https://www.elastic.co/docs/reference/aggregations/search-aggregations-bucket-terms-aggregation
  - https://www.elastic.co/guide/en/elasticsearch/reference/current/search-aggregations-bucket-datehistogram-aggregation.html
  - https://www.elastic.co/guide/en/elasticsearch/reference/current/search-aggregations-metrics-cardinality-aggregation.html
  - https://docs.opensearch.org/latest/aggregations/bucket/date-histogram/
- Stripe API pagination + Sigma split.
  - https://docs.stripe.com/api/pagination
  - https://docs.stripe.com/data/how-sigma-works
- GitHub / Linear / Slack search + cursor + count conventions.
  - https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api
  - https://linear.app/developers/pagination
  - https://relay.dev/graphql/connections.htm
  - https://api.slack.com/methods/search.messages
- SQL / OLAP vocabulary: `date_trunc`, `COUNT(DISTINCT)`, `width_bucket`,
  `GROUPING SETS`/`CUBE`/`ROLLUP`, `percentile_cont`.
  - https://docs.snowflake.com/en/sql-reference/functions/date_trunc
  - https://docs.snowflake.com/en/sql-reference/functions/width_bucket
  - https://oracle-base.com/articles/misc/rollup-cube-grouping-functions-and-grouping-sets
  - https://learn.microsoft.com/en-us/sql/t-sql/queries/select-group-by-transact-sql
    (COUNT(DISTINCT) is incompatible with CUBE/ROLLUP/GROUPING SETS)
- Faceted search: Algolia facets / facetFilters / disjunctive facets; Shopify
  GraphQL pagination.
  - https://www.algolia.com/doc/guides/managing-results/refine-results/faceting
  - https://support.algolia.com/hc/en-us/articles/11923043923217
- Programmatic OLAP query languages: Cube.js, Google Analytics Data API,
  Metabase MBQL.
  - https://cube.dev/docs/product/apis-integrations/rest-api/query-format
  - https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/runReport
  - https://github.com/metabase/metabase/wiki/(Incomplete)-MBQL-Reference
- AI-agent token efficiency for read/aggregation tools.
  - https://www.mindstudio.ai/blog/optimize-mcp-server-token-usage
  - https://thenewstack.io/how-to-reduce-mcp-token-bloat/
  - https://pydantic.dev/articles/engineering-mcp-tools-for-token-efficiency

Verification note: shapes below were checked against the official docs cited
above. The session's context-mode/WebFetch tooling was intercepted by an
environment hook, so verification ran through web search over those sources.

## Per-source shape and durable lesson

### Elasticsearch / OpenSearch
- `terms`: `field`, `size` (default 10, this *is* top-N), `order`
  (`_count`/`_key`), `missing` (named bucket for absent field, only with
  `min_doc_count: 0`), `min_doc_count` (default 1). Counts can be approximate on
  sharded data.
- `date_histogram`: `calendar_interval` (DST/calendar-aware, single quantity:
  `minute|hour|day|week|month|quarter|year`) vs `fixed_interval` (constant SI
  multiples). `time_zone` shifts bucket boundaries. `min_doc_count: 0` +
  `extended_bounds` produces a gap-free, zero-filled series.
- `cardinality`: HyperLogLog++ approximate distinct; `precision_threshold`
  trades memory for accuracy. Exact distinct requires enumerating every value.
- `composite`: streams every bucket via `after_key` cursor; **cannot sort by
  metric**, gives no upfront total.
- Lesson: a tiny set of orthogonal primitives (bucket-by-term, bucket-by-time,
  approx-distinct) covers ~90%. The hard, durable decisions are *semantics*
  (calendar vs fixed, missing bucket, zero-fill), not breadth.

### Stripe
- List + cursor only (`limit`, `starting_after`, `ending_before`); `has_more`;
  no `total_count` unless opted in, accurate only to 10,000. No aggregation on
  the live API at all; aggregation lives in Sigma (separate product, ~3h lag,
  SQL-shaped).
- Lesson: a narrow read API is defensible. If you add aggregation to the live
  surface, treat it as a real, minimal product decision.

### GitHub / Linear / Slack
- GitHub search: `{ total_count (capped 1000), incomplete_results, items }`.
- Relay connection (GitHub/Linear/Shopify): `first`/`after` +
  `pageInfo{hasNextPage,endCursor}` + optional `totalCount`.
- Slack: `paging.total` is estimated; migrating to cursormark.
- Lesson: total count is a nice-to-have, never a guarantee. Every mature system
  caps, estimates, or opts it in. Treat `total` as optional and possibly
  approximate.

### SQL / OLAP
- `date_trunc(unit, ts)` canonical units: `minute, hour, day, week, month,
  quarter, year` (the vocabulary to adopt). `COUNT(DISTINCT)` = exact distinct.
  `width_bucket` = equi-width numeric histogram. `percentile_cont` = percentiles.
  `CUBE/ROLLUP/GROUPING SETS` = subtotals, and are *incompatible* with
  `COUNT(DISTINCT)` -> a clear "advanced, separate mode" signal.
- Lesson: borrow `date_trunc` units + `count_distinct`. Defer width_bucket,
  percentiles, and CUBE/ROLLUP family.

### Algolia / faceted search
- Request: `facets[]`, `facetFilters` (inner array OR, outer AND),
  `maxValuesPerFacet`. Response returns `facets: { field: { value: count }}`
  alongside `hits`, plus `exhaustiveFacetsCount` (exact vs approximate flag).
- Disjunctive ("count as if this facet's own filter were not applied") is NOT in
  the API; the client library issues one extra query per disjunctive facet.
- Lesson: facets-with-results in one round trip is the right default. Ship
  conjunctive counts (refined by current filters). Disjunctive faceting is v2.

### Cube.js / GA Data API / Metabase (programmatic OLAP)
- Cube query: `{ measures[], dimensions[], filters[{member,operator,values}],
  timeDimensions[{dimension,dateRange,granularity}], limit, offset, order,
  total }`. `timeDimensions` fuses time filter + time bucket; **omitting
  `granularity` = filter only, no grouping** (elegant optionality).
- GA `runReport`: `{ dimensions[], metrics[], dateRanges[], dimensionFilter,
  metricFilter, orderBys, limit, keepEmptyRows }`.
- Metabase MBQL: `{ aggregation: [["count"],["distinct",f],["sum",f]],
  breakout: [...], filter: [...] }`; treat MBQL as opaque/versioned.
- Lesson: the convergent machine shape is `{ measures, dimensions,
  time+granularity, filters, limit/order, optional total }`. Steal: a single
  time-dimension construct with optional granularity, and a uniform
  `{field, op, values}` filter triple. Publish a measure/dimension catalog for
  capability discovery.

### AI-agent token efficiency
- Anti-pattern: dump rows -> agent aggregates in-context -> pay tokens per row.
  Pagination does not save an agent that has a tool-call budget.
- Fix: server-side aggregation tools (`count_open_issues_by_priority` instead of
  `list_all_issues`). Computation is ~free server-side, costs hundreds-thousands
  of tokens in-context.
- Lesson: for an agent-facing read contract, aggregation is a token-budget
  primitive, not an analytics nicety. This is the opposite of Stripe's split and
  the right call here precisely because the consumer is a context-bounded agent.

## Synthesis: minimal canonical vocabulary

Every surveyed system converges on the same concepts: measures, dimensions,
time+granularity, filters, limit/order. Mapped onto PDPP's existing
`count/sum/min/max/group_by`:

- Date bucketing -> one `date_trunc`-style time bucket, units
  `{minute,hour,day,week,month,quarter,year}`, calendar-aware, optional
  `time_zone`, optional zero-fill.
- Top-N / facets -> already largely present: `group_by` already supports
  `limit` + count-desc ordering in the current PDPP implementation. The net-new
  is generalizing it (a date-bucket dimension; optional facet-with-list).
- Term/emoji/value frequency -> NOT a new primitive: it is `group_by` + count +
  order-desc + limit, which PDPP already ships for a single scalar field.
- Distinct -> a `count_distinct` measure, flagged approximate at scale.
- Null/missing -> surface a single explicit, named null bucket (SQL collapses
  NULLs to one group; ES `missing` names it). Never silently drop null-valued
  records; that destroys an agent's completeness reasoning. Recommend
  `count_distinct` does NOT count null (avoids the ES off-by-one).
- Capability discovery -> per-field descriptor (`groupable`, `measurable[]`,
  `time_bucketable`) plus global supported `granularity`/`order`, surfaced in
  stream metadata and mirrored into the MCP tool schema so an agent self-teaches
  without a round trip.

## Over-engineering for v1 (defer, document as advanced backlog)

| Feature | Why defer |
| --- | --- |
| Nested / sub-aggregations | Combinatorial response size, the exact thing agent-efficiency is avoiding |
| CUBE / ROLLUP / GROUPING SETS | Reporting nicety; incompatible with COUNT(DISTINCT); separate mode |
| Percentiles / `percentile_cont` | Niche for personal-data Q&A; approximation rabbit hole |
| Composite / bucket pagination (`after_key`) | Adds cursor state, forbids metric sort, no total; top-N suffices at personal scale |
| Disjunctive facet counts | Requires N extra queries; ship conjunctive counts first |
| `width_bucket` numeric histograms | Only if a concrete numeric-distribution need appears; date histograms dominate |

Common thread: each trades the agent's core win (small bounded responses) for
breadth not yet needed.
