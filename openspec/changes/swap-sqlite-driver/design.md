# Design: close out the SQLite driver swap

## Purpose

This change exists to finish the stability work that moved the reference
implementation off the async `sqlite3` native binding and onto
`better-sqlite3`.

Earlier versions of this change also included extracting static SQL into
`.sql` files. That is still useful, but it is inspectability work, not crash
remediation. It now belongs to `make-reference-queries-inspectable`.

## Root Cause

The crash reproduced under concurrent dashboard workload and consistently
terminated inside `node_sqlite3::Statement::RowToJS` /
`Statement::Work_AfterAll`. The shape matched a native binding / V8 handle
failure while large SQLite text rows were being marshaled through the async
`sqlite3` work queue.

The reference cannot make that class of failure safe with route-level error
handling. The practical fix is to avoid the failing native driver path.

## Why `better-sqlite3`

- It avoids the async `sqlite3` worker queue and row-marshalling path that
  triggered the crash.
- It is a mature, widely deployed Node SQLite driver.
- The reference access pattern is already request-synchronous: handlers await
  each query before continuing, so the synchronous driver preserves the actual
  sequencing model.

## What Remains

The dependency and call-site migration are already complete. The remaining work
is proof and cleanup:

- rerun the original dashboard/search/planning crash sequence against the
  current driver;
- verify an existing polyfill SQLite database opens and serves records;
- keep or delete crash repro scripts intentionally;
- remove temporary diagnostic prints left from the crash hunt;
- decide whether `node --watch` should return to the reference dev command.

## Non-Goals

- No SQL query extraction. That is `make-reference-queries-inspectable`.
- No schema redesign.
- No public API behavior change.
- No broad storage abstraction.

## Acceptance Checks

1. The reference package depends on `better-sqlite3` and no longer depends on
   `@databases/sqlite`.
2. The crash repro that previously killed the server survives at least ten
   rounds.
3. An existing `packages/polyfill-connectors/.pdpp-data/*.sqlite` database opens
   and serves records without migration.
4. `pnpm --dir reference-implementation run verify` passes, with only the known
   baseline composed-origin failure allowed in the broader full-test sweep.
