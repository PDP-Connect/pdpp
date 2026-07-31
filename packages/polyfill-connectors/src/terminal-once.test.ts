// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression coverage for the single-terminal-emission gate.
 *
 * Live evidence (run_1785522735922, 2026-07-31): the Gmail connector
 * ingested every batch successfully (35/35, 83/83, 40/40, 1/1 — 159 records
 * total) and STILL failed with connector_protocol_violation
 * "Connector emitted DONE after DONE", zero checkpoint committed, after a
 * prior fix had already closed the fail()-doesn't-halt-main() class via a
 * marker checked by exactly one catch site — proving that fix protected
 * only the one path it instrumented.
 *
 * An independent check of the first cut of this gate then found a second,
 * blocking defect: it latched its "emitted" flag BEFORE calling `onEmit`,
 * so a synchronous throw from `onEmit` (a serialize/write failure) left the
 * gate permanently closed with no DONE ever written and no exit ever
 * started — a silent hang, strictly worse than the double-DONE bug. This
 * suite tests the corrected design: one bounded async attempt per gate,
 * modeled explicitly as pending -> won{committed} or pending -> won{failed}
 * (never a silent hang, never a retry against a payload that can't fix an
 * already-broken stdout), with reentrant/concurrent attempts always losing
 * immediately.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createTerminalOnceGate } from "./terminal-once.ts";

test("terminal-once gate: successful onEmit commits and wins", async () => {
  const emitted: number[] = [];
  const gate = createTerminalOnceGate<number>((payload) => {
    emitted.push(payload);
  });

  const outcome = await gate.attempt(1);

  assert.deepEqual(outcome, { kind: "won", result: "committed" });
  assert.deepEqual(emitted, [1]);
  assert.equal(gate.settled, true);
});

test("terminal-once gate: a synchronously-throwing emitter (the checker's rejected-emitter case) resolves 'failed', not a hang or silent success", async () => {
  const thrown = new Error("stringifyForJsonl blew up");
  const gate = createTerminalOnceGate<number>(() => {
    throw thrown;
  });

  const outcome = await gate.attempt(1);

  assert.equal(outcome.kind, "won");
  assert.equal((outcome as { result: string }).result, "failed");
  assert.equal((outcome as { error: unknown }).error, thrown);
  assert.equal(gate.settled, true, "the gate is permanently closed even though the write failed");
});

test("terminal-once gate: a rejecting async emitter (backpressure/ACK write that never resolves cleanly) also resolves 'failed'", async () => {
  const rejection = new Error("write EPIPE");
  const gate = createTerminalOnceGate<number>(
    () =>
      new Promise<void>((_resolve, reject) => {
        // Simulates a stdout write whose backpressure/drain promise
        // rejects asynchronously — e.g. the runtime's ACK-wait side
        // closing the pipe mid-write.
        setImmediate(() => reject(rejection));
      })
  );

  const outcome = await gate.attempt(1);

  assert.equal(outcome.kind, "won");
  assert.equal((outcome as { result: string }).result, "failed");
  assert.equal((outcome as { error: unknown }).error, rejection);
});

test("terminal-once gate: success followed by a late failure attempt is rejected outright (the live bug shape)", async () => {
  const emitted: Array<{ status: string }> = [];
  const gate = createTerminalOnceGate<{ status: string }>((payload) => {
    emitted.push(payload);
  });

  // main()'s success tail wins the race — matches the live run: all
  // batches ingested, a real DONE(succeeded) already reached the runtime.
  const successOutcome = await gate.attempt({ status: "succeeded" });
  // A late unhandledRejection/uncaughtException — or any other independent
  // terminal-decision site — fires AFTER the process is already
  // logically done.
  const lateFailureOutcome = await gate.attempt({ status: "failed" });

  assert.deepEqual(successOutcome, { kind: "won", result: "committed" });
  assert.deepEqual(lateFailureOutcome, { kind: "lost" }, "a later attempt must be rejected, not win or re-run onEmit");
  assert.deepEqual(emitted, [{ status: "succeeded" }], "onEmit never runs for the losing attempt");
  assert.equal(emitted.length, 1);
});

test("terminal-once gate: failure followed by a second failure attempt is also rejected outright — no retry-until-success", async () => {
  const emitted: Array<{ message: string }> = [];
  const gate = createTerminalOnceGate<{ message: string }>((payload) => {
    emitted.push(payload);
    throw new Error(payload.message);
  });

  const firstOutcome = await gate.attempt({ message: "first" });
  const secondOutcome = await gate.attempt({ message: "second" });

  assert.equal(firstOutcome.kind, "won");
  assert.equal((firstOutcome as { result: string }).result, "failed");
  assert.deepEqual(secondOutcome, { kind: "lost" }, "the gate does not offer a second bounded attempt");
  assert.deepEqual(emitted, [{ message: "first" }], "onEmit only ever runs once, even though it failed");
});

