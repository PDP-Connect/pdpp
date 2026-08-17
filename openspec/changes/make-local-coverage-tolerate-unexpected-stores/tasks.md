## 1. Test first

- [x] Failing test: every expected store present plus one unexpected store, asserting
      the snapshot commits. Red against unmodified source.
- [x] Regression test: a missing required store still fails closed.
- [x] Existing regression coverage for duplicate and malformed entries retained.

## 2. Implement

- [x] Remove `unexpectedStores.length === 0` from the `hasCommittedSnapshot` gate.
- [x] Keep `unexpectedStores` in the returned result so drift stays observable.
- [x] Document the missing/unexpected asymmetry at the decision site.

## 3. Validate

- [x] Module tests pass (33 pass, 0 fail).
- [x] Biome clean on changed files.
- [ ] Full reference-implementation suite green.
- [ ] `openspec validate make-local-coverage-tolerate-unexpected-stores --strict`
