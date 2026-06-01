/**
 * Kind-aware structured preview for the Explorer feed.
 *
 * `record-kind.ts` already derives a coarse presentation `kind` (message /
 * money / event / titled / generic) from the `connector::stream` pair and the
 * record body's field names, and `timeline-summaries.ts` derives a one-line
 * `summary`. Both are honest, hand-picked reads — not protocol claims.
 *
 * This module goes one small step further for the lenses that hold the record
 * body (recency and time-range): it pulls a handful of kind-specific preview
 * fields out of the same body so the Explorer feed can render type-aware cards
 * (a money row leads with its amount, a message row leads with author + body,
 * an event row leads with its time) instead of a single undifferentiated line.
 *
 * Like `kind` and `summary`, every field here is:
 *
 *   - derived only from data the feed already has in hand,
 *   - presentation metadata only — never written back, never sent to the
 *     resource server, never treated as a manifest field,
 *   - degraded to absent (and the card falls back to the one-line summary)
 *     whenever the body is missing (search hits) or the signal is not present.
 *
 * It deliberately does NOT introduce any new field schema, capability lookup,
 * or backend read. When the public read contract grows a typed `field.type` /
 * `field_capabilities` consumer, this heuristic extraction is the seam that a
 * declared-schema dispatch would replace.
 */
import type { DeclaredFieldTypes, RecordKind } from "./record-kind.ts";

/**
 * A small, presentation-only structured read of a record body. Every field is
 * optional: the renderer shows what is present and falls back to the one-line
 * summary for whatever is absent. `kind` mirrors the row's classified kind so
 * the card layout can be chosen without re-deriving it.
 */
export interface RecordPreview {
  /** Formatted amount for money rows, e.g. "-$12.45". */
  amount?: string;
  /** True when the amount is a credit / positive value (tints the card). */
  amountPositive?: boolean;
  /** Sender / author / role for message rows. */
  author?: string;
  /** Secondary body text: message content, memo, location, description. */
  body?: string;
  /** Pre-formatted time-of-day or range for event rows, e.g. "2:00 PM". */
  eventTime?: string;
  kind: RecordKind;
  /** Primary line: subject, title, payee, event name, …. */
  title?: string;
}

type RecordData = Record<string, unknown>;

function str(v: unknown, max: number): string | undefined {
  if (v === null || v === undefined) {
    return;
  }
  const s = (typeof v === "string" ? v : JSON.stringify(v)).replace(/\s+/g, " ").trim();
  if (!s) {
    return;
  }
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function firstString(data: RecordData, fields: readonly string[], max: number): string | undefined {
  for (const f of fields) {
    const v = str(data[f], max);
    if (v) {
      return v;
    }
  }
  return;
}

// A numeric field whose name ends in `cents` is an unambiguous cents amount.
const CENTS_FIELD_RE = /_cents$|^cents$/;

// Declared presentation types (from `field_capabilities[].type`) that denote a
// monetary value carried in MINOR units — i.e. integer cents. `currency` is the
// vocabulary the pilot manifests use (e.g. chase `amount`, documented as
// "signed amount in cents"); the explicit `*_minor_units` / `cents` aliases
// future-proof the same intent. A field with one of these declared types is
// formatted as cents (÷100), independent of its magnitude — which is what makes
// chase's small `-1245` render as `-$12.45` instead of being mistaken for whole
// dollars by the magnitude heuristic below.
const MINOR_UNITS_TYPE_RE = /^(currency|currency_minor_units|minor_units|cents)$/;
// Declared types denoting MILLI units (thousandths), e.g. YNAB-style amounts.
// No pilot manifest declares this today, but honoring it lets a connector state
// its unit explicitly instead of relying on the magnitude heuristic.
const MILLI_UNITS_TYPE_RE = /^(currency_milliunits|milliunits|milli_units)$/;

function normalizeType(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function formatDollars(n: number): { text: string; positive: boolean } {
  const positive = n >= 0;
  const sign = positive ? "" : "-";
  return { text: `${sign}$${Math.abs(n).toFixed(2)}`, positive };
}

/**
 * Pull a formatted money amount from the body.
 *
 * Unit resolution for a bare `amount` field, in precedence order:
 *   1. A DECLARED presentation type wins. `field_capabilities[].type` of
 *      `currency` (the pilot vocabulary) means minor units → cents (÷100);
 *      a declared `*_milliunits` type means thousandths (÷1000). This is why
 *      live chase `amount: -1245` (declared `currency`, documented cents)
 *      renders `-$12.45` rather than being read as whole dollars.
 *   2. With NO declared type, fall back to the legacy magnitude heuristic the
 *      one-line `summarize()` still uses: |amount| > 10k is treated as
 *      YNAB-style milliunits, otherwise whole dollars. This preserves the
 *      sandbox/YNAB behavior tests rely on for un-annotated manifests.
 *
 * Any `*_cents` field is always unambiguous cents. Returns null when no
 * amount-shaped field is present.
 */
function extractAmount(
  data: RecordData,
  fieldTypes?: DeclaredFieldTypes | null
): { text: string; positive: boolean } | null {
  if (typeof data.amount === "number") {
    const declared = normalizeType(fieldTypes?.amount);
    if (declared && MINOR_UNITS_TYPE_RE.test(declared)) {
      return formatDollars(data.amount / 100);
    }
    if (declared && MILLI_UNITS_TYPE_RE.test(declared)) {
      return formatDollars(data.amount / 1000);
    }
    // No declared unit: keep the legacy magnitude heuristic.
    const n = Math.abs(data.amount) > 10_000 ? data.amount / 1000 : data.amount;
    return formatDollars(n);
  }
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === "number" && CENTS_FIELD_RE.test(k)) {
      return formatDollars(v / 100);
    }
  }
  return null;
}

