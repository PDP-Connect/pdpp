## 1. Contract

- [ ] Add reference-contract schema for hybrid retrieval capability metadata.
- [ ] Add reference-contract schema for `GET /v1/search/hybrid`.
- [ ] Decide first-tranche pagination: snapshot cursor or no cursor support.

## 2. Implementation

- [ ] Advertise `capabilities.hybrid_retrieval` only when lexical and semantic retrieval are both available.
- [ ] Implement `GET /v1/search/hybrid` by composing existing lexical and semantic planners.
- [ ] Deduplicate by `(connector_id, stream, record_key)`.
- [ ] Return source provenance and per-source score objects.
- [ ] Preserve the existing lexical and semantic endpoint behavior unchanged.

## 3. Tests

- [ ] Metadata advertisement tests.
- [ ] Happy-path owner-token hybrid search across at least two streams.
- [ ] Client-token grant projection test.
- [ ] Dedup test for record matching both sources.
- [ ] Lexical-only and semantic-only provenance tests.
- [ ] Cursor behavior test matching the chosen pagination design.
- [ ] Cross-surface cursor rejection tests.

## 4. Dashboard Follow-Up

- [ ] If the endpoint is implemented, update dashboard search to prefer hybrid retrieval when advertised.
- [ ] Preserve graceful fallback to existing client-side lexical+semantic blend when not advertised.

## 5. Validation

- [ ] Run lexical and semantic retrieval suites.
- [ ] Run `pnpm --filter @pdpp/reference-contract run check:generated`.
- [ ] Run `pnpm --dir reference-implementation run verify`.
- [ ] Run `pnpm --dir apps/web run types:check` if dashboard changes.
- [ ] Run `openspec validate define-hybrid-retrieval --strict`.
- [ ] Run `openspec validate --all --strict`.
