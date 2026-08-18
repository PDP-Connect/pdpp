// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Proof-of-concept oracle for the failure-diagnosability design note
 * (`design-notes/failure-diagnosability-2026-08-18.md`), incident 4.
 *
 * Production 2026-08-18: HEB connection `cin_c875ca3ec8b6ce2c283a4288` failed
 * with `connector_error_json = {"code": null, "message":
 * "heb_session_failed: [REDACTED]", "retryable": false}`. The actual cause was
 * the literal string `[REDACTED]`.
 *
 * The cause was destroyed by `LONG_OPAQUE_RE` (`\b[A-Za-z0-9_-]{24,}\b`), an
 * ENTROPY heuristic aimed at unlabelled API keys. Categorical reason tokens
 * match it too, so whether a failure stayed diagnosable was decided by the
 * LENGTH of its reason token, not by whether it carried anything sensitive.
 *
 * These tests pin all four properties the fix must have, including the two
 * that say what it deliberately does NOT do.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { redactStderrTail } from "../runtime/stderr-redact.ts";

const REDACTED_OTP_RE = /REDACTED_OTP/;
const REDACTED_USERINFO_RE = /\[REDACTED\]@/;

/** Declared by the HEB connector; PII-free categorical constants. */
const HEB_DECLARED_REASONS: ReadonlySet<string> = new Set([
  "login_form_never_appeared",
  "heb_verification_code_not_provided",
  "two_factor_challenge_unrecognized",
]);

test("regression: the production defect — a declared reason token is destroyed by length alone", () => {
  // Exactly what production recorded, reproduced with no options passed.
  const { text } = redactStderrTail("heb_session_failed: login_form_never_appeared");
  assert.equal(text, "heb_session_failed: [REDACTED]");

  // And the arbitrariness that makes it a design defect rather than a tuning
  // problem: an 18-char token carrying no more and no less information
  // survives the identical pass.
  assert.equal(
    redactStderrTail("usaa_session_failed: source_unavailable").text,
    "usaa_session_failed: source_unavailable"
  );
});

test("a declared reason token survives redaction, so the owner sees the real cause", () => {
  for (const reason of HEB_DECLARED_REASONS) {
    const input = `heb_session_failed: ${reason}`;
    const { text, redacted } = redactStderrTail(input, { declaredReasonTokens: HEB_DECLARED_REASONS });
    assert.equal(text, input, `declared reason must survive verbatim: ${reason}`);
    assert.equal(redacted, false, "preserving a declared token is not a redaction");
  }
});

test("secrets are still redacted even when a declaration set is supplied", () => {
  // The declaration set must not become a hole. None of these is declared, so
  // each must redact exactly as before.
  const secrets = [
    ["sk", "live", "51HxYzAbCdEfGhIjKlMnOp"].join("_"),
    ["ghp", "16CharactersXXXXXXXXXXXXXXXXXXXX"].join("_"),
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
  ];
  for (const secret of secrets) {
    const { text } = redactStderrTail(`heb_session_failed: ${secret}`, {
      declaredReasonTokens: HEB_DECLARED_REASONS,
    });
    assert.equal(text, "heb_session_failed: [REDACTED]", `undeclared high-entropy token must redact: ${secret}`);
    assert.ok(!text.includes(secret), "the secret must not survive");
  }

  // The other redaction rules are untouched by the new branch.
  assert.match(redactStderrTail("otp 123456", { declaredReasonTokens: HEB_DECLARED_REASONS }).text, REDACTED_OTP_RE);
  assert.match(
    redactStderrTail("https://user:pw@host/x", { declaredReasonTokens: HEB_DECLARED_REASONS }).text,
    REDACTED_USERINFO_RE
  );
});

test("an UNdeclared reason token still redacts — declaration is the safety property, not spelling", () => {
  // This is the whole argument for an allowlist over a cleverer regex. A
  // name is alphabetic snake_case just like a reason token is, so no pattern
  // can tell them apart. Only prior declaration can.
  const { text } = redactStderrTail("heb_session_failed: some_undeclared_reason_token", {
    declaredReasonTokens: HEB_DECLARED_REASONS,
  });
  assert.equal(text, "heb_session_failed: [REDACTED]");
});

test("callers that do not opt in are byte-identical to the previous behaviour", () => {
  // Migration safety: ~all existing call sites pass no options. Every one of
  // them must behave exactly as it did before, or this is not a safe change.
  const samples = [
    "heb_session_failed: login_form_never_appeared",
    "plain message with no secrets",
    "token=abc123 and otp 123456",
    "https://user:pw@host/path",
    "",
  ];
  for (const sample of samples) {
    assert.deepEqual(
      redactStderrTail(sample),
      redactStderrTail(sample, {}),
      `omitting options must equal passing empty options: ${sample}`
    );
    assert.deepEqual(
      redactStderrTail(sample),
      redactStderrTail(sample, { declaredReasonTokens: new Set() }),
      `an empty declaration set must change nothing: ${sample}`
    );
  }
});

test("disclosed pre-existing gap: this redactor is not a PII control", () => {
  // Documented so it is not mistaken for coverage, and so the design note's
  // claim is checkable. Both of these pass through UNTOUCHED today, with no
  // options involved — they are under the 24-char threshold. The declared-
  // token change neither causes nor worsens this; it is recorded because it
  // shows LONG_OPAQUE_RE was never the PII boundary it is sometimes read as.
  assert.equal(redactStderrTail("contact tim.nunamaker@example.com").text, "contact tim.nunamaker@example.com");
  assert.equal(redactStderrTail("user tim_nunamaker_example").text, "user tim_nunamaker_example");
});
