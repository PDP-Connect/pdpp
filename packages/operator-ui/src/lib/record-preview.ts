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
import {
  type DeclaredFieldRoles,
  EMPTY_DECLARED_FIELD_ROLES,
  type FieldRole,
  fieldForRole,
  hasDeclaredRoles,
} from "./declared-field-roles.ts";
import { humanizeFieldLabel } from "./field-label.ts";
import { formatDeclaredAmount } from "./record-field-format.ts";
import type { DeclaredFieldTypes, RecordKind } from "./record-kind.ts";

/** One humanized key/value row of the honest generic card (design.md §5.4). */
export interface GenericField {
  /** Humanized display label (`net_pay` → "Net pay"). LABEL-only, never a type/role signal. */
  label: string;
  /** Stable raw field key, for keys and copy-the-raw-key affordances. */
  name: string;
  /** Compact, display-ready value string. */
  value: string;
}

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
  /**
   * The honest generic key/value table (design.md §5.4): humanized declared
   * fields, present ONLY on the `generic` kind. It is NOT a guessed card — it
   * shows the record's fields as a readable table, never inferring a
   * message/money/photo shape from field or stream names. Other kinds leave
   * this absent (they carry their typed slots instead).
   */
  fields?: readonly GenericField[];
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

// Neutral number formatting for an amount-ROLE field that declares no currency TYPE.
// Locale-pinned (en-US grouping) so SSR and client agree and tests can pin it.
const NUMBER_FMT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });

/**
 * Format the value of a SPECIFIC declared-amount field (the field carrying the
 * declared `amount` role). The field's declared TYPE (e.g. `currency`,
 * `currency_milliunits`) is the ONLY gate for currency formatting + minor/milli
 * scaling. Absent a declared currency type, the value is rendered as a NEUTRAL
 * number — no `$`, no magnitude-guessed ÷100/÷1000 scaling (the SLVP honesty rule:
 * an amount-ROLE field places the number in the amount slot, but only a declared
 * currency TYPE makes it money; otherwise it is shown as the plain number it is).
 * Returns null when the field is not a finite number.
 */
function extractAmountForField(
  data: RecordData,
  field: string,
  fieldTypes?: DeclaredFieldTypes | null
): { text: string; positive: boolean } | null {
  const v = data[field];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    return null;
  }
  const declared = formatDeclaredAmount(v, fieldTypes?.[field]);
  if (declared) {
    return declared;
  }
  // No declared currency type → neutral number, NOT dollars and NOT magnitude-scaled.
  // The old `Math.abs(v) > 10_000 ? v / 1000 : v` heuristic mis-rendered a real
  // $12,001 as "$12.00"; it is deleted. `positive` still tints the slot by sign.
  return { positive: v >= 0, text: formatNeutralNumber(v) };
}

/** Render a number as a neutral, locale-grouped string (e.g. `12001` → "12,001"). */
function formatNeutralNumber(n: number): string {
  return NUMBER_FMT.format(n);
}

// NOTE: the field-name role heuristic lists (TITLE_FIELDS / BODY_FIELDS / etc.) were
// REMOVED in the Codex end-review fix. The SLVP render path no longer guesses a slot
// from field names: a typed slot is filled ONLY from a manifest-DECLARED role, and an
// undeclared record (or undeclared slot) renders the honest generic key/value card.

// A pure record-IDENTIFIER field — the record key / foreign keys / uuids. These are
// keys, not human content, so the honest generic card omits them: an `id`/`*_id`/`uuid`
// must NEVER become a row's primary line (the live `Id: <uuid>` attachments wall). This
// is value-ROLE filtering of an identifier (like the empty-collection de-noising below),
// NOT field-name guessing of MEANING — it never promotes anything, it only drops keys.
const IDENTIFIER_FIELD_RE = /^(id|uuid|guid)$|(^|_)(id|uuid|guid)$/i;

// Maximum chars for a generic value cell before truncation.
const GENERIC_VALUE_MAX = 120;
// How many key/value rows the generic card surfaces. The full table lives in
// the inspector; the card/feed-row sees a readable head, not the whole body.
const GENERIC_CARD_FIELD_CAP = 6;

