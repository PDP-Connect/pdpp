/**
 * Record-kind classification for the Explorer feed.
 *
 * The designer's Explorer dispatched type-aware cards (message / money /
 * event / titled / generic) from per-field schema metadata. The reference's
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

export type RecordKind = "message" | "money" | "event" | "titled" | "generic";

export interface RecordKindDescriptor {
  kind: RecordKind;
  /** Short eyebrow-style label rendered as the row's kind tag. */
  label: string;
}

const KIND_LABELS: Record<RecordKind, string> = {
  message: "message",
  money: "money",
  event: "event",
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
const EVENT_STREAM_RE = /(visit|appointment|event|booking|reservation|session|trip|ride|workout|activity)/i;
const TITLED_STREAM_RE =
  /(document|file|issue|pull_request|repository|repo|gist|note|memory|channel|album|track|playlist|page|record|statement)/i;

// Field-name signals. A money record carries an amount-shaped field; an event
// carries a when-shaped field other than the envelope timestamps.
const MONEY_FIELD_RE = /(amount|_cents$|^cents$|price|balance|total|gross_pay|net_pay|income|budgeted)/i;
const MESSAGE_FIELD_RE = /^(content|text|message|body|snippet)$/i;
const MESSAGE_AUTHOR_RE = /^(author|author_role|role|from|sender|user|username)$/i;
const TITLE_FIELD_RE = /^(title|name|subject|merchant|provider_name|employer|document_kind|full_name)$/i;

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
function classifyByDeclaredTypes(fieldTypes: DeclaredFieldTypes): RecordKind | null {
  let hasMoney = false;
  let hasPerson = false;
  let hasText = false;
  let hasTemporal = false;
  for (const raw of Object.values(fieldTypes)) {
    const t = normalizeType(raw);
    if (!t) {
      continue;
    }
    if (MONEY_TYPE_RE.test(t)) {
      hasMoney = true;
    } else if (PERSON_TYPE_RE.test(t)) {
      hasPerson = true;
    } else if (TEXT_TYPE_RE.test(t)) {
      hasText = true;
    } else if (TEMPORAL_TYPE_RE.test(t)) {
      hasTemporal = true;
    }
  }
  if (hasMoney) {
    return "money";
  }
  if (hasPerson && hasText) {
    return "message";
  }
  if (hasText) {
    return "titled";
  }
  if (hasTemporal) {
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
 * `orders` or opaque `records` stream that carries `amount_cents` is money).
 */
function classifyByStrongField(data: Record<string, unknown>): RecordKind | null {
  if (hasField(data, MONEY_FIELD_RE)) {
    return "money";
  }
  return null;
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
  // A strong (money) field signal overrides the stream-name guess; a weak
  // (title/message) field signal only fills in when the stream name itself
  // could not classify the row.
  if (data) {
    const strong = classifyByStrongField(data);
    const weak = classifyByWeakField(data);
    const kind = strong ?? byStream ?? weak ?? "generic";
    return { kind, label: KIND_LABELS[kind] };
  }
  // No body — try manifest fields as a fallback heuristic before giving up.
  if (manifestFieldNames && manifestFieldNames.length > 0) {
    const fakeFields = Object.fromEntries(manifestFieldNames.map((k) => [k, true]));
    const strong = classifyByStrongField(fakeFields);
    const weak = classifyByWeakField(fakeFields);
    const kind = strong ?? byStream ?? weak ?? "generic";
    return { kind, label: KIND_LABELS[kind] };
  }
  const kind = byStream ?? "generic";
  return { kind, label: KIND_LABELS[kind] };
}
