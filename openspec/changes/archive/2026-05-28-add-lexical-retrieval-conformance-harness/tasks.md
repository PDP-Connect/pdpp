## 1. Harness Design

- [x] 1.1 Inventory existing lexical index maintenance functions and public retrieval tests.
- [x] 1.2 Define the test-only `LexicalRetrievalDriver` shape.
- [x] 1.3 Document backend identity and scoring fields required from every driver.

## 2. Driver Implementation

- [x] 2.1 Implement a SQLite driver using the existing lexical index maintenance/search path.
- [x] 2.2 Implement a memory driver with honest substring/token-frequency semantics.
- [x] 2.3 Implement a broken/falsifiability driver that drops or misorders a token.

## 3. Conformance Scenarios

- [x] 3.1 Cover upsert and query over declared searchable fields.
- [x] 3.2 Cover delete and delete-by-stream maintenance.
- [x] 3.3 Cover deterministic ordering and score metadata.
- [x] 3.4 Cover snippet behavior and no-result behavior.
- [x] 3.5 Prove the broken driver fails.

## 4. Validation

- [x] 4.1 Run new lexical conformance tests.
- [x] 4.2 Run existing `lexical-retrieval.test.js`.
- [x] 4.3 Run operation-boundary tests.
- [x] 4.4 Run `pnpm --filter pdpp-reference-implementation typecheck`.
- [x] 4.5 Run `pnpm --filter pdpp-reference-implementation check`.
- [x] 4.6 Run `openspec validate add-lexical-retrieval-conformance-harness --strict`.
- [x] 4.7 Run `openspec validate --all --strict`.
