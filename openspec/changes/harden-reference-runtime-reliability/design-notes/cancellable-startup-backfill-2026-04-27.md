# Cancellable startup retrieval backfill (P1)

Date: 2026-04-27
Status: implemented (code change, no spec delta)
Author: docker-ops bughunt lane

## Problem

`startServer` schedules `runRetrievalStartupBackfill(...)` via
`setImmediate` after AS/RS listen. The CLI's `exitOnSignal` closes HTTP
servers and calls `closeDb()` without awaiting that backfill. On
`node --watch` (dev compose) and `docker compose restart reference`,
the next process can re-open the same WAL DB while the previous
process's `index.upsertMany`/`embed` loop is still mid-write — the
sibling sees a stale lock and trips
`SQLITE_BUSY: database is locked`. This is the most plausible source
of the owner-observed restart failure.

`raw.exec(SCHEMA)` inside `initDb` runs BEFORE
`seedPreRegisteredClients` (which is already wrapped in
`runWithSqliteBusyRetry`), so even when the seed retry would absorb a
transient lock, the SCHEMA exec at boot does not.

## Decision

This is an internal cancellation/await-on-shutdown contract; no public
API change. No spec delta required for `harden-reference-runtime-reliability`
or `reference-implementation-architecture`.

Implementation:

1. Thread an `AbortSignal` from `startServer` through
   `scheduleRetrievalStartupBackfill` → `runRetrievalStartupBackfill`
   → `lexicalIndexBackfillForManifest` /
   `semanticIndexBackfillForManifest` → `rebuildLexicalIndexForStream`
   / `rebuildSemanticIndexForStream`. The page loops in the
   per-stream rebuilders check `signal.aborted` between transactions
   and throw if asserted; the per-manifest loops check between
   connectors. This bounds cancellation latency to one page-write
   (≤500 records) plus the embed/upsert RTT.

2. `startServer` returns an `abortStartupBackfill` function alongside
   the existing `startupBackfillDone` Promise.

3. The CLI `exitOnSignal` handler calls `abortStartupBackfill` BEFORE
   `closeDb()` and races `startupBackfillDone` against a 2 s deadline
   (matches the existing HTTP-drain budget). Backfill that exits
   cleanly inside the budget logs as a normal shutdown; backfill that
   does not is left to the OS-level process exit.

4. Wrap `raw.exec(SCHEMA)` in a new sync sibling
   `runWithSqliteBusyRetrySync` that mirrors the async helper's policy
   (5 attempts, exponential backoff capped at 1.5 s, only retries on
   transient `SQLITE_BUSY`/`SQLITE_LOCKED`). Sync because better-sqlite3
   is sync; the boot path is not async-safe.

## Rationale for "no spec change"

The existing `harden-reference-runtime-reliability` capability covers
"final structured log on crash or signal" + "graceful shutdown emits
exactly one info record." Cancellable cleanup of a background job is
implementation detail under the existing graceful-shutdown
requirement. No new behavior is asserted at the spec boundary; the
new exit path still produces "one info record naming the signal" and
still releases the DB.

## Tests

Targeted in `reference-implementation/test/`:
- existing `runtime-pipe-resilience.test.js` continues to pass (no
  regression in CLI handler shape).
- the public API contract (`startupBackfillDone`,
  `abortStartupBackfill`) is exercised through `startServer` in unit
  tests where applicable.

## Out of scope

- Per-page progress logs (P2 finding #5) — followup.
- Healthcheck + restart policy (P2 findings #3, #4) — followup.
