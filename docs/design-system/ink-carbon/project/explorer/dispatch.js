/**
 * PDPP Explorer — capability dispatch
 *
 * Takes a stream (schema + sample records) and returns the set of views
 * that should light up. Pure function of the schema's field types — never
 * branches on connector_id or stream name.
 *
 * Tier 1: Table is always returned (it's the floor).
 * Tier 2: Capability views are added based on detected schema signals.
 * Tier 3: An optional `preferred_view` may come in from outside the connector
 *         manifest (e.g. schema annotation or user override). We honor it
 *         only if the view is actually activated by Tier 2.
 */

const VIEW_ORDER = [
  // Order matters: pickInitial picks the first activated capability that
  // isn't "table". So we put the most semantically-specific views first
  // (ledger > conversation > gallery > calendar > map > reader > chart >
  // timeline > table). A stream that lights up multiple gets the most
  // informative default. Users can override via the view switcher.
  "ledger", "conversation", "gallery", "calendar", "map",
  "reader", "chart", "timeline", "table",
];

const FIELD_HINTS = {
  // Lexical clues used in addition to type. Always lowercased before match.
  author:  ["author", "from", "sender", "user", "user_id", "actor"],
  body:    ["body", "text", "message", "content", "snippet"],
  thread:  ["thread_id", "thread_ts", "channel", "channel_id", "conversation_id", "conv_id"],
  geo:     ["lat", "lng", "longitude", "latitude", "geo", "location", "polyline", "coords"],
  amount:  ["amount", "value", "price", "total"],
  ts_lex:  ["date", "ts", "occurred_at", "created_at", "started_at", "taken_at", "posted_at", "night_of", "ordered_at"],
  start:   ["start", "starts_at", "start_at", "begin"],
  end:     ["end", "ends_at", "end_at", "finish"],
  title:   ["title", "subject", "name", "headline"],
};

function namesByHint(fields, hintKey) {
  const hints = FIELD_HINTS[hintKey];
  return fields.filter((f) => hints.includes(String(f.name).toLowerCase())).map((f) => f.name);
}

function detect(stream) {
  const fields = stream.schema?.fields ?? [];
  const fieldByName = Object.fromEntries(fields.map((f) => [f.name, f]));
  const names = new Set(fields.map((f) => f.name));
  const has = (n) => names.has(n);
  const ofType = (t) => fields.filter((f) => f.type === t).map((f) => f.name);

  const activated = new Set();
  /** Map of capability → array of field names that triggered it (the "why"). */
  const signals = {};
  const declare = (cap, fields) => {
    activated.add(cap);
    signals[cap] = fields.filter(Boolean);
  };

  // Find a temporal anchor: explicit type=timestamp, else lexical fallback.
  const tsFields = ofType("timestamp");
  const tsLex = namesByHint(fields, "ts_lex");
  const timeField = tsFields[0] ?? tsLex[0];

  // ─── timeline ─────────────────────────────────────────────────────
  // Any record carrying a temporal anchor is timeline-able.
  if (timeField) declare("timeline", [timeField]);

  // ─── map ──────────────────────────────────────────────────────────
  // Explicit geo type, or lat+lng pair, or named geo fields.
  const geoFields = ofType("geo");
  const latField = fields.find((f) => /^lat(itude)?$/i.test(f.name))?.name;
  const lngField = fields.find((f) => /^l(ng|on|ongitude)$/i.test(f.name))?.name;
  if (geoFields.length || (latField && lngField)) {
    declare("map", [...geoFields, latField, lngField]);
  }

  // ─── gallery ──────────────────────────────────────────────────────
  // A blob field with image media type, or a clearly-named thumb/image.
  const blobImg = fields.find((f) => f.type === "blob" && (f.media_type ?? "").startsWith("image/"));
  const namedImg = fields.find((f) => /thumb|image|photo|picture|avatar/i.test(f.name) && (f.type === "blob" || f.type === "url"));
  if (blobImg || namedImg) declare("gallery", [(blobImg ?? namedImg).name]);

  // ─── ledger ──────────────────────────────────────────────────────
  // Currency type, or numeric `amount`/`value` field.
  const currencyField = fields.find((f) => f.type === "currency");
  const amountField = currencyField ?? fields.find((f) => f.type === "number" && namesByHint([f], "amount").length);
  if (amountField) {
    const counterparty = fields.find((f) => /merchant|payee|counterparty|recipient|seller/i.test(f.name));
    declare("ledger", [amountField.name, counterparty?.name].filter(Boolean));
  }

  // ─── conversation ────────────────────────────────────────────────
  // author + text-body + (thread or to). Detected lexically because most
  // schemas don't declare type="message".
  const authorFields = namesByHint(fields, "author");
  const bodyFields = namesByHint(fields, "body");
  const threadFields = namesByHint(fields, "thread");
  const hasTo = has("to") || has("recipient") || has("recipients");
  if (authorFields.length && bodyFields.length && (threadFields.length || hasTo)) {
    declare("conversation", [authorFields[0], bodyFields[0], threadFields[0] ?? (hasTo ? "to" : undefined)]);
  }

  // ─── calendar ────────────────────────────────────────────────────
  // start + (end or duration), with a title nice to have.
  const startFields = namesByHint(fields, "start");
  const endFields = namesByHint(fields, "end");
  const hasDuration = fields.some((f) => /^duration/i.test(f.name));
  if (startFields.length && (endFields.length || hasDuration)) {
    declare("calendar", [startFields[0], endFields[0] ?? "duration"]);
  }

  // ─── reader ──────────────────────────────────────────────────────
  // title + long body, no thread (which would route to conversation).
  const titleFields = namesByHint(fields, "title");
  if (titleFields.length && bodyFields.length && !threadFields.length) {
    declare("reader", [titleFields[0], bodyFields[0]]);
  }

  // ─── chart / heatmap ─────────────────────────────────────────────
  // Temporal anchor + at least one numeric measure. We exclude obvious
  // non-measures (lat/lng/id-ish fields) so location streams don't
  // accidentally light up the chart view.
  const isMeasure = (f) =>
    f.type === "number" &&
    !/^(lat|lng|longitude|latitude|id|.*_id|.*_count)$/i.test(f.name);
  const measures = fields.filter(isMeasure).map((f) => f.name);
  if (timeField && measures.length) declare("chart", [timeField, ...measures.slice(0, 3)]);

  // ─── table ───────────────────────────────────────────────────────
  // Always.
  activated.add("table");
  signals.table = ["(any record)"];

  // Order capabilities by VIEW_ORDER for deterministic UI.
  const ordered = VIEW_ORDER.filter((v) => activated.has(v));

  return { capabilities: ordered, signals };
}

/**
 * Decide the initial view for a stream.
 * 1. Honor user override (client-side, persisted) if it activated.
 * 2. Honor advisory hint (from out-of-manifest annotation) if it activated.
 * 3. Otherwise pick the highest-ranked activated capability.
 */
function pickInitial(stream, { override, hint } = {}) {
  const { capabilities } = detect(stream);
  if (override && capabilities.includes(override)) return override;
  if (hint && capabilities.includes(hint)) return hint;
  // Prefer richer views by default; table only if nothing else matched.
  const ranked = capabilities.filter((c) => c !== "table");
  return ranked[0] ?? "table";
}

window.PDPP_DISPATCH = { detect, pickInitial, VIEW_ORDER };
