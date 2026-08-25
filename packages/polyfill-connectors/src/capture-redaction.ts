// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Credential redaction for connector capture artifacts, applied at WRITE TIME.
 *
 * Why this exists separately from `src/scrub-defaults.ts`:
 *
 * The fixture scrubber answers "what is unsafe to COMMIT?" — it matches PII by
 * shape (email, SSN, card, phone, address, labelled names) and runs as a later
 * pass from raw/ into scrubbed/. This module answers a different question:
 * "what is unsafe to WRITE TO DISK AT ALL?" Two reasons the scrubber cannot be
 * the answer here:
 *
 *   1. Timing. raw/ persists on the volume and is precisely what a diagnostic
 *      agent is pointed at. A later sanitizing pass does not un-write bytes
 *      that already landed. Redaction has to happen before the write.
 *   2. Shape. A credential has no shape. `BG54aFvx` is not an email, an SSN, a
 *      card, or a labelled name, so every rule in scrub-defaults.ts passes it
 *      through verbatim. Secrets are identified by their POSITION (the value
 *      slot of a secret-ish field) or by IDENTITY (equal to a credential the
 *      run actually holds) — never by pattern.
 *
 * So the two are complementary, not duplicative, and this module is the
 * narrower, stricter gate. `credentialScrubRules()` re-exports the value-based
 * half of it as ScrubRules so the commit-time path inherits the same notion of
 * "credential-sensitive" instead of drifting to a second one.
 *
 * Both confirmed leak channels are covered; both were verified empirically
 * against real Playwright output rather than assumed:
 *
 *   ARIA snapshots (page.ariaSnapshot) serialize the live value PROPERTY, so a
 *   password typed by fill() appears in full:
 *       - textbox "Password" [ref=e25]: BG54aFvx
 *
 *   DOM dumps (page.content) serialize the value ATTRIBUTE, not the property.
 *   A typed password therefore does NOT appear, but a value="..." present in
 *   served markup or set via setAttribute DOES. Narrower than ARIA, still real.
 *
 * Redaction preserves diagnostic value. The point of these captures is
 * debugging a failed login, so a redacted field must still show that it
 * EXISTED and whether it was FILLED. We replace only the value text with
 * `[REDACTED]`, never the field, its role, its label, or its ref. An empty
 * field stays visibly empty — "present but empty" vs "present and filled" is
 * exactly the distinction that diagnoses a login failure.
 */

/** Placeholder written in place of a redacted secret value. */
export const REDACTED = "[REDACTED]";

/**
 * Field-name/label fragments whose value slot is treated as secret.
 *
 * Matched case-insensitively as substrings, so "password" also covers
 * "Password", "confirm_password" and "passwordConfirm". Deliberately broad:
 * a false positive costs one unreadable diagnostic value, a false negative
 * writes a live credential to a shared directory.
 */
const SECRET_NAME_FRAGMENTS: readonly string[] = [
  "passwd",
  "password",
  "passphrase",
  "secret",
  "token",
  "apikey",
  "api_key",
  "api-key",
  "credential",
  "otp",
  "one-time",
  "one time",
  "one_time",
  "onetime",
  "2fa",
  "mfa",
  "totp",
  "auth code",
  "auth_code",
  "authcode",
  "security code",
  "security_code",
  "verification code",
  "verification_code",
  "pin",
  "cvv",
  "cvc",
  "private key",
  "private_key",
  "privatekey",
  "session key",
  "session_key",
  "bearer",
];

/**
 * A credential value short enough that matching it verbatim would redact
 * unrelated text. "1" or "on" as a password would otherwise blank every
 * occurrence of those substrings across the capture and destroy the artifact's
 * diagnostic value. Such a value is left to the field-based rules instead; the
 * tradeoff is recorded rather than hidden.
 */
const MIN_MATCHABLE_SECRET_LENGTH = 4;

