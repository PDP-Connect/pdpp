// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Error classification tests for Gmail IMAP transport.
 * Verifies that connection-deadline errors (ImapFlow CONNECT_TIMEOUT, etc.)
 * and transient network errors are classified retryable, while auth rejections
 * remain non-retryable.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { isImapTransientError } from "./imap-error-classification.ts";

test("isImapTransientError: ImapFlow CONNECT_TIMEOUT error code is retryable", () => {
  const err = new Error("Failed to establish connection in required time");
  (err as Error & { code?: string }).code = "CONNECT_TIMEOUT";
  assert.ok(isImapTransientError(err), "CONNECT_TIMEOUT must be transient");
});

test("isImapTransientError: ImapFlow GREETING_TIMEOUT error code is retryable", () => {
  const err = new Error("Failed to receive greeting from server in required time");
  (err as Error & { code?: string }).code = "GREETING_TIMEOUT";
  assert.ok(isImapTransientError(err), "GREETING_TIMEOUT must be transient");
});

test("isImapTransientError: ImapFlow UPGRADE_TIMEOUT error code is retryable", () => {
  const err = new Error("Failed to upgrade connection in required time");
  (err as Error & { code?: string }).code = "UPGRADE_TIMEOUT";
  assert.ok(isImapTransientError(err), "UPGRADE_TIMEOUT must be transient");
});

test("isImapTransientError: OS connection errors (by message) are retryable", () => {
  const osErrors = [
    { message: "ETIMEDOUT", expected: true },
    { message: "ECONNRESET connection reset by peer", expected: true },
    { message: "ECONNREFUSED connection refused", expected: true },
  ];
  for (const { message, expected } of osErrors) {
    const err = new Error(message);
    const result = isImapTransientError(err);
    assert.equal(result, expected, `${message} retryable=${expected}`);
  }
});

test("isImapTransientError: fetch/pipe errors are retryable", () => {
  const fetchErrors = ["fetch failed: ECONNRESET", "EPIPE: broken pipe", "timeout on request"];
  for (const message of fetchErrors) {
    const err = new Error(message);
    assert.ok(isImapTransientError(err), `${message} must be transient`);
  }
});

test("isImapTransientError: auth rejection is NOT retryable (structured code)", () => {
  const err = new Error("Invalid credentials");
  (err as Error & { code?: string }).code = "BAD_AUTH";
  assert.ok(!isImapTransientError(err), "BAD_AUTH must NOT be transient");
});

test("isImapTransientError: auth rejection is NOT retryable (message)", () => {
  const authMessages = [
    "Authentication failed: invalid app password",
    "401 Unauthorized",
    "Bad credentials",
    "[Gmail] IMAP is disabled for this account",
  ];
  for (const message of authMessages) {
    const err = new Error(message);
    assert.ok(!isImapTransientError(err), `${message} must NOT be transient`);
  }
});

test("isImapTransientError: non-Error objects with retryable message", () => {
  const retryableString = "ETIMEDOUT in socket";
  assert.ok(isImapTransientError(retryableString), "string with ETIMEDOUT must be transient");
});

test("isImapTransientError: non-Error objects with non-retryable message", () => {
  const nonRetryableString = "Invalid credentials";
  assert.ok(!isImapTransientError(nonRetryableString), "string without transient pattern must NOT be transient");
});

test("MUTATION: removing TIMEOUT check would break CONNECT_TIMEOUT classification", () => {
  // This mutation test proves the error-code check is essential.
  // Without it, a CONNECT_TIMEOUT error with an auth-like message would fail.
  // (This test documents the invariant; the actual check is in production.)
  const err = new Error("Failed to establish connection in required time");
  (err as Error & { code?: string }).code = "CONNECT_TIMEOUT";
  assert.ok(isImapTransientError(err), "CONNECT_TIMEOUT code must be transient regardless of message wording");
  // If we only checked message (no code check), this would be false because
  // the message doesn't match /ECONN|ETIMEDOUT|fetch failed|EPIPE|timeout/i
  const messageOnly = /ECONN|ETIMEDOUT|fetch failed|EPIPE|timeout/i.test(err.message);
  assert.equal(messageOnly, false, "message pattern alone does NOT match 'in required time'");
  // So the code check is critical for catching ImapFlow deadline errors.
});
