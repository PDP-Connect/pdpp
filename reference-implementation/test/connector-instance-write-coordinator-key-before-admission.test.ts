// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression coverage for the UAT :3012 GroupMe blob-admission defect
 * (run_1786339135735_1): a blob-upload writer for one connector instance was
 * getting `connector_instance_busy` (mapped to HTTP 503 by
 * ref-error-status.ts) even though nothing held the per-instance key it
 * needed — the mechanism was NOT simple per-key FIFO unfairness.
 *
 * Root cause: `withConnectorInstanceWrite` used to call `acquireAdmission()`
 * (the GLOBAL activeWriters/admissionWaiters gate, capacity `activeLimit()`,
 * default 4) BEFORE `acquireKey()` (the per-connector-instance FIFO gate). A
 * caller blocked on `acquireKey` for a hot key still occupied a global
 * admission slot doing zero useful work. Once `activeLimit()` callers were
 * all blocked on the SAME key, every OTHER call to `withConnectorInstanceWrite`
 * — for that instance or any other — had to wait behind them in the global
 * admission queue, even when the per-key gate it actually needed was free.
 *
 * Fix: acquire the key BEFORE admission, matching
 * `withConnectorInstanceControlPlaneWrite`'s existing key-only design. A
 * caller now only consumes a global admission slot once it actually holds
 * the resource it needs. See /tmp/ingest-blob-admission-0810.md for the full
 * diagnosis and production log evidence.
 *
 * The test below proves ORDER, not timing: the unrelated writer's operation
 * must observably RUN while the hot holder is still deliberately held open
 * (never released until the test explicitly signals it), with every
 * same-key waiter it competes against already parked on the key. A wall-
 * clock assertion cannot distinguish "admitted because unrelated same-key
 * pressure no longer blocks it" from "admitted because the scheduler
 * happened to be fast this run" — event ordering can. A safety timeout
 * exists ONLY to fail the test cleanly instead of hanging if a regression
 * reintroduces the block; it never gates the pass/fail verdict, and its
 * timer handle is explicitly cancelled (`cancellableTimeout`) the instant
 * the real race settles, so a passing run does not keep an idle timer
 * pinning the event loop open for the rest of the safety window.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  __setConnectorInstanceWritePhaseHookForTest,
  connectorInstanceWriteCoordinatorStatsForTests,
  withConnectorInstanceWrite,
} from "../server/connector-instance-write-coordinator.ts";

const SAFETY_TIMEOUT_MS = 5000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A `setTimeout`-backed deadline whose timer handle is cancellable, so a
 * race that resolves before the deadline fires does not leave a live timer
 * pinning the event loop open — `node --test` (and any caller awaiting
 * process exit) must observe the process end promptly once the real work
 * finishes, not after the full safety-timeout duration.
 */
function cancellableTimeout<T>(ms: number, value: T): { cancel: () => void; promise: Promise<T> } {
  let timer: ReturnType<typeof setTimeout>;
  const promise = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(value), ms);
  });
  return {
    cancel: () => clearTimeout(timer),
    promise,
  };
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function withCoordinatorEnvironment<T>(
  values: Record<string, string | number>,
  operation: () => Promise<T>
): Promise<T> {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      process.env[key] = String(value);
    }
    return await operation();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

/**
 * Polls a predicate until it holds, with a hard safety bound. This is NOT
 * timing-as-correctness: the predicate itself is the deterministic
 * condition under test (a synchronous counter/log updated by a coordinator
 * hook), and the safety bound exists only so a genuine regression fails the
 * test cleanly instead of hanging forever.
 */
async function waitForCondition(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + SAFETY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    // biome-ignore lint/performance/noAwaitInLoops: Polling a deterministic condition, not asserting on elapsed time — the caller's assertion is what gates pass/fail.
    await delay(1);
  }
  throw new Error(`waitForCondition safety timeout: ${description} never held within ${SAFETY_TIMEOUT_MS}ms`);
}

