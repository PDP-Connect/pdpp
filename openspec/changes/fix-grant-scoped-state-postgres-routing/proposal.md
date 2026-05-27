## Why

`resolveGrantScopedStateGrant` in `reference-implementation/server/index.js` reads the persisted grant row through the SQLite `grantsGetScopedStateById` query unconditionally, even when `PDPP_STORAGE_BACKEND=postgres`. The matching writers in `auth.js` already branch on `isPostgresStorageBackend()` and write every issued grant to postgres `grants`. In postgres mode the SQLite `grants` table is empty (or carries only legacy migrated rows), so every postgres-issued continuous-mode grant flowing through the `rs.connector-state.get` / `rs.connector-state.put` operations resolves as `not_found`.

This is the same construction failure mode as the `computeIndexState` semantic-index miss documented in `tmp/workstreams/storage-backend-routing-audit-report.md`: a reader that does not branch on the active backend while its sibling writer does.

## What Changes

- Modify the reference implementation invariant so grant resolution on grant-scoped state operations consults the active storage backend rather than the SQLite primitives.
- Fix `resolveGrantScopedStateGrant` so it reads from postgres `grants` when `isPostgresStorageBackend()` is true, mirroring the existing two-branch pattern used by `auth.js` issue/introspect/revoke paths.
- Add a regression test that seeds a grant directly into postgres `grants` and asserts the resolver locates the row rather than returning `not_found`.

## Capabilities

Modified:

- `reference-implementation-architecture`

## Impact

- Production code: `reference-implementation/server/index.js` (single function, dual-branch read).
- Tests: `reference-implementation/test/grant-scoped-state-postgres-routing.test.js` — env-gated on `PDPP_TEST_POSTGRES_URL`.
- Out of scope: the two other findings of the storage-backend routing audit (`deleteAllRecordsForConnector` and `computeIndexState`), which are tracked separately. No public contract change.
