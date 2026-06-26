## Why

The ChatGPT connector currently hydrates conversation detail with one `GET /conversation/{id}` request per conversation. Large accounts turn that into a provider request storm, increasing run time and 429 pressure even though ChatGPT exposes a batch detail endpoint that returns the same conversation-detail shape for up to 10 ids per request.

Reducing the detail-fetch request count improves connector reliability without changing emitted records, cursor shape, grant semantics, or owner-facing data.

## What Changes

- Add a ChatGPT API seam for `POST /conversations/batch` with the same retry helper used by existing requests.
- Hydrate listed conversation ids in batches of at most 10 before the existing per-conversation processing lane.
- Preserve the current `GET /conversation/{id}` path as fallback for ids omitted by the batch response or when the batch endpoint is unavailable.
- Add regression tests proving batch-hit, batch-omission, batch-cap, and fallback behavior.

## Capabilities

Modified:

- `polyfill-runtime`

## Impact

- Affected code: ChatGPT connector API wrapper, ChatGPT detail-hydration orchestration, ChatGPT integration tests, connector version note.
- Validation: targeted ChatGPT connector tests, connector typecheck where available, OpenSpec strict validation.
- Risk: the batch endpoint is an undocumented provider endpoint. The implementation must fail open to the existing per-id GET path so collection remains correct if batch is unavailable or omits records.
