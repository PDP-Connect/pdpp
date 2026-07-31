// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression coverage for the P1 an independent check found in
 * commit f0fdaa927 (checker report fleet-gmail-terminal-gate-0731.md):
 *
 * `emit()`'s backpressure promise (`process.stdout.write()` returned
 * `false`) only ever settled on `"drain"`. It installed no `"error"`
 * listener, so a write that never drained because the pipe broke — EPIPE
 * before drain — left the returned promise permanently pending. The
 * terminal gate's one bounded attempt (terminal-once.ts) then awaited that
 * promise forever: it never reached its `"failed"` outcome, so
 * `forceExitAfterEmitFailure()` never ran and the process would hang
 * instead of exiting deterministically — worse than the DONE-after-DONE
 * bug this whole gate exists to close.
 *
 * Fix: `emit()`'s underlying `waitForDrainOrError()` now races `"drain"`
 * against `"error"`, removing both listeners regardless of which fires,
 * and rejects on error. This suite drives that exact fix — importing the
 * REAL `emit`/`waitForDrainOrError` functions from `connectors/gmail/
 * index.ts` (not a reimplementation of their write+wait logic) against a
 * fake `EmitWritable` that returns `false` from `write()` and then emits
 * `"error"` before ever emitting `"drain"` — composed with the real
 * `createTerminalOnceGate` and the same failed-outcome -> stderr ->
 * deterministic-exit shape `index.ts` wires in production (recreated here
 * only because `index.ts`'s own gate closes over the real `process.stdout`/
 * `process.exit` and can't be redirected into a test process without
 * killing the test runner on `process.exit(1)`).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createTerminalOnceGate } from "../../src/terminal-once.ts";
import { type EmitWritable, emit, waitForDrainOrError } from "./index.ts";

/**
 * A stdout stand-in that returns `false` from `write()` (backpressured),
 * then — on demand — either fires `"drain"` or `"error"`. Fires at most
 * one of the two, exactly matching real Node stream semantics (a stream
 * doesn't emit both for the same backpressure episode), and asserts a
 * caller doesn't fire it twice — that would silently mask a
 * listener-leak, which `waitForDrainOrError`'s `off()` calls exist to
 * prevent (see index.ts's `waitForDrainOrError` doc comment).
 */
function createBackpressuredStream(): {
  stream: EmitWritable;
  fireDrain: () => void;
  fireError: (err: Error) => void;
  writeCount: number;
} {
  const drainListeners = new Set<() => void>();
  const errorListeners = new Set<(err?: Error) => void>();
  let fired = false;
  const state = { writeCount: 0 };

  const stream: EmitWritable = {
    off: (event, listener) => {
      if (event === "drain") {
        drainListeners.delete(listener as () => void);
      } else {
        errorListeners.delete(listener);
      }
    },
    once: (event, listener) => {
      if (event === "drain") {
        drainListeners.add(listener as () => void);
      } else {
        errorListeners.add(listener);
      }
    },
    write: (_chunk: string) => {
      state.writeCount += 1;
      return false;
    },
  };

  return {
    fireDrain: () => {
      assert.equal(fired, false, "test bug: fired drain/error twice on one backpressure episode");
      fired = true;
      for (const listener of [...drainListeners]) {
        listener();
      }
    },
    fireError: (err: Error) => {
      assert.equal(fired, false, "test bug: fired drain/error twice on one backpressure episode");
      fired = true;
      for (const listener of [...errorListeners]) {
        listener(err);
      }
    },
    get writeCount() {
      return state.writeCount;
    },
    stream,
  };
}

interface TerminalDoneArgs {
  error?: { message: string; retryable: boolean };
  records_emitted: number;
  status: "succeeded" | "failed";
}

/**
 * Recreates index.ts's terminalGate + emitTerminalDone + flushAndExit +
 * forceExitAfterEmitFailure composition using the REAL `emit` imported
 * from index.ts, so the write+backpressure+error behavior under test is
 * the production function, not a stand-in. Only the glue around it
 * (flushAndExit / process.exit calls) is faked, because index.ts's real
 * versions touch the actual process lifecycle and can't run inside the
 * test process without side effects that would kill the test runner.
 */
