// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Backend-agnostic monotonic storage-lifecycle generation counter.
 *
 * Bumped by `initDb()`/`closeDb()` (server/db.ts, SQLite) and
 * `initPostgresStorage()`/`closePostgresStorage()` (server/postgres-storage.ts).
 * Any deferred/background unit of work that captures a storage handle
 * indirectly (e.g. by calling the module-level `getDb()`/pool accessors
 * later, not by holding a handle directly) MUST capture
 * `currentStorageGeneration()` at schedule time and re-check it with
 * `isCurrentStorageGeneration()` immediately before touching storage. A
 * mismatch means the storage this work was scheduled against has since been
 * closed and/or replaced (test teardown + re-init being the common case,
 * but the same shape covers a real controlled-shutdown/reinit) -- the work
 * MUST be dropped, silently, rather than either touching the new
 * generation's storage as if it were the old one, or throwing (a dropped
 * job with a durable dirty marker converges via the new generation's own
 * startup reconcile; a job that ran against the wrong storage handle would
 * corrupt or silently no-op against unrelated state, and a thrown error
 * here has no caller left to observe it -- this is fire-and-forget
 * background work by construction).
 *
 * This is a LIFECYCLE fence, not a test convenience: closing/reinitializing
 * storage while background work is in flight is a real event this codebase
 * already supports (test teardown, hot-reload style re-init, and a future
 * controlled-shutdown-then-restart-in-process path), and any subsystem that
 * schedules deferred DB-touching work must be safe across it by
 * construction, not merely "usually finishes first."
 */
let generation = 0;

export function bumpStorageGeneration(): number {
  generation += 1;
  return generation;
}

export function currentStorageGeneration(): number {
  return generation;
}

export function isCurrentStorageGeneration(capturedGeneration: number): boolean {
  return capturedGeneration === generation;
}
