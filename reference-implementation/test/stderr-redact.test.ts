// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { redactStderrTail } from "../runtime/stderr-redact.ts";

test("redactStderrTail passes through safe text unchanged", () => {
  const result = redactStderrTail("Connection refused: example.com:443");
  assert.equal(result.text, "Connection refused: example.com:443");
  assert.equal(result.redacted, false);
});

test("redactStderrTail handles empty and non-string input", () => {
  assert.deepEqual(redactStderrTail(""), { redacted: false, text: "" });
  assert.deepEqual(redactStderrTail(null), { redacted: false, text: "" });
  assert.deepEqual(redactStderrTail(undefined), { redacted: false, text: "" });
});

test("redactStderrTail redacts keyed credential markers", () => {
  const cases: [string, string][] = [
    ["token=abc123secret", "token=[REDACTED]"],
    ['password: "hunter2"', "password=[REDACTED]"],
    ["Authorization: Bearer eyJhbGciOiJIUzI1NiJ9", "Authorization=[REDACTED]"],
    ["api_key=sk_live_abc123", "api_key=[REDACTED]"],
    ["api-key: supersecret", "api-key=[REDACTED]"],
    ["cookie=sessionid=abcdef", "cookie=[REDACTED]"],
    ["secret=mysecretvalue", "secret=[REDACTED]"],
    ["otp=123456 was invalid", "otp=[REDACTED] was invalid"],
  ];
  for (const [input, expected] of cases) {
    const { text, redacted } = redactStderrTail(input);
    assert.ok(text.includes(expected), `Expected "${text}" to include "${expected}" (input: "${input}")`);
    assert.equal(redacted, true, `Expected redacted=true for input: "${input}"`);
  }
});

test("redactStderrTail redacts 6-digit OTP-shaped numbers", () => {
  const { text, redacted } = redactStderrTail("OTP verification failed with code 482910");
  assert.equal(text, "OTP verification failed with code [REDACTED_OTP]");
  assert.equal(redacted, true);
});

test("redactStderrTail redacts long opaque strings (>=24 chars)", () => {
  const longToken = ["sk", "live", "abcdefghijklmnopqrstuvwxyz1234567890"].join("_"); // constructed to avoid tripping secret scanners on a synthetic fixture
  const { text, redacted } = redactStderrTail(`API call failed with key ${longToken}`);
  assert.ok(!text.includes(longToken), "Long token should be redacted");
  assert.equal(redacted, true);
});

test("redactStderrTail redacts URL-embedded credentials", () => {
  const cases = [
    // https with user:pass
    "fetch failed: https://myuser:mysecretpassword@api.example.com/endpoint",
    // http with user:pass
    "connecting to http://admin:p@ssw0rd@internal.host/path",
    // only user (no password)
    "error at https://serviceaccount@storage.example.com/bucket",
  ];
  for (const input of cases) {
    const { text, redacted } = redactStderrTail(input);
    assert.ok(!text.includes("mysecretpassword"), `Password should be redacted in: ${input}`);
    assert.ok(!text.includes("p@ssw0rd"), `Password should be redacted in: ${input}`);
    assert.equal(redacted, true, `Expected redacted=true for: ${input}`);
    // Protocol and host should be preserved
    assert.ok(text.includes("[REDACTED]@"), `Should contain [REDACTED]@ placeholder in: ${text}`);
  }
});

test("redactStderrTail preserves URL host after redacting userinfo", () => {
  const input = "fetch error: https://user:secret@api.example.com/v1/data returned 401";
  const { text } = redactStderrTail(input);
  assert.ok(text.includes("api.example.com"), "Host should be preserved after userinfo redaction");
  assert.ok(text.includes("https://[REDACTED]@api.example.com"), "Should contain redacted form");
  assert.ok(!text.includes("secret"), "Secret should not appear");
});

test("redactStderrTail redacts PEM private key blocks", () => {
  const pemKey = [
    "-----BEGIN RSA PRIVATE KEY-----",
    "MIIEowIBAAKCAQEA2a2rwplBQLF29amygykEMmYz0+Kcj3bKBp29o2dFCnOBrO7s",
    "bmByXMadFcwN4MYtUgzOh3gCxGUFQP7DPSQqMiB7FJMF9GjfFMq9RKXPLABCD",
    "-----END RSA PRIVATE KEY-----",
  ].join("\n");
  const input = `SSL handshake error:\n${pemKey}\nRetrying...`;
  const { text, redacted } = redactStderrTail(input);
  assert.ok(!text.includes("MIIEowIBAAK"), "PEM body should be redacted");
  assert.ok(text.includes("[REDACTED_PEM]"), "Should contain [REDACTED_PEM] placeholder");
  assert.equal(redacted, true);
  assert.ok(text.includes("SSL handshake error"), "Non-PEM context should be preserved");
  assert.ok(text.includes("Retrying"), "Text after PEM should be preserved");
});

