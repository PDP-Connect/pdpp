// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { discoverExpectedTestFiles, parseRunOutput, runSuiteToCompletion } from "./suite-completion.ts";

const FIXTURE_RUNNER = fileURLToPath(new URL("./fixtures/fake-run-tests.mjs", import.meta.url));

async function withScratchRiRoot<T>(fn: (riRoot: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-ri-suite-oracle-test-"));
  try {
    await mkdir(join(dir, "test"), { recursive: true });
    await writeFile(join(dir, "test", "alpha.test.js"), "// fixture\n");
    await writeFile(join(dir, "test", "beta.test.js"), "// fixture\n");
    await writeFile(join(dir, "test", "gamma.test.js"), "// fixture\n");
    // Non-test files must never be discovered.
    await writeFile(join(dir, "test", "helper.js"), "// not a test\n");
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function fixtureCommand(
  scenario: string,
  expectedRelPaths: string[]
): {
  command: string[];
  env: Record<string, string>;
} {
  return {
    command: ["node", FIXTURE_RUNNER],
    env: {
      FAKE_RUN_TESTS_SCENARIO: scenario,
      FAKE_RUN_TESTS_EXPECTED_FILES: JSON.stringify(expectedRelPaths),
      // Silence the parent env leaking through in case it matters to a
      // future scenario; the fixture never reads anything else.
      PDPP_TEST_FIXTURE: "1",
    },
  };
}

test("discoverExpectedTestFiles finds only *.test.{js,mjs,ts} in test/, not helper files", async () => {
  await withScratchRiRoot(async (riRoot) => {
    const files = await discoverExpectedTestFiles(riRoot);
    const relPaths = files.map((f) => f.relPath).sort((a, b) => a.localeCompare(b));
    assert.deepEqual(relPaths, [
      join("test", "alpha.test.js"),
      join("test", "beta.test.js"),
      join("test", "gamma.test.js"),
    ]);
  });
});

test("discoverExpectedTestFiles includes co-located server/streaming and scripts test dirs when present", async () => {
  await withScratchRiRoot(async (riRoot) => {
    await mkdir(join(riRoot, "server", "streaming"), { recursive: true });
    await writeFile(join(riRoot, "server", "streaming", "wire.test.js"), "// fixture\n");
    await mkdir(join(riRoot, "scripts"), { recursive: true });
    await writeFile(join(riRoot, "scripts", "doctor.test.mjs"), "// fixture\n");

    const files = await discoverExpectedTestFiles(riRoot);
    const relPaths = files.map((f) => f.relPath).sort((a, b) => a.localeCompare(b));
    assert.ok(relPaths.includes(join("server", "streaming", "wire.test.js")));
    assert.ok(relPaths.includes(join("scripts", "doctor.test.mjs")));
  });
});

test("parseRunOutput derives per-file pass/fail/skip counts from PDPP_TEST_ACCOUNTING_EVENT lines", () => {
  const output = [
    "==> test/one.test.js",
    'PDPP_TEST_ACCOUNTING_EVENT {"type":"test:start","details":{"type":"test","name":"a"}}',
    'PDPP_TEST_ACCOUNTING_EVENT {"type":"test:pass","details":{"type":"test","name":"a","skip":false}}',
    'PDPP_TEST_ACCOUNTING_EVENT {"type":"test:pass","details":{"type":"test","name":"b (skipped: reason X)","skip":true}}',
    "==> test/two.test.js",
    'PDPP_TEST_ACCOUNTING_EVENT {"type":"test:fail","details":{"type":"test","name":"c","skip":false}}',
  ].join("\n");

  const parsed = parseRunOutput(output);
  assert.deepEqual(parsed.completedFiles, ["test/one.test.js", "test/two.test.js"]);
  assert.equal(parsed.malformedEventLines, 0);

  const one = parsed.outcomes.get("test/one.test.js");
  assert.ok(one);
  assert.equal(one.passed, 1);
  assert.equal(one.skipped, 1);
  assert.deepEqual(one.skipReasons, { "reason X": 1 });

  const two = parsed.outcomes.get("test/two.test.js");
  assert.ok(two);
  assert.equal(two.failed, 1);
});

test("parseRunOutput records an unparseable accounting-event line as malformed rather than throwing", () => {
  const output = ["==> test/one.test.js", "PDPP_TEST_ACCOUNTING_EVENT {not json"].join("\n");
  const parsed = parseRunOutput(output);
  assert.equal(parsed.malformedEventLines, 1);
});

test("parseRunOutput records a boolean-true skip with no discoverable reason as (unexplained) instead of throwing", () => {
  const output = [
    "==> test/one.test.js",
    'PDPP_TEST_ACCOUNTING_EVENT {"type":"test:pass","details":{"type":"test","name":"mystery","skip":true}}',
  ].join("\n");
  const parsed = parseRunOutput(output);
  const one = parsed.outcomes.get("test/one.test.js");
  assert.ok(one);
  assert.deepEqual(one.skipReasons, { "(unexplained)": 1 });
});

test("runSuiteToCompletion reports completed-all-green when every file completes and nothing fails", async () => {
  await withScratchRiRoot(async (riRoot) => {
    const expected = (await discoverExpectedTestFiles(riRoot)).map((f) => f.relPath);
    const { command, env } = fixtureCommand("green", expected);
    const verdict = await runSuiteToCompletion({ riRoot, command, env, timeoutMs: 15_000 });

    assert.equal(verdict.status, "completed-all-green");
    assert.equal(verdict.exitCode, 0);
    assert.equal(verdict.signal, null);
    assert.equal(verdict.oracleTimedOut, false);
    assert.deepEqual(verdict.missingFiles, []);
    assert.deepEqual(verdict.unexpectedFiles, []);
    assert.equal(verdict.totals.failed, 0);
  });
});

test("runSuiteToCompletion reports completed-with-failures when a discovered test fails", async () => {
  await withScratchRiRoot(async (riRoot) => {
    const expected = (await discoverExpectedTestFiles(riRoot)).map((f) => f.relPath);
    const { command, env } = fixtureCommand("with-failure", expected);
    const verdict = await runSuiteToCompletion({ riRoot, command, env, timeoutMs: 15_000 });

    assert.equal(verdict.status, "completed-with-failures");
    assert.equal(verdict.oracleTimedOut, false);
    assert.ok(verdict.totals.failed >= 1);
  });
});

// --- Mutation proofs -------------------------------------------------------
//
// Each proof deliberately induces a failure mode a naive check (exit code
// only, or "did stdout mention PASS") would misreport as success, and
// asserts the oracle instead reports did-not-complete / a changed, non-green
// verdict. An oracle that cannot be made to fail these three is not
// distinguishing completion from its absence -- it is decoration.

test("MUTATION PROOF (hang): a process that never exits is reported did-not-complete, never as completion", async () => {
  await withScratchRiRoot(async (riRoot) => {
    const expected = (await discoverExpectedTestFiles(riRoot)).map((f) => f.relPath);
    const { command, env } = fixtureCommand("hang", expected);
    // Short oracle deadline so the proof itself stays fast; the fixture
    // would otherwise run forever (setInterval, never process.exit()).
    const verdict = await runSuiteToCompletion({ riRoot, command, env, timeoutMs: 1500 });

    assert.equal(verdict.status, "did-not-complete");
    assert.equal(verdict.oracleTimedOut, true);
    assert.equal(verdict.exitCode, null, "a killed process must not report an exit code as if it returned one");
    assert.equal(verdict.signal, "SIGKILL");
  });
});

test("MUTATION PROOF (external timeout-kill): a process killed by an OUTSIDE signal (not the oracle's own deadline) is also did-not-complete", async () => {
  await withScratchRiRoot(async (riRoot) => {
    const expected = (await discoverExpectedTestFiles(riRoot)).map((f) => f.relPath);
    const { command, env } = fixtureCommand("hang", expected);
    // Generous oracle deadline (60s) -- the point of this proof is that an
    // EXTERNAL killer (standing in for `timeout(1)` or a CI job timeout)
    // ends the child first. If the oracle's own deadline fired instead, this
    // proof would not distinguish the two death paths at all.
    const verdictPromise = runSuiteToCompletion({ riRoot, command, env, timeoutMs: 60_000 });
    // Kill the fixture from OUTSIDE the oracle shortly after it starts, the
    // same way an external `timeout` wrapper or CI job timeout would.
    setTimeout(async () => {
      const { execSync } = await import("node:child_process");
      // Best-effort: find and kill the fixture's node process by matching
      // its unique marker file path in the command line.
      try {
        execSync(`pkill -SIGTERM -f ${JSON.stringify(FIXTURE_RUNNER)}`);
      } catch {
        /* pkill exits non-zero when no process matched; ignore */
      }
    }, 600);
    const verdict = await verdictPromise;

    assert.equal(verdict.status, "did-not-complete");
    assert.equal(
      verdict.oracleTimedOut,
      false,
      "the oracle's own watchdog must not have fired for this proof to be meaningful"
    );
    assert.equal(verdict.signal, "SIGTERM");
  });
});

test("MUTATION PROOF (silently-dropped test file): a file discovery expected but the runner never touched is reported as missing, not as completion", async () => {
  await withScratchRiRoot(async (riRoot) => {
    const expected = (await discoverExpectedTestFiles(riRoot)).map((f) => f.relPath);
    assert.ok(expected.length >= 2, "fixture premise: need at least 2 discovered files for a meaningful drop");
    const { command, env } = fixtureCommand("dropped-file", expected);
    const verdict = await runSuiteToCompletion({ riRoot, command, env, timeoutMs: 15_000 });

    assert.equal(verdict.status, "completed-with-failures");
    assert.equal(
      verdict.exitCode,
      0,
      "premise: the dropped-file scenario exits 0, so only file-set comparison catches this"
    );
    assert.equal(verdict.missingFiles.length, 1);
    assert.equal(verdict.missingFiles[0], expected.at(-1));
  });
});

// Live-caught regression, not a hypothetical: the FIRST --sha run against a
// real pristine-base commit reported "completed-with-failures" (an
// unrelated, real, expected test failure) while silently missing that the
// SAME run also crashed with an uncaught exception in run-tests.js's own
// summary step -- an entirely different, more serious defect this oracle's
// exit-code/marker-only comparison could not distinguish from an ordinary
// test failure until this proof was added.
test("MUTATION PROOF (runner self-crash): every file/marker/tally looking clean does NOT mean completed-all-green if the runner itself threw", async () => {
  await withScratchRiRoot(async (riRoot) => {
    const expected = (await discoverExpectedTestFiles(riRoot)).map((f) => f.relPath);
    const { command, env } = fixtureCommand("runner-crash", expected);
    const verdict = await runSuiteToCompletion({ riRoot, command, env, timeoutMs: 15_000 });

    assert.equal(verdict.runnerCrashed, true);
    assert.equal(verdict.status, "completed-with-failures");
    assert.equal(verdict.missingFiles.length, 0, "premise: every file DID complete before the crash");
    assert.equal(verdict.totals.failed, 0, "premise: every individual test DID pass before the crash");
  });
});
