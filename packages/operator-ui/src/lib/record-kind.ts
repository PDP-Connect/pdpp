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

// Stream-name signals. Matched case-insensitively against the stream id.
// Ordered by specificity: a `transactions` stream is money even though it is
// not "message"-shaped, so money/event/message checks are independent and
// the first that matches wins in `classifyByStreamName`.
const MESSAGE_STREAM_RE = /(message|chat|conversation|thread|dm|email|mail|comment|post)/i;
const MONEY_STREAM_RE =
  /(transaction|payment|pay_statement|paystub|payroll|invoice|charge|expense|budget|ledger|order)/i;
// Physical/measured activity: a workout, ride, or sleep session that leads with
// numeric stats (distance / duration / score), distinct from a calendar `event`
// (which leads with a start/end time). Checked ahead of EVENT so a `workout`
// stream becomes an activity card rather than a bare event.
const ACTIVITY_STREAM_RE = /(workout|exercise|activit(y|ies)|ride|run|swim|sleep|fitness|step)/i;
const EVENT_STREAM_RE = /(visit|appointment|event|booking|reservation|session|trip)/i;
// Geo / place streams: a check-in, saved place, or location ping that leads
// with coordinates. Field-level lat/lng is the strong signal (below); the name
// is a weak hint.
const LOCATION_STREAM_RE = /(location|place|check[-_ ]?in|geo|visit_place|where|trip_point)/i;
const TITLED_STREAM_RE =
  /(document|file|issue|pull_request|repository|repo|gist|note|memory|channel|album|track|playlist|page|record|statement)/i;

// Field-name signals. A money record carries an amount-shaped field; an event
// carries a when-shaped field other than the envelope timestamps.
const MONEY_FIELD_RE = /(amount|_cents$|^cents$|price|balance|total|gross_pay|net_pay|income|budgeted)/i;
const MESSAGE_FIELD_RE = /^(content|text|message|body|snippet)$/i;
const MESSAGE_AUTHOR_RE = /^(author|author_role|role|from|sender|user|username)$/i;
const TITLE_FIELD_RE = /^(title|name|subject|merchant|provider_name|employer|document_kind|full_name)$/i;
// Geo coordinate pair — the unambiguous location signal. A record carrying both
// a latitude- and longitude-shaped field is a place regardless of stream name.
const LAT_FIELD_RE = /^(lat|latitude)$/i;
const LNG_FIELD_RE = /^(lng|lon|long|longitude)$/i;
// Measured-activity stats — distance / duration / elevation / a score. A pair
// (or a distance/duration alone) marks a workout-style record. `steps` and
// `calories` are common fitness aggregates.
const ACTIVITY_STAT_RE = /^(distance|distance_m|duration|elapsed|elapsed_time|elevation|elev_gain|steps|calories)$/i;
// A long-text body field — the reader signal. Same names as the message body,
// but reader is gated on the body actually being long (see hasLongBody).
const LONG_BODY_RE = /^(body|content|article|text|markdown|html)$/i;
// Minimum characters for a body field to count as "long-form" reading material.
const READER_MIN_BODY_CHARS = 280;

function hasField(data: Record<string, unknown>, re: RegExp): boolean {
  for (const key of Object.keys(data)) {
    if (re.test(key)) {
      return true;
    }
  }
  return false;
}

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

function classifyByStreamName(stream: string): RecordKind | null {
  if (MESSAGE_STREAM_RE.test(stream)) {
    return "message";
  }
  if (MONEY_STREAM_RE.test(stream)) {
    return "money";
  }
  // Activity and location are checked ahead of the broad EVENT match so a
  // `workouts` or `check_ins` stream gets its specific card instead of a bare
  // event. Both are narrowly named, so this does not steal calendar events.
  if (ACTIVITY_STREAM_RE.test(stream)) {
    return "activity";
  }
  if (LOCATION_STREAM_RE.test(stream)) {
    return "location";
  }
  if (EVENT_STREAM_RE.test(stream)) {
    return "event";
  }
  if (TITLED_STREAM_RE.test(stream)) {
    return "titled";
  }
  return null;
}

/**
 * Strong field signal - overrides the stream-name guess. A genuine
 * amount-shaped field means money regardless of how the stream is named (an
 * `orders` or opaque `records` stream that carries `amount_cents` is money);
 * a genuine lat/lng pair means a location for the same reason.
 */
function classifyByStrongField(data: Record<string, unknown>): RecordKind | null {
  if (hasField(data, MONEY_FIELD_RE)) {
    return "money";
  }
  // A genuine coordinate pair is as unambiguous as an amount field: a record
  // carrying both lat and lng is a place no matter how the stream is named.
  if (hasField(data, LAT_FIELD_RE) && hasField(data, LNG_FIELD_RE)) {
    return "location";
  }
  return null;
}

/** True when the body has a long-form text field (the reader signal). */
function hasLongBody(data: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === "string" && v.trim().length >= READER_MIN_BODY_CHARS && LONG_BODY_RE.test(k)) {
      return true;
    }
  }
  return false;
}

