// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the `cancelRun` client-wrapper outcome mapping.
 *
 * The pure `(status, body, code)` → outcome classifier lives in
 * `cancel-run-result.ts` (not `operator-runs.ts`) specifically so it can be
 * imported and executed under `node --test`: `operator-runs.ts` transitively
 * imports `owner-token.ts`, which does `import "server-only"` and throws
 * outside the React Server runtime. We unit-test the classifier directly and
 * separately assert (via source regex, below) that `cancelRun` feeds the real
 * response status/body/error-code through it and POSTs the cancel route.
 *
 * Outcomes under test (task 4.1):
 *   202                         → cancel_requested
 *   404 no_active_run           → no_active_run
 *   409 run_already_terminal    → run_already_terminal
 *   anything else / non-JSON    → typed thrown Error (described)
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { cancelRunErrorCode, classifyCancelRunResponse } from "./cancel-run-result.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const OPERATOR_RUNS_FILE = `${HERE}operator-runs.ts`;

const NO_SUCH_RUN_RE = /no such run/;
const OTHER_CONFLICT_RE = /some other conflict/;
const UPSTREAM_EXPLODED_RE = /upstream exploded/;
const STATUS_FALLBACK_RE = /run cancel failed \(503\)/;
const CATCH_RE = /catch/;

test("202 maps to cancel_requested", () => {
  assert.deepEqual(classifyCancelRunResponse(202, null, null), { status: "cancel_requested" });
});

test("404 with error code no_active_run maps to no_active_run", () => {
  const body = { error: { code: "no_active_run", message: "no active run for run_id" } };
  assert.deepEqual(classifyCancelRunResponse(404, body, cancelRunErrorCode(body)), { status: "no_active_run" });
});

test("409 with error code run_already_terminal maps to run_already_terminal", () => {
  const body = { error: { code: "run_already_terminal", message: "run already terminal" } };
  assert.deepEqual(classifyCancelRunResponse(409, body, cancelRunErrorCode(body)), {
    status: "run_already_terminal",
  });
});

test("a 404 without the documented error code throws a described error (not a silent no_active_run)", () => {
  const body = { error: { code: "not_found", message: "no such run" } };
  assert.throws(() => classifyCancelRunResponse(404, body, cancelRunErrorCode(body)), NO_SUCH_RUN_RE);
});

test("a 409 without the documented error code throws a described error", () => {
  const body = { error: { code: "conflict", message: "some other conflict" } };
  assert.throws(() => classifyCancelRunResponse(409, body, cancelRunErrorCode(body)), OTHER_CONFLICT_RE);
});

test("an unexpected status throws a described error with the status in the fallback", () => {
  // Non-JSON / unexpected body: describeError surfaces the raw text, else the
  // `run cancel failed (<status>)` fallback keeps the status visible.
  assert.throws(() => classifyCancelRunResponse(500, "upstream exploded", null), UPSTREAM_EXPLODED_RE);
  assert.throws(() => classifyCancelRunResponse(503, null, null), STATUS_FALLBACK_RE);
});

test("cancelRunErrorCode reads error.code and tolerates malformed bodies", () => {
  assert.equal(cancelRunErrorCode({ error: { code: "no_active_run" } }), "no_active_run");
  assert.equal(cancelRunErrorCode({ error: {} }), null);
  assert.equal(cancelRunErrorCode({ error: "string-form" }), null);
  assert.equal(cancelRunErrorCode("plain text"), null);
  assert.equal(cancelRunErrorCode(null), null);
});

// ── Source-regex guard for the I/O wiring (matches operator-runs.test.ts style).
// `cancelRun` itself can't be imported here (server-only chain), so assert it
// POSTs the cancel route, reads the body, and routes it through the classifier
// + error-code extractor — and lets ReferenceServerUnreachableError propagate
// (it never catches it).

const CANCEL_RUN_EXPORT_RE = /export async function cancelRun\(runId: string\): Promise<CancelRunResult>/;
const CANCEL_RUN_POSTS_ROUTE_RE =
  /fetchAs\(`\/_ref\/runs\/\$\{encodeURIComponent\(runId\)\}\/cancel`,\s*\{\s*method: "POST",\s*\}\)/;
const CANCEL_RUN_USES_CLASSIFIER_RE = /classifyCancelRunResponse\(response\.status, body, cancelRunErrorCode\(body\)\)/;

test("cancelRun POSTs the owner-session cancel route and routes the response through the classifier", async () => {
  const src = await readFile(OPERATOR_RUNS_FILE, "utf8");
  assert.match(src, CANCEL_RUN_EXPORT_RE);
  assert.match(src, CANCEL_RUN_POSTS_ROUTE_RE);
  assert.match(src, CANCEL_RUN_USES_CLASSIFIER_RE);
  // It must NOT catch ReferenceServerUnreachableError — that propagates exactly
  // like the other run helpers leave it.
  const block = src.slice(src.indexOf("export async function cancelRun"));
  assert.equal(CATCH_RE.test(block.slice(0, block.indexOf("export async function deleteConnectorSchedule"))), false);
});
