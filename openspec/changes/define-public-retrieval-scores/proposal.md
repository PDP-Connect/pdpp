## Why

Lexical and semantic retrieval compute ranking signals, but the public result shape hides them. Agent clients cannot threshold, blend, debug, or tune retrieval behavior without a stable score contract.

## What Changes

- Define if and how retrieval scores are exposed on `/v1/search` and `/v1/search/semantic`.
- Add capability advertisement for score availability and score type.
- Keep scores explanatory, not portable across implementations unless explicitly stated.
- Preserve grant safety: scores SHALL NOT reveal hidden fields, candidate counts, debug vectors, SQL internals, or rejected matches.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `lexical-retrieval`: Adds a public score contract for lexical search results.
- `semantic-retrieval`: Adds a public score contract for semantic search results.

## Impact

- Affected public APIs: `/v1/search`, `/v1/search/semantic`, and protected-resource capability metadata.
- Affected implementation areas: lexical/semantic result builders, dashboard merged search, route contracts, generated docs/OpenAPI, and retrieval tests.
- No storage migration is required.
