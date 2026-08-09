// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Discriminating test for drainConnectorInstanceIndexWork's timeout contract
// (server/records.ts). A barrier that silently returns on timeout is not a
// barrier: it lets a caller (CLI shutdown, a test assertion) proceed as
// though the deferred lexical/semantic index lane had settled when a job is
// still genuinely in flight -- recreating the exact "[db] No database is
// open" race this barrier exists to close. This file proves:
//
//  1. A tail that is still pending when the deadline elapses causes the
//     barrier to REJECT with ConnectorInstanceIndexWorkDrainTimeoutError,
//     not resolve.
//  2. A tail that settles BEFORE the deadline lets the barrier resolve
//     normally -- the timeout path is not the only path, and the barrier
//     does not false-fail a genuinely-quick drain.

import assert from "node:assert/strict";
import test from "node:test";
import {
  ConnectorInstanceIndexWorkDrainTimeoutError,
  drainConnectorInstanceIndexWork,
  enqueueConnectorInstanceIndexWorkForTests,
} from "../server/records.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  assert.ok(resolve, "Promise executor runs synchronously, so resolve is always assigned here");
  return { promise, resolve };
}

test("drainConnectorInstanceIndexWork rejects with a typed timeout error when a tail is still pending at the deadline", async () => {
  const release = deferred();
  const stuckTail = enqueueConnectorInstanceIndexWorkForTests("cin_drain_timeout_probe", async () => {
    await release.promise;
  });

  await assert.rejects(
    drainConnectorInstanceIndexWork(20),
    (err: unknown) => {
      assert.ok(
        err instanceof ConnectorInstanceIndexWorkDrainTimeoutError,
        "the barrier must reject with its own typed timeout error, not resolve silently"
      );
      assert.equal(
        err.pendingConnectorInstanceCount,
        1,
        "the error reports exactly the one still-pending connector instance"
      );
      return true;
    },
    "a still-pending tail must make the barrier fail loudly, not return as though drained"
  );

  // Clean up: release the stuck tail so it does not leak into a later test's
  // connectorInstanceIndexTails map.
  release.resolve();
  await stuckTail;
});

test("drainConnectorInstanceIndexWork resolves normally once every tail settles before the deadline", async () => {
  const release = deferred();
  const tail = enqueueConnectorInstanceIndexWorkForTests("cin_drain_success_probe", async () => {
    await release.promise;
  });

  const drainResult = drainConnectorInstanceIndexWork(2000);
  release.resolve();

  await assert.doesNotReject(
    drainResult,
    "a tail that settles before the deadline must let the barrier resolve normally"
  );
  await tail;
});

// REVISE-flagged defect: the round-boundary race originally paired
// Promise.allSettled(tails) with a bare `new Promise((resolve) =>
// setTimeout(resolve, ...))` inside Promise.race. Promise.race never clears
// the loser's timer, so even a drain whose tail settles almost immediately
// left a ref'ed setTimeout scheduled for the FULL remaining deadline (up to
// timeoutMs) — Node's event loop stays alive for that whole duration even
// though drainConnectorInstanceIndexWork itself already resolved. The tail
// must still be genuinely PENDING (not already resolved) when the drain's
// first loop iteration snapshots connectorInstanceIndexTails, or the drain
// takes the tails.length === 0 fast path and never reaches the race at
// all -- a same-tick-resolved tail would pass this test even against the
// original bug, so the tail below resolves on a real macrotask instead.
test("drainConnectorInstanceIndexWork leaves no pending deadline timer behind once its tail settles", async () => {
  const activeTimeoutCount = () => process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;

  const before = activeTimeoutCount();
  const tail = enqueueConnectorInstanceIndexWorkForTests(
    "cin_drain_no_timer_leak_probe",
    () => new Promise((resolve) => setTimeout(resolve, 5))
  );

  // A long timeoutMs is the whole point of this test: if the round-boundary
  // timer were left uncleared once the tail settles, it would still be
  // ref'ed/pending for nearly this entire duration after the awaited call
  // below returns. A short timeoutMs could pass this test by accident (the
  // leaked timer fires and self-clears before the assertion runs).
  await drainConnectorInstanceIndexWork(60_000);
  const after = activeTimeoutCount();

  assert.ok(
    after <= before,
    `drain must not leave a pending Timeout behind once its tail settles: ${before} active Timeout resource(s) before, ${after} after`
  );
  await tail;
});
