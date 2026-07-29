const TOP_LEVEL_REGEX_1 = /effectiveArgs\s*=\s*\[?['"]--test-force-exit['"]/;

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression oracle for a reporter-stream race that made
 * `pnpm test-accounting:check` flip its RI skip count between 104 and 105
 * across identical clean-tree runs.
 *
 * Root cause: `--test-force-exit` makes Node's test runner call
 * process.exit() as soon as its own internal bookkeeping considers a file
 * "done", without waiting for the custom reporter (an async generator
 * consuming the runner's internal event stream) to finish draining that
 * file's trailing test:pass/test:fail/test:complete events. The reporter's
 * `for await` loop is then cut short mid-stream, non-deterministically
 * dropping a variable number of trailing events even though every test in
 * the file actually ran and passed. `structuredNodeSummary` (receipt.ts)
 * stays internally consistent on the truncated stream (assertions still
 * equals passed+failed+skipped), so this does not crash — it silently
 * undercounts, which is what let it slip past every non-repeated run.
 *
 * The fix (reference-implementation/scripts/run-tests.ts) stops forwarding
 * --test-force-exit to child `node --test` processes and instead bounds a
 * genuinely hung file with a runner-level SIGKILL watchdog that only fires
 * after the child fails to exit on its own within PDPP_TEST_FILE_TIMEOUT_MS.
 * A normal run drains its reporter completely and exits before the watchdog
 * ever fires.
 *
 * This test spawns the real reporter against the file where the race was
 * observed live (compact-record-history.test.js has both a large pure-helper
 * section and a trailing Postgres-gated boolean-skip test — the exact shape
 * that exposed the drop) and asserts the structured event count is stable
 * across repeated runs. Reverting the fix (re-adding --test-force-exit to
 * the spawned args) reproduces flakiness in this same assertion.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { structuredNodeSummary } from "../../scripts/test-accounting/receipt.ts";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const REPORTER_PATH = fileURLToPath(new URL("../../scripts/test-accounting/node-reporter.ts", import.meta.url));
const TARGET_TEST_FILE = "reference-implementation/test/compact-record-history.test.ts";
const RUN_COUNT = 6;

function childTestEnv() {
  // NODE_TEST_CONTEXT/NODE_TEST_WORKER_ID are set by the outer `node --test`
  // this suite itself runs under. Left inherited, Node detects the spawned
  // child as a recursive test() run() and skips it entirely (a warning, not
  // an error) — a real Node behavior, not the race under test. run-tests.js
  // avoids this because it is invoked as a plain script, never itself under
  // `node --test`; this harness must scrub it explicitly to spawn a real
  // nested run.
  const env = { ...process.env };
  env.NODE_TEST_CONTEXT = undefined;
  env.NODE_TEST_WORKER_ID = undefined;
  return env;
}

async function runNodeTestOnce(extraArgs: string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--test", ...extraArgs, `--test-reporter=${REPORTER_PATH}`, TARGET_TEST_FILE],
      { cwd: REPO_ROOT, env: childTestEnv(), stdio: ["ignore", "pipe", "pipe"] }
    );
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", () => resolve(output));
  });
}

describe("run-tests reporter determinism (compact-record-history.test.js)", () => {
  it(`observes the same structured assertion count across ${RUN_COUNT} repeated clean runs without --test-force-exit`, async () => {
    const counts: number[] = [];
    for (let index = 0; index < RUN_COUNT; index += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: ordered test setup is intentionally sequential
      const output = await runNodeTestOnce([]);
      counts.push(structuredNodeSummary(output).assertions);
    }
    assert.ok(
      counts.every((count: number) => count === counts[0]),
      `structured assertion count must be stable across repeated runs; observed ${JSON.stringify(counts)}`
    );
  });

  it("run-tests.ts never forwards --test-force-exit to spawned child test processes", async () => {
    const runTestsSource = await import("node:fs/promises").then((fs) =>
      fs.readFile(fileURLToPath(new URL("../scripts/run-tests.ts", import.meta.url)), "utf8")
    );
    assert.doesNotMatch(
      runTestsSource,
      TOP_LEVEL_REGEX_1,
      "run-tests.ts must not forward --test-force-exit — it truncates the reporter event stream non-deterministically"
    );
  });
});
