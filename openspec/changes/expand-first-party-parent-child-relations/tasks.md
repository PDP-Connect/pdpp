## 1. Audit

- [ ] Scan first-party manifests for declared relationships and classify each as parent-to-child, reverse/belongs-to, stale, or unsupported.
- [ ] Record the classification in `design.md` or a change-local design note.

## 2. Manifest Backfill

- [ ] Enable only safe parent-to-child `query.expand` declarations.
- [ ] Do not enable reverse relations such as message-to-thread/channel/user or transaction-to-account/category.
- [ ] Keep Gmail existing expansions intact.

## 3. Tests

- [ ] Add manifest-level validation that every first-party `query.expand` entry has a matching relationship and child foreign key.
- [ ] Add first-party synthetic record tests for each newly enabled relation.
- [ ] Test list and detail expansion.
- [ ] Test child grant projection and missing-child-grant rejection.
- [ ] Test `expand_limit` for has-many relations.

## 4. Docs

- [ ] Add one copy-pasteable `expand[]` example for a first-party stream.
- [ ] Document that reverse/belongs-to relations are intentionally deferred.

## 5. Validation

- [ ] Run `pnpm --dir reference-implementation exec node --test test/query-contract.test.js`.
- [ ] Run relevant connector manifest/parser tests if manifests change.
- [ ] Run `pnpm --dir reference-implementation run verify`.
- [ ] Run `openspec validate expand-first-party-parent-child-relations --strict`.
- [ ] Run `openspec validate --all --strict`.
