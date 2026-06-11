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
//   - URL-embedded userinfo (https://user:pass@host) — the userinfo portion
//     is replaced with `[REDACTED]@`.
//   - Any `<word>=<value>` or `<word>:<value>` token where <word> is one
//     of the known credential markers (token, bearer, password, passwd,
//     cookie, secret, otp, authorization, api[_-]?key) gets the value
//     replaced with `[REDACTED]`.
//   - PEM-encoded private material (-----BEGIN ... KEY----- ... -----END ...----- )
//     is replaced with `[REDACTED_PEM]`.
//   - Any standalone 6-digit run gets replaced with `[REDACTED_OTP]`.
//   - Long opaque hex/base64-shaped runs (>=24 alnum-ish chars) are
//     replaced with `[REDACTED]` to catch raw API keys that show up
//     without a labelled prefix in stack traces.
//   - Short secrets: standalone runs of 8-23 alnum+symbol chars that appear
//     immediately after a credential-marker assignment are covered by the
//     keyed-secret rule above, so they are caught even when short.

// URL-embedded userinfo: https://user:secret@host or http://user:secret@host
// Captures protocol so we can preserve it; replaces "user:pass" with [REDACTED].
const URL_USERINFO_RE = /(\bhttps?:\/\/)[^@\s/]+(:[^@\s/]+)?@/gi;

// Keyed credential markers: token=xxx, password: "xxx", Authorization: Bearer xxx
const KEYED_SECRET_RE =
  /\b(authorization|bearer|token|password|passwd|cookie|secret|otp|api[_-]?key)\b\s*[:=]\s*["']?[^"',\s}]+/gi;

// PEM blocks — single- or multi-line. Matches any -----BEGIN <TYPE>----- block.
// Covers PRIVATE KEY, RSA PRIVATE KEY, CERTIFICATE, EC PRIVATE KEY, etc.
const PEM_BLOCK_RE = /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g;

const OTP_RE = /\b\d{6}\b/g;
const LONG_OPAQUE_RE = /\b[A-Za-z0-9_\-]{24,}\b/g;

export function redactStderrTail(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { text: text ?? '', redacted: false };
  }
  // URL-embedded credentials first (before keyed-secret, so "password" in the
  // URL path doesn't trip a partial match on the userinfo it already redacted).
  let next = text.replace(URL_USERINFO_RE, '$1[REDACTED]@');
  // PEM blocks before the long-opaque pass to avoid the base64 body matching first.
  next = next.replace(PEM_BLOCK_RE, '[REDACTED_PEM]');
  next = next.replace(KEYED_SECRET_RE, (match, marker) => `${marker}=[REDACTED]`);
  next = next.replace(OTP_RE, '[REDACTED_OTP]');
  next = next.replace(LONG_OPAQUE_RE, '[REDACTED]');
  return { text: next, redacted: next !== text };
}
