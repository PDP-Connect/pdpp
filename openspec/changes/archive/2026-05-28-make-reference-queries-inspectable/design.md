# Design

## Goal

Make the reference implementation's durable SQLite query surface reviewable without forcing readers to infer it from string templates embedded across large JS/TS modules.

## Approach

The change should extract static SQL into a small `reference-implementation/server/queries/` tree and load the statements through a single registry. Each file name should become the stable query identifier used by code and tests.

Dynamic query builders remain in code when the shape is genuinely conditional, such as optional filters, variable `IN (...)` lists, or cursor predicates. Those call sites should be isolated and documented rather than contorted into static files.

## Non-Goals

- No database driver swap; `better-sqlite3` is already the active driver.
- No schema redesign.
- No public API behavior changes.
- No performance rewrite unless a query extraction reveals an existing correctness or performance bug.

## Acceptance Checks

- The extracted query registry is deterministic and fails fast on missing SQL files.
- Every extracted query has a stable name and is prepared at startup or test setup.
- A schema/query validation step catches references to missing tables or columns.
- Existing reference tests pass with the same known baseline exclusions.
