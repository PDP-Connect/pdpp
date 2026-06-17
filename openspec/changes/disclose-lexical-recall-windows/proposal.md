## Why

The reference lexical search path currently uses bounded candidate windows for performance, but the public response does not tell callers whether the returned list was ranked over the complete matching set or over a truncated candidate set. That is an honesty gap: clients can treat a fast result as exhaustive when recall may have been bounded.

## What Changes

- Add response-level lexical recall metadata for `/v1/search`.
- Require the response to disclose whether the result set is complete, exact-counted, lower-bound-counted, estimated, or not counted.
- Require implementations that rank over a bounded candidate window to expose the window and truncation facts without leaking unauthorized records or fields.
- Preserve the existing `data[]`, `has_more`, and `next_cursor` contract; this is additive.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `lexical-retrieval`: lexical search responses disclose recall/count/window metadata when implementations use bounded candidate windows or can otherwise report count accuracy.

## Impact

- Public RS API: `GET /v1/search` response envelope gains a `meta.recall` object.
- Reference implementation: lexical search response builders, cursor/page tests, and MCP/search adapters that mirror `/v1/search` metadata.
- No new dependency and no ranking algorithm change in this tranche.