test("terminal-once gate: a reentrant call made synchronously from inside the winning onEmit always loses", async () => {
  const reentrantOutcomes: Array<{ kind: string }> = [];
  let gate!: ReturnType<typeof createTerminalOnceGate<number>>;
  gate = createTerminalOnceGate<number>(() => {
    // Simulates e.g. a synchronous exception handler firing DURING the
    // winning attempt's own emit — must not be able to win alongside its
    // own caller. `claimed` is set before onEmit runs (see
    // terminal-once.ts), so this call observes the claim synchronously —
    // no need to await it to prove it lost the slot immediately.
    gate.attempt(999).then((outcome) => reentrantOutcomes.push(outcome));
  });

  const outerOutcome = await gate.attempt(1);
  // Let the reentrant attempt's already-resolved promise callback run.
  await Promise.resolve();

  assert.deepEqual(outerOutcome, { kind: "won", result: "committed" });
  assert.deepEqual(
    reentrantOutcomes,
    [{ kind: "lost" }],
    "the reentrant call made from inside onEmit must lose, not win alongside its own caller"
  );
});

test("terminal-once gate: many concurrent attempts — exactly one wins, regardless of order", async () => {
  const emitted: number[] = [];
  const gate = createTerminalOnceGate<number>((payload) => {
    emitted.push(payload);
  });

  const outcomes = await Promise.all([1, 2, 3, 4, 5].map((n) => gate.attempt(n)));
  const wins = outcomes.filter((o) => o.kind === "won");
  const losses = outcomes.filter((o) => o.kind === "lost");

  assert.equal(wins.length, 1, "exactly one concurrent attempt wins");
  assert.equal(losses.length, 4, "every other concurrent attempt is rejected outright");
  assert.equal(emitted.length, 1, "onEmit fires exactly once across any number of concurrent attempts");
});

test("terminal-once gate: settled reflects gate closure for both committed and failed outcomes", async () => {
  const failingGate = createTerminalOnceGate<number>(() => {
    throw new Error("boom");
  });
  assert.equal(failingGate.settled, false, "not settled before any attempt");
  await failingGate.attempt(1);
  assert.equal(failingGate.settled, true, "settled after a failed attempt — the gate is still permanently closed");

  const succeedingGate = createTerminalOnceGate<number>(() => undefined);
  await succeedingGate.attempt(1);
  assert.equal(succeedingGate.settled, true, "settled after a committed attempt");
});

// ─── Exit-code proof (real subprocess) ──────────────────────────────────
//
// gmail/index.ts wires createTerminalOnceGate's onEmit to write the DONE
// line then start the exit handshake, and reacts to a "failed" outcome by
// logging to stderr and calling process.exit(1) directly (no retry, no
// ACK-wait handshake, which itself depends on the now-unreliable
// stdout/stdin). That composed pattern can only be proven in a real OS
// process — process.exit() would kill the test runner if called in-process
// — so this spawns a minimal standalone script implementing exactly that
// wiring (not the full Gmail connector; no IMAP involved) with an onEmit
// that always throws, and asserts the process exits with a deterministic
// nonzero code instead of hanging.
const GATE_MODULE_PATH = fileURLToPath(new URL("./terminal-once.ts", import.meta.url));

test("terminal-once gate composed with Gmail's failure wiring: a failing onEmit exits deterministically with code 1, never hangs", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-terminal-once-exit-"));
  const scriptPath = join(tmpDir, "exit-on-failure.mjs");
  writeFileSync(
    scriptPath,
    `
import { createTerminalOnceGate } from ${JSON.stringify(GATE_MODULE_PATH)};

// Mirrors gmail/index.ts's terminalGate + emitTerminalDone composition:
// onEmit does the (here: always-failing) write, and a "failed" outcome
// gets logged then forces process.exit(1) directly — no retry.
const gate = createTerminalOnceGate(async () => {
  throw new Error("simulated stdout write failure");
});

async function main() {
  const outcome = await gate.attempt({ status: "succeeded" });
  if (outcome.kind === "won" && outcome.result === "failed") {
    process.stderr.write("terminal write failed; forcing exit(1) without retry\\n");
    process.exit(1);
  }
  // Should be unreachable in this test: onEmit always throws.
  process.exit(0);
}

main();
`,
    "utf8"
  );

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", scriptPath], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`subprocess hung instead of exiting deterministically; stderr so far=${stderr}`));
      }, 10_000);
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, stderr });
      });
    }
  );

  try {
    assert.equal(result.signal, null, "the process must exit on its own, not be killed");
    assert.equal(result.code, 1, "a failed terminal write must exit with a deterministic nonzero code");
    assert.match(result.stderr, /terminal write failed; forcing exit\(1\) without retry/);
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
  }
});
