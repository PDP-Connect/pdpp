# Amazon Year Partition Cursor Safety

Status: captured
Owner: RI owner
Created: 2026-06-02
Updated: 2026-06-02
Related: `packages/polyfill-connectors/connectors/amazon/index.ts`, `openspec/changes/add-browser-collector-enrollment-primitive`

## Question

Should the Amazon connector collect order history newest-first, oldest-first, or with a mid-year page cursor, and what cursor shape is safe under Amazon order-history pagination?

## Context

The current Amazon connector partitions by year, scans Amazon's order-history pages for each year, emits `orders` and `order_items`, and stages state after a year completes:

- `order_count`
- `frozen`
- `last_scraped`

That state is a year-completion cursor, not a durable page cursor. The run can emit progress mid-year, but it does not currently claim that page `N` within a year is durably complete.

Amazon order-history pagination appears offset/page based. Offset pagination is not a stable append-only cursor: inserted, removed, cancelled, or reclassified orders can shift later offsets. A naive resume cursor such as `year=2021,startIndex=70` can skip or duplicate records if the source changes between runs.

## Stakes

If the connector treats an offset as a durable correctness cursor, a failed or cancelled run could resume after shifted data and miss records. If it always restarts the active year, long years cost more time but preserve correctness because stable record IDs dedupe repeated emits.

The operator still needs mid-run visibility. Progress breadcrumbs can say which year/page/order ordinal is being processed without making those breadcrumbs the committed correctness cursor.

## Current Leaning

Keep the durable cursor as year-partition completion unless Amazon exposes a stable ascending cursor.

The SLVP shape is:

- Use year partitions as the durable unit of completeness.
- Emit non-PII mid-run progress for year, page ordinal, orders found, and order ordinal.
- Treat any active-year page/order position as an advisory resume hint only.
- On resume after interruption, restart or overlap the active year and rely on stable record IDs to dedupe.
- Freeze older years only after a stable count and, ideally, a content fingerprint across runs.

Oldest-first collection is not automatically safer unless the source provides a stable ascending cursor. Jumping to the "last page" and paging forward over offset pagination can still be fragile because offsets can shift.

## Promotion Trigger

Promote this into OpenSpec or an implementation change before adding any of:

- A durable page-level Amazon cursor.
- An active-year resume cursor that skips already-seen pages.
- A freeze policy based on anything stronger than repeated stable counts.
- A shared connector requirement for partition cursors over offset-paginated sources.

## Decision Log

- 2026-06-02: Captured after the owner asked whether descending date order is compatible with cursor design. Current answer: compatible for year-partition completeness, not safe as a naive page-offset cursor.
