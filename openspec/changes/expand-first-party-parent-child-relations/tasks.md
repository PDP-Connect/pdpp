## 1. Audit

- [x] Scan first-party manifests for declared relationships and classify each as parent-to-child, reverse/belongs-to, stale, or unsupported.
- [x] Record the classification in `design.md` or a change-local design note.

## 2. Manifest Backfill

- [x] Enable only safe parent-to-child `query.expand` declarations.
- [x] Do not enable reverse relations such as message-to-thread/channel/user or transaction-to-account/category.
- [x] Keep Gmail existing expansions intact.

## 3. Tests

- [x] Add manifest-level validation that every first-party `query.expand` entry has a matching relationship and child foreign key.
- [x] Add first-party synthetic record tests for each newly enabled relation.
- [x] Test list and detail expansion.
- [x] Test child grant projection and missing-child-grant rejection.
- [x] Test `expand_limit` for has-many relations.

## 4. Docs

- [x] Add one copy-pasteable `expand[]` example for a first-party stream.
- [x] Document that reverse/belongs-to relations are intentionally deferred.

## 5. Validation

- [x] Run `pnpm --dir reference-implementation exec node --test test/query-contract.test.js`.
- [x] Run relevant connector manifest/parser tests if manifests change.
- [x] Run `pnpm --dir reference-implementation run verify`.
- [x] Run `openspec validate expand-first-party-parent-child-relations --strict`.
- [x] Run `openspec validate --all --strict`.
