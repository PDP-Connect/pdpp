// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Behavioral tests for the leaf stall budget.
//
// The whole point of the budget is to tell two shapes apart, so both are
// exercised as REAL spawned child processes, never as source-text assertions:
//
//   (a) a STUCK child   — alive, holding its pipes open, producing nothing;
//   (b) a SLOW-PROGRESSING FINITE child — emitting a trickle of output with
//       gaps that are long relative to the budget but never exceed it, then
//       exiting on its own.
//
// (b) is the case a naive total-runtime cap gets wrong: it runs for LONGER
// than the stall budget in wall-clock terms while never being silent for
// longer than the budget. A correct implementation must let (b) finish and
// must kill (a).
//
// The budget is driven through PDPP_ACCOUNTING_STALL_BUDGET_MS so the tests
// run in seconds rather than the 300s production default; the code path under
// test is identical either way. `capture` is exercised through the module's
// real spawn/append/watchdog machinery via a child that is a real `node -e`
// process, so a regression that removed the watchdog would leave (a) hanging
// until the enclosing per-file timeout killed the whole file.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

const STALLED_PATTERN = /STALLED/;
const NO_OUTPUT_PATTERN = /produced no output/;
const PROGRESS_PREFIX_PATTERN = /\[test-accounting\]/;
const STARTED_PATTERN = /started/;
const EXIT_ZERO_PATTERN = /exit 0/;
const DEADLINE_PATTERN = /deadline/i;

/** Wall-clock ms and outcome of running one child under a given stall budget. */
interface Outcome {
  code: number | null;
  durationMs: number;
  stderr: string;
  stdout: string;
}

// Drive the REAL authority capture path in a subprocess. authority.ts reads its
// budget from the environment at module load, so each case needs its own
// process; spawning one keeps the production module completely unmodified.
function runCapture(
  childScript: string,
  budgetMs: number,
  deadlineMs?: number,
  parseNodeEvents = false
): Promise<Outcome> {
  const driver = `
    const { runCaptureForTest } = await import(${JSON.stringify(new URL("./authority.ts", import.meta.url).href)});
    const result = await runCaptureForTest(
      [process.execPath, "-e", ${JSON.stringify(childScript)}],
      process.cwd(),
      ${JSON.stringify(parseNodeEvents)}
    );
    process.stdout.write(JSON.stringify({
      stdout: result.stdout.slice(-1024),
      retained_capture_bytes: result.retained_capture_bytes ?? Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
      node_summary: result.node_summary,
    }) + "\\n");
  `;
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", driver], {
      env: {
        ...process.env,
        PDPP_ACCOUNTING_STALL_BUDGET_MS: String(budgetMs),
        ...(deadlineMs === undefined ? {} : { PDPP_ACCOUNTING_LEAF_DEADLINE_MS: String(deadlineMs) }),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const hardTimeout = setTimeout(() => child.kill("SIGKILL"), deadlineMs === undefined ? 30_000 : deadlineMs + 5000);
    child.on("close", (code) => {
      clearTimeout(hardTimeout);
      resolve({ code, durationMs: Date.now() - started, stderr, stdout });
    });
  });
}

// Holds stdout/stderr open and never writes: the exact wedge shape an operator
// cannot distinguish from slow work without a stall signal.
const STUCK_CHILD = "setInterval(() => {}, 1000);";

// Emits one line every 1.2s for 6s, then exits 0. Total runtime (~6s) exceeds
// the 3s budget used below, while the longest silence (1.2s) never does.
const SLOW_BUT_LIVE_CHILD = `
  let n = 0;
  const timer = setInterval(() => {
    process.stdout.write("tick " + (++n) + "\\n");
    if (n === 5) { clearInterval(timer); process.exit(0); }
  }, 1200);
`;

