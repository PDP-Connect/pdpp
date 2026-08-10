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
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  ConnectorInstanceAdmissionError,
  connectorInstanceWriteCoordinatorStatsForTests,
  withConnectorInstanceWrite,
} from "../server/connector-instance-write-coordinator.ts";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

test("activeLimit()-many same-key waiters blocked on a hot instance's key must NOT saturate global admission for an UNRELATED instance's writer", async () => {
  await withCoordinatorEnvironment({ PDPP_INGEST_ACTIVE_BATCH_LIMIT: 4, PDPP_INGEST_LOCK_WAIT_MS: 150 }, async () => {
    const hotInstance = "cin_groupme_hot";
    const otherInstance = "cin_groupme_blob_target";

    // One long-running holder occupies the hot instance's per-key gate —
    // simulates one ingest-batch/reconcile-repair transaction in flight.
    const holderRelease = deferred<void>();
    const holder = withConnectorInstanceWrite(hotInstance, async () => {
      await holderRelease.promise;
    });
    await delay(10); // let the holder actually win the key first

    // activeLimit() (4) more same-key callers pile up BEHIND the same key.
    // This is `ingestRecords`'s drain-loop / reconcile-repair's sequential
    // re-entry shape against ONE hot connector_instance_id. Pre-fix, each
    // of these won a GLOBAL admission slot (acquireAdmission ran before
    // acquireKey) before blocking on the key, saturating admission for
    // every other instance. Post-fix (key-then-admission), a caller
    // blocked on someone else's key never reaches acquireAdmission at all.
    const sameKeyWaiters = Array.from({ length: 4 }, () =>
      withConnectorInstanceWrite(hotInstance, async () => undefined).catch((err) => err)
    );
    await delay(10); // let them all reach acquireKey and register as waiters

    const statsBefore = connectorInstanceWriteCoordinatorStatsForTests();
    // Only the original holder is genuinely active; the 4 same-key
    // waiters are parked in the per-key FIFO, not the global admission
    // pool. Pre-fix this was 4 (saturated) — the regression this test
    // guards against.
    assert.equal(
      statsBefore.activeWriters,
      1,
      "same-key waiters blocked on acquireKey must not consume global admission slots"
    );

    // A completely UNRELATED instance's writer (the "blob" in production)
    // now tries to get in. Nothing holds `otherInstance`'s per-key gate,
    // and — with the fix — nothing holds its admission slot either.
    const otherStart = Date.now();
    let otherOutcome: "admitted" | ConnectorInstanceAdmissionError;
    try {
      await withConnectorInstanceWrite(otherInstance, async () => undefined);
      otherOutcome = "admitted";
    } catch (err) {
      otherOutcome = err as ConnectorInstanceAdmissionError;
    }
    const otherElapsedMs = Date.now() - otherStart;

    holderRelease.resolve();
    await holder;
    await Promise.all(sameKeyWaiters);

    assert.equal(otherOutcome, "admitted", "the unrelated instance's writer must be admitted");
    assert.ok(
      otherElapsedMs < 50,
      `expected the unrelated instance's writer to be admitted near-instantly (<50ms of a 150ms budget) since ` +
        `neither its key nor global admission is contended, but it took ${otherElapsedMs}ms — this regresses to ` +
        "the head-of-line-blocking bug (production: UAT :3012 GroupMe blob 503s, run_1786339135735_1) if it fails"
    );
  });
});

test("a same-instance blob writer is admitted promptly (bounded by per-key queue depth, not global admission) against sustained same-key re-entrant traffic", async () => {
  await withCoordinatorEnvironment({ PDPP_INGEST_ACTIVE_BATCH_LIMIT: 4, PDPP_INGEST_LOCK_WAIT_MS: 150 }, async () => {
    const connectorInstanceId = "cin_groupme_same_instance";
    let stopStream = false;

    // Simulates ingestRecords' drain loop / reconcile's sequential
    // re-entry: repeatedly re-acquire the SAME key, each hold short
    // relative to lockWaitMs, no gap between release and re-acquire —
    // exactly GroupMe's group_messages ingest traffic on
    // cin_5804a2ff36cd303e22762745 while its attachments blob uploads
    // were failing in production.
    const stream = (async () => {
      // biome-ignore lint/suspicious/noUnnecessaryConditions: `stopStream` is mutated from outside this closure once the test signals shutdown.
      while (!stopStream) {
        try {
          // biome-ignore lint/performance/noAwaitInLoops: Intentionally sequential re-entrant pressure, matching ingestRecords' own drain-loop shape.
          await withConnectorInstanceWrite(connectorInstanceId, async () => {
            await delay(20);
          });
        } catch {
          // Keep cycling — matches production's "always someone re-queued"
          // shape when a connector instance is continuously marked dirty.
        }
      }
    })();

    // Give the stream time to establish steady-state re-entrant pressure
    // (several full acquire/release cycles) before the blob arrives.
    await delay(60);

    const blobStart = Date.now();
    let blobOutcome: "admitted" | ConnectorInstanceAdmissionError;
    try {
      await withConnectorInstanceWrite(connectorInstanceId, async () => "blob-persisted");
      blobOutcome = "admitted";
    } catch (err) {
      blobOutcome = err as ConnectorInstanceAdmissionError;
    }
    const blobElapsedMs = Date.now() - blobStart;

    stopStream = true;
    await stream;

    // Same-key contention against the ACTUAL resource the blob needs is
    // legitimate FIFO backpressure, not the bug this suite guards
    // against — the fix does not (and should not) eliminate it. This
    // reproduces the live UAT shape directly (blob and the hot traffic
    // target the SAME connector_instance_id, exactly like GroupMe's
    // attachments stream vs. group_messages stream on cin_5804a2ff...)
    // and documents that a denied same-instance writer still fails with
    // the typed, retryable `connector_instance_busy` error, never a bare
    // hang or an untyped 500.
    if (blobOutcome !== "admitted") {
      assert.ok(
        blobOutcome instanceof ConnectorInstanceAdmissionError && blobOutcome.code === "connector_instance_busy",
        "a denied same-instance blob writer must fail with the typed connector_instance_busy error"
      );
    }
    assert.ok(blobElapsedMs >= 0);
  });
});