/** Polls the coordinator's own stats until a predicate holds, with a hard safety bound. */
function waitForStats(
  predicate: (stats: ReturnType<typeof connectorInstanceWriteCoordinatorStatsForTests>) => boolean,
  description: string
): Promise<void> {
  return waitForCondition(() => predicate(connectorInstanceWriteCoordinatorStatsForTests()), description);
}

test("an unrelated instance's writer RUNS while activeLimit()-many same-key waiters are still parked on a hot instance's held key", async () => {
  await withCoordinatorEnvironment(
    { PDPP_INGEST_ACTIVE_BATCH_LIMIT: 4, PDPP_INGEST_ADMISSION_QUEUE_LIMIT: 16, PDPP_INGEST_LOCK_WAIT_MS: 60_000 },
    async () => {
      const hotInstance = "cin_groupme_hot";
      const otherInstance = "cin_groupme_blob_target";
      const events: string[] = [];

      // Deterministic per-call marker: `before_key_acquire` fires
      // synchronously (in registration order) the instant a call reaches
      // acquireKey, whether it then resolves the key immediately or has to
      // queue — this is the load-bearing observable the rest of the test
      // polls on, not a timer.
      let hotInstanceKeyAttempts = 0;
      __setConnectorInstanceWritePhaseHookForTest((stage, context) => {
        if (stage === "before_key_acquire" && context.connectorInstanceId === hotInstance) {
          hotInstanceKeyAttempts += 1;
        }
      });

      // Deliberately held open until explicitly released, well past every
      // assertion below — this is what makes the proof about ORDER: if the
      // unrelated writer's operation runs at all before this resolves, it
      // was not waiting on the holder or the same-key pressure it created.
      // PDPP_INGEST_LOCK_WAIT_MS is set to 60s above specifically so a
      // same-key waiter's own admission wait can never race this deadline —
      // holderRelease is the ONLY thing that unblocks this test's writers,
      // in `finally`, unconditionally, so a thrown assertion still lets
      // every pending promise settle before the test function returns.
      const holderRelease = deferred<void>();
      let holder: Promise<void> | undefined;
      let sameKeyWaiters: Promise<unknown>[] = [];
      let other: Promise<void> | undefined;
      const safetyTimer = cancellableTimeout(SAFETY_TIMEOUT_MS, "timed-out" as const);
      try {
        holder = withConnectorInstanceWrite(hotInstance, async () => {
          events.push("hot-holder:running");
          await holderRelease.promise;
          events.push("hot-holder:released");
        });
        await waitForCondition(() => hotInstanceKeyAttempts >= 1, "the hot holder must reach acquireKey first");
        await waitForStats((stats) => stats.activeWriters >= 1, "the hot holder must win admission+key");

        // activeLimit() (4) more same-key callers pile up BEHIND the same
        // key — `ingestRecords`'s drain-loop / reconcile-repair's
        // sequential re-entry shape against ONE hot connector_instance_id.
        // Pre-fix, each of these won a GLOBAL admission slot
        // (acquireAdmission ran before acquireKey) before blocking on the
        // key. Post-fix, a caller blocked on someone else's key never
        // reaches acquireAdmission at all.
        sameKeyWaiters = Array.from({ length: 4 }, (_, index) =>
          withConnectorInstanceWrite(hotInstance, () => {
            events.push(`same-key-waiter-${index}:running`);
            return Promise.resolve();
          }).catch((err) => err)
        );
        // Deterministically confirm all 4 have genuinely reached
        // acquireKey (registered as waiters on the held gate, not merely
        // scheduled as microtasks) before the unrelated writer is even
        // started. The hook fires synchronously per call, in call order,
        // so this count is exact. NOTE: under the pre-fix admission-before-
        // key ordering, the 4th same-key waiter never reaches acquireKey at
        // all within this test's window — activeLimit()=4 is already
        // exhausted by the holder + first 3 waiters, so it blocks inside
        // acquireAdmission's own queue instead. That is itself a direct,
        // code-level manifestation of the bug this suite targets: a purely
        // same-key backlog exhausting the GLOBAL admission gate before any
        // per-key registration even happens.
        await waitForCondition(
          () => hotInstanceKeyAttempts >= 5, // holder (1) + 4 same-key waiters
          "all 4 same-key callers must have reached acquireKey on the hot instance (a same-key backlog " +
            "exhausting global admission before per-key registration is itself the admission-before-key defect)"
        );
        assert.deepEqual(events, ["hot-holder:running"], "no same-key waiter may have run yet — the holder is open");

        // A completely unrelated instance's writer (the "blob" in
        // production) now tries to get in, while the hot holder is STILL
        // open and all 4 same-key waiters are STILL parked behind it.
        // Nothing holds `otherInstance`'s per-key gate. Race it against the
        // safety timeout only to avoid a hang on regression — the
        // assertion below is what actually proves the fix.
        const otherRan = deferred<void>();
        other = withConnectorInstanceWrite(otherInstance, () => {
          events.push("other-instance-writer:running");
          otherRan.resolve();
          return Promise.resolve();
        });
        const raced = await Promise.race([otherRan.promise.then(() => "ran" as const), safetyTimer.promise]);
        // Cancel immediately once the race settles either way — an
        // uncancelled timer would keep its handle alive in the event loop
        // for the rest of SAFETY_TIMEOUT_MS even after `raced` resolves,
        // delaying process exit long after the assertions below finish
        // (observed: assertions report ~3ms, but the process itself took
        // ~5.36s to exit under the prior `delay(...)`-based race).
        safetyTimer.cancel();

        // THE ORDERING PROOF: the unrelated writer's operation must have
        // observably run BEFORE the hot holder was released and BEFORE any
        // same-key waiter's operation ran — proving it was never blocked
        // behind them, not merely "eventually admitted."
        assert.equal(
          raced,
          "ran",
          `the unrelated instance's writer never ran within the ${SAFETY_TIMEOUT_MS}ms safety timeout — ` +
            "same-key admission pressure on a DIFFERENT connector instance is still blocking it (regression " +
            "to admission-before-key ordering)"
        );
        assert.deepEqual(
          events,
          ["hot-holder:running", "other-instance-writer:running"],
          "the unrelated writer must run strictly between the hot holder winning its key and any same-key " +
            "waiter's operation running (none of which have run yet — the hot holder is still open) — any " +
            "other order means the unrelated writer was queued behind same-key contention it shares no " +
            "resource with"
        );

        holderRelease.resolve();
        await holder;
        await other;
        await Promise.all(sameKeyWaiters);

        assert.deepEqual(
          events,
          [
            "hot-holder:running",
            "other-instance-writer:running",
            "hot-holder:released",
            "same-key-waiter-0:running",
            "same-key-waiter-1:running",
            "same-key-waiter-2:running",
            "same-key-waiter-3:running",
          ],
          "same-key waiters must still run strictly after the holder releases, in FIFO order — the fix must " +
            "not disturb per-key ordering, only remove the unrelated cross-instance admission coupling"
        );
      } finally {
        // Unconditional: an assertion thrown above must still release the
        // holder so every same-key waiter (and the unrelated writer, if it
        // never ran) can settle before the test function returns — with
        // PDPP_INGEST_LOCK_WAIT_MS set to 60s, nothing else will. The
        // safety timer is cancelled unconditionally too (idempotent if
        // already cancelled above) so an early throw — before the race is
        // even reached — cannot leave its handle alive either.
        safetyTimer.cancel();
        holderRelease.resolve();
        await Promise.allSettled([holder, other, ...sameKeyWaiters].filter(Boolean));
        __setConnectorInstanceWritePhaseHookForTest(null);
      }
    }
  );
});
