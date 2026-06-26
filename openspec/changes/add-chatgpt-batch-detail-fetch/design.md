## Context

The existing ChatGPT connector already has the core correctness machinery this change needs: list pagination, detail parsing, DETAIL_GAP handling, retry/backoff, source-pressure handling, run budgets, and convergence tests. The problem is the number of detail requests, not emitted record semantics.

The prior research note `docs/research/chatgpt-connector-batch-endpoint-plan-2026-06-19.md` identifies the provider endpoint:

```text
POST /backend-api/conversations/batch
{ "conversation_ids": ["id1", ..., "id10"] }
```

The endpoint returns an array of full conversation objects. If an id cannot be returned, the id is omitted rather than returned as an element-level error.

## Design

Add `fetchBatch(ids)` to the ChatGPT API interface and implementation. It is a provider-specific helper, not a new runtime abstraction. It SHALL cap input chunks at 10 ids before calling the provider.

In the message/detail path, prefetch listed conversation ids in chunks of 10 and store successful results in a local `Map<conversation_id, ChatGptFetchResult>`. The existing per-conversation detail function checks the map first. A cache hit returns the batch result and deletes it from the cache. A miss calls the existing per-id GET path.

This preserves:

- Existing conversation parsers.
- Existing DETAIL_GAP semantics.
- Existing run budget and source-pressure behavior.
- Existing list cursor behavior.
- Existing per-id GET path for fallback and diagnosis.

## Alternatives Considered

- **Replace the lane with a batch-native lane.** Rejected. It would mix a fetch-strategy improvement with orchestration rewrites and increase regression risk.
- **Use only the batch endpoint.** Rejected. Omitted ids and endpoint instability must not cause data loss.
- **Add new global rate machinery.** Rejected. The current retry/source-pressure machinery is already the correctness boundary; this change reduces request count without changing that contract.

## Acceptance Checks

- Batch happy path hydrates conversations without per-id GET calls.
- Batch omission falls back to per-id GET for only the missing ids.
- A run with more than 10 ids calls the batch endpoint in chunks of at most 10.
- Batch endpoint failure degrades to the existing GET path rather than dropping records.
- Emitted records remain shape-compatible with the existing per-id detail parser.

## Out Of Scope

- Changing ChatGPT record schemas.
- Changing cursor or STATE shape.
- Changing DETAIL_COVERAGE semantics.
- Adding AIMD, GCRA, checkpoint, or provider rate-governance machinery.
- Running or deploying live ChatGPT collection.
