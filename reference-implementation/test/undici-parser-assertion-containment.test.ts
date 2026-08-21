// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isVendoredUndiciParserAssertion } from "../runtime/undici-parser-errors.ts";

const CONTAINED_PATTERN = /CONTAINED/;
const SURVIVED_ONCE_PATTERN = /SURVIVED contained=1/;
const FATAL_PATTERN = /FATAL/;

// Regression coverage for the vendored-undici parser assertion that killed
// the whole reference process in production:
//
//   AssertionError [ERR_ASSERTION]: assert(!this.paused)
//     at Parser.finish (node:internal/deps/undici/undici:7388:9)
//     at Socket.onHttpSocketEnd (node:internal/deps/undici/undici:7827:34)
//
// Two layers, mirroring test/runtime-pipe-resilience.test.ts:
//   1. Classifier   — what counts as a containable vendored-parser
//      assertion, and (load-bearing) what does NOT.
//   2. Host-survives — a real child process installs the production guard
//      shape, an assertion with the captured stack is raised
//      asynchronously, and the process must survive it while a
//      genuinely-fatal assertion must still kill it.

// ─── 1. Classifier ───────────────────────────────────────────────────────────

/**
 * Builds an error carrying the EXACT shape captured in the production log:
 * a generated `assert(!this.paused)` AssertionError whose stack is anchored
 * in Node's vendored undici bundle.
 */
function capturedProductionAssertion(): Error {
  const err = Object.assign(new Error("The expression evaluated to a falsy value:\n\n  assert(!this.paused)\n"), {
    actual: false,
    code: "ERR_ASSERTION",
    expected: true,
    generatedMessage: true,
    operator: "==",
  });
  err.name = "AssertionError";
  err.stack = [
    "AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:",
    "",
    "  assert(!this.paused)",
    "",
    "    at Parser.finish (node:internal/deps/undici/undici:7388:9)",
    "    at Socket.onHttpSocketEnd (node:internal/deps/undici/undici:7827:34)",
    "    at Socket.emit (node:events:521:24)",
    "    at endReadableNT (node:internal/streams/readable:1736:12)",
    "    at process.processTicksAndRejections (node:internal/process/task_queues:90:21)",
  ].join("\n");
  return err;
}

test("classifies the captured production Parser.finish assertion as containable", () => {
  assert.equal(isVendoredUndiciParserAssertion(capturedProductionAssertion()), true);
});

test("classifies a Parser.execute assertion in vendored undici as containable", () => {
  const err = capturedProductionAssertion();
  err.stack = [
    "AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:",
    "    at Parser.execute (node:internal/deps/undici/undici:7350:9)",
    "    at Socket.onHttpSocketReadable (node:internal/deps/undici/undici:7821:26)",
  ].join("\n");
  assert.equal(isVendoredUndiciParserAssertion(err), true);
});

// The next four are the load-bearing negatives: they are what keeps this
// guard from degenerating into a catch-all that hides real programmer bugs.

test("rejects an ERR_ASSERTION raised by application code", () => {
  // Same code and generated-message shape, but the stack is anchored in the
  // reference implementation, so a real invariant may have been mid-update.
  const err = capturedProductionAssertion();
  err.stack = [
    "AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:",
    "",
    "  assert(!this.paused)",
    "",
    "    at commitState (/app/reference-implementation/runtime/index.ts:3706:5)",
    "    at process.processTicksAndRejections (node:internal/process/task_queues:90:21)",
  ].join("\n");
  assert.equal(isVendoredUndiciParserAssertion(err), false);
});

test("rejects a vendored-undici frame that is not a parser teardown assertion", () => {
  // An assertion elsewhere in undici (not Parser.finish/execute) is not the
  // proven-benign teardown shape and must stay fatal.
  const err = capturedProductionAssertion();
  err.stack = [
    "AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:",
    "    at writeStream (node:internal/deps/undici/undici:8080:7)",
    "    at Socket.emit (node:events:521:24)",
  ].join("\n");
  assert.equal(isVendoredUndiciParserAssertion(err), false);
});

test("rejects an authored assertion message from the parser frame", () => {
  // generatedMessage=false means an author wrote the message; that is not
  // the bare `assert(expr)` internal-invariant shape.
  const err = capturedProductionAssertion();
  Object.assign(err, { generatedMessage: false });
  assert.equal(isVendoredUndiciParserAssertion(err), false);
});

test("rejects non-assertion errors and non-error inputs", () => {
  assert.equal(isVendoredUndiciParserAssertion(new TypeError("boom")), false);
  const wrongCode = capturedProductionAssertion();
  Object.assign(wrongCode, { code: "ERR_INVALID_STATE" });
  assert.equal(isVendoredUndiciParserAssertion(wrongCode), false);
  const noStack = Object.assign(new Error("x"), { code: "ERR_ASSERTION", generatedMessage: true, stack: undefined });
  assert.equal(isVendoredUndiciParserAssertion(noStack), false);
  assert.equal(isVendoredUndiciParserAssertion(null), false);
  assert.equal(isVendoredUndiciParserAssertion(undefined), false);
  assert.equal(isVendoredUndiciParserAssertion("ERR_ASSERTION"), false);
  assert.equal(isVendoredUndiciParserAssertion(42), false);
});