/** True when a field's accessible name / attribute names imply a secret value. */
export function isSecretFieldName(name: string): boolean {
  const haystack = name.toLowerCase();
  return SECRET_NAME_FRAGMENTS.some((fragment) => haystack.includes(fragment));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Known secret values held by the current run, longest-first so that a longer
 * secret is redacted before any shorter secret contained inside it.
 */
function matchableSecrets(secrets: readonly string[]): string[] {
  return [...new Set(secrets)]
    .filter((secret) => secret.trim().length >= MIN_MATCHABLE_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);
}

/**
 * Replace every occurrence of a known credential value with `[REDACTED]`.
 *
 * This is the identity-based rule, and it is the one that catches a secret in
 * a field nobody thought to label — including values echoed into page text,
 * inline scripts, JSON blobs or URLs, where no field-based rule could see it.
 */
export function redactKnownSecrets(content: string, secrets: readonly string[]): string {
  let out = content;
  for (const secret of matchableSecrets(secrets)) {
    out = out.split(secret).join(REDACTED);
  }
  return out;
}

/**
 * Redact secret values from a Playwright ARIA snapshot (`mode: "ai"`).
 *
 * Playwright emits one node per line as `- <role> "<name>" [attrs]: <value>`,
 * with the value optionally quoted. We rewrite only the text after the final
 * value-introducing colon, leaving indentation, role, accessible name, refs
 * and state flags intact so the tree still reads correctly.
 *
 * A field with no value keeps its empty rendering: an unfilled password box
 * still looks unfilled after redaction.
 */
export function redactAriaSnapshot(snapshot: string, secrets: readonly string[] = []): string {
  const lines = snapshot.split("\n").map((line) => redactAriaLine(line));
  return redactKnownSecrets(lines.join("\n"), secrets);
}

/**
 * Matches an ARIA node line, splitting it into the part up to and including
 * the value-introducing colon, and the value itself.
 *
 * Group 1 — everything through `:` (indent, "- ", role, quoted name, [flags]).
 * Group 2 — the value text.
 *
 * The name is matched as a quoted run so that a colon INSIDE the accessible
 * name (e.g. `textbox "Time: HH:MM"`) cannot be mistaken for the value
 * separator.
 */
const ARIA_VALUE_LINE_RE = /^(\s*-\s+[A-Za-z]+(?:\s+"(?:[^"\\]|\\.)*")?(?:\s+\[[^\]]*\])*\s*:\s*)(.+)$/;

function redactAriaLine(line: string): string {
  const match = ARIA_VALUE_LINE_RE.exec(line);
  if (!match) {
    return line;
  }
  const [, prefix, rawValue] = match;
  if (prefix === undefined || rawValue === undefined) {
    return line;
  }
  // A child-bearing node ends at the colon; anything after it on the same line
  // is a real value. Structural lines (e.g. `- generic [ref=e2]:`) have no
  // trailing text and never reach here.
  if (!isSecretFieldName(prefix)) {
    return line;
  }
  // Preserve the quoting style Playwright chose, so the file still parses as
  // the same shape of YAML and a numeric-looking value stays a string.
  const quoted = rawValue.startsWith('"') && rawValue.endsWith('"');
  return `${prefix}${quoted ? `"${REDACTED}"` : REDACTED}`;
}

/**
 * Naming attributes that describe what an input IS FOR. `type` is excluded on
 * purpose and handled by its own rule: `type="password"` contains the literal
 * "password", so folding it in here would let the name-fragment rule silently
 * stand in for the type rule and hide the loss of either one.
 */
const HTML_NAMING_ATTR_RE =
  /\b(?:name|id|placeholder|aria-label|autocomplete|data-testid)\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+)/gi;

const HTML_INPUT_TAG_RE = /<input\b[^>]*>/gi;
const HTML_VALUE_ATTR_RE = /(\bvalue\s*=\s*)("[^"]*"|'[^']*'|[^\s"'>]+)/i;
const HTML_PASSWORD_TYPE_RE = /\btype\s*=\s*["']?password["']?/i;

/**
 * Redact secret values from a DOM HTML dump (`page.content()`).
 *
 * Only the `value` attribute of a secret-ish `<input>` is rewritten. The tag,
 * its type, name, id and every other attribute survive, so the element is
 * still visible to whoever is debugging the page — it simply no longer carries
 * the credential.
 *
 * `type="password"` is always treated as secret regardless of its name, which
 * catches an unlabelled password box.
 */
export function redactDomHtml(html: string, secrets: readonly string[] = []): string {
  const withRedactedInputs = html.replace(HTML_INPUT_TAG_RE, (tag) => {
    const namingAttrs = [...tag.matchAll(HTML_NAMING_ATTR_RE)].map((m) => m[1] ?? "").join(" ");
    const isSecret = HTML_PASSWORD_TYPE_RE.test(tag) || isSecretFieldName(namingAttrs);
    if (!isSecret) {
      return tag;
    }
    return tag.replace(HTML_VALUE_ATTR_RE, (_full, prefix: string, value: string) => {
      const quote = value.startsWith("'") ? "'" : '"';
      return `${prefix}${quote}${REDACTED}${quote}`;
    });
  });
  return redactKnownSecrets(withRedactedInputs, secrets);
}

/**
 * The identity-based rule expressed as scrubber `ScrubRule`s, so the
 * commit-time scrubber path shares this module's definition of
 * "credential-sensitive" rather than growing a divergent second one.
 *
 * Field-based rules are intentionally NOT exported this way: they are
 * structural (they need to see an ARIA line or an HTML tag), and the scrubber's
 * flat regex-over-text model cannot express them safely.
 */
export function credentialScrubRules(secrets: readonly string[]): {
  pattern: RegExp;
  replacement: string;
  scope: "all";
}[] {
  return matchableSecrets(secrets).map((secret) => ({
    pattern: new RegExp(escapeRegExp(secret), "g"),
    replacement: REDACTED,
    scope: "all" as const,
  }));
}
