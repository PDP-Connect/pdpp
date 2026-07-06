## Why

The source detail UI rendered a bounded pending-detail-gap page as an exact
count. A live Amazon connection showed `100 pending gaps` while the durable gap
store contained more than that. Owners need to know when a displayed backlog
count is a floor.

## What Changes

- Carry a `pending_detail_gaps_is_floor` flag on each Collection Report stream
  entry when the pending-gap read hits its bound.
- Render capped stream counts as `at least N pending gaps`.
- Keep the bounded read; this change does not introduce an unbounded gap scan.

## Capabilities

Modified:
- `reference-implementation-architecture`

## Impact

- Reference control-plane response gains one optional/derived field on
  `collection_report` entries.
- Console source stream rows and stream detail evidence use the floor wording.