test("a STUCK child is killed and reported once its silence exceeds the declared stall budget", async () => {
  const budgetMs = 3000;
  const outcome = await runCapture(STUCK_CHILD, budgetMs);

  // Without a watchdog this child never exits and this assertion times out.
  assert.equal(outcome.code, 1, "the wedged leaf must fail the run, not hang it");
  assert.match(outcome.stderr, STALLED_PATTERN, "the operator must be told the leaf stalled");
  assert.match(outcome.stderr, NO_OUTPUT_PATTERN, "the failure must name the stall as the cause");
  assert.ok(
    outcome.durationMs < budgetMs * 4,
    `expected the stuck child to be killed promptly after the budget, took ${outcome.durationMs}ms`
  );
});

test("a SLOW-PROGRESSING FINITE child runs to completion even though its total runtime exceeds the stall budget", async () => {
  const budgetMs = 3000;
  const outcome = await runCapture(SLOW_BUT_LIVE_CHILD, budgetMs);

  // This is the discrimination the budget exists for: ~6s of real work under a
  // 3s budget must survive, because no single silence ever reached 3s.
  assert.equal(outcome.code, 0, `slow-but-live leaf must not be killed; stderr was: ${outcome.stderr}`);
  assert.doesNotMatch(
    outcome.stderr,
    STALLED_PATTERN,
    "a leaf making steady progress must never be reported as stalled"
  );
  assert.ok(
    outcome.durationMs > budgetMs,
    `the fixture must actually outlive the budget to be meaningful, ran ${outcome.durationMs}ms`
  );
});

test("progress is reported on stderr while a leaf is quiet, so a live run is never silent", async () => {
  // The observability half: an operator watching a long leaf must see it is
  // alive. Heartbeats tick every PROGRESS_TICK_MS (5s), so a ~6s leaf emits at
  // least one without ever stalling.
  const outcome = await runCapture(SLOW_BUT_LIVE_CHILD, 60_000);

  assert.equal(outcome.code, 0);
  assert.match(outcome.stderr, PROGRESS_PREFIX_PATTERN, "progress must be visible on stderr");
  assert.match(outcome.stderr, STARTED_PATTERN, "the operator must see the leaf start");
  assert.match(outcome.stderr, EXIT_ZERO_PATTERN, "the operator must see the leaf finish");
});

test("a continuously chatty leaf is killed at its total deadline", async () => {
  const deadlineMs = 1500;
  const outcome = await runCapture(
    "setInterval(() => process.stdout.write('.'.repeat(64 * 1024)), 1);",
    60_000,
    deadlineMs
  );

  assert.equal(outcome.code, 1, "a chatty leaf must fail at its total deadline");
  assert.match(outcome.stderr, DEADLINE_PATTERN, "the operator must be told the leaf exceeded its total deadline");
  assert.ok(outcome.durationMs < 8000, `deadline kill must be prompt; ran ${outcome.durationMs}ms`);
});

test("large non-event output completes with bounded retained capture", async () => {
  const child = `
    const chunk = 'x'.repeat(64 * 1024);
    let remaining = 50 * 1024 * 1024;
    function write() {
      while (remaining > 0) {
        const value = chunk.slice(0, Math.min(chunk.length, remaining));
        remaining -= value.length;
        if (!process.stdout.write(value)) { process.stdout.once('drain', write); return; }
      }
      process.stdout.write('\\nPDPP_TEST_ACCOUNTING_EVENT {"type":"test:pass","details":{"type":"test"}}\\n');
    }
    write();
  `;
  const outcome = await runCapture(child, 60_000, undefined, true);
  const result = JSON.parse(outcome.stdout) as {
    retained_capture_bytes: number;
    stdout: string;
    node_summary?: { assertions: number; passed: number; failed: number };
  };

  assert.equal(outcome.code, 0);
  assert.equal(result.node_summary?.assertions, 1, "structured counts must include the event after bulk output");
  assert.equal(result.node_summary?.passed, 1);
  assert.equal(result.node_summary?.failed, 0);
  assert.ok(result.retained_capture_bytes <= 128 * 1024, `retained capture was ${result.retained_capture_bytes} bytes`);
});
