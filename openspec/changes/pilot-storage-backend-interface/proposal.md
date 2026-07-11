# Proposal: pilot-storage-backend-interface

## Why

The reference implementation maintains two storage engines (SQLite via
`records.js`/`search.js`, Postgres via `postgres-records.js`/`postgres-search.js`)
dispatched by `isPostgresStorageBackend()` branches scattered across the server.
A full inventory
classified all 187 such branches: 153 are `drift_to_remove` (the same conceptual
storage operation implemented twice inline in shared orchestration), 21 are
`adapter_selection_keep` (the legitimate backend-selection points, already the
right pattern), and 14 are `backend_specific_keep` (honest dialect logic that is
clearer kept backend-specific: SQLite WAL retry, Postgres `FOR UPDATE` locks,
`sqlite-vec` vs `pgvector`).

Each `drift_to_remove` seam means a new storage operation must be written twice
and kept in sync by hand; conformance suites catch the drift only after it
ships. A `StorageBackend` interface would let shared orchestration call one
typed method and route to one of two thin adapters, making the divergence
explicit and independently testable.

This change does NOT commit to migrating all 153 seams. It pilots ONE operation
to prove the interface pattern reduces real semantic drift without absorbing
honest backend-specific logic, after which continuing is a separate owner
decision.

## What Changes

- Define a minimal `StorageBackend` interface (JSDoc-typed; the codebase is
  mixed JS/TS) with a single method for the pilot operation.
- Implement a SQLite adapter and a Postgres adapter that satisfy it, each
  wrapping the existing backend-specific query.
- Migrate `listRowsForAggregation` (`server/records.js:2547`) — an internal,
  unexported helper called from exactly one site (`aggregateRecords`), with
  five-line structurally-identical implementations on each side — to dispatch
  through the interface, removing its inline `isPostgresStorageBackend()` branch.
- Add a dual-backend conformance harness for the operation that runs the
  PRODUCTION code path against both backends and is green BEFORE and AFTER the
  migration (conformance-first proof of no behavior change).

## Out of Scope

- The other 152 `drift_to_remove` seams (including large entangled ones like
  `ingestRecord`, `queryRecords`, `getRecord`). Whether to continue past this
  pilot is a separate owner decision evaluated against the acceptance criteria.
- Dropping SQLite (the only thing that would justify a query-builder). The pilot
  produces TWO adapters in lockstep, not one engine.
- Enabling the Postgres CI tier (a separate change: runner per-suite isolation +
  pre-existing PG failure cleanup must land first).

## Acceptance Criteria

Acceptance is semantic-seam removal with dual-backend conformance proof, NOT
branch-count reduction.

1. A `StorageBackend` interface exists with the pilot operation's method; a
   SQLite adapter and a Postgres adapter both satisfy it.
2. A dual-backend conformance harness exercises the PRODUCTION
   `listRowsForAggregation` path against both backends and is green BEFORE the
   production migration (baseline) and AFTER it.
3. The `record_json` string-normalization invariant (Postgres returns objects
   that must be stringified; SQLite returns strings) is explicitly asserted by
   the harness and enforced by the Postgres adapter.
4. The existing aggregate-route integration tests remain green without
   modification.
5. The `isPostgresStorageBackend()` branch at `records.js:2547` is removed; no
   new `isPostgresStorageBackend()` call is introduced for this operation.
6. No behavior change on either backend, proven by conformance not assertion.
7. An independent adversarial audit confirms no behavior change and that no
   honest backend-specific logic was absorbed into the interface contract.
8. the independent reviewer RI-owner reviews the diff and tests directly and signs off before merge.

## Assumptions (owner-level; stop if either changes)

- SQLite is retained; the pilot produces two adapters, not a migration away from
  SQLite.
- CI cost is unchanged: the SQLite conformance file runs with no new
  infrastructure; the Postgres conformance file is env-gated.
- Continuing to the remaining 152 seams is a separate decision, made after the
  pilot's results are evaluated.
