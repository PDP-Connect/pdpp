#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Synthetic stand-in for reference-implementation/scripts/run-tests.ts, used
// ONLY by completion-oracle.test.ts to exercise runSuiteToCompletion()
// against controlled scenarios without paying the cost (or the
// nondeterminism) of the real ~6 minute suite. Reproduces just the two
// output primitives the real runner emits that the oracle depends on:
//   - a "==> <relPath>" line per completed file
//   - PDPP_TEST_ACCOUNTING_EVENT JSON lines for test:pass/test:fail
//
// Scenario is selected via the FAKE_RUN_TESTS_SCENARIO env var:
//   green          -- every discovered file completes, all tests pass.
//   with-failure   -- every file completes, one test fails.
//   hang           -- writes some output, then never exits (event loop kept
//                     alive on purpose) -- proves the oracle's own deadline
//                     fires and it does not report completion.
//   dropped-file   -- exits 0 having skipped emitting a marker for one
//                     expected file entirely -- proves the oracle notices a
//                     file discovery expected but the runner never ran.
//   runner-crash   -- every file completes and every test passes, but the
//                     process then throws an uncaught exception (Node's own
//                     crash signature) instead of exiting cleanly -- proves
//                     the oracle does not call this "all-green" just
//                     because every marker and this oracle's own tally look
//                     clean; the runner's own summary step never finished.
//
// FAKE_RUN_TESTS_EXPECTED_FILES (JSON array of relPaths) lets the test drive
// this fixture against the oracle's OWN discovery output, so "missing" /
// "unexpected" comparisons are meaningful rather than accidental.

const scenario: string | undefined = process.env.FAKE_RUN_TESTS_SCENARIO;
const expectedFiles: string[] = JSON.parse(process.env.FAKE_RUN_TESTS_EXPECTED_FILES ?? "[]") as string[];

function emitEvent(type: string, details: Record<string, unknown>): void {
  process.stdout.write(`PDPP_TEST_ACCOUNTING_EVENT ${JSON.stringify({ type, details })}\n`);
}

function completeFile(relPath: string, { fail = false }: { fail?: boolean } = {}): void {
  process.stdout.write(`\n==> ${relPath}\n`);
  const name = `synthetic test in ${relPath}`;
  emitEvent("test:start", { type: "test", name });
  emitEvent(fail ? "test:fail" : "test:pass", { type: "test", name, skip: false });
}

switch (scenario) {
  // biome-ignore lint/suspicious/noFallthroughSwitchClause: This fixture deliberately continues to the next outcome case.
  case "green": {
    for (const file of expectedFiles) {
      completeFile(file);
    }
    process.exit(0);
  }
  // biome-ignore lint/suspicious/noFallthroughSwitchClause: This fixture deliberately continues to the next outcome case.
  case "with-failure": {
    expectedFiles.forEach((file, index) => {
      completeFile(file, { fail: index === 0 });
    });
    process.exit(1);
  }
  // biome-ignore lint/suspicious/noFallthroughSwitchClause: This fixture deliberately continues to the next outcome case.
  case "dropped-file": {
    // Complete every file except the last -- simulates a file the runner
    // silently never got to (e.g. a discovery/queue bug), while still
    // exiting 0 so a naive "exit code only" check would call this green.
    const [, ...rest] = [...expectedFiles].reverse();
    for (const file of rest.reverse()) {
      completeFile(file);
    }
    process.exit(0);
  }
  // biome-ignore lint/suspicious/noFallthroughSwitchClause: This fixture deliberately continues to the next outcome case.
  case "runner-crash": {
    // Mirrors run-tests.ts's real failure mode: every file finishes and
    // reports its own honest per-test outcome first (this fixture writes
    // ALL the normal, parseable output), then a bug in the runner's OWN
    // final summary step throws after everything else already succeeded.
    for (const file of expectedFiles) {
      completeFile(file);
    }
    process.stderr.write("file:///fake/scripts/test-accounting/receipt.ts:8\n");
    process.stderr.write("  throw new Error('test accounting result: ' + message);\n");
    process.stderr.write("        ^\n\n");
    process.stderr.write("Error: test accounting result: synthetic unexplained-skip crash\n");
    process.stderr.write("    at fake-run-tests.mjs (synthetic stack frame)\n");
    process.stderr.write(`Node.js v${process.versions.node}\n`);
    process.exit(1);
  }
  case "hang": {
    // Complete one file normally, then leave the event loop alive forever
    // (an unref'd-nothing setInterval) -- exactly the "leaked handle"
    // failure mode run-tests.ts's own comments describe. Never calls
    // process.exit(); only a signal from the parent ends this process.
    if (expectedFiles[0]) {
      completeFile(expectedFiles[0]);
    }
    setInterval(() => {
      /* keep the event loop alive forever -- the leaked-handle hang this scenario simulates */
    }, 1000);
    break;
  }
  default: {
    process.stderr.write(`fake-run-tests: unknown FAKE_RUN_TESTS_SCENARIO ${JSON.stringify(scenario)}\n`);
    process.exit(2);
  }
}
