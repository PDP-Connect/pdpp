## 1. Score Shape Decision

- [x] 1.1 Audit current lexical BM25 and semantic distance values at the result builder boundary.
- [x] 1.2 Decide exact score object shape and capability advertisement fields.
- [x] 1.3 Document score stability limits and model/profile comparability limits.

## 2. Contract And Docs

- [x] 2.1 Add score advertisement fields to lexical and semantic capability schemas.
- [x] 2.2 Add optional typed score objects to lexical and semantic result schemas.
- [x] 2.3 Regenerate reference OpenAPI and generated route docs.

## 3. Runtime Implementation

- [x] 3.1 Emit lexical score objects only when advertised.
- [x] 3.2 Emit semantic score objects only when advertised.
- [x] 3.3 Preserve no-vector/no-hidden-field/no-debug-leak invariants.
- [x] 3.4 Confirm no dashboard search UI update is useful for this API-only score tranche.

## 4. Tests

- [x] 4.1 Add lexical tests proving advertised score presence, ordering direction, and hidden-field safety.
- [x] 4.2 Add semantic tests proving advertised score presence, model identity linkage, and hidden-field safety.
- [x] 4.3 Add tests proving scores are implementation-relative and not emitted when disabled.

## 5. Validation

- [x] 5.1 Run lexical and semantic retrieval suites.
- [ ] 5.2 Run reference contract generation checks.
- [x] 5.3 Confirm web checks are not applicable because dashboard rendering did not change.
- [x] 5.4 Run `openspec validate define-public-retrieval-scores --strict`.
- [x] 5.5 Run `openspec validate --all --strict`.
- [x] 5.6 Run `git diff --check`.
