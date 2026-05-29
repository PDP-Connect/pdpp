# Connector scoping on /v1/search and group_by on sum/min/max

Status: captured
Owner: Claude (worktree-reference-api-seams)
Created: 2026-04-24
Updated: 2026-04-24
Related: polish-reference-api-discovery-seams (parent change), specs/lexical-retrieval, specs/semantic-retrieval, specs/hybrid-retrieval, specs/reference-implementation-architecture (aggregations)

## Question

Two assistant-friendly seams remain on the search and aggregate surfaces. They were called out in `tmp/pdpp-review-memo.md` and intentionally deferred from the seam-polish slice because both touch durable contract:

1. **Connector scoping on `/v1/search`.** Owner-mode lexical search (and by extension semantic + hybrid) currently fans out across every owner-visible connector. There is no public way to narrow to "only my emails" without inferring the right `streams[]` per connector. The lexical-retrieval spec explicitly says there is no public connector source filter, so adding one is a contract change.
2. **`group_by` on `sum`/`min`/`max` aggregations.** The runtime allows `group_by` only with `metric=count`; the manifest's `query.aggregations.group_by` declaration is independent of metric and could already authorize, e.g., `sum-by-payee`. The reference architecture spec only has scenarios for grouped count.

## Context

### Connector scoping

- Affected specs: `lexical-retrieval/spec.md`, `semantic-retrieval/spec.md`, `hybrid-retrieval/spec.md`. Each currently locks the v1 query allowlist with `additionalProperties: false` and excludes connector source filters deliberately.
- Owner-mode plumbing exists (`resolveOwnerVisibleConnectorIds`); narrowing happens in `runLexicalSearch` / `runSemanticSearch` / `runHybridSearch`. A `connectors[]` filter would compose with `streams[]` and range filters cleanly: streams[] filters per-connector plan entries; connectors[] filters the connector list before plan construction.
- Open questions:
  - Parameter shape: a single `source` object vs. `sources[]` repeated. The latter mirrors `streams[]`.
  - Error class for unknown connector source under owner mode (`unknown_source`?). For client tokens the source is implied by the grant — should the param be a no-op when it matches, or rejected as redundant?
  - Should the param be allowed only in owner mode, or also in client mode for parity?

### group_by on sum/min/max

- Affected spec: `reference-implementation-architecture/spec.md` aggregation requirements (currently exercises grouped count only).
- Manifest already lets connectors declare `query.aggregations.group_by: ["payee"]` independently of `count`; the runtime hard-codes `if (metric !== 'count') reject group_by`. Lifting that gate is small.
- Aggregator state needs per-group accumulators rather than the current single-pass `sum`/`bestComparable`. Pure JS, same data path as count-by-group.
- Open questions:
  - Bucket ordering for non-count metrics: by metric value descending? by group key? Today, count groups are sorted by count desc with key as tiebreaker. For sum we'd default to value desc; min/max ordering is less obvious — by metric value with a stable tiebreaker is plausible but should be explicit in the spec scenario.
  - Grouped-min/max where the metric value is null for all rows in a bucket: drop the bucket, or emit `value: null`?
  - Group limit semantics: re-use the existing `DEFAULT_AGGREGATE_GROUP_LIMIT` and `MAX_AGGREGATE_GROUP_LIMIT`.

## Stakes

These are dataflow-shaping improvements rather than safety-critical fixes. Shipping them improves DX for analytics queries (`sum-by-payee`) and "just my emails" recall, both of which the assistant memo flagged as common needs.

## Current Leaning

- **Scoping**: Add `connectors[]` (repeated) to the v1 search allowlist on lexical, semantic, and hybrid. Owner-mode narrows the connector list before plan construction; client-mode rejects mismatches as `invalid_request` (the connector is already implied by the grant, so an *additional* matching value is acceptable). Compose with `streams[]` and range filters as today.
- **group_by**: Lift the `metric=count`-only gate. For `sum` emit `groups[].sum`; for `min`/`max` emit `groups[].value`; sort by metric value descending with `JSON.stringify(key)` tiebreaker; honor `limit`. Add scenarios under the existing "Grouped aggregation results SHALL be bounded and deterministic" requirement.

## Promotion Trigger

Promote into a focused OpenSpec change when:

- A real consumer hits "search only my emails" or `sum-by-payee` and the absence is blocking a workflow, OR
- The owner asks for the seam in a follow-up sprint.

## Test Surfaces a Follow-Up Should Add

Connector scoping (`test/lexical-retrieval.test.js`, `test/semantic-retrieval.test.js`, `test/hybrid-retrieval.test.js`):

- owner-mode `connectors[]=gmail` returns hits only from that connector
- owner-mode `connectors[]=gmail&streams[]=messages&filter[received_at][gte]=...` composes
- owner-mode `connectors[]=does_not_exist` is `invalid_request`
- client-mode `connectors[]=<grant_connector>` is accepted; mismatch is `invalid_request`

group_by on sum/min/max (`test/query-contract.test.js`, manifest fixture `polyfill-range-filters.test.js` for declaration semantics):

- declared `group_by` on a numeric field with `metric=sum` returns deterministic per-group sums
- min/max grouping is rejected when the field schema is not min/max-comparable
- limit/ordering scenarios mirror grouped count

These notes should be enough for a successor agent to spin up a focused change without re-reading the full review memo.