// ─── 2. Host-survives proof ──────────────────────────────────────────────────

interface GuardChildOutcome {
  readonly code: number | null;
  readonly stdout: string;
}

/**
 * Runs a child process that installs the SAME guard shape as the CLI
 * entrypoint (classifier-gated `uncaughtException` handler) and then raises
 * `raiseExpression` asynchronously, from a real socket-'end'-like event tick
 * so no try/catch can intercept it — the production delivery path.
 *
 * Returns the child's exit code, which is the whole contract: 0 means the
 * process survived the fault and reached its own clean exit; non-zero means
 * the fault was fatal.
 */
function runGuardChild(raiseExpression: string): Promise<GuardChildOutcome> {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-undici-guard-"));
  const script = join(dir, "guard-child.ts");
  writeFileSync(
    script,
    [
      'import { isVendoredUndiciParserAssertion } from "REPLACED_IMPORT";',
      "let contained = 0;",
      'process.on("uncaughtException", (err: unknown) => {',
      "  if (isVendoredUndiciParserAssertion(err)) {",
      "    contained += 1;",
      '    process.stdout.write("CONTAINED\\n");',
      "    return;",
      "  }",
      '  process.stdout.write("FATAL\\n");',
      "  process.exit(1);",
      "});",
      `const err = ${raiseExpression};`,
      // Throw from a macrotask so it arrives as an asynchronous
      // uncaughtException, exactly like the socket 'end' event in production.
      "setImmediate(() => { throw err; });",
      // If the guard works, the loop keeps running and we exit cleanly,
      // proving unrelated work survives the fault.
      "setTimeout(() => {",
      `  process.stdout.write("SURVIVED contained=" + contained + "\\n");`,
      "  process.exit(0);",
      "}, 250);",
      "",
    ]
      .join("\n")
      .replace("REPLACED_IMPORT", new URL("../runtime/undici-parser-errors.ts", import.meta.url).href),
    "utf8"
  );

  return new Promise<GuardChildOutcome>((resolve) => {
    const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.resume();
    child.on("close", (code) => {
      rmSync(dir, { force: true, recursive: true });
      resolve({ code, stdout });
    });
  });
}

/** Source text that rebuilds the captured production assertion in a child. */
const PRODUCTION_ASSERTION_SOURCE = [
  "Object.assign(new Error('assert(!this.paused)'), {",
  "  code: 'ERR_ASSERTION', generatedMessage: true, actual: false, expected: true, operator: '==',",
  "  stack: [",
  "    'AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:',",
  "    '    at Parser.finish (node:internal/deps/undici/undici:7388:9)',",
  "    '    at Socket.onHttpSocketEnd (node:internal/deps/undici/undici:7827:34)',",
  "    '    at endReadableNT (node:internal/streams/readable:1736:12)',",
  "  ].join('\\n'),",
  "})",
].join("\n");

test("host survives the vendored undici parser assertion", async () => {
  const outcome = await runGuardChild(PRODUCTION_ASSERTION_SOURCE);
  assert.match(outcome.stdout, CONTAINED_PATTERN, "guard should contain the vendored parser assertion");
  assert.match(outcome.stdout, SURVIVED_ONCE_PATTERN, "unrelated work should keep running after containment");
  assert.equal(outcome.code, 0, "process must survive a vendored undici parser assertion");
});

test("host still dies on an assertion raised by application code", async () => {
  // The mutation guard for the test above: if the classifier were widened to
  // any ERR_ASSERTION, this case would wrongly survive and this test fails.
  const applicationAssertion = [
    "Object.assign(new Error('assert(!this.paused)'), {",
    "  code: 'ERR_ASSERTION', generatedMessage: true, actual: false, expected: true, operator: '==',",
    "  stack: [",
    "    'AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:',",
    "    '    at commitState (/app/reference-implementation/runtime/index.ts:3706:5)',",
    "  ].join('\\n'),",
    "})",
  ].join("\n");
  const outcome = await runGuardChild(applicationAssertion);
  assert.match(outcome.stdout, FATAL_PATTERN, "application assertions must not be contained");
  assert.equal(outcome.code, 1, "a genuinely corrupt process must still die");
});

test("host still dies on an unrelated uncaught error", async () => {
  const outcome = await runGuardChild("new TypeError('unrelated programmer bug')");
  assert.match(outcome.stdout, FATAL_PATTERN, "unrelated errors must stay fatal");
  assert.equal(outcome.code, 1, "unrelated uncaught errors must still be fatal");
});
