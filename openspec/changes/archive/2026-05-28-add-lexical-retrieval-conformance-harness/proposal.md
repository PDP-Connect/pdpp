## Why

Lexical retrieval is still backed directly by the SQLite FTS5 implementation. Before any `LexicalIndex` extraction or storage portability work, the reference needs a conformance harness that defines the semantic contract independently from FTS5 details.

## What Changes

- Add a test-only lexical retrieval conformance harness with SQLite, memory, and broken drivers.
- Require drivers to advertise backend identity, tokenizer/scoring semantics, score direction, and snippet behavior.
- Do not change production search routing or introduce a production `LexicalIndex` interface.

## Capabilities

Modified:

- `reference-implementation-architecture`

## Impact

- Tests only, plus any small test helper exports needed to exercise existing lexical maintenance functions.
- Out of scope: changing `/v1/search`, extracting `LexicalIndex`, implementing PostgreSQL search, or touching semantic/hybrid search.
