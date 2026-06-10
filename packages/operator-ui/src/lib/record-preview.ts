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
 * The same seam serves the activity (stat strip), reader (long body excerpt),
 * and location (coordinate pair) kinds — each pulls only fields already in the
 * body.
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
import { formatDeclaredAmount } from "./record-field-format.ts";
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
  /** Formatted coordinate pair for location rows, e.g. "37.7749, -122.4194". */
  coordinates?: string;
  /** Pre-formatted time-of-day or range for event rows, e.g. "2:00 PM". */
  eventTime?: string;
  kind: RecordKind;
  /**
   * Labelled stat chips for activity rows, e.g. `[{value:"5.2 km",label:"distance"}]`.
   * Already formatted for display; the renderer lays them out as a stat strip.
   */
  stats?: readonly { label: string; value: string }[];
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
    // A DECLARED monetary unit wins (chase `amount: currency` → cents).
    const declared = formatDeclaredAmount(data.amount, fieldTypes?.amount);
    if (declared) {
      return declared;
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

// Reader rows lead with a title and a longer clamped body excerpt than the
// other kinds, since the body IS the content (an article, issue, or note).
const READER_BODY_FIELDS = ["body", "content", "article", "text", "markdown", "summary", "snippet"] as const;
const READER_TITLE_FIELDS = ["title", "subject", "name", "headline"] as const;

function buildReaderPreview(data: RecordData): RecordPreview | null {
  const title = firstString(data, READER_TITLE_FIELDS, 90);
  const author = firstString(data, AUTHOR_FIELDS, 32);
  const body = firstString(data, READER_BODY_FIELDS, 280);
  if (!(title || body)) {
    return null;
  }
  return { author, body: body && body !== title ? body : undefined, kind: "reader", title };
}

// Location rows lead with a place name and a precise coordinate pair, mirroring
// the designer's LocationCard (title + monospaced lat,lng).
const LAT_FIELDS = ["lat", "latitude"] as const;
const LNG_FIELDS = ["lng", "lon", "long", "longitude"] as const;

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) {
    return v;
  }
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return;
}

function firstNum(data: RecordData, fields: readonly string[]): number | undefined {
  for (const f of fields) {
    const n = num(data[f]);
    if (n !== undefined) {
      return n;
    }
  }
  return;
}

function buildLocationPreview(data: RecordData): RecordPreview | null {
  const title = firstString(data, ["title", "caption", "name", "place", "venue", "address"], 80);
  const lat = firstNum(data, LAT_FIELDS);
  const lng = firstNum(data, LNG_FIELDS);
  const coordinates = lat !== undefined && lng !== undefined ? `${lat.toFixed(4)}, ${lng.toFixed(4)}` : undefined;
  if (!(title || coordinates)) {
    return null;
  }
  return { coordinates, kind: "location", title: title ?? "Location" };
}

// Activity stats. `distance` is assumed to be meters (the common connector
// unit, e.g. Strava); `duration`/`elapsed` seconds. Values already carrying a
// `*_m`/`_seconds` suffix are treated the same. Formatting is locale-neutral so
// SSR and client agree and tests can pin it.
function fmtDistanceMeters(m: number): string {
  if (m >= 1000) {
    return `${(m / 1000).toFixed(m >= 10_000 ? 0 : 1)} km`;
  }
  return `${Math.round(m)} m`;
}

function fmtDurationSeconds(s: number): string {
  const total = Math.round(s);
  const h = Math.floor(total / 3600);
  const min = Math.floor((total % 3600) / 60);
  if (h > 0) {
    return `${h}h ${min}m`;
  }
  const sec = total % 60;
  return min > 0 ? `${min}m ${sec}s` : `${sec}s`;
}

const ACTIVITY_TITLE_FIELDS = ["title", "name", "type", "activity_type", "sport"] as const;

function buildActivityPreview(data: RecordData): RecordPreview | null {
  const title = firstString(data, ACTIVITY_TITLE_FIELDS, 70);
  const stats: Array<{ label: string; value: string }> = [];
  const distance = firstNum(data, ["distance", "distance_m"]);
  if (distance !== undefined) {
    stats.push({ label: "distance", value: fmtDistanceMeters(distance) });
  }
  const duration = firstNum(data, ["duration", "duration_seconds", "elapsed", "elapsed_time"]);
  if (duration !== undefined) {
    stats.push({ label: "duration", value: fmtDurationSeconds(duration) });
  }
  const elevation = firstNum(data, ["elevation", "elev_gain", "elevation_gain"]);
  if (elevation !== undefined) {
    stats.push({ label: "elevation", value: `${Math.round(elevation)} m` });
  }
  const steps = firstNum(data, ["steps"]);
  if (steps !== undefined && stats.length < 3) {
    stats.push({ label: "steps", value: steps.toLocaleString("en-US") });
  }
  // Sleep/score-style activities: surface a lone score when no motion stat fit.
  if (stats.length === 0) {
    const score = firstNum(data, ["score", "value", "rating"]);
    if (score !== undefined) {
      stats.push({ label: "score", value: String(score) });
    }
  }
  if (!(title || stats.length)) {
    return null;
  }
  return { kind: "activity", stats: stats.length ? stats : undefined, title: title ?? "Activity" };
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
    case "activity":
      return buildActivityPreview(data);
    case "reader":
      return buildReaderPreview(data);
    case "location":
      return buildLocationPreview(data);
    case "titled":
      return buildTitledPreview(data);
    default:
      return null;
  }
}
