# Tasks: add-aggregate-other-rollup

## 1. Reference contract (schemas)

- [x] 1.1 Add `other_count: { type: "integer", minimum: 0 }` to
  `AggregationResponseSchema` in
  `packages/reference-contract/src/public/index.ts`. Document that it is
  emitted whenever a grouping dimension is present (zero when all groups fit;
  omitted for ungrouped aggregations). Reference the openspec change in the
  comment.
- [x] 1.2 Update the `aggregateStream` manifest summary in
  `packages/reference-contract/src/public/index.ts` to describe `other_count`
  and the truncation-detection guarantee.

## 2. Reference implementation

- [x] 2.1 `reference-implementation/server/records.js`: in the `group_by`
  branch, capture the sorted full group list before slicing; set
  `response.other_count` to the sum of counts in the truncated tail
  (`sortedGroups.slice(aggregateRequest.limit)`).
- [x] 2.2 `reference-implementation/server/records.js`: same change for the
  `group_by_time` branch.
- [x] 2.3 Confirm that ungrouped aggregation paths (scalar `count`, `sum`,
  `min`, `max`, `count_distinct`) do NOT emit `other_count`.

## 3. MCP adapter

- [x] 3.1 `packages/mcp-server/src/tools.js`: update the `aggregate` tool
  description to mention `other_count` so models know to check it for
  truncation detection without a second call.
- [x] 3.2 `packages/mcp-server/src/tools.js`: update `summarizeAggregate` to
  include `other_count=N` in the text summary when present on the RS response.

## 4. Tests

- [x] 4.1 `reference-implementation/test/aggregate-time-buckets.test.js`: add
  `assert.equal(res.other_count, 0)` to the existing scalar `group_by` test
  (all groups fit within limit).
- [x] 4.2 Same inline assertion for the existing `group_by_time` UTC-day test.
- [x] 4.3 New test: `group_by other_count is the sum of counts for groups
  beyond limit` — limit=2, 3 distinct values, asserts other_count=1.
- [x] 4.4 New test: `group_by other_count is 0 when all groups fit within
  limit` — limit=100, 3 groups, asserts other_count=0.
- [x] 4.5 New test: `group_by_time other_count covers buckets truncated by
  limit` — limit=2, 4 buckets, asserts other_count=2 (sum of tail counts).

## 5. Validation

- [x] 5.1 `reference-implementation/test/aggregate-time-buckets.test.js`: 16
  tests pass (was 13).
- [x] 5.2 Full `packages/mcp-server` suite green (136 tests).
- [x] 5.3 `openspec validate --all --strict` green.
- [x] 5.4 `git diff --check`; grep changed public names for consistency.

## Acceptance checks

Reproducible commands:

```
node --test reference-implementation/test/aggregate-time-buckets.test.js
node --test packages/mcp-server/test/aggregate-tool.test.js
node --test packages/mcp-server/test/*.test.js
openspec validate add-aggregate-other-rollup --strict
openspec validate --all --strict
```
