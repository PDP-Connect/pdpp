## Why

The reference implementation has proven selected Postgres storage behavior with
env-gated conformance drivers, but normal runtime storage still remains SQLite
only. This final Postgres slice makes records, blobs, disclosure spine, and
retrieval storage selectable at runtime while preserving SQLite as the default.

## What Changes

- Add an explicit Postgres runtime storage mode for records, blobs, disclosure
  spine, lexical search, semantic search, and hybrid search backing data.
- Add idempotent Postgres schema/bootstrap code for the runtime tables needed by
  those surfaces.
- Promote `pg` to a runtime dependency only for the explicit Postgres backend.
- Keep SQLite as the default backend for local development, tests, and existing
  deployments unless `PDPP_STORAGE_BACKEND=postgres` is set.
- Add conformance and route-level validation that exercises the Postgres backend
  against the same user-visible record/search/blob/spine semantics as SQLite.
- Treat this as the second and final Postgres slice; if a required runtime
  surface cannot be implemented cleanly, stop and redesign instead of creating a
  third Postgres tranche.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `reference-implementation-architecture`: Adds the explicit Postgres runtime
  storage contract for records/search/blob/spine surfaces while preserving the
  default SQLite backend.

## Impact

- Runtime configuration: `PDPP_STORAGE_BACKEND=postgres` and
  `PDPP_DATABASE_URL` for Postgres mode; SQLite remains `PDPP_DB_PATH` driven.
- Reference server storage modules for records, blobs, spine events, lexical
  retrieval, semantic retrieval, and hybrid search composition.
- Compose/dev docs and env examples for the runtime Postgres mode.
- Dependency scope for `pg` moves from dev/test-only to runtime dependency.
- Validation covers SQLite default behavior, Postgres-gated behavior, typecheck,
  lints, OpenSpec strict validation, and owner workstream status.
