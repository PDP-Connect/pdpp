// Redaction policy for connector-authored stderr diagnostics.
//
// Mirrors the reference diagnostic redaction policy used in
// `boundGapString` (runtime/index.js): obvious credential/secret markers
// and 6-digit OTP-shaped numbers are scrubbed before persistence. The
// excerpt is connector-authored and therefore untrusted; we redact what
// we recognize and label the result `redacted: true` so the owner UI
// does not present it as an authoritative PDPP error.
//
// We do NOT promise to catch every secret. The contract is:
//   - Any `<word>=<value>` or `<word>:<value>` token where <word> is one
//     of the known credential markers (token, bearer, password, passwd,
//     cookie, secret, otp, authorization, api[_-]?key) gets the value
//     replaced with `[REDACTED]`.
//   - Any standalone 6-digit run gets replaced with `[REDACTED_OTP]`.
//   - Long opaque hex/base64-shaped runs (>=24 alnum-ish chars) are
//     replaced with `[REDACTED]` to catch raw API keys that show up
//     without a labelled prefix in stack traces.

const KEYED_SECRET_RE =
  /\b(authorization|bearer|token|password|passwd|cookie|secret|otp|api[_-]?key)\b\s*[:=]\s*["']?[^"',\s}]+/gi;
const OTP_RE = /\b\d{6}\b/g;
const LONG_OPAQUE_RE = /\b[A-Za-z0-9_\-]{24,}\b/g;

export function redactStderrTail(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { text: text ?? '', redacted: false };
  }
  let next = text.replace(KEYED_SECRET_RE, (match, marker) => `${marker}=[REDACTED]`);
  next = next.replace(OTP_RE, '[REDACTED_OTP]');
  next = next.replace(LONG_OPAQUE_RE, '[REDACTED]');
  return { text: next, redacted: next !== text };
}
