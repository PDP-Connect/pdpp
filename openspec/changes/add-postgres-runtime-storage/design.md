## Context

Slice 1 (`add-postgres-storage-adapters`) proved low-risk storage families
against Postgres through conformance drivers while intentionally avoiding
runtime storage selection. The remaining work is the second and final Postgres
slice: durable reference runtime storage. That includes records, blobs,
disclosure spine, lexical search, semantic search, hybrid search, connector
manifests, OAuth clients, grants, tokens, pending consent, owner-device auth,
connector state, schedules, active runs, and cursor snapshots.

Current runtime code is SQLite-first. Records and search helpers call
`better-sqlite3` directly or through the local query wrapper, semantic retrieval
uses sqlite-vec or a SQLite BLOB fallback, disclosure spine reads/writes are sync
SQLite calls, and AS/control-plane helpers still persist clients, grants,
tokens, pending approvals, and connector manifests in SQLite. Operation modules
are already storage-driver agnostic; the host wires concrete capabilities into
them.

## Goals / Non-Goals

**Goals:**

- Add an explicit Postgres backend for all durable runtime tables required by
  the reference AS/RS/control-plane process: records, blobs, disclosure spine,
  lexical search, semantic search, hybrid search, connector manifests, OAuth
  clients, grants, tokens, pending consent, owner-device auth, connector state,
  schedules, active runs, and cursor snapshots.
- Preserve SQLite as the default backend and preserve existing SQLite tests.
- Keep operation modules independent of concrete database drivers.
- Use idempotent Postgres bootstrap DDL, not manual setup instructions.
- Reuse existing conformance harnesses where available and add runtime-gated
  tests where route/user-visible behavior is the contract.
- Keep this as slice 2 of 2 for Postgres.

**Non-Goals:**

- No migration toolchain for moving existing SQLite data into Postgres.
- No multi-tenant storage service abstraction beyond the concrete backend seam
  needed by the reference runtime.
- No change to public record/search/blob/spine/auth/control-plane response
  shapes.
- No Postgres requirement for default development, default tests, or Docker
  reference startup.
- No third Postgres slice.

## Decisions

1. **Use an explicit runtime backend switch.**

   `PDPP_STORAGE_BACKEND` selects `sqlite` or `postgres`. The default is
   `sqlite`. Postgres mode requires `PDPP_DATABASE_URL` and fails fast when it is
   missing. This avoids implicit coupling to the existing proof service and
   keeps local defaults stable.

2. **Introduce capability-level backend seams, not generic repositories.**

   Records, blobs, spine, lexical search, and semantic search should branch at
   the host/capability layer. Operation modules continue to receive functions
   such as `queryRecords`, `getVisibleRecord`, `readBlob`, and `runSearch`;
   they do not import `pg`, SQL strings, or backend config.

3. **Keep Postgres schema bootstrap idempotent and local.**

   Runtime startup creates the required tables/indexes/extensions if missing.
   Postgres mode uses the `pgvector/pgvector:pg16` image path and may run
   `CREATE EXTENSION IF NOT EXISTS vector`. The JSONB vector path is retained
   only as degraded compatibility for custom Postgres images that lack pgvector.

4. **Preserve record mutation atomicity.**

   Per-stream version allocation, live-record mutation, record-change append,
   and prune behavior remain one durable transaction. Postgres must use row
   locking or atomic upsert/returning behavior that serializes concurrent
   writers for the same `(connector_id, stream)`.

5. **Treat search parity as observable behavior.**

   Lexical, semantic, and hybrid search must return the same grant-safe record
   identities and response shapes as SQLite for the shared fixtures. Scoring
   internals may differ by backend, but authorization, pagination boundaries,
   and disclosure emission must not.

## Risks / Trade-offs

- **Async Postgres driver vs sync SQLite code** -> Branch at async capability
  entry points and leave existing synchronous SQLite internals intact.
- **Semantic vector extension availability** -> Treat pgvector as the expected
  Postgres path; retain a degraded JSONB fallback that computes distances after
  grant-scoped candidate narrowing for custom images where the extension is
  unavailable.
- **SQL dialect drift** -> Keep SQL in backend-specific modules and validate
  with conformance/route tests for each user-visible surface.
- **Backend switch overreach** -> Scope the switch to durable storage owned by
  the reference runtime. Short-lived in-memory tickets may remain in-memory when
  that is already the security design, but durable AS/RS/control-plane rows must
  be Postgres-backed in Postgres mode.
- **Runtime docs overpromise data migration** -> Document that Postgres mode is
  a fresh-runtime storage backend, not a SQLite-to-Postgres migration path.

## Migration Plan

1. Add storage backend config and Postgres bootstrap.
2. Add Postgres-backed records/blob/spine/search runtime modules.
3. Wire the reference server to use Postgres modules when
   `PDPP_STORAGE_BACKEND=postgres`.
4. Add env-gated tests that run against the profile-gated Compose Postgres
   service.
5. Preserve and rerun SQLite default tests.
6. Document setup, validation, and limitations.
7. Validate OpenSpec and workstream status, then commit/push from `main`.
