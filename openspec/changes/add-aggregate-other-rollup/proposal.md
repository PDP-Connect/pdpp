# Add `other_count` Rollup to Grouped Aggregate Responses

## Why

Grouped aggregate responses (`group_by` and `group_by_time`) return the top-N
groups ordered by count. Without a rollup field, callers cannot tell whether
the top-N is a complete picture of the data or a truncated subset. A model or
agent that trusts a limited facet list without knowing the tail size can draw
incorrect conclusions (e.g. "these are all the senders" when 40% of records
fell into groups beyond the limit). A second aggregation call to compute the
tail is extra latency and an unnecessary round trip.

## What Changes

- Every grouped aggregate response now includes an `other_count` integer: the
  sum of counts for all groups/buckets beyond the `limit`. Zero means all
  groups fit; a positive value signals truncation and quantifies the tail.
- `other_count` is emitted for both `group_by` (scalar top-N facets) and
  `group_by_time` (calendar time-bucket series) when a grouping dimension is
  present. It is omitted for ungrouped (scalar) aggregations.
- The field is present even when no truncation occurs (`other_count: 0`) so
  callers can use its presence as a reliable indicator that the response is a
  grouped response, not just a heuristic "check if groups.length == limit".
- The MCP `aggregate` tool description is updated to mention `other_count` so
  models know to check for truncation without a second call.
- The MCP `summarizeAggregate` helper surface the `other_count` value in the
  text summary when present.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `data-query-api`: the aggregate endpoint's response contract gains
  `other_count` on grouped responses.
- `mcp-adapter`: the `aggregate` tool description and text summarizer surface
  `other_count` so models can detect top-N truncation in-band.

## Impact

- Affected files: `reference-implementation/server/records.js`,
  `packages/reference-contract/src/public/index.ts`,
  `packages/mcp-server/src/tools.js`.
- Additive-only change: `other_count` is a new response field; no existing
  field is removed or renamed. Old callers that ignore unknown fields are
  unaffected.
- No REST query parameter changes, no storage changes, no grant-semantics
  changes.
- Affected tests: `reference-implementation/test/aggregate-time-buckets.test.js`
  (3 new + 2 inline assertions in existing tests),
  `packages/mcp-server/test/aggregate-tool.test.js` (existing suite still
  passes; description change covered by the description-teaches test).
