# Tasks — detail-gap locator identity fix

## 1. Store identity

- [x] 1.1 Add `detailGapIdentityKey(recordKey, locatorText)` deriving the
      `key:`/`loc:` namespaced identity component.
- [x] 1.2 Derive `gap_id` from `(instance, grant, stream, parent_stream,
      identity_key)` when an explicit `gap_id` is not supplied.
- [x] 1.3 Update the SQLite upsert `ON CONFLICT` target and trailing lookup to
      the new identity expression.
- [x] 1.4 Update the Postgres upsert `ON CONFLICT` target to the new identity
      expression.

## 2. Identity index and reconcile migration

- [x] 2.1 SQLite: new identity unique index expression; move index creation into
      the migration; drop the old index, reconcile duplicates, rebuild.
- [x] 2.2 Postgres: same behavior inside a transaction.
- [x] 2.3 Remove the identity unique index from both bootstrap DDL blocks so
      creation always follows the dedupe.

## 3. Tests

- [x] 3.1 Locator drift re-upserts the same identity and stores the newer locator
      shape.
- [x] 3.2 Recovery under a new-shape locator closes the old-shape pending row.
- [x] 3.3 `key:`/`loc:` namespaces do not collide.
- [x] 3.4 Locator fallback is preserved when `record_key` is absent.
- [x] 3.5 Migration collapses pre-existing duplicate rows, keeping the resolved
      sibling; rebuilt index rejects a third-shape duplicate.
- [x] 3.6 Postgres parity for drift, recovery, and fallback.

## Acceptance checks

Reproducible steps:

```
openspec validate fix-detail-gap-locator-identity --strict
git diff --check
node --test reference-implementation/test/connector-detail-gap-store.test.js
PDPP_TEST_POSTGRES_URL=postgres://.../pdpp_test node --test reference-implementation/test/connector-detail-gap-store.test.js
```
