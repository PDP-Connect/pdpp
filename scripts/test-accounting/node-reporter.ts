// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { accountingEventLine } from "./receipt.ts";

interface ReporterEventData {
  details?: { error?: ReporterError; name?: string; skip?: boolean | string; type?: string };
  message?: string;
  name?: string;
  skip?: boolean | string;
}
interface ReporterError {
  code?: unknown;
  failureType?: unknown;
  message?: unknown;
  stack?: unknown;
}
interface ReporterEvent {
  data?: ReporterEventData;
  type: string;
}

const MAX_FAILURE_FIELD_LENGTH = 2000;
const MAX_FAILURE_DIAGNOSTIC_LENGTH = 4000;
const MAX_DIAGNOSTIC_BUFFER_LENGTH = 16_000;
// Hard bound on raw input handed to the structured-header scanner, applied
// BEFORE any scanning happens (not the 2,000/4,000-char post-redaction
// output cap below). error.message/error.stack are user- and
// library-controlled with no prior size limit; without this bound, scanning
// their raw text costs work proportional to an attacker-chosen length before
// the output cap ever gets a chance to bound anything. Oversized input never
// gets truncated-then-redacted (a credential could sit past the truncation
// point and leak); it is replaced wholesale by a safe overflow marker.
const MAX_RAW_SCAN_LENGTH = 20_000;
const OVERSIZED_INPUT_MARKER = "[REDACTED oversized diagnostic input]";
// Fixed linear multiple of (bounded) input length used to size each field's
// scan budget. The scanner's own character-inspection accounting (see
// ScanBudget below) is what makes this a real bound rather than a hope: the
// scanner is linear by construction, but the budget exists as a second,
// independent enforcement layer so a future change to the scanner cannot
// silently regress past O(n) without a field simply failing closed instead
// of consuming unbounded CPU.
const SCAN_BUDGET_MULTIPLIER = 8;
const BUDGET_EXHAUSTED_MARKER = "[REDACTED scan budget exhausted]";
// Emitted when a quoted key case-insensitively matching Authorization,
// Cookie, or Set-Cookie was found, but the separator/colon/value that
// should follow it could not be parsed (a malformed or unsupported escape
// sequence, or any other unrecognized shape). Once a key is confirmed
// sensitive, there is no safe way to "fall back to copying the candidate
// through" — the credential may still be present in whatever unrecognized
// syntax follows the key, so the entire field is replaced rather than only
// the unparseable span.
const MALFORMED_SENSITIVE_HEADER_MARKER = "[REDACTED malformed sensitive header]";
const AUTHORIZATION_PATTERN = /(?<![A-Za-z0-9_-])authorization\b\s*:\s*[^\r\n]+/gi;
const COOKIE_PATTERN = /\b(?:cookie|set-cookie)\s*:\s*[^\r\n]+/gi;
const GITHUB_PAT_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;
const STRUCTURED_HEADER_KEYS = new Set(["authorization", "cookie", "set-cookie"]);
// The longest recognized key name is "set-cookie" (10 characters). No
// legitimate structured-header key is anywhere near this long, so bounding
// the KEY body scan to a small constant makes a failed key-open candidate
// (the common case: most quote-opens in arbitrary text are not one of these
// three keys) cost O(1) rather than O(remaining input) — the true fix for
// superlinear behavior on adversarial "many quote-open candidates, each
// scanning to the end looking for a key close" shapes, independent of and
// in addition to the shared ScanBudget backstop below.
const MAX_STRUCTURED_HEADER_KEY_SCAN_LENGTH = 32;
// A legitimate separator between a recognized key's closing quote and its
// colon (or between the colon and the value's opening quote) is a handful
// of whitespace/escape units at most — no real serializer inserts more than
// a few. Bounding this scan independently of the shared ScanBudget means an
// ordinary, unrelated diagnostic that merely happens to contain a
// recognized-looking key (e.g. a code sample discussing "Authorization"
// headers, followed by ordinary prose) cannot itself cost more than a small
// constant amount of work before either finding its colon/value or being
// classified as unparseable — independent of and in addition to the shared
// budget, exactly like MAX_STRUCTURED_HEADER_KEY_SCAN_LENGTH above.
const MAX_STRUCTURED_HEADER_SEPARATOR_SCAN_LENGTH = 64;
const QUOTED_SENSITIVE_VALUE_PATTERN =
  /(["'](?:github_token|client_secret|access_token|token|secret|password|api[_-]?key|[a-z][a-z0-9_-]*(?:token|secret|password|api[_-]?key))["']\s*:\s*)["'](?:\\.|[^"'\\])*["']/gi;
const SENSITIVE_QUERY_PARAMETER_PATTERN =
  /([?&](?:github_token|client_secret|access_token|token|secret|password|api[_-]?key|[a-z][a-z0-9_-]*(?:token|secret|password|api[_-]?key))=)[^&#\s]*/gi;
const SENSITIVE_URL_USERINFO_PATTERN = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]*:[^\s/@]+@/gi;
const UNQUOTED_SENSITIVE_VALUE_PATTERN =
  /\b(github_token|client_secret|access_token|token|secret|password|api[_-]?key|[a-z][a-z0-9_-]*(?:token|secret|password|api[_-]?key))\b\s*([=:])\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,\s}&#\]]+)/gi;

class DiagnosticBuffer {
  #overflowed = Boolean(false);
  #value = "";

  append(chunk: string) {
    if (this.#overflowed) {
      return;
    }
    if (this.#value.length + chunk.length > MAX_DIAGNOSTIC_BUFFER_LENGTH) {
      this.#overflowed = true;
      this.#value = "";
      return;
    }
    this.#value += chunk;
  }

  take(): string {
    const value = this.#overflowed ? "[REDACTED diagnostic overflow]" : this.#value;
    this.#overflowed = false;
    this.#value = "";
    return value;
  }
}

// Tracks total character inspections across the whole scan of one field, so
// that no nested helper (backslash-run counting, quote matching, whitespace
// skipping, string-body scanning) can escape accounting by working "inside"
// a call the outer loop only charges once for. Every scanning function below
// takes a ScanBudget and calls `consume` for each character it looks at,
// including characters it merely peeks at while classifying a run — not just
// characters it ultimately copies to output. Once exhausted, every consuming
// call becomes a no-op that reports exhaustion, and the top-level scan must
// check `exhausted` and bail out to a whole-field-safe marker rather than
// returning a partially-scanned (and therefore potentially still
// credential-bearing) result.
class ScanBudget {
  #exhausted = false;
  #remaining: number;

  constructor(totalOperations: number) {
    this.#remaining = totalOperations;
  }

  get exhausted(): boolean {
    return this.#exhausted;
  }

  // Charges `count` character inspections against the budget. Returns
  // whether the budget is (now) exhausted, so a call site can bail out
  // immediately in the same expression that consumes the budget. Safe to
  // call again after exhaustion: `#remaining` only drifts further negative,
  // which leaves `#exhausted` true.
  consume(count: number): boolean {
    this.#remaining -= count;
    this.#exhausted = this.#remaining < 0;
    return this.#exhausted;
  }
}

// ECMAScript WhiteSpace/LineTerminator, which includes the ASCII forms plus
// Unicode separators relevant to JSON-like (not necessarily strictly valid
// JSON) diagnostic text: U+00A0 NO-BREAK SPACE, U+2028 LINE SEPARATOR,
// U+2029 PARAGRAPH SEPARATOR, U+FEFF BOM, and the other Unicode `Zs`/space
// code points \s already matches. A redactor that fails closed on malformed
// input cannot assume strict JSON grammar for its separators — a
// credential-bearing key/value pair can be separated by any of these and
// still be recognizably "the Authorization header" to a human reader.
const STRUCTURED_WHITESPACE_CHAR_PATTERN = /\s/u;
// Escaped-whitespace letter forms: \t \n \r (single-letter escapes) and the
// 4-hex-digit \uXXXX forms for the Unicode separators above, at any
// backslash depth. JSON.stringify itself never emits \u2028/\u2029/\u00a0 as
// \u-escapes (it leaves them as literal characters, which the literal
// pattern above already covers at every escape depth) — this branch exists
// for JSON-like-but-not-JSON.stringify-produced diagnostic text, which may
// legitimately use \uXXXX for these code points.
const STRUCTURED_ESCAPED_WHITESPACE_LETTER_PATTERN = /[tnr]/;
const STRUCTURED_ESCAPED_WHITESPACE_UNICODE_PATTERN = /^u(?:2028|2029|00a0|feff)$/i;
const STRUCTURED_ESCAPED_WHITESPACE_UNICODE_LENGTH = 5; // "u" + 4 hex digits

interface BackslashRun {
  count: number;
  end: number;
}

// Counts a run of consecutive backslashes starting at `index` exactly once,
// charging the budget for every character inspected (including the
// terminating non-backslash character, if any, so the caller's subsequent
// charAt of it is never double-charged nor uncharged). Every caller that
// needs a run's length or end position goes through this single count, and
// every scan below advances its cursor to (at minimum) `end` after
// inspecting a run — no index inside a run is ever re-entered once
// classified, which is what keeps the whole scan linear in input length: a
// string of N backslashes costs O(N) total, not O(N) per index.
function countBackslashRun(source: string, index: number, limit: number, budget: ScanBudget): BackslashRun {
  let cursor = index;
  while (cursor < limit && source.charAt(cursor) === "\\") {
    if (budget.consume(1)) {
      return { count: cursor - index, end: cursor };
    }
    cursor += 1;
  }
  return { count: cursor - index, end: cursor };
}

interface QuoteMatch {
  backslashes: number;
  end: number;
  quoteChar: string;
}

// Given an already-counted backslash run [index, run.end), determines
// whether it is immediately followed by a quote character (an "opening
// delimiter" at that backslash depth). Charges the budget for the one
// character it inspects (the character at run.end); does no scanning of its
// own beyond that — the run itself was already counted (and charged) once by
// the caller.
function quoteAfterRun(source: string, run: BackslashRun, budget: ScanBudget): QuoteMatch | undefined {
  if (budget.consume(1)) {
    return;
  }
  const quoteChar = source.charAt(run.end);
  return quoteChar === '"' || quoteChar === "'" ? { backslashes: run.count, end: run.end + 1, quoteChar } : undefined;
}

// Handles one backslash run encountered inside a string body: charges the
// budget for the run and its terminating character, then reports whether
// this run is the matching closing-quote run (`isClose: true`, cursor stays
// at the run's start so the caller can return it) or should be skipped as
// escape-pair content (`isClose: false`, cursor advances past it).
function resolveStringBodyBackslashRun(
  source: string,
  cursor: number,
  backslashes: number,
  quoteChar: string,
  limit: number,
  budget: ScanBudget
): { isClose: boolean; next: number } {
  const run = countBackslashRun(source, cursor, limit, budget);
  if (budget.exhausted || budget.consume(1)) {
    return { isClose: false, next: cursor };
  }
  if (run.count === backslashes && source.charAt(run.end) === quoteChar) {
    return { isClose: true, next: cursor };
  }
  return { isClose: false, next: run.end < limit ? run.end + 1 : run.end };
}

// Scans a string body for the end of its content: the position of a closing
// quote run whose backslash depth matches the opening quote's. Each
// character encountered — including every character inside every backslash
// run it classifies along the way — is charged to `budget` exactly once via
// countBackslashRun/resolveStringBodyBackslashRun or the direct
// per-character consume below, so a body containing K backslash runs costs
// O(body length) total rather than O(body length) per run. Returns -1 if
// the body never closes within `limit` OR if the budget is exhausted first;
// the caller cannot distinguish these (both mean "give up and fail
// closed"), which is intentional: exhaustion must behave exactly like
// "malformed input", never like a mid-scan partial success.
function scanStringBody(
  source: string,
  start: number,
  backslashes: number,
  quoteChar: string,
  limit: number,
  budget: ScanBudget
): number {
  let cursor = start;
  while (cursor < limit) {
    if (budget.exhausted) {
      return -1;
    }
    const ch = source.charAt(cursor);
    if (ch === "\\") {
      const resolved = resolveStringBodyBackslashRun(source, cursor, backslashes, quoteChar, limit, budget);
      if (budget.exhausted) {
        return -1;
      }
      if (resolved.isClose) {
        return cursor;
      }
      cursor = resolved.next;
      continue;
    }
    if (budget.consume(1)) {
      return -1;
    }
    if (backslashes === 0 && ch === quoteChar) {
      return cursor;
    }
    cursor += 1;
  }
  return -1;
}

// Skips one or more separator units, where a unit is either a literal
// ECMAScript whitespace/line-terminator character (STRUCTURED_WHITESPACE_
// CHAR_PATTERN, which covers Unicode separators such as U+2028/U+2029/NBSP)
// or a JSON-escaped whitespace sequence — `\t`/`\n`/`\r`, or `\uXXXX` for
// the Unicode separators — at any backslash depth. Every character
// inspected, including the lookahead into a candidate \uXXXX sequence, is
// charged to `budget`.
// Given a backslash run already counted at `cursor` (inside a candidate
// separator position), determines whether it is followed by an escaped
// whitespace unit — a single letter (`t`/`n`/`r`) or a `uXXXX` sequence
// naming one of the recognized Unicode separators — and charges the budget
// for every character it inspects while deciding. Returns the cursor
// position after the escaped unit if one matched, or undefined otherwise.
function matchEscapedWhitespaceUnit(
  source: string,
  run: BackslashRun,
  limit: number,
  budget: ScanBudget
): number | undefined {
  if (run.end >= limit) {
    return;
  }
  const letter = source.charAt(run.end);
  if (budget.consume(1)) {
    return;
  }
  if (STRUCTURED_ESCAPED_WHITESPACE_LETTER_PATTERN.test(letter)) {
    return run.end + 1;
  }
  if (letter !== "u" || run.end + STRUCTURED_ESCAPED_WHITESPACE_UNICODE_LENGTH > limit) {
    return;
  }
  const candidate = source.slice(run.end, run.end + STRUCTURED_ESCAPED_WHITESPACE_UNICODE_LENGTH);
  if (budget.consume(STRUCTURED_ESCAPED_WHITESPACE_UNICODE_LENGTH - 1)) {
    return;
  }
  return STRUCTURED_ESCAPED_WHITESPACE_UNICODE_PATTERN.test(candidate)
    ? run.end + STRUCTURED_ESCAPED_WHITESPACE_UNICODE_LENGTH
    : undefined;
}

function skipStructuredWhitespace(source: string, index: number, limit: number, budget: ScanBudget): number {
  let cursor = index;
  for (;;) {
    if (budget.exhausted || cursor >= limit) {
      return cursor;
    }
    if (budget.consume(1)) {
      return cursor;
    }
    const ch = source.charAt(cursor);
    if (STRUCTURED_WHITESPACE_CHAR_PATTERN.test(ch)) {
      cursor += 1;
      continue;
    }
    if (ch !== "\\") {
      return cursor;
    }
    const run = countBackslashRun(source, cursor, limit, budget);
    if (budget.exhausted) {
      return cursor;
    }
    const escapedEnd = matchEscapedWhitespaceUnit(source, run, limit, budget);
    if (escapedEnd === undefined) {
      return cursor;
    }
    cursor = escapedEnd;
  }
}

interface StructuredHeaderValueSpan {
  closeEnd: number;
  openEnd: number;
  terminated: boolean;
}

// The outcome of attempting to match a structured-header pair at a given
// candidate position:
//   - "not-a-key": no recognized Authorization/Cookie/Set-Cookie key opens
//     here at all (most quote-open candidates in arbitrary text). Nothing
//     sensitive was found, so the caller's outer scan may safely fall
//     through to its ordinary "not a match, copy through" handling.
//   - "redact": a recognized key was found and its value parsed
//     successfully (terminated or not — an unterminated VALUE still
//     redacts through end-of-field, see StructuredHeaderValueSpan).
//   - "fail-closed": a recognized key was found, but the separator, colon,
//     or value that should follow it could not be parsed (malformed
//     escape, unsupported separator syntax, or any other unrecognized
//     shape). Once the key is confirmed sensitive, ANY parse failure past
//     that point must never fall back to copying the candidate through —
//     the credential may still be present in an unrecognized shape, so the
//     caller must fail closed for the entire field, not just this
//     candidate.
type StructuredHeaderMatch =
  | { kind: "fail-closed" }
  | { kind: "not-a-key" }
  | ({ kind: "redact" } & StructuredHeaderValueSpan);

const NOT_A_KEY: StructuredHeaderMatch = { kind: "not-a-key" };
const FAIL_CLOSED: StructuredHeaderMatch = { kind: "fail-closed" };

// Matches one `<quoted key>` `<ws>` `:` `<ws>` `<quoted value>` pair whose
// key's opening backslash run is the already-counted `keyRun`. See
// StructuredHeaderMatch for the three possible outcomes. Once the quoted
// key is found and case-insensitively equals a recognized name, every
// subsequent parse step commits to "fail-closed" on any failure — there is
// no path back to "not-a-key" past that point, by construction (every
// `return` below the key-recognition check is FAIL_CLOSED, never
// NOT_A_KEY). If the value's quote never closes within `limit` — or the
// budget runs out first — this still counts as a successful parse that
// fails closed at the *value-redaction* layer (StructuredHeaderValueSpan's
// existing terminated:false handling), not this function's "could not even
// parse the shape" layer.
function matchStructuredHeaderValue(
  input: string,
  keyRun: BackslashRun,
  limit: number,
  budget: ScanBudget
): StructuredHeaderMatch {
  const keyOpen = quoteAfterRun(input, keyRun, budget);
  if (!keyOpen || budget.exhausted) {
    return NOT_A_KEY;
  }
  // Bound the key-body scan independently of `limit`: the longest
  // recognized key is 10 characters, so a key that hasn't closed within
  // MAX_STRUCTURED_HEADER_KEY_SCAN_LENGTH characters cannot be one of
  // STRUCTURED_HEADER_KEYS regardless of how it eventually closes (or
  // whether it closes at all). This keeps a failed key-open candidate O(1)
  // rather than O(remaining input), which is what makes the outer scan
  // linear even when arbitrary text contains many quote-open-shaped
  // candidates that are never a real header key. This bound applies only to
  // recognizing the KEY — once the key is confirmed sensitive, the
  // separator/colon/value scan below is unbounded by this constant (it is
  // still bounded by the shared ScanBudget).
  const keyScanLimit = Math.min(limit, keyOpen.end + MAX_STRUCTURED_HEADER_KEY_SCAN_LENGTH);
  const keyBodyEnd = scanStringBody(input, keyOpen.end, keyOpen.backslashes, keyOpen.quoteChar, keyScanLimit, budget);
  if (keyBodyEnd === -1) {
    // An unterminated (or over-length) KEY is not a recognized header pair
    // at all — there is no key name to check, so there is nothing sensitive
    // to fail closed on here. The caller's outer scan simply continues past
    // it. If this was actually budget exhaustion, the caller checks that
    // itself.
    return NOT_A_KEY;
  }
  const key = input.slice(keyOpen.end, keyBodyEnd);
  if (!STRUCTURED_HEADER_KEYS.has(key.toLowerCase())) {
    return NOT_A_KEY;
  }
  // From here on, the key is confirmed sensitive. Every remaining `return`
  // is FAIL_CLOSED on failure, never NOT_A_KEY: a malformed or unsupported
  // separator/colon/value shape after a recognized key must not fall back
  // to "copy the candidate through unchanged," because the credential may
  // still be present in that unrecognized shape.
  const keyCloseEnd = keyBodyEnd + keyOpen.backslashes + 1;
  const preColonScanLimit = Math.min(limit, keyCloseEnd + MAX_STRUCTURED_HEADER_SEPARATOR_SCAN_LENGTH);
  const colonIndex = skipStructuredWhitespace(input, keyCloseEnd, preColonScanLimit, budget);
  if (budget.exhausted || input.charAt(colonIndex) !== ":") {
    return FAIL_CLOSED;
  }
  const preValueScanLimit = Math.min(limit, colonIndex + 1 + MAX_STRUCTURED_HEADER_SEPARATOR_SCAN_LENGTH);
  const valueStart = skipStructuredWhitespace(input, colonIndex + 1, preValueScanLimit, budget);
  if (budget.exhausted) {
    return FAIL_CLOSED;
  }
  const valueRun = countBackslashRun(input, valueStart, limit, budget);
  const valueOpen = quoteAfterRun(input, valueRun, budget);
  if (!valueOpen || budget.exhausted) {
    return FAIL_CLOSED;
  }
  const valueBodyEnd = scanStringBody(input, valueOpen.end, valueOpen.backslashes, valueOpen.quoteChar, limit, budget);
  if (valueBodyEnd === -1) {
    return { closeEnd: limit, kind: "redact", openEnd: valueOpen.end, terminated: false };
  }
  return {
    closeEnd: valueBodyEnd + valueOpen.backslashes + 1,
    kind: "redact",
    openEnd: valueOpen.end,
    terminated: true,
  };
}

// Bounded, linear structural scanner for Authorization/Cookie/Set-Cookie
// key/value pairs inside raw or JSON-escaped (any depth) structured
// diagnostics. Recognizes `<quoted key>` `<ws>` `:` `<ws>` `<quoted value>`
// at any escape depth and separator form (including Unicode whitespace),
// redacting only the value span and failing closed (redacting through
// end-of-input) on an unterminated recognized value.
//
// Every character inspection anywhere in the scan — the outer loop, every
// backslash run counted, every quote and whitespace lookahead — is charged
// against the one `budget` threaded through every helper, so nested helper
// work cannot escape accounting the way an outer-loop-only step counter
// could. If the budget is exhausted before the scan completes, the entire
// input is discarded and replaced by a single safe marker: a
// partially-scanned result could still contain an unredacted credential
// past the point work stopped, so exhaustion must behave identically to
// "reject the whole field," not "return what we got so far."
type OuterCandidateOutcome =
  | { chunk: string; kind: "advance"; nextIndex: number }
  | { kind: "fail-closed-budget" }
  | { kind: "fail-closed-malformed-key" };

// Handles one outer-loop candidate position that starts with a backslash,
// double, or single quote. Three outcomes:
//   - "advance": either a full structured-header value redaction, or "not a
//     match" (copy the inspected run/character through and advance past
//     it, so it is never re-examined).
//   - "fail-closed-budget": the shared budget was exhausted mid-decision.
//   - "fail-closed-malformed-key": a recognized sensitive key was found but
//     its separator/colon/value could not be parsed — per
//     matchStructuredHeaderValue's contract, this can NEVER fall back to
//     "not a match, copy through," because the credential may still be
//     present in the unrecognized syntax that follows the key.
function resolveOuterCandidate(
  input: string,
  index: number,
  ch: string,
  limit: number,
  budget: ScanBudget
): OuterCandidateOutcome {
  const run = ch === "\\" ? countBackslashRun(input, index, limit, budget) : { count: 0, end: index };
  if (budget.exhausted) {
    return { kind: "fail-closed-budget" };
  }
  const match = matchStructuredHeaderValue(input, run, limit, budget);
  if (budget.exhausted) {
    return { kind: "fail-closed-budget" };
  }
  if (match.kind === "fail-closed") {
    return { kind: "fail-closed-malformed-key" };
  }
  if (match.kind === "redact") {
    const redactedValue = match.terminated ? input.slice(match.closeEnd - 1, match.closeEnd) : "";
    return {
      chunk: `${input.slice(index, match.openEnd)}[REDACTED]${redactedValue}`,
      kind: "advance",
      nextIndex: match.closeEnd,
    };
  }
  if (ch === "\\") {
    // Not a structured header at this run: copy the whole run in one step
    // and jump past it, so this run is never re-entered.
    return { chunk: input.slice(index, run.end), kind: "advance", nextIndex: run.end };
  }
  return { chunk: ch, kind: "advance", nextIndex: index + 1 };
}

function scanAndRedactStructuredHeaders(input: string, budget: ScanBudget): string {
  const limit = input.length;
  let output = "";
  let index = 0;
  while (index < limit) {
    if (budget.consume(1)) {
      return BUDGET_EXHAUSTED_MARKER;
    }
    const ch = input.charAt(index);
    if (ch !== "\\" && ch !== '"' && ch !== "'") {
      output += ch;
      index += 1;
      continue;
    }
    const outcome = resolveOuterCandidate(input, index, ch, limit, budget);
    if (outcome.kind === "fail-closed-budget" || budget.exhausted) {
      return BUDGET_EXHAUSTED_MARKER;
    }
    if (outcome.kind === "fail-closed-malformed-key") {
      return MALFORMED_SENSITIVE_HEADER_MARKER;
    }
    output += outcome.chunk;
    index = outcome.nextIndex;
  }
  return output;
}

// Production entry point: sizes the shared budget to a fixed linear
// multiple (SCAN_BUDGET_MULTIPLIER) of the input's own length.
export function redactStructuredHeaders(input: string): string {
  return scanAndRedactStructuredHeaders(input, new ScanBudget(input.length * SCAN_BUDGET_MULTIPLIER));
}

// Test-only entry point: lets a test drive the exact same scan with a
// caller-chosen budget (in operations, not characters) so exhaustion can be
// observed deterministically — proving the budget is real and shared,
// rather than reverse-engineering SCAN_BUDGET_MULTIPLIER from input length
// or depending on wall-clock timing. Delegates to the identical scan used
// in production; nothing about the scanning logic itself differs.
export function redactStructuredHeadersWithBudget(input: string, totalOperations: number): string {
  return scanAndRedactStructuredHeaders(input, new ScanBudget(totalOperations));
}

function boundedRedactedTail(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return;
  }
  if (value.length > MAX_RAW_SCAN_LENGTH) {
    return OVERSIZED_INPUT_MARKER;
  }
  const redacted = redactStructuredHeaders(value)
    .replace(QUOTED_SENSITIVE_VALUE_PATTERN, '$1"[REDACTED]"')
    .replace(AUTHORIZATION_PATTERN, "Authorization: [REDACTED]")
    .replace(COOKIE_PATTERN, "Cookie: [REDACTED]")
    .replace(GITHUB_PAT_PATTERN, "[REDACTED]")
    .replace(SENSITIVE_URL_USERINFO_PATTERN, "$1[REDACTED]@")
    .replace(UNQUOTED_SENSITIVE_VALUE_PATTERN, "$1$2[REDACTED]")
    .replace(SENSITIVE_QUERY_PARAMETER_PATTERN, "$1[REDACTED]");
  return redacted.length > maximumLength ? redacted.slice(-maximumLength) : redacted;
}

function failureDetails(error: ReporterError | undefined, diagnosticTail: string): Record<string, string> | undefined {
  const details = {
    code: boundedRedactedTail(error?.code, MAX_FAILURE_FIELD_LENGTH),
    failure_type: boundedRedactedTail(error?.failureType, MAX_FAILURE_FIELD_LENGTH),
    message: boundedRedactedTail(error?.message, MAX_FAILURE_FIELD_LENGTH),
    stack: boundedRedactedTail(error?.stack, MAX_FAILURE_FIELD_LENGTH),
    stderr_tail: boundedRedactedTail(diagnosticTail, MAX_FAILURE_DIAGNOSTIC_LENGTH),
  };
  const present: Record<string, string> = {};
  for (const [field, value] of Object.entries(details)) {
    if (value !== undefined) {
      present[field] = value;
    }
  }
  return Object.keys(present).length > 0 ? present : undefined;
}

// Node's reporter stream is the runner's structured API. Terminal events are
// accounting evidence; all lifecycle events are presentation noise. A failure
// retains bounded, redacted runner diagnostics so a failing CI job explains
// itself without changing terminal pass/fail/skip accounting.
export default async function* accountingReporter(source: AsyncIterable<ReporterEvent>): AsyncGenerator<string> {
  const diagnostic = new DiagnosticBuffer();
  for await (const event of source) {
    const data = event.data ?? {};
    const details = data.details ?? {};
    if (event.type === "test:stderr" || event.type === "test:diagnostic") {
      if (typeof data.message === "string" && data.message.trim()) {
        // Keep chunks until terminal failure so a credential label and value
        // cannot be separated by Node's chunking or a tail boundary. Once the
        // bounded input buffer overflows, emit only a redacted overflow marker.
        const { message } = data;
        diagnostic.append(message);
      }
      continue;
    }
    if (event.type !== "test:pass" && event.type !== "test:fail") {
      continue;
    }
    const eventDetails = {
      type: details.type,
      name: data.name ?? details.name,
      skip: data.skip ?? details.skip,
      ...(event.type === "test:fail" ? { failure: failureDetails(details.error, diagnostic.take()) } : {}),
    };
    yield `${accountingEventLine({ type: event.type, details: eventDetails })}\n`;
    diagnostic.take();
  }
}
