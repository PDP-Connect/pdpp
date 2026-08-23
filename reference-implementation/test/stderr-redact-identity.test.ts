// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Identity-based credential redaction in `runtime/stderr-redact.ts`.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Every rule in `stderr-redact.ts` matched by SHAPE, and a credential has no
 * shape. Proven by direct execution against the deployed head (14d371ee4) on
 * 2026-08-23: a REAL owner password — 8 characters of mixed-case alphanumerics,
 * the same credential that leaked to disk through the capture path earlier the
 * same day — was passed to `redactStderrTail` inside an ordinary connector
 * stderr line and came back verbatim with `redacted: false`. The identical
 * value with a `password=` prefix redacted correctly.
 *
 * Unlabelled stderr flows into `run.failed.data.connector_diagnostics.stderr_tail`,
 * which is durable. So the labelled/unlabelled split was the whole difference
 * between a contained failure and a persisted credential.
 *
 * Every secret in this file is a synthetic placeholder. No real credential value
 * appears here, and none ever should — a test fixture is committed, and the
 * defect being fixed is precisely "credentials reach durable storage".
 */

import assert from "node:assert/strict";
import test from "node:test";

import { redactStderrTail } from "../runtime/stderr-redact.ts";

/**
 * Stands in for the real credential's SHAPE, which is the load-bearing property:
 * 8 characters, mixed case, alphanumeric, no separator, no label. Too short for
 * `LONG_OPAQUE_RE` (>=24), not six digits, not a PEM block, not URL userinfo.
 * It matches no shape rule in the module, which is why identity is needed.
 */
const PLACEHOLDER_PASSWORD = "Zq7tRm2k";

test("an unlabelled registered credential is redacted (the defect)", () => {
  const line = `Login failed for ${PLACEHOLDER_PASSWORD}`;

  // Fail-before: with no registry, this is the deployed behaviour — untouched.
  const shapeOnly = redactStderrTail(line);
  assert.equal(shapeOnly.text, line, "no shape rule matches an unlabelled short credential");
  assert.equal(shapeOnly.redacted, false);

  // Pass-after: registering the value redacts it wherever it appears.
  const { text, redacted } = redactStderrTail(line, { knownSecrets: [PLACEHOLDER_PASSWORD] });
  assert.ok(!text.includes(PLACEHOLDER_PASSWORD), "the registered credential must not survive");
  assert.equal(text, "Login failed for [REDACTED]");
  assert.equal(redacted, true);
});

test("redaction preserves diagnostic value: the line still shows a credential APPEARED", () => {
  // This is the property that let the owner read the Venmo failure. Blanking
  // the line would remove the evidence the excerpt is retained for.
  const { text } = redactStderrTail(`login failed: ${PLACEHOLDER_PASSWORD}`, {
    knownSecrets: [PLACEHOLDER_PASSWORD],
  });
  assert.equal(text, "login failed: [REDACTED]");
  assert.ok(text.startsWith("login failed:"), "surrounding diagnostic text survives intact");
  assert.ok(text.includes("[REDACTED]"), "a marker records that a credential was present");
});

test("a registered credential is redacted at every occurrence, mid-word included", () => {
  const { text } = redactStderrTail(
    `attempt 1 used ${PLACEHOLDER_PASSWORD}; attempt 2 used ${PLACEHOLDER_PASSWORD} again`,
    { knownSecrets: [PLACEHOLDER_PASSWORD] }
  );
  assert.equal(text, "attempt 1 used [REDACTED]; attempt 2 used [REDACTED] again");
});

test("the labelled form still redacts — shape rules are kept, not replaced", () => {
  // Regression guard. Identity covers only what the runtime resolved; a secret
  // this process never held (an API key the connector fetched itself) still
  // needs the shape rules, so they must survive the identity pass.
  const { text, redacted } = redactStderrTail(`password=${PLACEHOLDER_PASSWORD}`);
  assert.equal(text, "password=[REDACTED]");
  assert.equal(redacted, true);
});

test("an UNREGISTERED secret still gets shape-based treatment where a rule applies", () => {
  // No registry at all, and every shape rule must still fire exactly as before.
  const longToken = ["sk", "live", "abcdefghijklmnopqrstuvwxyz1234567890"].join("_");
  assert.ok(!redactStderrTail(`key ${longToken}`).text.includes(longToken), "long opaque run");
  assert.equal(redactStderrTail("code 482910").text, "code [REDACTED_OTP]", "six-digit OTP");
  assert.equal(
    redactStderrTail("fetch https://user:pw@host/x failed").text,
    "fetch https://[REDACTED]@host/x failed",
    "URL userinfo"
  );

  // And with an unrelated registry present, so identity does not suppress shape.
  const withRegistry = redactStderrTail(`key ${longToken}`, { knownSecrets: [PLACEHOLDER_PASSWORD] });
  assert.ok(!withRegistry.text.includes(longToken), "shape rules still run alongside identity");
});

