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

// Stream manifests carry two timestamp hints the reference honors
// when picking a record's "semantic" (emitted by the source) time:
// consent_time_field is the primary, cursor_field is the fallback.
// The structural shape matches what connector manifests declare but
// stays loose (consumers of this helper only care about these two
// fields).
export interface ManifestStreamLike {
  consent_time_field?: string | null | undefined;
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

export function timestampWithinWindow(
  value: unknown,
  since: string | null | undefined,
  until: string | null | undefined
): boolean {
  if (typeof value !== "string" || !value.trim()) {
    return false;
  }
  if (since) {
    const valueMillis = parseDateLike(value, "start");
    const sinceMillis = parseDateLike(since, "start");
    if (valueMillis !== null && sinceMillis !== null) {
      if (valueMillis < sinceMillis) {
        return false;
      }
    } else if (String(value) < String(since)) {
      return false;
    }
  }
  if (until) {
    const valueMillis = parseDateLike(value, "end");
    const untilMillis = parseDateLike(until, "end");
    if (valueMillis !== null && untilMillis !== null) {
      if (valueMillis > untilMillis) {
        return false;
      }
    } else if (String(value) > String(until)) {
      return false;
    }
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
    const before = index > 0 ? (lower[index - 1] ?? null) : null;
    const after = index + needle.length < lower.length ? (lower[index + needle.length] ?? null) : null;
    if (!(isAlphaNumeric(before) || isAlphaNumeric(after))) {
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

function searchValue(value: unknown, needle: string, parts: ReadonlyArray<string | number>): QueryMatch | null {
  if (typeof value === "string") {
    const index = findMatchIndex(value, needle);
    if (index === -1) {
      return null;
    }
    return {
      field: fieldPathToString(parts),
      snippet: buildSnippet(value, index, needle.length),
    };
  }

  if (typeof value === "number" || typeof value === "boolean") {
    const rendered = String(value);
    const index = findMatchIndex(rendered, needle);
    if (index === -1) {
      return null;
    }
    return {
      field: fieldPathToString(parts),
      snippet: rendered,
    };
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const match = searchValue(value[i], needle, [...parts, i]);
      if (match) {
        return match;
      }
    }
    return null;
  }

  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      const match = searchValue(child, needle, [...parts, key]);
      if (match) {
        return match;
      }
    }
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
