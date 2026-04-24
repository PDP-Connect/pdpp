## 1. Score Shape Decision

- [ ] 1.1 Audit current lexical BM25 and semantic distance values at the result builder boundary.
- [ ] 1.2 Decide exact score object shape and capability advertisement fields.
- [ ] 1.3 Document score stability limits and model/profile comparability limits.

## 2. Contract And Docs

- [ ] 2.1 Add score advertisement fields to lexical and semantic capability schemas.
- [ ] 2.2 Add optional typed score objects to lexical and semantic result schemas.
- [ ] 2.3 Regenerate reference OpenAPI and generated route docs.

## 3. Runtime Implementation

- [ ] 3.1 Emit lexical score objects only when advertised.
- [ ] 3.2 Emit semantic score objects only when advertised.
- [ ] 3.3 Preserve no-vector/no-hidden-field/no-debug-leak invariants.
- [ ] 3.4 Update dashboard search UI only if a score display is useful; do not expose noisy decimals by default.

## 4. Tests

- [ ] 4.1 Add lexical tests proving advertised score presence, ordering direction, and hidden-field safety.
- [ ] 4.2 Add semantic tests proving advertised score presence, model identity linkage, and hidden-field safety.
- [ ] 4.3 Add tests proving scores are implementation-relative and not emitted when disabled.

## 5. Validation

- [ ] 5.1 Run lexical and semantic retrieval suites.
- [ ] 5.2 Run reference contract generation checks.
- [ ] 5.3 Run web checks if dashboard rendering changes.
- [ ] 5.4 Run `openspec validate define-public-retrieval-scores --strict`.
- [ ] 5.5 Run `openspec validate --all --strict`.
- [ ] 5.6 Run `git diff --check`.