test("a non-secret string of similar shape is NOT redacted", () => {
  // Over-redaction is a real failure mode, not a safe default: the HEB incident
  // (`heb_session_failed: [REDACTED]`) was caused by redaction eating a
  // categorical reason token. Only the registered VALUE is matched — a string
  // that merely looks like a credential is left alone.
  const lookalike = "Xk4pQw9z"; // same 8-char mixed-case alnum shape, not registered
  const line = `Login failed for ${lookalike}`;
  const { text, redacted } = redactStderrTail(line, { knownSecrets: [PLACEHOLDER_PASSWORD] });
  assert.equal(text, line, "an unregistered lookalike must survive verbatim");
  assert.equal(redacted, false);

  // Ordinary diagnostic prose is untouched by the identity pass.
  const prose = "Connection refused: example.com:443";
  assert.equal(redactStderrTail(prose, { knownSecrets: [PLACEHOLDER_PASSWORD] }).text, prose);
});

test("a secret shorter than the 4-character floor is NOT matched by identity", () => {
  // The floor is a deliberate, recorded tradeoff, not an oversight — see
  // MIN_MATCHABLE_SECRET_LENGTH in stderr-redact.ts. Matching a 1-3 character
  // value verbatim would pepper [REDACTED] through ordinary English and destroy
  // the excerpt, while also marking every occurrence of the secret's letters.
  // Stderr has no field-based backstop for what falls under the floor, so this
  // exposure is real and is pinned here rather than left implicit.
  const { text } = redactStderrTail("Login failed for ab", { knownSecrets: ["ab"] });
  assert.equal(text, "Login failed for ab", "under the floor, identity does not fire");

  // The floor is INCLUSIVE: exactly 4 characters IS redacted, so the ambiguous
  // boundary case fails toward redaction.
  assert.equal(
    redactStderrTail("Login failed for abcd", { knownSecrets: ["abcd"] }).text,
    "Login failed for [REDACTED]"
  );
});

test("a longer secret is redacted before a shorter secret contained inside it", () => {
  // Ordering matters: redacting the short one first would split the long one
  // into fragments that no longer match themselves, leaving part of the longer
  // credential in the durable excerpt.
  const short = "Rm2kPw";
  const long = `Zq7t${short}Xy91`;
  const { text } = redactStderrTail(`auth used ${long}`, { knownSecrets: [short, long] });
  assert.equal(text, "auth used [REDACTED]");
  assert.ok(!text.includes(short), "no fragment of either credential survives");
});

test("a credential containing regex metacharacters is matched literally", () => {
  // The identity pass must never compile a secret as a pattern: a password like
  // this would otherwise throw, or match the wrong text.
  const metaSecret = "a.*b[c]$d";
  const { text } = redactStderrTail(`login failed: ${metaSecret}`, { knownSecrets: [metaSecret] });
  assert.equal(text, "login failed: [REDACTED]");
  // And the pattern it would have compiled to must NOT match other text.
  assert.equal(redactStderrTail("login failed: axxbcd", { knownSecrets: [metaSecret] }).text, "login failed: axxbcd");
});

test("identity runs BEFORE the shape rules, so a secret straddling a rewrite is not split", () => {
  // Ordering is a safety property, not a style choice. A shape rule that
  // rewrites part of a line destroys the match for any secret straddling that
  // region, and the rest of the credential then survives verbatim.
  //
  // Measured both ways. Identity LAST: the OTP rule collapses the leading six
  // digits to [REDACTED_OTP] first, the full secret no longer matches itself,
  // and the tail leaks:
  //     "used [REDACTED_OTP] fallback now"   <- "fallback" is credential text
  // Identity FIRST redacts the whole value before any rule can cut it.
  const spanningSecret = "482910 fallback";
  const { text } = redactStderrTail(`used ${spanningSecret} now`, { knownSecrets: [spanningSecret] });
  assert.equal(text, "used [REDACTED] now");
  assert.ok(!text.includes("fallback"), "no fragment of the credential may survive a shape rewrite");

  // Same property against the URL-userinfo rule, which rewrites only the
  // userinfo portion and would otherwise leave the rest of the secret in place.
  const urlSecret = "user:pw@host";
  const urlText = redactStderrTail(`fetch https://${urlSecret}/x`, { knownSecrets: [urlSecret] }).text;
  assert.equal(urlText, "fetch https://[REDACTED]/x");
  assert.ok(!urlText.includes("host"), "the non-userinfo half of the credential must not survive");
});

test("identity outranks the declared-reason-token allowlist", () => {
  // A declared token that equals a live credential is a credential first. The
  // allowlist can only ever REDUCE redaction of SHAPE matches; it must not be
  // able to re-expose a value the run actually holds.
  const tokenShapedSecret = "venmo_probe_transport_error_value";
  const { text } = redactStderrTail(`failed: ${tokenShapedSecret}`, {
    declaredReasonTokens: new Set([tokenShapedSecret]),
    knownSecrets: [tokenShapedSecret],
  });
  assert.equal(text, "failed: [REDACTED]");
});

test("omitting knownSecrets is byte-identical to the previous behaviour", () => {
  // Additive-only guarantee: every existing caller that does not opt in must see
  // exactly the deployed output.
  const samples = [
    "Connection refused: example.com:443",
    "password=hunter2",
    "code 482910",
    "https://user:pw@host/x",
    `Login failed for ${PLACEHOLDER_PASSWORD}`,
    "",
  ];
  for (const sample of samples) {
    assert.deepEqual(redactStderrTail(sample), redactStderrTail(sample, {}), sample);
    assert.deepEqual(redactStderrTail(sample), redactStderrTail(sample, { knownSecrets: [] }), sample);
  }
});
