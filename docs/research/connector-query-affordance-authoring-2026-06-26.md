# Connector Query-Affordance Authoring Rules

Date: 2026-06-26
Status: captured
Builds on: `connector-authoring-semantics-prior-art-2026-06-24.md` (Algolia /
Elasticsearch / Plaid: search, filter, facet/aggregation, and presentation role
are separate axes) and `connector-query-affordance-audit-2026-06-26.md`.

## Question

When a connector author declares query affordances on already-granted fields,
what rules keep declarations honest, server-valid, and useful — without
recreating field-name guessing?

## Claims (each verified against the reference server contract)

1. **Four independent declaration axes.** A readable field is not implicitly
   searchable, filterable, aggregatable, or facetable. Each is its own opt-in:
   - `query.search.lexical_fields` / `query.search.semantic_fields` — text retrieval.
   - `query.range_filters` — bounded reads (`gte`/`gt`/`lte`/`lt`).
   - `query.aggregations.group_by_time` — calendar count-over-time buckets.
   - `query.aggregations.group_by` — facet/equality-style grouped counts.

2. **`group_by_time` is schema-gated to date strings.** The reference aggregate
   engine (`reference-implementation/server/records.js`, `isMinMaxAggregateSchema`
   + the group_by_time branch) accepts a field for time bucketing ONLY when its
   schema is a `string` with `format: date` or `date-time`. Integer epoch fields
   (e.g. `mtime_epoch`) are valid `range_filters` candidates but MUST NOT be
   declared `group_by_time`; the server rejects them at request time. Declaring
   one ships a manifest the engine refuses.

3. **Grouping requires `aggregations.count: true`.** `group_by` and
   `group_by_time` run as `metric=count`; the server rejects them unless the
   stream's `aggregations.count` is `true`. Adding either to a stream that had no
   `aggregations` block means also adding `count: true`.

4. **`group_by` (facets) requires a scalar field.** Booleans, integers, numbers,
   and single-type strings qualify; an enum is ideal but not required. Free-text
   and high-cardinality identifiers are poor facets and should be left
   undeclared (or allowlisted).

5. **Presentation role ≠ query affordance.** `x_pdpp_role: event-time` says
   "render this as the card's event slot." It does NOT make a field
   filterable/groupable. Conversely a timestamp can be range/group declared
   without being the event-time slot. Do not stamp `event-time` on message,
   transaction, metric, or snapshot timestamps just to chart them — declare
   `group_by_time` instead.

6. **The event axis, not every timestamp, gets `group_by_time`.** A record's
   creation/start time is the natural count-over-time axis. Secondary
   state-change markers (`updated_at`, `closed_at`, `merged_at`, `completed_at`,
   `last_*`), interval closings (`end_*`), ingest markers (`fetched_at`), and the
   stream's own sync `cursor_field` are filterable but not the chart axis; they
   are not required to declare `group_by_time`.

7. **Honest non-support over fake affordances.** A useful-looking field that the
   connector intentionally does not expose (privacy-sensitive addresses, snapshot
   periods, operational job timing) goes on the justified allowlist
   (`packages/polyfill-connectors/src/query-affordance-allowlist.ts`) with a
   one-line reason, not silently omitted and not forced.

## Sources

- `docs/research/connector-authoring-semantics-prior-art-2026-06-24.md` (Algolia
  `attributesForFaceting`, Elasticsearch `text` vs `keyword`, Plaid Transactions).
- Reference server contract: `reference-implementation/server/records.js`
  (`normalizeAggregateRequest`, `isMinMaxAggregateSchema`, `requireDeclaredAggregate`).
- Field-capability projection: `reference-implementation/server/index.js`
  (`buildFieldCapabilities`) — fully declaration-driven, no hardcoded field list.

## Synthesis

The query-affordance contract is enforceable precisely because the server is
already declaration-driven: the manifest is the single source of truth, the
aggregate engine validates declarations at request time, and the schema route
projects them into `field_capabilities` for clients. The remaining failure mode
is authorial omission, which the manifest-honesty tests
(`query-affordance-manifest-honesty.test.ts`) now catch in both directions —
undeclared-but-useful fields fail, and stale allowlist entries fail.
