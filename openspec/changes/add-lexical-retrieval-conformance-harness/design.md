## Context

Record-read, record-mutation, disclosure-spine, consent, device-auth, connector-state, and scheduler seams now have conformance patterns. Lexical retrieval does not. That makes production extraction risky because FTS5-specific behavior could be mistaken for the durable contract.

This change creates the missing evidence without changing runtime architecture.

## Decision

Add a test-only `LexicalRetrievalDriver` conformance harness. The harness SHALL test semantic retrieval obligations that are portable across lexical backends:

- upsert, delete, and delete-by-stream maintenance;
- query matching over declared searchable fields;
- deterministic result ordering for ties;
- honest score metadata including kind, direction, and value semantics;
- honest backend identity including backend kind and tokenizer semantics;
- snippet behavior as plain extracted record text, not generated content.

The memory driver SHALL be deliberately honest that it is not FTS5: simple substring/token-frequency behavior is acceptable if its identity and scoring semantics are declared.

## Stop Conditions

Stop for owner review if the implementation:

- introduces or exports a production `LexicalIndex` interface;
- changes `/v1/search` public behavior;
- copies SQLite FTS5 tokenization too deeply into the memory driver instead of declaring a different backend identity;
- touches semantic or hybrid retrieval beyond shared test setup.

## Acceptance Checks

- SQLite, memory, and falsifiability drivers all run through the same lexical conformance suite.
- The broken driver fails at least one semantic invariant.
- Existing lexical retrieval public-contract tests remain green.
- Operation boundary tests remain green.
