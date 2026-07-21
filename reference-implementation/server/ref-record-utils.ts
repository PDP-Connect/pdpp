// Pure helpers used by the /_ref operator surface (ref-control.ts) for
// timestamp selection, query matching, and cursor encoding. None of
// these functions touch I/O or state; they're here in a separate
// module specifically so ref-control can stay an orchestrator and
// these utilities can be tested in isolation.

// Hoisted regexes (Biome's useTopLevelRegex rule; Node avoids
// recompiling the pattern per call).
const ISO_DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ALPHA_NUMERIC_UNICODE_RE = /[\p{L}\p{N}]/u;
const SIMPLE_WORD_QUERY_RE = /^[\p{L}\p{N}_-]+$/u;
const UNICODE_TOKEN_RE = /[\p{L}\p{N}]+/gu;
const WORD_OR_PHRASE_RE = /^[\p{L}\p{N}\s_-]+$/u;
const WHITESPACE_RUN_RE = /\s+/g;

// Stream manifests carry timestamp hints and optional coverage-policy
// declarations the reference honors for semantic-time selection and the
// accepted-coverage axis projection. The shape matches what connector
// manifests declare but stays loose — consumers of this helper only care
// about the fields they read. See `ManifestStream` in ref-control.ts for
// the full typed shape used by the coverage projection.
export interface ManifestStreamLike {
  consent_time_field?: string | null | undefined;
  /**
   * Accepted-coverage policy for the stream. Absent means `collect` (the
   * default). Other values declare the stream's absence as accepted:
   * `unsupported` | `unavailable` | `deferred` | `inventory_only`.
   * Combining with `required: true` is contradictory and degrades health.
   */
  coverage_policy?: "collect" | "deferred" | "inventory_only" | "unavailable" | "unsupported";
  cursor_field?: string | null | undefined;
  [extension: string]: unknown;
}

export interface SemanticTimestamp {
  field: string;
  value: string;
}

function uniqueFields(fields: ReadonlyArray<string | null | undefined>): string[] {
  const present = fields.filter((field): field is string => typeof field === "string" && field.length > 0);
  return Array.from(new Set(present));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function pickSemanticTimestamp(
  manifestStream: ManifestStreamLike | null | undefined,
  data: unknown
): SemanticTimestamp | null {
  if (!isRecord(data)) {
    return null;
  }
  const candidates = uniqueFields([manifestStream?.consent_time_field, manifestStream?.cursor_field]);
  for (const field of candidates) {
    const value = data[field];
    if (typeof value === "string" && value.trim()) {
      return { field, value: value.trim() };
    }
  }
  return null;
}

type DateBoundary = "exact" | "start" | "end";

function parseDateLike(value: unknown, boundary: DateBoundary = "exact"): number | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const trimmed = value.trim();
  const dateOnly = ISO_DATE_ONLY_RE.test(trimmed);
  let normalized: string;
  if (dateOnly) {
    const suffix = boundary === "end" ? "T23:59:59.999Z" : "T00:00:00.000Z";
    normalized = `${trimmed}${suffix}`;
  } else {
    normalized = trimmed;
  }
  const millis = Date.parse(normalized);
  return Number.isFinite(millis) ? millis : null;
}

export function compareTimestampValues(left: unknown, right: unknown): number {
  const leftMillis = parseDateLike(left);
  const rightMillis = parseDateLike(right);
  if (leftMillis !== null && rightMillis !== null) {
    return leftMillis - rightMillis;
  }
  return String(left ?? "").localeCompare(String(right ?? ""));
}

// True when `value` falls on the wrong side of `bound` — before the
// window's lower `start` bound, or after its upper `end` bound. `side`
// is the single axis: it selects the date-boundary suffix parseDateLike
// snaps date-only strings to (start → 00:00:00.000, end → 23:59:59.999),
// the numeric out-of-range direction (below vs above), and the matching
// lexical direction used when either operand isn't date-parseable. The
// lexical branch is the deliberate fallback for non-timestamp strings:
// same string-ordering the numeric path implies, so unparseable values
// still order consistently against the bound.
function isOutsideBound(value: string, bound: string, side: "start" | "end"): boolean {
  const valueMillis = parseDateLike(value, side);
  const boundMillis = parseDateLike(bound, side);
  if (valueMillis !== null && boundMillis !== null) {
    return side === "start" ? valueMillis < boundMillis : valueMillis > boundMillis;
  }
  return side === "start" ? String(value) < String(bound) : String(value) > String(bound);
}

export function timestampWithinWindow(
  value: unknown,
  since: string | null | undefined,
  until: string | null | undefined
): boolean {
  if (typeof value !== "string" || !value.trim()) {
    return false;
  }
  if (since && isOutsideBound(value, since, "start")) {
    return false;
  }
  if (until && isOutsideBound(value, until, "end")) {
    return false;
  }
  return true;
}

export interface ChooseDisplayTimestampInput {
  emittedAt: string;
  mode?: "native" | "emitted";
  semanticTimestamp: SemanticTimestamp | null | undefined;
}

export function chooseDisplayTimestamp({
  semanticTimestamp,
  emittedAt,
  mode = "native",
}: ChooseDisplayTimestampInput): string {
  if (mode === "native" && semanticTimestamp?.value) {
    return semanticTimestamp.value;
  }
  return emittedAt;
}

