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
