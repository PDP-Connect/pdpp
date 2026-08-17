// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Behavioral tests for `ownerErrorCopy` — a save-failure classifier must map
 * a bounded, plain-language line for every input shape the "use server"
 * action can construct from a real thrown error, and never let two distinct
 * inputs collapse onto a copy that hides which one actually happened.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { ownerErrorCopy } from "./owner-error-copy.ts";

const UNREACHABLE_COPY_RE = /reach the deployment/i;
const SESSION_EXPIRED_COPY_RE = /session expired/i;
const REJECTED_VALUE_COPY_RE = /was not accepted/i;
const GENERIC_REQUEST_FAILED_COPY_RE = /rejected this update/i;
const GENERIC_FALLBACK_COPY_RE = /could not be saved/i;
const STATUS_CODE_LEAK_RE = /\d{3}/;
const JSON_SYNTAX_LEAK_RE = /[{}[\]]/;

test("an unreachable deployment gets connectivity-specific copy", () => {
  const message = ownerErrorCopy({ kind: "unreachable" });
  assert.match(message, UNREACHABLE_COPY_RE);
});

test("a 401 gets session-expiry copy, not the generic request-failed line", () => {
  const message = ownerErrorCopy({ kind: "request_failed", status: 401 });
  assert.match(message, SESSION_EXPIRED_COPY_RE);
});

test("a 400 gets rejected-value copy, distinct from the 401 and generic lines", () => {
  const message = ownerErrorCopy({ kind: "request_failed", status: 400 });
  assert.match(message, REJECTED_VALUE_COPY_RE);
});

test("a 5xx (or any status other than 400/401) falls to the generic request-failed line", () => {
  const message500 = ownerErrorCopy({ kind: "request_failed", status: 500 });
  const message503 = ownerErrorCopy({ kind: "request_failed", status: 503 });
  assert.match(message500, GENERIC_REQUEST_FAILED_COPY_RE);
  assert.equal(message500, message503);
});

test("an unknown error shape gets the fully generic fallback line", () => {
  const message = ownerErrorCopy({ kind: "unknown" });
  assert.match(message, GENERIC_FALLBACK_COPY_RE);
});

test("all five reachable outcomes produce mutually distinct copy", () => {
  const outcomes = [
    ownerErrorCopy({ kind: "unreachable" }),
    ownerErrorCopy({ kind: "request_failed", status: 401 }),
    ownerErrorCopy({ kind: "request_failed", status: 400 }),
    ownerErrorCopy({ kind: "request_failed", status: 502 }),
    ownerErrorCopy({ kind: "unknown" }),
  ];
  assert.equal(new Set(outcomes).size, outcomes.length, "each classified outcome must read distinctly to the owner");
});

test("no returned copy ever contains a raw status code or JSON-shaped text", () => {
  // A mutant that starts interpolating `status` or the raw error into the
  // string must fail here, not just a source-shape check.
  const allStatuses = [400, 401, 402, 403, 404, 409, 422, 429, 500, 502, 503];
  for (const status of allStatuses) {
    const message = ownerErrorCopy({ kind: "request_failed", status });
    assert.doesNotMatch(message, STATUS_CODE_LEAK_RE, `copy for status ${status} must not leak a status code`);
    assert.doesNotMatch(message, JSON_SYNTAX_LEAK_RE, `copy for status ${status} must not leak JSON syntax`);
  }
});
