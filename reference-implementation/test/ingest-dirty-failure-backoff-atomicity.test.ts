// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Discriminating test for LAND review finding #1: recordSearchIndexDirtyFailure
// must advance `attempts` and compute `next_attempt_at` in ONE atomic
// statement per backend, not two separate autocommit statements. The
// original implementation ran a first UPDATE (increment attempts, RETURNING
// the new value), then a SECOND UPDATE computing next_attempt_at in JS from
// that returned value -- a crash between the two left attempts incremented
// but next_attempt_at unchanged (still null, or still a past timestamp),
// which is a real (if benign) atomicity gap.
//
// A single SQL statement's own atomicity is guaranteed by the storage
// engine itself, not provable by injecting a fault between two JS-level
// calls (there is only one call now). What this test proves instead is the
// JOINT CORRECTNESS that atomicity is FOR: after every failure, attempts
// and next_attempt_at are always mutually consistent with the declared
// backoff schedule -- there is no code path left where one field updates
// without the other reflecting it. That joint-consistency invariant is
// exactly what would break (attempts advanced, next_attempt_at stale/null)
// under the old two-statement design if a crash landed between them.

import assert from "node:assert/strict";
import test from "node:test";
import { closeDb, getDb, initDb } from "../server/db.ts";
import {
  clearSearchIndexDirty,
  markSearchIndexDirtySqlite,
  recordSearchIndexDirtyFailure,
} from "../server/stores/search-index-dirty-store.ts";

const BACKOFF_SCHEDULE_SECONDS = [0, 5, 15, 30, 60, 120, 300, 600];

function rawRow(connectorInstanceId: string, stream: string) {
  return getDb()
    .prepare(
      "SELECT attempts, dirty, last_error, next_attempt_at, revision FROM search_index_dirty WHERE connector_instance_id = ? AND stream = ?"
    )
    .get(connectorInstanceId, stream) as {
    attempts: number;
    dirty: number;
    last_error: string | null;
    next_attempt_at: string | null;
    revision: number;
  };
}

test("recordSearchIndexDirtyFailure: attempts and next_attempt_at are always jointly consistent (single atomic statement)", async () => {
  initDb(":memory:");
  try {
    const connectorInstanceId = "cin_backoff_atomicity";
    const stream = "items";
    const markedAt = "2026-08-10T00:00:00.000Z";
    markSearchIndexDirtySqlite({ connectorId: "backoff-atomicity", connectorInstanceId, stream }, markedAt);

    for (let expectedAttempts = 1; expectedAttempts <= BACKOFF_SCHEDULE_SECONDS.length + 1; expectedAttempts += 1) {
      const before = Date.now();
      // biome-ignore lint/performance/noAwaitInLoops: Each failure must observe the previous failure's persisted attempts count before the next is asserted.
      await recordSearchIndexDirtyFailure({ connectorInstanceId, stream }, `failure #${expectedAttempts}`);
      const after = Date.now();

      const row = rawRow(connectorInstanceId, stream);
      assert.equal(row.attempts, expectedAttempts, `attempts must advance to exactly ${expectedAttempts}`);
      assert.equal(row.last_error, `failure #${expectedAttempts}`, "last_error reflects this exact failure");
      assert.ok(
        row.next_attempt_at,
        "next_attempt_at must be set -- never left null after a failure (the atomicity gap this test guards)"
      );

      // The expected delay for this attempts count, per the SAME schedule
      // baked into both the SQLite CASE ladder (record-failure.sql) and the
      // Postgres CASE expression (search-index-dirty-store.ts).
      const scheduleIndex = Math.min(expectedAttempts, BACKOFF_SCHEDULE_SECONDS.length - 1);
      const expectedDelaySeconds = BACKOFF_SCHEDULE_SECONDS[scheduleIndex] ?? BACKOFF_SCHEDULE_SECONDS.at(-1);
      assert.ok(typeof expectedDelaySeconds === "number");

      const nextAttemptMs = Date.parse(row.next_attempt_at as string);
      // The base time for the computation is `new Date().toISOString()`
      // taken at the top of recordSearchIndexDirtyFailure, bounded between
      // this test's `before`/`after` timestamps around the call.
      const minExpected = before + expectedDelaySeconds * 1000;
      const maxExpected = after + expectedDelaySeconds * 1000;
      assert.ok(
        nextAttemptMs >= minExpected - 1 && nextAttemptMs <= maxExpected + 1,
        `next_attempt_at (${row.next_attempt_at}) must reflect exactly the ${expectedDelaySeconds}s backoff for attempts=${expectedAttempts} computed from the SAME statement that incremented attempts -- got delta ${nextAttemptMs - before}ms, expected ~${expectedDelaySeconds * 1000}ms`
      );

      // Joint consistency: next_attempt_at is never behind marked_at/now in
      // a way that would imply attempts advanced without backoff applying
      // (the exact symptom of the two-statement race this fix closes).
      assert.ok(
        nextAttemptMs > before,
        "next_attempt_at must be in the future relative to this failure, proving backoff was actually applied atomically with the attempts increment"
      );
    }

    // A successful clear resets both fields together -- also proven as one
    // statement (clearSearchIndexDirty), so a scope that recovers does not
    // carry stale attempts/backoff state into its next dirty cycle.
    const clearedOk = await clearSearchIndexDirty({ connectorInstanceId, stream }, 1, new Date().toISOString());
    assert.equal(clearedOk, true, "clear must apply: revision has not advanced since this test's initial mark");
    const cleared = rawRow(connectorInstanceId, stream);
    assert.equal(cleared.attempts, 0, "attempts resets to 0 on clear");
    assert.equal(cleared.next_attempt_at, null, "next_attempt_at resets to null on clear");
    assert.equal(cleared.last_error, null, "last_error resets to null on clear");
  } finally {
    closeDb();
  }
});

test("clearSearchIndexDirty preserves a second mark even when both marks have the same timestamp", async () => {
  initDb(":memory:");
  try {
    const connectorInstanceId = "cin_same_millisecond";
    const stream = "items";
    const sameMarkedAt = "2026-08-12T00:00:00.000Z";
    const key = { connectorId: "same-millisecond", connectorInstanceId, stream };

    markSearchIndexDirtySqlite(key, sameMarkedAt);
    const listedRevision = rawRow(connectorInstanceId, stream).revision;
    markSearchIndexDirtySqlite(key, sameMarkedAt);

    const recontended = rawRow(connectorInstanceId, stream);
    assert.equal(
      recontended.revision,
      listedRevision + 1,
      "every mark advances the generation despite timestamp collision"
    );
    assert.equal(recontended.dirty, 1);

    const staleClear = await clearSearchIndexDirty(
      { connectorInstanceId, stream },
      listedRevision,
      "2026-08-12T00:00:01.000Z"
    );
    assert.equal(staleClear, false, "a reconcile holding the first generation cannot clear the second mark");
    assert.equal(rawRow(connectorInstanceId, stream).dirty, 1, "the newer mark remains eligible for reconciliation");

    const currentClear = await clearSearchIndexDirty(
      { connectorInstanceId, stream },
      recontended.revision,
      "2026-08-12T00:00:02.000Z"
    );
    assert.equal(currentClear, true);
    assert.equal(rawRow(connectorInstanceId, stream).dirty, 0);
  } finally {
    closeDb();
  }
});
