// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression coverage for the single-terminal-emission gate.
 *
 * Live evidence (run_1785522735922, 2026-07-31): the Gmail connector
 * ingested every batch successfully (35/35, 83/83, 40/40, 1/1 — 159 records
 * total) and STILL failed with connector_protocol_violation
 * "Connector emitted DONE after DONE", zero checkpoint committed. This was
 * after a prior fix had already closed the fail()-doesn't-halt-main() class
 * (a ConnectorFailure marker checked by exactly one catch site) — proving
 * that fix protected only the one path it instrumented. The real invariant
 * a connector needs is architectural: no matter which of its independent
 * terminal-decision sites fires, or in what order, or how long after
 * another one already fired, at most one DONE ever reaches the wire.
 * `createTerminalOnceGate` is that invariant, factored out so it's testable
 * without spawning a subprocess or mocking IMAP.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createTerminalOnceGate } from "./terminal-once.ts";

test("terminal-once gate: first attempt wins and invokes onEmit exactly once", () => {
  const emitted: number[] = [];
  const gate = createTerminalOnceGate<number>((payload) => emitted.push(payload));

  const won = gate.attempt(1);

  assert.equal(won, true);
  assert.deepEqual(emitted, [1]);
  assert.equal(gate.emitted, true);
});

test("terminal-once gate: success followed by a late failure attempt does not re-emit (the live bug shape)", () => {
  const emitted: Array<{ status: string }> = [];
  const gate = createTerminalOnceGate<{ status: string }>((payload) => emitted.push(payload));

  // main()'s success tail wins the race — matches the live run: all
  // batches ingested, a real DONE(succeeded) already reached the runtime.
  const successWon = gate.attempt({ status: "succeeded" });
  // A late unhandledRejection/uncaughtException — or any other independent
  // terminal-decision site — fires AFTER the process is already
  // logically done, during flushAndExitAfterRuntimeAck's async wait.
  const lateFailureWon = gate.attempt({ status: "failed" });

  assert.equal(successWon, true, "the first (success) attempt must win");
  assert.equal(lateFailureWon, false, "a later attempt must be dropped, not win");
  assert.deepEqual(emitted, [{ status: "succeeded" }], "only the winning payload ever reaches onEmit");
  assert.equal(emitted.length, 1, "onEmit must never be called a second time");
});

test("terminal-once gate: failure followed by a second failure attempt does not re-emit", () => {
  const emitted: Array<{ status: string; message: string }> = [];
  const gate = createTerminalOnceGate<{ status: string; message: string }>((payload) => emitted.push(payload));

  // e.g. fail() winning the race against handleMainRejection's own
  // failure-DONE for the same underlying error.
  const firstWon = gate.attempt({ status: "failed", message: "first" });
  const secondWon = gate.attempt({ status: "failed", message: "second" });

  assert.equal(firstWon, true);
  assert.equal(secondWon, false);
  assert.deepEqual(emitted, [{ status: "failed", message: "first" }]);
});

test("terminal-once gate: many concurrent attempts — exactly one wins, regardless of order", () => {
  const emitted: number[] = [];
  const gate = createTerminalOnceGate<number>((payload) => emitted.push(payload));

  const results = [1, 2, 3, 4, 5].map((n) => gate.attempt(n));

  assert.deepEqual(
    results,
    [true, false, false, false, false],
    "only the first call in program order wins, no matter how many follow"
  );
  assert.equal(emitted.length, 1, "onEmit fires exactly once across any number of attempts");
});

test("terminal-once gate: emitted flag reflects gate state, not payload status", () => {
  const gate = createTerminalOnceGate<{ status: string }>(() => undefined);

  assert.equal(gate.emitted, false, "not emitted before any attempt");
  gate.attempt({ status: "failed" });
  assert.equal(gate.emitted, true, "emitted after the first attempt, win or lose is not the question — it won");
  gate.attempt({ status: "succeeded" });
  assert.equal(gate.emitted, true, "still true; a dropped later attempt does not change gate state");
});
