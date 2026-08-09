// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Discriminating test for shutdownStorageClose (server/index.ts), the pure
 * drain-gates-close decision boundary extracted out of the CLI-only
 * `if (process.argv[1]?.endsWith("server/index.ts"))` shutdown block so this
 * invariant is provable at a real boundary instead of by reading the
 * source.
 *
 * REVISE-flagged defect: the original inline shutdown code called
 * closePostgresStorage() UNCONDITIONALLY before checking whether the
 * deferred-index drain had actually succeeded, so a drain timeout still
 * closed Postgres storage under an active job -- the exact race the SQLite
 * closeDb() gating was supposed to prevent, just for the other backend.
 * This file proves the fixed contract: on a successful drain, BOTH
 * closePostgresStorage() and closeDb() run; on a drain timeout, NEITHER
 * runs.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { shutdownStorageClose } from "../server/index.ts";

function callOrder(): { calls: string[]; record: (name: string) => void } {
  const calls: string[] = [];
  return { calls, record: (name: string) => calls.push(name) };
}

test("shutdownStorageClose closes BOTH storage backends when the drain succeeds", async () => {
  const { calls, record } = callOrder();
  const outcome = await shutdownStorageClose({
    closeDb: () => record("closeDb"),
    closePostgresStorage: () => {
      record("closePostgresStorage");
      return Promise.resolve();
    },
    drainConnectorInstanceIndexWork: () => {
      record("drain");
      return Promise.resolve();
    },
  });

  assert.deepEqual(outcome, { closed: true });
  assert.deepEqual(
    calls,
    ["drain", "closePostgresStorage", "closeDb"],
    "a successful drain must close Postgres storage before closeDb, and only after the drain itself completes"
  );
});

test("shutdownStorageClose closes NEITHER storage backend when the drain times out", async () => {
  const { calls, record } = callOrder();
  const drainError = new Error("simulated drain timeout");
  let observedTimeoutErr: unknown;

  const outcome = await shutdownStorageClose({
    closeDb: () => record("closeDb"),
    closePostgresStorage: () => {
      record("closePostgresStorage");
      return Promise.resolve();
    },
    drainConnectorInstanceIndexWork: () => {
      record("drain");
      return Promise.reject(drainError);
    },
    onDrainTimeout: (err) => {
      observedTimeoutErr = err;
    },
  });

  assert.deepEqual(outcome, { closed: false, err: drainError });
  assert.deepEqual(
    calls,
    ["drain"],
    "a drain timeout must close NEITHER closePostgresStorage NOR closeDb -- a deferred job can be using either backend"
  );
  assert.equal(observedTimeoutErr, drainError, "the timeout callback observes the real drain error");
});

test("shutdownStorageClose surfaces the drain error to the caller without needing a callback", async () => {
  const drainError = new Error("simulated drain timeout, no onDrainTimeout supplied");
  const outcome = await shutdownStorageClose({
    closeDb: () => {
      throw new Error("closeDb must not be called on a drain timeout");
    },
    closePostgresStorage: () => Promise.reject(new Error("closePostgresStorage must not be called on a drain timeout")),
    drainConnectorInstanceIndexWork: () => Promise.reject(drainError),
  });

  assert.deepEqual(outcome, { closed: false, err: drainError });
});