const TITLE_FIELDS = [
  "title",
  "subject",
  "name",
  "merchant",
  "payee_name",
  "payee",
  "provider_name",
  "employer",
  "full_name",
  "description",
] as const;
const AUTHOR_FIELDS = ["from", "sender", "author", "author_role", "role", "username", "user"] as const;
const BODY_FIELDS = ["content", "text", "message", "body", "snippet", "memo", "purpose", "topic"] as const;
const LOCATION_FIELDS = ["location", "venue", "place", "address"] as const;

// 24h or 12h clock fragment, optionally a range. Locale-pinned UTC formatting
// so SSR and client agree and tests can pin it.
const TIME_FMT = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
});

function extractEventTime(data: RecordData): string | undefined {
  const start = data.start ?? data.start_time ?? data.starts_at ?? data.start_at ?? data.when;
  const ms = typeof start === "string" || typeof start === "number" ? Date.parse(String(start)) : Number.NaN;
  if (Number.isNaN(ms)) {
    return;
  }
  const startLabel = TIME_FMT.format(new Date(ms));
  const end = data.end ?? data.end_time ?? data.ends_at ?? data.end_at;
  const endMs = typeof end === "string" || typeof end === "number" ? Date.parse(String(end)) : Number.NaN;
  if (!Number.isNaN(endMs) && endMs > ms) {
    return `${startLabel} – ${TIME_FMT.format(new Date(endMs))}`;
  }
  return startLabel;
}

function buildMoneyPreview(data: RecordData, fieldTypes?: DeclaredFieldTypes | null): RecordPreview | null {
  const amt = extractAmount(data, fieldTypes);
  // `name` covers chase, whose payee is carried in `name` (declared `text`);
  // ordered after the more specific payee/merchant fields so they still win.
  const title = firstString(data, ["merchant", "payee_name", "payee", "name", "description", "memo", "category"], 60);
  const body = firstString(data, ["memo", "category_name", "category", "note"], 60);
  if (!(amt || title)) {
    return null;
  }
  return {
    amount: amt?.text,
    amountPositive: amt?.positive,
    body: body && body !== title ? body : undefined,
    kind: "money",
    title,
  };
}

function buildMessagePreview(data: RecordData): RecordPreview | null {
  const author = firstString(data, AUTHOR_FIELDS, 32);
  const title = firstString(data, ["subject"], 80);
  const body = firstString(data, BODY_FIELDS, 220);
  if (!(author || body || title)) {
    return null;
  }
  return { author, body, kind: "message", title };
}

function buildEventPreview(data: RecordData): RecordPreview | null {
  const title = firstString(data, ["title", "name", "subject", "summary"], 80);
  const eventTime = extractEventTime(data);
  const body = firstString(data, LOCATION_FIELDS, 80);
  if (!(title || eventTime)) {
    return null;
  }
  return { body, eventTime, kind: "event", title };
}

function buildTitledPreview(data: RecordData): RecordPreview | null {
  const title = firstString(data, TITLE_FIELDS, 90);
  const body = firstString(data, [...BODY_FIELDS, "summary"], 160);
  if (!title) {
    return null;
  }
  return { body: body && body !== title ? body : undefined, kind: "titled", title };
}

/**
 * Build the kind-specific preview for a feed row.
 *
 * `data` is the record body when the lens has it (recency / time-range) and
 * `null` for search hits, which carry only a snippet.
 *
 * `fieldTypes` is the optional declared presentation-type map for the stream
 * (`field_capabilities[].type`, sourced from the manifest). Only the money
 * builder consults it today — to resolve a bare `amount`'s unit from its
 * declared type (e.g. chase `amount: currency` → cents) instead of guessing
 * from magnitude. It is presentation metadata only; absent or unrecognized
 * types leave every builder on its existing heuristic.
 *
 * Returns null when there is no body or nothing kind-distinct could be
 * extracted, in which case the card falls back to the one-line summary.
 */
export function buildRecordPreview(
  kind: RecordKind,
  data: RecordData | null,
  fieldTypes?: DeclaredFieldTypes | null
): RecordPreview | null {
  if (!data) {
    return null;
  }
  switch (kind) {
    case "money":
      return buildMoneyPreview(data, fieldTypes);
    case "message":
      return buildMessagePreview(data);
    case "event":
      return buildEventPreview(data);
    case "titled":
      return buildTitledPreview(data);
    default:
      return null;
  }
}