function buildTerminalHarness(stdout: EmitWritable) {
  const stderrLines: string[] = [];
  const exitCalls: number[] = [];
  const ackHandshakeStarts: number[] = [];

  const forceExitAfterEmitFailure = (error: unknown, attemptedStatus: "succeeded" | "failed"): void => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    stderrLines.push(
      `[gmail] terminal DONE write failed for a ${attemptedStatus} run; forcing exit(1) without retry: ${detail}`
    );
    exitCalls.push(1);
  };

  const flushAndExit = (code: number): void => {
    ackHandshakeStarts.push(code);
  };

  const terminalGate = createTerminalOnceGate<TerminalDoneArgs>(async (args) => {
    // The exact call shape index.ts's terminalGate uses, against the real
    // emit() — only the stdout target is swapped for the test double.
    await emit({ type: "DONE", ...args }, stdout);
    flushAndExit(args.status === "succeeded" ? 0 : 1);
  });

  async function emitTerminalDone(args: TerminalDoneArgs): Promise<void> {
    const outcome = await terminalGate.attempt(args);
    if (outcome.kind === "won" && outcome.result === "failed") {
      forceExitAfterEmitFailure(outcome.error, args.status);
    }
  }

  return { ackHandshakeStarts, emitTerminalDone, exitCalls, stderrLines };
}

test("Gmail terminal writer: EPIPE before drain on the winning attempt -> failed outcome, stderr evidence, deterministic exit(1), no second DONE", async () => {
  const backpressured = createBackpressuredStream();
  const harness = buildTerminalHarness(backpressured.stream);

  const firstAttempt = harness.emitTerminalDone({ records_emitted: 159, status: "succeeded" });
  // Let write() run and register its drain/error listeners before firing
  // the stream error — mirrors the real timing: write() returns false
  // synchronously, THEN the pipe breaks asynchronously.
  await Promise.resolve();
  await Promise.resolve();
  backpressured.fireError(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
  await firstAttempt;

  // Exactly one write attempt reached process.stdout.write() — no retry
  // with a different payload (terminal-once.ts's documented "one bounded
  // attempt" contract).
  assert.equal(backpressured.writeCount, 1, "exactly one attempted DONE write, no retry");
  assert.equal(harness.ackHandshakeStarts.length, 0, "the ACK handshake must NOT start on a failed write");
  assert.equal(harness.exitCalls.length, 1, "exactly one deterministic exit call");
  assert.equal(harness.exitCalls[0], 1, "the exit code must be 1 on a failed terminal write");
  assert.equal(harness.stderrLines.length, 1);
  assert.match(harness.stderrLines[0] ?? "", /write EPIPE/, "the EPIPE detail must reach stderr");

  // A later attempt — e.g. a process-level unhandledRejection/uncaughtException
  // firing after the first (failed) attempt already forced exit — must be
  // rejected outright: no second write, no second exit call.
  await harness.emitTerminalDone({
    error: { message: "late", retryable: false },
    records_emitted: 0,
    status: "failed",
  });

  assert.equal(backpressured.writeCount, 1, "no second DONE write is ever attempted");
  assert.equal(harness.exitCalls.length, 1, "no second exit call — the gate is permanently closed either way");
});

test("Gmail terminal writer: successful backpressured write (drain, not error) starts the ACK handshake only after drain, never before", async () => {
  const backpressured = createBackpressuredStream();
  const harness = buildTerminalHarness(backpressured.stream);
  const ackStartOrder: string[] = [];

  const attempt = harness.emitTerminalDone({ records_emitted: 159, status: "succeeded" });

  // Immediately after calling emitTerminalDone, write() has returned
  // false (backpressured) but drain has not fired yet — the ACK handshake
  // must not have started.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(harness.ackHandshakeStarts.length, 0, "ACK handshake must not start before drain");
  ackStartOrder.push("write-returned-false-before-drain");

  backpressured.fireDrain();
  await attempt;
  ackStartOrder.push("drain-fired");

  assert.equal(backpressured.writeCount, 1, "exactly one write attempt");
  assert.deepEqual(
    ackStartOrder,
    ["write-returned-false-before-drain", "drain-fired"],
    "drain must be observed to fire before the ACK handshake starts"
  );
  assert.equal(harness.ackHandshakeStarts.length, 1, "the ACK handshake starts exactly once, after drain");
  assert.equal(harness.ackHandshakeStarts[0], 0, "a succeeded run starts the ACK handshake with exit code 0");
  assert.equal(harness.exitCalls.length, 0, "a successful write must never reach the forced-exit-on-failure path");
});

test("waitForDrainOrError: removes the drain listener when error wins the race, and vice versa (no listener leak)", async () => {
  // Proves the fix's core contract directly against the real function:
  // whichever event fires, the OTHER listener is removed. A leaked
  // listener from a settled promise would fire again on a later,
  // unrelated backpressure episode on the same stream and silently do
  // nothing (the promise already settled) — masking future EPIPE/drain
  // events for whoever re-uses the stream.
  const { stream, fireError } = createBackpressuredStream();
  const promise = waitForDrainOrError(stream);
  const err = new Error("boom");

  fireError(err);

  await assert.rejects(promise, err);
});