test("redactStderrTail redacts PEM certificate blocks", () => {
  const pemCert = [
    "-----BEGIN CERTIFICATE-----",
    "MIIDazCCAlOgAwIBAgIUYzFakeBase64DataHere1234567890ABCDEF=",
    "-----END CERTIFICATE-----",
  ].join("\n");
  const { text, redacted } = redactStderrTail(`Certificate error:\n${pemCert}`);
  assert.ok(!text.includes("MIIDazCCAlO"), "PEM body should be redacted");
  assert.ok(text.includes("[REDACTED_PEM]"), "Should contain [REDACTED_PEM] placeholder");
  assert.equal(redacted, true);
});

test("redactStderrTail does not redact short innocuous tokens", () => {
  // Short tokens not preceded by a credential marker should pass through
  const { text, redacted } = redactStderrTail("Error code: 42, status: OK, retries: 3");
  assert.equal(text, "Error code: 42, status: OK, retries: 3");
  assert.equal(redacted, false);
});

// Regression coverage for a rejected earlier fix attempt at this same UAT
// bug (apple_contacts `connector_error_json` collapsing to
// `{"message":"[REDACTED]"}`). That attempt exempted pure-lowercase-
// underscore runs from the long-opaque-token rule on the theory that shape
// can never be a secret — false: lowercase hex digests, lowercase base32
// secrets, and underscore-joined passphrase-style secrets are all real,
// observed secret shapes that are pure lowercase+underscore. The redaction
// contract is shape-agnostic by design (see the module doc comment); it
// must never special-case a charset as "safe." The actual fix routes
// connector error *codes* through a separate typed, validated channel
// (`ConnectorDoneError.code`, see connector-runtime.ts's
// `TerminalErrorCode`/`terminalFailure`) that never touches this free-form
// redaction path at all. These tests pin that free-form `message` text
// stays fully subject to redaction, with no charset-based carve-out.
test("redactStderrTail redacts pure-lowercase-underscore runs exactly like any other opaque token", () => {
  const cases = [
    // A lowercase hex digest (e.g. an MD5/SHA1 hex string) is pure
    // lowercase+underscore-free but every char is [a-z0-9] -- the prior
    // exemption's `^[a-z]+(?:_[a-z]+)*$` pattern did not match this, but a
    // broader "looks like an identifier" heuristic could plausibly have
    // been extended to. Confirm hex digests are unaffected either way.
    "deadbeefcafebabe0123456789abcdef",
    // Underscore-joined lowercase secret shapes: a passphrase-style API
    // key, or a lowercase base32 secret -- both pure lowercase+underscore,
    // both real secret shapes seen in the wild.
    "correct_horse_battery_staple_secret",
    "totp_seed_abcdefghijklmnopqrstuvwxyz",
  ];
  for (const value of cases) {
    const { text, redacted } = redactStderrTail(`context: ${value}`);
    assert.ok(!text.includes(value), `expected "${value}" to be redacted like any other opaque run, got "${text}"`);
    assert.equal(redacted, true, `expected redacted=true for "${value}"`);
  }
});

test("redactStderrTail redacts a connector's own long snake_case error identifier when it appears in free-form message text", () => {
  // A connector error CODE never reaches redactStderrTail at all in the
  // fixed pipeline (it rides ConnectorDoneError.code through a separate,
  // validated, non-redacted channel). If an error identifier like this one
  // shows up inside free-form MESSAGE text instead, redaction must still
  // apply uniformly -- there is no safe way to distinguish "connector
  // wrote this on purpose" from "this happens to look like an identifier"
  // from the string alone.
  const identifier = "carddav_discovery_propfind_failed";
  const { text, redacted } = redactStderrTail(`${identifier}: status=401`);
  assert.ok(!text.includes(identifier), `expected "${identifier}" to be redacted in free-form text, got "${text}"`);
  assert.equal(redacted, true);
});