function buildSnippet(value: string, index: number, queryLength: number, radius = 60): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(value.length, index + queryLength + radius);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < value.length ? "…" : "";
  return `${prefix}${value.slice(start, end).replace(WHITESPACE_RUN_RE, " ").trim()}${suffix}`;
}

function fieldPathToString(parts: ReadonlyArray<string | number>): string {
  let result = "";
  for (const part of parts) {
    if (typeof part === "number") {
      result += `[${part}]`;
      continue;
    }
    result += result ? `.${part}` : part;
  }
  return result;
}

function isAlphaNumeric(char: string | null): boolean {
  return typeof char === "string" && ALPHA_NUMERIC_UNICODE_RE.test(char);
}

function isSimpleWordQuery(query: string): boolean {
  return SIMPLE_WORD_QUERY_RE.test(query);
}

// True when the `len`-char slice of `text` starting at `index` is not glued
// to an alphanumeric character on either side — i.e. it sits on a whole-word
// boundary. Positions before the string start / past its end count as
// boundaries (null → not alphanumeric), so a hit flush against either edge is
// a whole-word match.
function isWholeWordMatch(text: string, index: number, len: number): boolean {
  const before = index > 0 ? (text[index - 1] ?? null) : null;
  const after = index + len < text.length ? (text[index + len] ?? null) : null;
  return !(isAlphaNumeric(before) || isAlphaNumeric(after));
}

function tokenizeQuery(query: unknown): string[] {
  return String(query ?? "").match(UNICODE_TOKEN_RE) ?? [];
}

function findMatchIndex(value: string, needle: string): number {
  const lower = value.toLowerCase();
  if (!needle) {
    return -1;
  }
  if (!isSimpleWordQuery(needle)) {
    return lower.indexOf(needle);
  }

  let fromIndex = 0;
  while (fromIndex < lower.length) {
    const index = lower.indexOf(needle, fromIndex);
    if (index === -1) {
      return -1;
    }
    if (isWholeWordMatch(lower, index, needle.length)) {
      return index;
    }
    fromIndex = index + needle.length;
  }
  return -1;
}

export interface QueryMatch {
  field: string;
  snippet: string;
}

// A leaf match: `rendered` is the text searched, `snippet` is the excerpt
// to surface for it. The string branch renders the raw value and derives a
// windowed snippet around the hit; the scalar branch renders the value and
// surfaces it whole. Both share the "find hit → -1 means no match → build
// QueryMatch at this field path" shape, which lives here once.
function matchLeaf(
  rendered: string,
  needle: string,
  parts: ReadonlyArray<string | number>,
  snippet: (index: number) => string
): QueryMatch | null {
  const index = findMatchIndex(rendered, needle);
  if (index === -1) {
    return null;
  }
  return {
    field: fieldPathToString(parts),
    snippet: snippet(index),
  };
}

// Descend into a container (array or record) and return the first child that
// matches, in the order `entries` yields — array index order or
// Object.entries key order. Unbraids container-descent from leaf-matching:
// both branches share the "recurse extending the field path → return first
// non-null" shape, which lives here once.
function searchChildren(
  entries: Iterable<[string | number, unknown]>,
  needle: string,
  parts: ReadonlyArray<string | number>
): QueryMatch | null {
  for (const [key, child] of entries) {
    const match = searchValue(child, needle, [...parts, key]);
    if (match) {
      return match;
    }
  }
  return null;
}

function searchValue(value: unknown, needle: string, parts: ReadonlyArray<string | number>): QueryMatch | null {
  if (typeof value === "string") {
    return matchLeaf(value, needle, parts, (index) => buildSnippet(value, index, needle.length));
  }

  if (typeof value === "number" || typeof value === "boolean") {
    const rendered = String(value);
    return matchLeaf(rendered, needle, parts, () => rendered);
  }

  if (Array.isArray(value)) {
    return searchChildren(value.entries(), needle, parts);
  }

  if (isRecord(value)) {
    return searchChildren(Object.entries(value), needle, parts);
  }

  return null;
}

export function findQueryMatch(data: unknown, query: unknown): QueryMatch | null {
  const needle = String(query ?? "")
    .trim()
    .toLowerCase();
  if (!needle) {
    return null;
  }
  return searchValue(data, needle, []);
}

export function buildRecordSearchMatchExpression(query: unknown): string | null {
  const trimmed = String(query ?? "").trim();
  if (!trimmed) {
    return null;
  }

  const tokens = tokenizeQuery(trimmed);
  if (!tokens.length) {
    return null;
  }

  const isWordOrPhrase = WORD_OR_PHRASE_RE.test(trimmed);
  const allInformative = tokens.every((token) => token.length >= 2);
  if (!(isWordOrPhrase || allInformative)) {
    return null;
  }

  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" AND ");
}

export function encodeOffsetCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

export function decodeOffsetCursor(raw: unknown): number | null {
  if (typeof raw !== "string" || !raw) {
    return null;
  }
  try {
    const decoded: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!isRecord(decoded)) {
      return null;
    }
    const offset = decoded.offset;
    if (!Number.isInteger(offset) || (typeof offset === "number" && offset < 0)) {
      return null;
    }
    return offset as number;
  } catch {
    return null;
  }
}
