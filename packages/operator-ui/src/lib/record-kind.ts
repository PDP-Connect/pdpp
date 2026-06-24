/**
 * Record-kind classification for the Explorer feed.
 *
 * The designer's Explorer dispatched type-aware cards (message / money /
 * event / activity / reader / location / titled / generic) from per-field
 * schema metadata. The reference's
 * public read contract now carries an optional declared presentation `type`
 * on each `field_capabilities` entry (sourced from the manifest's
 * `x_pdpp_type` schema extension or its sandbox-shaped `fields[]` /
 * `schema.fields[]` declarations). When those declared types are present we
 * dispatch the card from them — a declared signal, not a guess.
 *
 * When declared types are absent (the current shape for every manifest that
 * has not yet been annotated), we fall back to the original heuristic: a
 * coarse `kind` derived from signals the feed already has on every row — the
 * `connector::stream` pair and, when the record body is in hand (recency and
 * time-range lenses), its field names. This is the same class of heuristic
 * the one-line `summarize()` table uses: a hand-picked "what is this record"
 * read, not a protocol claim. It degrades to `generic` whenever the signals
 * are absent (e.g. search hits, which carry only a snippet), so the row never
 * over-promises a shape it cannot see.
 *
 * `kind` is presentation metadata only. It is never written back, never sent
 * to the resource server, and never treated as a manifest field. The declared
 * type is consumed read-only as a preferred dispatch signal; it never alters
 * filter, grant, or retrieval semantics.
 */

import type { DeclaredFieldRoles } from "./declared-field-roles.ts";

export type RecordKind = "message" | "money" | "event" | "activity" | "reader" | "location" | "titled" | "generic";

export interface RecordKindDescriptor {
  kind: RecordKind;
  /** Short eyebrow-style label rendered as the row's kind tag. */
  label: string;
}

const KIND_LABELS: Record<RecordKind, string> = {
  message: "message",
  money: "money",
  event: "event",
  activity: "activity",
  reader: "read",
  location: "place",
  titled: "item",
  generic: "record",
};

// NOTE: the stream-name / field-name guessing engine (MESSAGE_STREAM_RE, MONEY_FIELD_RE,
// LAT/LNG_FIELD_RE, ACTIVITY_STAT_RE, LONG_BODY_RE, hasField, classifyByStreamName /
// StrongField / WeakField / refineByBody) was DELETED. `kind` is now derived SOLELY from
// declared `x_pdpp_type` signals (classifyByDeclaredTypes). An undeclared stream is
// `generic` with a neutral glyph — never name-guessed. This makes the kind glyph uniform
// with the content honesty gate: every presentation fact is manifest-authored or honestly
// generic, and `reader` (which required measuring a long body) folds into titled/generic.

/**
 * A map of declared field name → declared presentation `type`, taken from the
 * stream's `field_capabilities[].type` (i.e. the manifest's declared types).
 * Presentation-only and read-only; only field names that carry a declared
 * type appear here.
 */
export type DeclaredFieldTypes = Readonly<Record<string, string>>;

// Declared-type signals. Matched case-insensitively against a normalized
// declared `type` string. These intentionally mirror the small vocabulary the
// sandbox demo manifests already encode (`currency_minor_units`, `timestamp`,
// `person`, `text`, `blob`, …) and the read-contract's declared `type`; an
// unrecognized declared type simply contributes no signal and the row falls
// through to the field-name heuristic.
const MONEY_TYPE_RE = /^(currency|currency_minor_units|money|monetary|amount|price|cents)$/;
const TEMPORAL_TYPE_RE = /^(timestamp|datetime|date[-_]?time|date|time)$/;
const PERSON_TYPE_RE = /^(person|actor|contact|author|sender|user)$/;
const TEXT_TYPE_RE = /^(text|message|body|content|richtext|rich_text|markdown|prose)$/;
// A declared geo/coordinate type is the strongest location signal.
const GEO_TYPE_RE = /^(geo|geopoint|geo_point|coordinate|coordinates|location|lat_lng|latlng)$/;
// Declared measured-activity quantities (a distance or duration with a unit).
const ACTIVITY_TYPE_RE = /^(distance|duration|elevation|pace|speed|heart_rate|steps)$/;

