## Why

The reference Postgres lexical search path is now fast and honest, but broad
queries can still rank only a bounded candidate window. That is an interim
quality compromise: callers can tell recall is bounded, but the implementation
can still miss a better lexical match outside the window.

## What Changes

- Add an optional Postgres `pg_search` / ParadeDB BM25 lexical backend path for
  exact scoped top-k retrieval when the extension is explicitly enabled and
  available.
- Preserve the current native Postgres FTS path as the default fallback with its
  existing `candidate_window` recall disclosure.
- Keep SQLite behavior unchanged while preserving API contract parity across
  SQLite, native Postgres FTS, and optional Postgres BM25.
- Add diagnostics/capability metadata that distinguishes `disabled`,
  `unavailable`, `enabled`, and `fallback_native_fts` Postgres lexical backend
  states.
- Require an explicit deployment/licensing posture before the reference Docker
  image depends on or bundles `pg_search`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `reference-implementation-architecture`: define the optional Postgres BM25
  lexical backend, fallback behavior, diagnostics, and deployment constraints.
- `lexical-retrieval`: define when lexical recall metadata may report exact
  scoped top-k retrieval instead of a bounded candidate window.

## Impact

- Runtime: `reference-implementation/server/postgres-search.js`,
  `reference-implementation/server/postgres-storage.js`,
  `reference-implementation/server/search.js`, metadata/diagnostics surfaces.
- Storage: optional Postgres extension probe and optional BM25 index DDL; no
  SQLite storage change.
- Contracts: lexical recall metadata remains mandatory; optional BM25 may
  change `meta.recall.ranking_scope` only when exact scoped top-k is proven.
- Deployment: reference image/operator documentation must explicitly handle
  `pg_search` extension availability and licensing posture.
- Tests: Postgres fallback tests, optional `pg_search` integration tests,
  lexical retrieval conformance, MCP recall mirroring, and SQLite parity.
