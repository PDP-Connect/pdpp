// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
const LONG_OPAQUE_RE = /\b[A-Za-z0-9_-]{24,}\b/g;

export interface RedactedStderr {
  redacted: boolean;
  text: string;
}

/**
 * Reason tokens the CONNECTOR DECLARED, which `LONG_OPAQUE_RE` must not eat.
 *
 * `LONG_OPAQUE_RE` is an ENTROPY heuristic, not a PII control: it redacts any
 * >=24-char alnum run because raw API keys look like that. Categorical reason
 * tokens look like that too. Production 2026-08-18: HEB connection
 * `cin_c875ca3ec8b6ce2c283a4288` recorded
 * `connector_error_json.message = "heb_session_failed: [REDACTED]"` — the
 * literal string `[REDACTED]` was the entire cause. The eaten token was a
 * PII-free categorical constant (`login_form_never_appeared`, 25 chars);
 * `source_unavailable` (18 chars) survived the same pass. Length, not content,
 * decided which failures stayed diagnosable.
 *
 * Shape alone CANNOT fix this, and that is the load-bearing finding. A tighter
 * "alphabetic snake_case" rule admits `login_form_never_appeared` but also
 * admits `tim_nunamaker_gmail_com` — a personal name is alphabetic snake_case
 * too. No regex separates a declared reason from a name, because the
 * difference is PROVENANCE, not spelling.
 *
 * So the safety property here is DECLARATION, not spelling. A token survives
 * only if the connector declared it ahead of time as part of its reason
 * vocabulary; the declaration is reviewable in the connector's source, where a
 * human can see `login_form_never_appeared` is a constant and would see a name
 * for what it is. Anything undeclared redacts exactly as before, so this can
 * only ever REDUCE what escapes — never widen it.
 */
export interface StderrRedactionOptions {
  readonly declaredReasonTokens?: ReadonlySet<string>;
}

export function redactStderrTail(text: unknown, options: StderrRedactionOptions = {}): RedactedStderr {
  if (typeof text !== "string" || text.length === 0) {
    return { redacted: false, text: (text as string | null | undefined) ?? "" };
  }
  const declared = options.declaredReasonTokens;
  // URL-embedded credentials first (before keyed-secret, so "password" in the
  // URL path doesn't trip a partial match on the userinfo it already redacted).
  let next = text.replace(URL_USERINFO_RE, "$1[REDACTED]@");
  // PEM blocks before the long-opaque pass to avoid the base64 body matching first.
  next = next.replace(PEM_BLOCK_RE, "[REDACTED_PEM]");
  next = next.replace(KEYED_SECRET_RE, (_match, marker: string) => `${marker}=[REDACTED]`);
  next = next.replace(OTP_RE, "[REDACTED_OTP]");
  // A declared reason token is preserved verbatim; everything else redacts
  // exactly as it always has. `declared` is empty for every caller that does
  // not opt in, so this branch is byte-identical to the previous behaviour.
  next = next.replace(LONG_OPAQUE_RE, (match) => (declared?.has(match) ? match : "[REDACTED]"));
  return { redacted: next !== text, text: next };
}
