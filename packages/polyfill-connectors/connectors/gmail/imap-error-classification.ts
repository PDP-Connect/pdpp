// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * IMAP transport error classification for Gmail connector.
 * Distinguishes transient network/deadline errors (retryable) from terminal
 * auth rejections (non-retryable) by checking error code first, then message.
 * Auth rejection (invalid credentials, disabled IMAP) remains non-retryable.
 */

const TRANSIENT_IMAP_MESSAGE_PATTERN = /ECONN|ETIMEDOUT|fetch failed|EPIPE|timeout/i;

/**
 * Classify an IMAP transport error as transient (retryable) or terminal.
 * Checks both error code (structured, from imapflow) and message (fallback).
 *
 * Transient (retryable):
 *   - ImapFlow codes: CONNECT_TIMEOUT, GREETING_TIMEOUT, UPGRADE_TIMEOUT
 *   - OS codes: ECONNRESET, ECONNREFUSED, ECONNABORTED
 *   - Message patterns: ETIMEDOUT, fetch failed, EPIPE, timeout
 *
 * Terminal (non-retryable):
 *   - Auth codes: BAD_AUTH, AUTH_FAILED, etc.
 *   - Auth messages: "invalid credentials", "[Gmail] IMAP is disabled", etc.
 */
export function isImapTransientError(err: unknown): boolean {
  // Structured check: error code from imapflow or OS.
  if (err instanceof Error) {
    const errWithCode = err as Error & { code?: string };
    const code = errWithCode.code?.toUpperCase() ?? "";
    // Transient deadline errors from imapflow.
    if (code.includes("TIMEOUT")) {
      return true;
    }
    // OS-level transient network errors.
    if (code.includes("ECONN")) {
      return true;
    }
  }
  // Fallback: message pattern (Node.js errors, downstream HTTP clients, etc.).
  const msg = err instanceof Error ? err.message : String(err);
  return TRANSIENT_IMAP_MESSAGE_PATTERN.test(msg);
}