/**
 * The declared-ROLE value for a card slot. When the manifest declares which field
 * fills `role`, that field's value is used (a declaration, NEVER a guess); otherwise
 * `undefined` and the slot stays absent (the caller does NOT fall back to a field-name
 * guess — that is the whole point). This is the one consumption point through which
 * the live `x_pdpp_role` vocabulary (the assembler populates `DeclaredFieldRoles` from
 * `field_capabilities[].role`) renders typed cards with ZERO further client change.
 */
function roleValue(
  data: RecordData,
  roles: DeclaredFieldRoles | undefined,
  role: FieldRole,
  max: number
): string | undefined {
  if (!roles) {
    return;
  }
  const field = fieldForRole(roles, role);
  return field ? str(data[field], max) : undefined;
}

/** Compact a single field value for a generic key/value cell. */
function genericValue(v: unknown): string | undefined {
  if (v === null || v === undefined) {
    return;
  }
  if (typeof v === "boolean") {
    return v ? "true" : "false";
  }
  if (typeof v === "number") {
    return Number.isFinite(v) ? String(v) : undefined;
  }
  // De-noise EMPTY collections (e.g. `cc: []`, `tool_calls: {}`): an empty array/object
  // carries no information, so it must not pollute the generic key/value table (it was
  // surfacing as `Cc: []`). This is value-SHAPE readability filtering of honest declared
  // data — NOT title promotion or field-name guessing (Codex record-presentation gate).
  if (Array.isArray(v) && v.length === 0) {
    return;
  }
  if (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0) {
    return;
  }
  return str(v, GENERIC_VALUE_MAX);
}

// 24h or 12h clock fragment, optionally a range. Locale-pinned UTC formatting
// so SSR and client agree and tests can pin it.
const TIME_FMT = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
});

/**
 * Format the time value of the DECLARED `event-time` field. Never guesses the time
 * from `start`/`end`/`when` field names (Codex end-review P0: event time is the
 * declared event-time role, not a name guess). Returns undefined when the field is
 * not a parseable instant.
 */
function extractEventTimeFromField(data: RecordData, field: string): string | undefined {
  const v = data[field];
  const ms = typeof v === "string" || typeof v === "number" ? Date.parse(String(v)) : Number.NaN;
  if (Number.isNaN(ms)) {
    return;
  }
  return TIME_FMT.format(new Date(ms));
}

