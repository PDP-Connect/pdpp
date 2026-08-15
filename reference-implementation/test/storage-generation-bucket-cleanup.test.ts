// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Regression test for LAND review finding #2: acquireIndexWork's own
// rejection paths (queue-full immediate rejection, waiter-timeout) must
// also call dropIndexWorkStateIfIdleAndStale, not just releaseIndexWork --
// because a throw from acquireIndexWork itself happens BEFORE
// withIndexWork's try/finally exists (that block only wraps the operation
// AFTER `await acquireIndexWork(...)` returns), so a rejected/timed-out
// admission attempt never reaches releaseIndexWork's cleanup on its own.
//
// A holder pins a stale generation's bucket active while a second call
// queues behind it and times out -- proving the timeout does not
// prematurely (or incorrectly) touch a bucket that is still genuinely in
// use, and that once the holder finally drains, the bucket is correctly
// dropped and the current generation's own accounting is never corrupted
// by any of this. (A perfectly isolated "the bucket's ONLY-ever visitor is
// a rejection" case cannot be constructed through admission-limit
// manipulation alone -- acquireIndexWork's fast-acquire path unconditionally
// wins whenever active < limit, so a rejection is only reachable at all
// when something else is concurrently holding the permit, and that
// something must eventually release. This test settles for proving the
// realistic, reachable shape of the bug instead.)

import assert from "node:assert/strict";
import test from "node:test";
import {
  recordIndexWorkGenerationBucketExistsForTests,
  recordIndexWorkStatsForTests,
  withRecordIndexWorkForGenerationForTests,
  withRecordIndexWorkForTests,
} from "../server/records.ts";
import { bumpStorageGeneration, currentStorageGeneration } from "../server/storage-generation.ts";

interface WorkAdmissionError extends Error {
  code?: string;
}

function isWorkAdmissionError(value: unknown): value is WorkAdmissionError {
  return value instanceof Error;
}

function withEnv(overrides: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    process.env[key] = overrides[key];
  }
  return fn().finally(() => {
    for (const key of Object.keys(overrides)) {
      const value = previous[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

test("a stale generation's bucket is dropped after drain, even when a queued waiter's only fate was a TIMEOUT rejection that never touched releaseIndexWork", async () => {
  await withEnv(
    {
      PDPP_INGEST_INDEX_WORK_ACQUIRE_DEADLINE_MS: "30",
      PDPP_INGEST_INDEX_WORK_LIMIT: "1",
      PDPP_INGEST_INDEX_WORK_QUEUE_LIMIT: "4",
    },
    async () => {
      const workingGeneration = bumpStorageGeneration();
      assert.equal(currentStorageGeneration(), workingGeneration);

      // A holder takes the bucket's only permit while `workingGeneration`
      // is still current (so its own one-time last-gate re-check, which
      // runs immediately after acquiring, passes cleanly) and keeps it
      // until released near the end of this test.
      let releaseHolder: (() => void) | undefined;
      const holderHeld = new Promise<void>((resolve) => {
        releaseHolder = resolve;
      });
      const holder = withRecordIndexWorkForGenerationForTests(workingGeneration, async () => {
        await holderHeld;
      });
      await new Promise((resolve) => setImmediate(resolve));

      // Bump generation forward -- `workingGeneration` becomes stale while
      // the holder is still active.
      const nextGeneration = bumpStorageGeneration();
      assert.equal(currentStorageGeneration(), nextGeneration);

      // A concurrent, unrelated job legitimately holds the NEW current
      // generation's only permit -- if the stale generation's cleanup ever
      // touched the wrong bucket, this would be corrupted by the assertion
      // below.
      let releaseCurrent: (() => void) | undefined;
      const currentHeld = new Promise<void>((resolve) => {
        releaseCurrent = resolve;
      });
      const currentJob = withRecordIndexWorkForTests(async () => {
        await currentHeld;
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(recordIndexWorkStatsForTests(), { active: 1, queued: 0 });

      // A second call against the now-stale `workingGeneration` queues
      // behind the still-active holder and times out 30ms later -- it
      // NEVER acquires, so it never reaches releaseIndexWork's cleanup;
      // only acquireIndexWork's own waiter-timeout catch branch (the fix)
      // ever runs for this call.
      // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
      const timedOut = withRecordIndexWorkForGenerationForTests(workingGeneration, async () => {
        throw new Error("must never run: this waiter should time out before ever acquiring");
      });
      await assert.rejects(timedOut, (err: unknown) => isWorkAdmissionError(err) && err.code === "record_index_busy");

      // The bucket must NOT be dropped while the holder is still active --
      // the timeout's own cleanup call must correctly see it is not idle
      // and leave it alone.
      assert.equal(
        recordIndexWorkGenerationBucketExistsForTests(workingGeneration),
        true,
        "must not drop the bucket while the holder is still active, even after a queued waiter times out"
      );

      // Release the holder last. Its own last-gate re-check already passed
      // (it acquired while still current), so it completes normally, and
      // releaseIndexWork's own cleanup drops the now-idle-and-stale bucket.
      releaseHolder?.();
      await holder;

      assert.equal(
        recordIndexWorkGenerationBucketExistsForTests(workingGeneration),
        false,
        "the stale generation's bucket is dropped once its holder drains"
      );

      assert.deepEqual(
        recordIndexWorkStatsForTests(),
        { active: 1, queued: 0 },
        "the current generation's admission state is untouched throughout"
      );

      releaseCurrent?.();
      await currentJob;
    }
  );
});
