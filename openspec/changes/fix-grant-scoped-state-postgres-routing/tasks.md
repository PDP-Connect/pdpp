# Tasks

## 1. Route grant resolution through the active backend

- [x] 1.1 Branch `resolveGrantScopedStateGrant` on `isPostgresStorageBackend()` and read from postgres `grants` with `::text` JSONB casts so the downstream `requirePersistedGrantState` parser sees the same string shape as the SQLite reader.
- [x] 1.2 Export the function so the regression test can call it without spinning up the full Fastify surface.

## 2. Regression test

- [x] 2.1 Add `reference-implementation/test/grant-scoped-state-postgres-routing.test.js` gated on `PDPP_TEST_POSTGRES_URL`.
- [x] 2.2 Seed a grant directly into postgres `grants`; assert the resolver does not return `not_found`. Use `grant_invalid` (manifest unresolved) as the positive signal that the postgres read succeeded.
- [x] 2.3 Negative-control case: a grant id absent from both backends still surfaces as `not_found`.

## 3. Validation

- [x] 3.1 `openspec validate fix-grant-scoped-state-postgres-routing --strict`
- [x] 3.2 Run the new test against the Compose postgres proof service.
- [x] 3.3 Grep readback: no remaining call sites read `grantsGetScopedStateById` outside this resolver.

## Acceptance checks

- Postgres-issued grants flow through `rs.connector-state.get` / `rs.connector-state.put` without `not_found`.
- SQLite mode behavior is byte-identical to pre-fix (same query, same row shape, same downstream resolution).
- The downstream `requirePersistedGrantState` / `requireResolvedPersistedGrantState` code path is unchanged — only the row read is dual-branched.