function buildMoneyPreview(
  data: RecordData,
  fieldTypes?: DeclaredFieldTypes | null,
  roles?: DeclaredFieldRoles
): RecordPreview | null {
  // The amount SLOT is filled by a declared `amount` ROLE — never because a field
  // is currency-TYPED (Codex constraint #3: a currency does not become the amount
  // because it is currency). TYPE then gates the FORMATTING of that declared field.
  const amountField = roles ? fieldForRole(roles, "amount") : undefined;
  const amt = amountField ? extractAmountForField(data, amountField, fieldTypes) : undefined;
  // Title/body come from declared roles only (this builder runs only once a role is
  // declared; no field-name guess for the typed slots — the generic fallback handles
  // undeclared records).
  const title = roleValue(data, roles, "primary-title", 60);
  const body = roleValue(data, roles, "secondary", 60);
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

// The role-backed typed builders fill EVERY slot from a DECLARED role only — no
// `?? firstString(...)` heuristic fallback for undeclared slots (Codex end-review P0:
// a partial declaration must not re-enable field-name guessing for the rest of the
// card). A slot with no declared role stays absent; the generic key/value table (via
// buildGenericPreview's `fields`) still shows the undeclared fields. When a builder
// can form no meaningful role-backed slot, it returns null and the dispatcher falls
// to the honest generic card.

function buildMessagePreview(data: RecordData, roles?: DeclaredFieldRoles): RecordPreview | null {
  const author = roleValue(data, roles, "actor", 32);
  const title = roleValue(data, roles, "primary-title", 80);
  const body = roleValue(data, roles, "secondary", 220);
  if (!(author || body || title)) {
    return null;
  }
  return { author, body, kind: "message", title };
}

function buildEventPreview(data: RecordData, roles?: DeclaredFieldRoles): RecordPreview | null {
  const title = roleValue(data, roles, "primary-title", 80);
  // Event time only from the declared `event-time` field — never guessed from
  // `start`/`end`/etc.
  const eventTimeField = roles ? fieldForRole(roles, "event-time") : undefined;
  const eventTime = eventTimeField ? extractEventTimeFromField(data, eventTimeField) : undefined;
  const body = roleValue(data, roles, "secondary", 80);
  if (!(title || eventTime)) {
    return null;
  }
  // A declared-but-EMPTY primary-title (e.g. a codex/messages record whose
  // `content` is blank but which has an event-time, so it stayed kind=event) must
  // render the honest "(no content)" placeholder — NOT fall through title-less to
  // the row's identity-key fallback (the bare-UUID rows). Mirror the message path's
  // emptyDeclaredContentPreview placeholder. (event-time on `messages` is a broad
  // convention across 7 connectors, so the empty-content case is handled HERE, not
  // by re-authoring every manifest.)
  if (!title && roles && fieldForRole(roles, "primary-title")) {
    const titleField = fieldForRole(roles, "primary-title");
    const placeholder = titleField ? `(no ${humanizeFieldLabel(titleField).toLowerCase()})` : undefined;
    return { body, eventTime, kind: "event", title: placeholder };
  }
  return { body, eventTime, kind: "event", title };
}

function buildTitledPreview(data: RecordData, roles?: DeclaredFieldRoles): RecordPreview | null {
  const title = roleValue(data, roles, "primary-title", 90);
  const body = roleValue(data, roles, "secondary", 160);
  // A declared `actor` surfaces even on a titled card — it is honest declared content
  // (the author/attribution), so a role-authored stream that declares an actor but is
  // NOT a message-typed stream (e.g. chatgpt/messages, which is `titled` now that the
  // overbroad actor→message rule is gone) still shows its author. No actor → absent.
  const author = roleValue(data, roles, "actor", 32);
  if (!title) {
    return null;
  }
  return { author, body: body && body !== title ? body : undefined, kind: "titled", title };
}

/**
 * Build the HONEST GENERIC card (design.md §5.4) for an undeclared record: a
 * readable key/value table of the record's declared fields with humanized
 * labels — NEVER a guessed message/money/photo card. This is the
 * reference-honest path for any record whose roles are undeclared and whose
 * shape no heuristic confidently classified. Prior art: Datadog renders
 * arbitrary structured logs as a generic key/value attribute table; Google My
 * Activity / GitHub render heterogeneous items through a generic base-schema.
 *
 * It consumes `DeclaredFieldRoles` FIRST: if a manifest declares a title /
 * body, the card surfaces them as `title`/`body` (the typed-slot seam working
 * for the generic kind too); the remaining fields fill the humanized key/value
 * table. With NO declared roles (today's universal case) every field goes to
 * the table and nothing is promoted to a title — two same-type fields stay in
 * the table because there is no honest way to say which is the title.
 */
/**
 * A declared stream (has x_pdpp_role) whose declared content fields (title AND
 * body) are BOTH empty for this record — e.g. a gmail/messages row whose
 * `subject`/`snippet` were not collected. It renders a minimal honest placeholder
 * from the declared title field's NAME (e.g. "(no subject)") plus any declared
 * actor — it must NEVER fall through to dumping the record's UNDECLARED operational
 * metadata (labels, is_seen, is_draft, flags) as a key/value wall, which reads as a
 * dev console. (SLVP honesty: declared-but-empty ≠ "show me everything else".)
 */
function emptyDeclaredContentPreview(data: RecordData, roles: DeclaredFieldRoles): RecordPreview | null {
  const author = roleValue(data, roles, "actor", 32);
  const titleField = fieldForRole(roles, "primary-title");
  const placeholder = titleField ? `(no ${humanizeFieldLabel(titleField).toLowerCase()})` : undefined;
  if (!(placeholder || author)) {
    return null;
  }
  return { author, kind: "generic", title: placeholder };
}

/**
 * The honest-generic key/value table: the record's humanized fields, EXCLUDING
 * the role-promoted title/body (`promoted`) and pure identifier fields (id/*_id/
 * uuid — record keys, not human content). Capped at `GENERIC_CARD_FIELD_CAP`.
 */
function humanizedGenericFields(data: RecordData, promoted: ReadonlySet<string>): GenericField[] {
  const fields: GenericField[] = [];
  for (const [name, raw] of Object.entries(data)) {
    if (promoted.has(name) || fields.length >= GENERIC_CARD_FIELD_CAP || IDENTIFIER_FIELD_RE.test(name)) {
      continue;
    }
    const value = genericValue(raw);
    if (value === undefined) {
      continue;
    }
    fields.push({ label: humanizeFieldLabel(name), name, value });
  }
  return fields;
}

function buildGenericPreview(data: RecordData, roles?: DeclaredFieldRoles): RecordPreview | null {
  // Declared roles only — NEVER the field-name heuristic. An undeclared generic
  // record must not borrow the typed builders' name lists, or it would guess a
  // title the way the heuristic does. With no declaration, title/body stay absent.
  const title = roleValue(data, roles, "primary-title", 90);
  const body = roleValue(data, roles, "secondary", 160);
  const promoted = new Set<string>();
  if (roles) {
    const titleField = fieldForRole(roles, "primary-title");
    const bodyField = fieldForRole(roles, "secondary");
    if (title && titleField) {
      promoted.add(titleField);
    }
    if (body && bodyField) {
      promoted.add(bodyField);
    }
  }
  // EMPTY-DECLARED-CONTENT GUARD (extracted): a declared stream whose title AND
  // body are empty for THIS record renders a minimal honest placeholder, never the
  // undeclared operational-field dump. See `emptyDeclaredContentPreview`.
  if (roles !== undefined && hasDeclaredRoles(roles) && !(title || body)) {
    return emptyDeclaredContentPreview(data, roles);
  }
  const fields = humanizedGenericFields(data, promoted);
  if (!(title || body || fields.length > 0)) {
    return null;
  }
  return {
    body: body && body !== title ? body : undefined,
    fields: fields.length > 0 ? fields : undefined,
    kind: "generic",
    title,
  };
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
 * `roles` is the optional declared presentation-ROLE map (`DeclaredFieldRoles`,
 * design.md §5.2). Every builder consults it BEFORE its last-resort field-name
 * heuristic, so a manifest-declared title/body/actor wins by declaration. It
 * defaults to empty for a stream that declares no roles (the `x_pdpp_role`
 * vocabulary is live, but most streams declare nothing), which is exactly why
 * undeclared records take the honest generic key/value card rather than a
 * guessed typed card.
 *
 * For a `generic` kind this now returns the honest key/value card instead of
 * null; the card renderer shows a readable table, never the one-line summary's
 * guessed shape. Returns null only when there is no body.
 */
export function buildRecordPreview(
  kind: RecordKind,
  data: RecordData | null,
  fieldTypes?: DeclaredFieldTypes | null,
  roles: DeclaredFieldRoles = EMPTY_DECLARED_FIELD_ROLES
): RecordPreview | null {
  if (!data) {
    return null;
  }
  // THE SLVP HONESTY GATE (design.md §5.4; Codex end-review P0): a TYPED card slot
  // (title / body / actor / amount / media) renders ONLY from a manifest-DECLARED
  // role. When a stream declares NO roles, render the honest generic key/value card
  // REGARDLESS of the heuristic `kind` — a stream named `messages`/`transactions`/
  // `repositories` must NOT be guessed into a typed message/money/titled card from
  // its field/stream names. The heuristic `kind` only chooses WHICH typed builder
  // dispatches AFTER a declaration exists; with no declaration there is no typed card.
  if (!hasDeclaredRoles(roles)) {
    return buildGenericPreview(data, roles);
  }
  // Roles are declared → a role-backed typed card. EVERY slot is filled from a
  // declared role only (the typed builders no longer guess undeclared slots from
  // field names — Codex end-review P0: a partial declaration must not re-enable the
  // heuristic). reader / location / activity have no role-backed form, so they
  // render the honest generic card rather than guessing stats/coordinates/body. If a
  // role-backed builder can form no meaningful slot, fall to the generic card (never
  // drop the record).
  const typed = buildRoleBackedPreview(kind, data, fieldTypes, roles);
  return typed ?? buildGenericPreview(data, roles);
}

function buildRoleBackedPreview(
  kind: RecordKind,
  data: RecordData,
  fieldTypes: DeclaredFieldTypes | null | undefined,
  roles: DeclaredFieldRoles
): RecordPreview | null {
  switch (kind) {
    case "money":
      return buildMoneyPreview(data, fieldTypes, roles);
    case "message":
      return buildMessagePreview(data, roles);
    case "event":
      return buildEventPreview(data, roles);
    case "titled":
      return buildTitledPreview(data, roles);
    default:
      // activity / reader / location / generic: no role-backed typed form → generic.
      return null;
  }
}

// ─── Row-primary / row-secondary projection (W1: content-first rows) ──────────
//
// The Explore FEED ROW shows a single primary content line + a quieter secondary
// snippet. Both are projected from the SAME honest `RecordPreview` the card and
// inspector consume — so a row is never richer (or more guessed) than the card.
//
// THE RL1 HONESTY BOUNDARY (plan 2026-06-22 RL1): the row primary is derived in a
// STRICT source order, all of which is already-honest preview content:
//   1. declared role-backed slots — primary-title, then body/secondary, then the
//      formatted amount, then the actor (whichever the record's DECLARED roles
//      filled; `buildRecordPreview` only fills these from a manifest declaration);
//   2. else the first HONEST GENERIC field — a humanized "label: value" pair pulled
//      from a field the record actually DECLARES (`preview.fields[0]`), never a
//      field-name guess (the generic card promotes nothing to a title without a role);
//   3. else a neutral generic fallback supplied by the caller (the record id / "Record").
//
// It MUST NEVER fall back to a connector-specific stream name, a record-kind noun,
// a timeline-summary, or `entry.summary` — those are the forbidden inference paths.
// (A search-hit snippet, which is real matched record text, is handled by the caller
// and passed in as `fallback` when there is no body-backed preview.)

/** Compact a generic key/value field into a single readable "Label: value" line. */
function genericFieldLine(field: GenericField): string {
  return `${field.label}: ${field.value}`;
}

/**
 * The honest ROW-PRIMARY content line for a feed row, in the RL1 source order.
 *
 * `preview` is the record's `buildRecordPreview` output (honest, declared-roles-only
 * for typed slots; declared-fields-only for the generic table) or `null` when the
 * lens holds no body. `fallback` is a NEUTRAL last resort the caller supplies (the
 * record id, or a real search-hit snippet) — NEVER a stream name or timeline summary.
 *
 * Returns the first non-empty source in order; falls to `fallback` only when the
 * preview yields no declared content, and to "Record" only when even `fallback` is empty.
 */
export function rowPrimary(preview: RecordPreview | null, fallback?: string | null): string {
  const declared = preview?.title ?? preview?.body ?? preview?.amount ?? preview?.author;
  if (declared) {
    return declared;
  }
  const firstField = preview?.fields?.[0];
  if (firstField) {
    return genericFieldLine(firstField);
  }
  const trimmed = fallback?.trim();
  return trimmed || "Record";
}

/**
 * The quieter ROW-SECONDARY snippet that rides alongside the primary — the NEXT
 * honest content slot that is not already the primary, so the row never repeats
 * itself. Same RL1 boundary: only declared preview content (and the generic table's
 * remaining humanized fields), never a stream/kind/summary inference.
 *
 * Returns `undefined` when there is no distinct secondary content to show.
 */
export function rowSecondary(preview: RecordPreview | null): string | undefined {
  if (!preview) {
    return;
  }
  const primary = rowPrimary(preview);
  // Body, then amount, then author — whichever distinct declared slot is not the primary.
  for (const slot of [preview.body, preview.amount, preview.author]) {
    if (slot && slot !== primary) {
      return slot;
    }
  }
  // Generic table: the remaining humanized fields (skip whichever became the primary).
  const fields = preview.fields ?? [];
  const rest: string[] = [];
  for (const field of fields) {
    const line = genericFieldLine(field);
    if (line === primary) {
      continue;
    }
    rest.push(line);
    if (rest.length >= 2) {
      break;
    }
  }
  return rest.length > 0 ? rest.join(" · ") : undefined;
}
