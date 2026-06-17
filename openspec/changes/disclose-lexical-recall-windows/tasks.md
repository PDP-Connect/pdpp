## 1. Operation Contract

- [ ] 1.1 Add `SearchLexicalRecallMeta` / `SearchLexicalEnvelopeMeta` types to `reference-implementation/operations/rs-search-lexical`.
- [ ] 1.2 Extend `executeSearchLexical` envelopes to include `meta.count`, `meta.count_accuracy`, and `meta.recall`.
- [ ] 1.3 Preserve cursor pagination behavior while proving `has_more` does not imply recall completeness.

## 2. Runtime Metadata Sources

- [ ] 2.1 Have SQLite lexical search builders return exact, lower-bound, or not-counted metadata without broadening the search scope.
- [ ] 2.2 Have Postgres lexical search builders return equivalent metadata, including candidate-window facts when the bounded window is active.
- [ ] 2.3 Ensure owner fan-in metadata counts only caller-visible sources and uses compact aggregate facts, not a per-source dump.

## 3. Adapter Propagation

- [ ] 3.1 Preserve `meta` in the native `/v1/search` response envelope and sandbox `/sandbox/v1/search` route.
- [ ] 3.2 Mirror RS recall metadata through the MCP search tool's `structuredContent.data`.
- [ ] 3.3 Add concise MCP text output for `candidate_window` / non-complete recall.

## 4. Verification

- [ ] 4.1 Add operation tests for exact complete, bounded-window lower-bound, and not-counted responses.
- [ ] 4.2 Add route tests proving `has_more: false` with `meta.recall.complete: false` remains visibly non-exhaustive.
- [ ] 4.3 Add MCP tests proving recall metadata is mirrored and bounded-window searches are summarized honestly.
- [ ] 4.4 Run `openspec validate disclose-lexical-recall-windows --strict` and relevant lexical/MCP test suites.

## 5. Acceptance

- [ ] 5.1 Live or fixture-search a broad/common lexical query and verify the response discloses whether candidate-window truncation occurred.
- [ ] 5.2 Confirm older clients remain compatible because the change is additive to the list envelope.
