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
//
// WHY SHAPE ALONE IS NOT ENOUGH — the identity rule
// -------------------------------------------------
// Every rule above matches by SHAPE, and a credential has no shape. Proven by
// direct execution against the deployed head on 2026-08-23: a real owner
// password, 8 characters of mixed-case alphanumerics, was passed to this
// function inside an ordinary connector stderr line ("Login failed for
// <password>") and came back VERBATIM with `redacted: false`. It is too short
// for `LONG_OPAQUE_RE`, not six digits, not a PEM block, not URL userinfo, and
// carries no `password=` marker — so it matched nothing and flowed into a
// durable `run.failed.data.connector_diagnostics.stderr_tail`. The same value
// with a `password=` label redacts correctly, which is precisely the point:
// shape rules only fire when the connector was polite enough to label its own
// leak, and a connector that leaks a credential by accident does not label it.
//
// So `knownSecrets` adds an IDENTITY rule: a value the run actually holds is
// redacted wherever it appears, regardless of label, length or spelling. The
// shape rules are KEPT and still run — identity can only ever cover secrets the
// runtime resolved, and a connector's stderr can carry a secret this process
// never held (an API key the connector fetched itself, a cookie from the
// provider). The two are complementary: identity catches what has no shape,
// shape catches what was never registered.
//
// This is the same notion of "credential-sensitive" as
// `packages/polyfill-connectors/src/capture-redaction.ts`'s `redactKnownSecrets`
// — deliberately so, and the reason for the shared floor constant below. That
// module is NOT imported here: it lives in the connector child's package, and
// RI production source may not import connector-package modules (the
// zero-connector-knowledge conformance guard, see
// `test/ri-zero-connector-knowledge-conformance.test.ts`; the same rule is why
// `runtime/declared-reason-tokens.ts` stopped importing a connector's token
// list). The two also run in different processes, exactly like
// `connector-gap-bounding.ts`'s `CONNECTOR_ERROR_CODE_RE` and its connector-side
// twin: they cannot literally share a module, but the CONTRACT must match.

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
  /**
   * Credential values this run actually resolved, redacted by IDENTITY
   * wherever they appear — see the module doc for why shape rules cannot do
   * this. Omitted callers get byte-identical behaviour to before.
   *
   * These are the resolved plaintext values, not references to them. The
   * caller already holds them (the runtime injects them into the connector
   * child's environment), so passing them here moves no secret to a place it
   * was not already; it tells redaction what to look for.
   */
  readonly knownSecrets?: Iterable<string>;
}

/**
 * Below this length a credential value is not matched by identity, because
 * matching it would do more harm than the leak it prevents: a two-character
 * secret occurs as a substring of ordinary English, so redacting it verbatim
 * would pepper `[REDACTED]` through the whole diagnostic and destroy the thing
 * the excerpt exists for. `capture-redaction.ts` uses the same floor.
 *
 * WHY 4 IS SAFE HERE, WHICH IS NOT THE SAME ARGUMENT CAPTURE MAKES
 * ----------------------------------------------------------------
 * Capture can afford a floor because it has a SECOND, independent defence for
 * what falls under it: a short password still sits in the value slot of a
 * field named "password", and the field-based rules redact that slot on name
 * alone. Identity is capture's backstop, not its only cover.
 *
 * Stderr has no fields. A free-form line has no value slot to key on, so
 * anything the floor excludes is covered by NOTHING here. That asymmetry is
 * the reason to state the floor's safety rather than inherit it:
 *
 *   - It is bounded and knowable, not a guess. The floor is 4, and the
 *     shortest credential any registered connection can hold is enforced
 *     elsewhere; a sub-4-character password is not a credential a provider
 *     issues or accepts.
 *   - It fails toward redaction, not toward leaking, in the ambiguous case.
 *     Exactly 4 characters IS matched — the floor is inclusive.
 *   - The alternative fails worse. Redacting a 1-3 character value verbatim
 *     turns `Login failed for user` into `[REDACTED]ogin failed for [REDACTED]ser`
 *     if the secret is "L" — an unreadable diagnostic AND a stronger hint about
 *     the secret than the original line gave, since every occurrence is now
 *     marked. A floor is the safer failure here, not the laxer one.
 *
 * So the decision is: keep the floor, keep it identical to capture's so the two
 * cannot drift, and record here that stderr's exposure under it is real and
 * uncovered rather than let the shared constant imply capture's field-based
 * backstop exists on this path too.
 */
const MIN_MATCHABLE_SECRET_LENGTH = 4;

/**
 * Registered secrets worth matching, longest first so a longer secret is
 * redacted before any shorter secret contained inside it — otherwise redacting
 * the short one first would break the long one into pieces that no longer
 * match, and part of the longer credential would survive.
 */
function matchableSecrets(secrets: Iterable<string>): string[] {
  return [...new Set(secrets)]
    .filter((secret) => typeof secret === "string" && secret.trim().length >= MIN_MATCHABLE_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);
}

/**
 * Replace every occurrence of a registered credential value with `[REDACTED]`.
 *
 * Split/join rather than a RegExp so the secret is never compiled as a pattern:
 * a credential containing regex metacharacters would otherwise either throw or,
 * worse, match the wrong thing.
 *
 * The marker is left in place deliberately. `[REDACTED]` still says a
 * credential APPEARED at this point in the line, which is what makes a failed
 * login diagnosable — the surrounding text ("Login failed for ...") survives
 * intact. Blanking the line would remove exactly the evidence the excerpt is
 * retained for.
 */
function redactKnownSecrets(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const secret of matchableSecrets(secrets)) {
    out = out.split(secret).join("[REDACTED]");
  }
  return out;
}

export function redactStderrTail(text: unknown, options: StderrRedactionOptions = {}): RedactedStderr {
  if (typeof text !== "string" || text.length === 0) {
    return { redacted: false, text: (text as string | null | undefined) ?? "" };
  }
  const declared = options.declaredReasonTokens;
  // IDENTITY FIRST. A known credential is redacted before any shape rule can
  // rewrite the text around it: once a shape rule has replaced part of a line,
  // a secret straddling that region no longer matches itself and would survive.
  // Running first also means a registered secret is redacted even where a
  // declared reason token would otherwise have preserved it verbatim — identity
  // outranks the allowlist, which is the correct precedence, since a token that
  // equals a live credential is a credential first and a reason token second.
  let next = options.knownSecrets ? redactKnownSecrets(text, options.knownSecrets) : text;
  // URL-embedded credentials next (before keyed-secret, so "password" in the
  // URL path doesn't trip a partial match on the userinfo it already redacted).
  next = next.replace(URL_USERINFO_RE, "$1[REDACTED]@");
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