function normalizeType(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function declaredTypesPresent(fieldTypes: DeclaredFieldTypes | null | undefined): boolean {
  if (!fieldTypes) {
    return false;
  }
  for (const value of Object.values(fieldTypes)) {
    if (normalizeType(value)) {
      return true;
    }
  }
  return false;
}

/**
 * Dispatch a kind from declared field types — the preferred signal when the
 * manifest declares presentation types. Precedence mirrors the heuristic's:
 * a money-typed field is the strongest signal; a person/author + text pair is
 * a message; a leading temporal field is an event only when nothing stronger
 * (money / message) is declared; an unpaired text/title-ish field is `titled`.
 * Returns null when the declared types carry no recognized kind signal, so the
 * caller falls through to the stream-name / field-name heuristic.
 */
// Declared-type signal tags, collected per stream and resolved by precedence.
type DeclaredSignal = "money" | "geo" | "activity" | "person" | "text" | "temporal";

// Ordered so the FIRST match wins for a given declared type; money/geo/activity
// are the strong, kind-distinct signals and are tested ahead of the weaker
// person/text/temporal ones (the same precedence the old if/else chain used).
const DECLARED_SIGNAL_RES: readonly [DeclaredSignal, RegExp][] = [
  ["money", MONEY_TYPE_RE],
  ["geo", GEO_TYPE_RE],
  ["activity", ACTIVITY_TYPE_RE],
  ["person", PERSON_TYPE_RE],
  ["text", TEXT_TYPE_RE],
  ["temporal", TEMPORAL_TYPE_RE],
];

function collectDeclaredSignals(fieldTypes: DeclaredFieldTypes): Set<DeclaredSignal> {
  const signals = new Set<DeclaredSignal>();
  for (const raw of Object.values(fieldTypes)) {
    const t = normalizeType(raw);
    if (!t) {
      continue;
    }
    for (const [signal, re] of DECLARED_SIGNAL_RES) {
      if (re.test(t)) {
        signals.add(signal);
        break;
      }
    }
  }
  return signals;
}

function classifyByDeclaredTypes(fieldTypes: DeclaredFieldTypes): RecordKind | null {
  const signals = collectDeclaredSignals(fieldTypes);
  if (signals.has("money")) {
    return "money";
  }
  // A declared coordinate is the clearest place signal; it outranks the weaker
  // temporal/text signals (a check-in with a caption is still a place).
  if (signals.has("geo")) {
    return "location";
  }
  // A measured activity declares quantities like distance/duration; such a stat
  // marks an activity ahead of a plain temporal event.
  if (signals.has("activity")) {
    return "activity";
  }
  if (signals.has("person") && signals.has("text")) {
    return "message";
  }
  if (signals.has("text")) {
    return "titled";
  }
  if (signals.has("temporal")) {
    return "event";
  }
  return null;
}

/**
 * Dispatch a kind from declared presentation ROLES — the OTHER declared signal
 * (alongside types). A role is a manifest declaration, not a name guess, so it is
 * an equally honest kind source — but ONLY for the kinds a role unambiguously
 * implies: a declared `amount` role is money; a declared `event-time` role is an
 * event. Anything else with a title/secondary/actor is `titled`.
 *
 * `actor` does NOT imply `message` (Codex end-review blocker, 2026-06-22): an
 * `actor` role means "authored / attributed by", which is equally true of a music
 * TRACK (artist), a pull request (author), and a chat turn. There is no declared
 * signal that a record is CONVERSATIONAL, so claiming `message` from `actor` alone
 * over-claims. The `message` kind requires a declared TYPE pair (person + text),
 * handled by classifyByDeclaredTypes. A role-authored stream that declares an actor
 * (e.g. chatgpt/messages) renders as `titled`; its declared actor still surfaces in
 * the card via the declared-actor display (record-preview.ts), so the author is not
 * lost — only the unwarranted `message` glyph is.
 *
 * Returns null when no role implies a distinct kind.
 */
function classifyByDeclaredRoles(roles: DeclaredFieldRoles): RecordKind | null {
  const declared = new Set(Object.values(roles));
  if (declared.has("amount")) {
    return "money";
  }
  if (declared.has("event-time")) {
    return "event";
  }
  if (declared.has("primary-title") || declared.has("secondary") || declared.has("actor")) {
    return "titled";
  }
  return null;
}

/**
 * Classify a feed row's presentation `kind` — the leading glyph + kind tag.
 *
 * `kind` is derived SOLELY from DECLARED signals: declared `x_pdpp_type`
 * (classifyByDeclaredTypes) and declared `x_pdpp_role` (classifyByDeclaredRoles).
 * There is NO stream-name / field-name / body-shape guessing: a stream that
 * declares no recognized type OR role is `generic` with a neutral glyph, exactly
 * as the content honesty gate renders an undeclared record as the honest generic
 * card. Types win first (they carry the money/geo/activity distinctions); roles
 * fill in the message/event/titled kinds a role-authored stream declares (e.g.
 * chatgpt/messages: content→primary-title + role→actor ⇒ message). This keeps the
 * glyph honest — manifest-authored or neutral, never inferred from a name.
 *
 * Signature note: `_data` and `_manifestFieldNames` are retained for call-site
 * compatibility but are NO LONGER consulted (they were the body/manifest-name
 * guessing inputs). `reader` is no longer reachable (it required measuring a long
 * body); a long-text stream is `titled`/`message` per its declared type/role.
 */
export function classifyRecordKind(
  _stream: string,
  _data: Record<string, unknown> | null,
  fieldTypes?: DeclaredFieldTypes | null,
  _manifestFieldNames?: readonly string[] | null,
  roles?: DeclaredFieldRoles | null
): RecordKindDescriptor {
  if (declaredTypesPresent(fieldTypes)) {
    const declared = classifyByDeclaredTypes(fieldTypes as DeclaredFieldTypes);
    if (declared) {
      return { kind: declared, label: KIND_LABELS[declared] };
    }
  }
  // Declared ROLES are an equally-honest declared signal (not a name guess).
  if (roles && Object.keys(roles).length > 0) {
    const byRole = classifyByDeclaredRoles(roles);
    if (byRole) {
      return { kind: byRole, label: KIND_LABELS[byRole] };
    }
  }
  // No declared type or role signal → honest neutral `generic` glyph.
  return { kind: "generic", label: KIND_LABELS.generic };
}