/** True when the body carries a measured-activity stat field. */
function hasActivityStat(data: Record<string, unknown>): boolean {
  return hasField(data, ACTIVITY_STAT_RE);
}

/**
 * Weak field signal - only promotes a stream the name could not classify
 * (`generic`). A title or message field refines an unknown stream but must
 * not override a confident event/message/money stream-name match (a clinical
 * `visit` stays an event even though it carries a `provider_name` title).
 */
function classifyByWeakField(data: Record<string, unknown>): RecordKind | null {
  if (hasField(data, MESSAGE_FIELD_RE) && hasField(data, MESSAGE_AUTHOR_RE)) {
    return "message";
  }
  if (hasField(data, TITLE_FIELD_RE)) {
    return "titled";
  }
  return null;
}

/**
 * Classify a feed row.
 *
 * `data` is the record body when the lens has it (recency / time-range) and
 * `null` for search hits, which carry only a snippet.
 *
 * `fieldTypes` is the optional declared presentation-type map for the stream
 * (`field_capabilities[].type`, sourced from the manifest). When the manifest
 * declares types, they are the **preferred** dispatch signal and win over the
 * stream-name / field-name heuristic — a declared `currency` type is a money
 * card by declaration, not by guess. When no declared type is recognized (or
 * none is declared at all), the row falls through to the original heuristic
 * unchanged.
 *
 * `manifestFieldNames` is an optional list of field names taken from the
 * connector manifest's `schema.properties` keys. When the record body is
 * absent (search hits), manifest fields provide the same heuristic signals
 * that the body's actual keys would provide — without any new network call.
 * This improves kind tags for streams whose names are opaque (e.g.
 * `accounts` carrying `balance_cents`). The manifest hint is:
 *   - only consulted when `data` is null (body wins when present);
 *   - treated as the same heuristic tier as body field names (not a
 *     protocol claim), so the result stays presentation-only.
 */
export function classifyRecordKind(
  stream: string,
  data: Record<string, unknown> | null,
  fieldTypes?: DeclaredFieldTypes | null,
  manifestFieldNames?: readonly string[] | null
): RecordKindDescriptor {
  // Declared field types are the preferred signal. When present, they decide
  // the kind ahead of the stream-name / field-name heuristic. They are still
  // presentation-only — the precise card body (`buildRecordPreview`) requires
  // an actual record body, so a no-body search hit gets at most a kind tag,
  // never an invented precise card.
  if (declaredTypesPresent(fieldTypes)) {
    const declared = classifyByDeclaredTypes(fieldTypes as DeclaredFieldTypes);
    if (declared) {
      return { kind: declared, label: KIND_LABELS[declared] };
    }
    // Declared types present but none carried a recognized kind signal: fall
    // through to the heuristic rather than forcing `generic`.
  }

  const byStream = classifyByStreamName(stream);
  // A strong (money / coordinate) field signal overrides the stream-name guess;
  // a weak (title/message) field signal only fills in when the stream name
  // itself could not classify the row. Two body-only refinements sit between
  // them: a measured-activity stat promotes an event/unclassified row to
  // `activity`, and a long-form text body promotes a titled/unclassified row to
  // `reader`. Neither overrides a confident message/money/location match.
  if (data) {
    const strong = classifyByStrongField(data);
    const weak = classifyByWeakField(data);
    const base = strong ?? byStream ?? weak ?? "generic";
    const kind = refineByBody(base, data);
    return { kind, label: KIND_LABELS[kind] };
  }
  // No body — try manifest fields as a fallback heuristic before giving up.
  // `reader` is intentionally not derivable here: it requires an actual long
  // body, which field names alone cannot establish.
  if (manifestFieldNames && manifestFieldNames.length > 0) {
    const fakeFields = Object.fromEntries(manifestFieldNames.map((k) => [k, true]));
    const strong = classifyByStrongField(fakeFields);
    const weak = classifyByWeakField(fakeFields);
    let kind = strong ?? byStream ?? weak ?? "generic";
    if ((kind === "generic" || kind === "event") && hasActivityStat(fakeFields)) {
      kind = "activity";
    }
    return { kind, label: KIND_LABELS[kind] };
  }
  const kind = byStream ?? "generic";
  return { kind, label: KIND_LABELS[kind] };
}

/**
 * Body-only refinements applied after the strong/stream/weak base is chosen.
 * An activity stat promotes an `event` or unclassified row to `activity`; a
 * long-form body promotes a `titled` or unclassified row to `reader`. A
 * confident `message`/`money`/`location` base is never overridden.
 */
function refineByBody(base: RecordKind, data: Record<string, unknown>): RecordKind {
  if ((base === "event" || base === "generic" || base === "titled") && hasActivityStat(data)) {
    return "activity";
  }
  if ((base === "titled" || base === "generic") && hasLongBody(data)) {
    return "reader";
  }
  return base;
}
