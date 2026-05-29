/**
 * Record-kind classification for the Explorer feed.
 *
 * The designer's Explorer dispatched type-aware cards (message / money /
 * event / titled / generic) from per-field schema metadata. The reference's
 * public read contract does not carry typed manifest field schemas today
 * (see design-notes/explorer-record-kind-and-typed-manifest-2026-05-28.md),
 * so we cannot key the dispatch off declared field types.
 *
 * Instead we derive a coarse `kind` from signals the feed already has on
 * every row: the `connector::stream` pair and, when the record body is in
 * hand (recency and time-range lenses), its field names. This is the same
 * class of heuristic the one-line `summarize()` table already uses - a
 * hand-picked "what is this record" read, not a protocol claim. It degrades
 * to `generic` whenever the signals are absent (e.g. search hits, which
 * carry only a snippet), so the row never over-promises a shape it cannot
 * see.
 *
 * `kind` is presentation metadata only. It is never written back, never sent
 * to the resource server, and never treated as a manifest field. Promoting a
 * real typed-field schema would replace this heuristic with a declared
 * `field.type`; until then this keeps the Explorer honest while still giving
 * the feed the type-aware texture the design called for.
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
 * `null` for search hits, which carry only a snippet. Field signals refine
 * the stream-name guess when the body is present; otherwise the stream name
 * alone decides, falling back to `generic`.
 */
/**
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
  manifestFieldNames?: readonly string[] | null
): RecordKindDescriptor {
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
