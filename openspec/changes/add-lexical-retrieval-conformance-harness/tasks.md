## 1. Harness Design

- [ ] 1.1 Inventory existing lexical index maintenance functions and public retrieval tests.
- [ ] 1.2 Define the test-only `LexicalRetrievalDriver` shape.
- [ ] 1.3 Document backend identity and scoring fields required from every driver.

## 2. Driver Implementation

- [ ] 2.1 Implement a SQLite driver using the existing lexical index maintenance/search path.
- [ ] 2.2 Implement a memory driver with honest substring/token-frequency semantics.
- [ ] 2.3 Implement a broken/falsifiability driver that drops or misorders a token.

## 3. Conformance Scenarios

- [ ] 3.1 Cover upsert and query over declared searchable fields.
- [ ] 3.2 Cover delete and delete-by-stream maintenance.
- [ ] 3.3 Cover deterministic ordering and score metadata.
- [ ] 3.4 Cover snippet behavior and no-result behavior.
- [ ] 3.5 Prove the broken driver fails.

## 4. Validation

- [ ] 4.1 Run new lexical conformance tests.
- [ ] 4.2 Run existing `lexical-retrieval.test.js`.
- [ ] 4.3 Run operation-boundary tests.
- [ ] 4.4 Run `pnpm --filter pdpp-reference-implementation typecheck`.
- [ ] 4.5 Run `pnpm --filter pdpp-reference-implementation check`.
- [ ] 4.6 Run `openspec validate add-lexical-retrieval-conformance-harness --strict`.
- [ ] 4.7 Run `openspec validate --all --strict`.
