// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A credential save that the server refused must never read as a save that
 * worked.
 *
 * Regression origin: the owner re-saved a Gmail credential with a fresh Google
 * app password. The reference server answered HTTP 409
 * (`static_secret_identity_unverified_replacement`) and stored nothing — the
 * connection kept its OLD broken credential. Only the 400 rejection code was
 * classified as an owner-actionable refusal, so a 409 fell through to the
 * generic error path with no dedicated treatment.
 *
 * These tests pin the classification for BOTH refusal classes, and pin that it
 * stays connector-agnostic: the rule reads status + envelope only.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { isCredentialRefusal, refErrorCode } from "./static-secret-refusal.ts";

// The full 409 set the reference maps in routes/ref-error-status.ts. Every one
// must reach the owner; none may be treated as a successful capture.
const CONFLICT_CODES = [
  "static_secret_binding_invalid",
  "static_secret_draft_required",
  "static_secret_identity_ambiguous",
  "static_secret_identity_conflict",
  "static_secret_identity_mismatch",
  "static_secret_identity_revoked",
  "static_secret_identity_unverified_replacement",
];

function envelope(code: string, message: string): string {
  return JSON.stringify({ error: { code, message, type: "api_error", request_id: "req_test" } });
}

test("every 409 replacement-authority code is an owner-actionable refusal", () => {
  for (const code of CONFLICT_CODES) {
    const body = envelope(code, "some owner-causal reason");
    assert.equal(refErrorCode(body), code);
    assert.equal(isCredentialRefusal(409, refErrorCode(body)), true, `${code} must be a refusal`);
  }
});

test("a 409 code the console has never heard of is still a refusal", () => {
  // Forward compatibility: the reference may add a conflict code. An unknown
  // one must still surface the server's message, never a crash banner and
  // never a success state.
  const body = envelope("static_secret_some_future_conflict", "A brand new reason.");
  assert.equal(isCredentialRefusal(409, refErrorCode(body)), true);
});

test("a 409 with an unparseable body is still a refusal", () => {
  // Status alone decides. A proxy-mangled or empty body must not downgrade a
  // refusal into an apparent success.
  assert.equal(isCredentialRefusal(409, refErrorCode("<html>502 gateway</html>")), true);
  assert.equal(isCredentialRefusal(409, refErrorCode("")), true);
});

test("the 400 synchronous provider rejection remains a refusal", () => {
  const body = envelope(
    "static_secret_credential_rejected",
    "Google rejected this app password for that mailbox. Check the Gmail address and create a fresh app password, then try again."
  );
  assert.equal(isCredentialRefusal(400, refErrorCode(body)), true);
});

test("an unrelated 400 is not classified as a credential refusal", () => {
  // A malformed-request 400 is a bug, not an owner-actionable credential
  // problem; it must not be dressed up as one.
  assert.equal(isCredentialRefusal(400, refErrorCode(envelope("invalid_request", "Missing field."))), false);
});

test("transport and server failures are not refusals", () => {
  // 502/503 mean the capture outcome is UNKNOWN, not refused. They travel the
  // generic error path rather than claiming the credential was rejected.
  assert.equal(isCredentialRefusal(500, null), false);
  assert.equal(
    isCredentialRefusal(502, refErrorCode(envelope("static_secret_identity_missing", "Upstream down."))),
    false
  );
  assert.equal(
    isCredentialRefusal(503, refErrorCode(envelope("static_secret_identity_unavailable", "Try later."))),
    false
  );
});

test("a 2xx is never a refusal", () => {
  assert.equal(isCredentialRefusal(200, null), false);
  assert.equal(isCredentialRefusal(201, null), false);
});

test("refErrorCode reads a bare string envelope and tolerates a code-less body", () => {
  assert.equal(
    refErrorCode(JSON.stringify({ error: "static_secret_identity_mismatch" })),
    "static_secret_identity_mismatch"
  );
  assert.equal(refErrorCode(JSON.stringify({ error: { message: "no code here" } })), null);
  assert.equal(refErrorCode(JSON.stringify({})), null);
});

test("the classification never consults a connector id", () => {
  // The same status/code pair decides identically regardless of which
  // connector produced it — gmail, jellyfin, steam, and groupme all share this
  // one path, and the RI is not allowed connector-specific knowledge.
  const body = envelope("static_secret_identity_mismatch", "Create a separate connection for the other account.");
  const verdicts = ["gmail", "jellyfin", "steam", "groupme"].map(() => isCredentialRefusal(409, refErrorCode(body)));
  assert.deepEqual(verdicts, [true, true, true, true]);
});
