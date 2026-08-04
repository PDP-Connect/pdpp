/**
 * Shared legacy-interaction secret-redaction authority.
 *
 * This module provides the canonical regex-chain redaction logic for
 * connector-authored interaction prompts and messages that may contain
 * natural-language-phrased credentials or tokens. It is fail-closed:
 * if redaction fails or the input is invalid, it returns null rather
 * than accidentally leaking raw phrasing.
 *
 * Three independent call sites (runtime write, server read, console read)
 * must use this shared authority — never re-implement the regex chain.
 */

/**
 * Apply canonical redaction regexes to an already-bounded string.
 * Used by the runtime path that applies its own bounding via boundGapString.
 *
 * Targets:
 * - URLs: `https://...`, `wss://...`
 * - Bearer tokens/credentials: `token=...`, `Bearer ...`, etc.
 * - Numeric OTP codes: exactly 6 digits
 *
 * Fail-closed: returns empty string if input is not a string.
 */
export function applySanitizationRegexes(value: string): string {
  return (
    value
      .replace(/\b(?:https?|wss?):\/\/[^\s<>"')]+/gi, "[REDACTED_URL]")
      .replace(
        /\b((?:qr[_-]?)?(?:secret|token|password|passwd|cookie|otp|bearer))\b\s*[:=]\s*["']?[^"',\s}]+/gi,
        "$1=[REDACTED]"
      )
      .replace(
        /\b((?:cdp|playwright|webrtc|neko)[_-]?(?:url|uri|endpoint|token|secret))\b\s*[:=]\s*["']?[^"',\s}]+/gi,
        "$1=[REDACTED]"
      )
      .replace(/\b\d{6}\b/g, "[REDACTED_OTP]")
  );
}

/**
 * Redact common secret patterns from a legacy interaction string.
 *
 * Bounds the input to maxLength, then applies canonical redaction regexes.
 * Used by the server and console read paths.
 *
 * Fail-closed: returns null if input is invalid, empty after trimming,
 * or exceeds maxLength after redaction.
 */
export function redactLegacyInteractionString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const bounded = value.trim().slice(0, maxLength);
  if (!bounded) {
    return null;
  }
  const sanitized = applySanitizationRegexes(bounded);
  return sanitized.length <= maxLength ? sanitized : `${sanitized.slice(0, maxLength - 1)}…`;
}
