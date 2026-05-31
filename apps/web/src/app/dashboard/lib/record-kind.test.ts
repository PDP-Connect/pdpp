import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyRecordKind } from "./record-kind.ts";

test("classifies message-shaped streams by name", () => {
  assert.equal(classifyRecordKind("messages", null).kind, "message");
  assert.equal(classifyRecordKind("conversations", null).kind, "message");
  assert.equal(classifyRecordKind("email_threads", null).kind, "message");
});

test("classifies money-shaped streams by name", () => {
  assert.equal(classifyRecordKind("transactions", null).kind, "money");
  assert.equal(classifyRecordKind("pay_statements", null).kind, "money");
  assert.equal(classifyRecordKind("invoices", null).kind, "money");
});

test("classifies event-shaped streams by name", () => {
  assert.equal(classifyRecordKind("clinical_visits", null).kind, "event");
  assert.equal(classifyRecordKind("appointments", null).kind, "event");
});

test("classifies titled streams by name", () => {
  assert.equal(classifyRecordKind("tax_documents", null).kind, "titled");
  assert.equal(classifyRecordKind("repositories", null).kind, "titled");
});

test("falls back to generic when the stream name is opaque and no body is held", () => {
  assert.equal(classifyRecordKind("xyz", null).kind, "generic");
});

test("a *_cents field is a strong signal that overrides an opaque stream name", () => {
  assert.equal(classifyRecordKind("records", { amount_cents: -1245, merchant: "Cafe" }).kind, "money");
  assert.equal(classifyRecordKind("opaque", { gross_pay_cents: 612_500 }).kind, "money");
});

test("a money field overrides a non-money stream-name guess", () => {
  // A stream named like a document but carrying an amount is really money.
  assert.equal(classifyRecordKind("statements", { amount_cents: 100 }).kind, "money");
});

test("a title field does NOT override a confident event stream name", () => {
  // clinical_visits carries provider_name (a title field) but stays an event.
  assert.equal(
    classifyRecordKind("clinical_visits", { provider_name: "Dr. Hale", visit_at: "2026-02-14" }).kind,
    "event"
  );
});

test("a title field promotes an otherwise-generic stream", () => {
  assert.equal(classifyRecordKind("things", { title: "Quarterly report" }).kind, "titled");
});

test("a message+author field pair promotes a generic stream to message", () => {
  assert.equal(classifyRecordKind("entries", { role: "user", content: "hello" }).kind, "message");
});

test("a lone content field without an author does not force message", () => {
  // Avoids over-claiming: content alone is too weak a signal.
  assert.equal(classifyRecordKind("opaque", { content: "blob" }).kind, "generic");
});

test("label is a short eyebrow string matching the kind", () => {
  assert.equal(classifyRecordKind("messages", null).label, "message");
  assert.equal(classifyRecordKind("transactions", null).label, "money");
  assert.equal(classifyRecordKind("tax_documents", null).label, "item");
  assert.equal(classifyRecordKind("xyz", null).label, "record");
});

// Manifest field name hints — used for search hits and other no-body paths.
// The field-name array is the FOURTH argument; the third is the declared
// field-type map (null here, exercising the heuristic fallback path).

test("manifest fields: balance_cents promotes an opaque stream to money", () => {
  assert.equal(classifyRecordKind("accounts", null, null, ["id", "name", "type", "balance_cents"]).kind, "money");
});

test("manifest fields: amount on an opaque stream promotes to money", () => {
  assert.equal(classifyRecordKind("records", null, null, ["id", "amount", "merchant"]).kind, "money");
});

test("manifest fields: money signal overrides a non-money stream-name match", () => {
  // 'statements' would be 'titled' by stream name alone; balance_cents wins.
  assert.equal(classifyRecordKind("statements", null, null, ["id", "balance_cents"]).kind, "money");
});

test("manifest fields: title field promotes a generic stream to titled", () => {
  assert.equal(classifyRecordKind("things", null, null, ["id", "title", "created_at"]).kind, "titled");
});

test("manifest fields: author+content pair promotes generic stream to message", () => {
  assert.equal(classifyRecordKind("entries", null, null, ["id", "role", "content", "timestamp"]).kind, "message");
});

test("manifest fields: lone content field without author does not force message", () => {
  assert.equal(classifyRecordKind("opaque", null, null, ["id", "content"]).kind, "generic");
});

test("manifest fields: record body takes precedence over manifest hints", () => {
  // body has no kind signal; manifest says balance_cents; but body wins and
  // the stream-name guess ('accounts' → generic) prevails over manifest hint.
  // The body contains only opaque fields with no heuristic match.
  assert.equal(
    classifyRecordKind("accounts", { id: "1", type: "depository" }, null, ["id", "type", "balance_cents"]).kind,
    "generic"
  );
});

test("manifest fields: null manifest hints fall through to stream-name-only classification", () => {
  assert.equal(classifyRecordKind("transactions", null, null, null).kind, "money");
  assert.equal(classifyRecordKind("xyz", null, null, null).kind, "generic");
});

test("manifest fields: empty manifest hint array falls through to stream-name classification", () => {
  assert.equal(classifyRecordKind("transactions", null, null, []).kind, "money");
  assert.equal(classifyRecordKind("xyz", null, null, []).kind, "generic");
});

// Declared field types — the preferred dispatch signal when the manifest
// declares presentation types on field_capabilities[].type.

test("declared types: a currency-typed field dispatches money over an opaque stream name", () => {
  // 'records' would be 'titled' by stream name; the declared currency type wins.
  assert.equal(
    classifyRecordKind("records", { id: "1", value: 1245 }, { value: "currency", id: "string" }).kind,
    "money"
  );
});

test("declared types: currency_minor_units (sandbox vocabulary) dispatches money", () => {
  assert.equal(classifyRecordKind("opaque", { amt: 500 }, { amt: "currency_minor_units" }).kind, "money");
});

test("declared types win over an opaque stream/body heuristic", () => {
  // Stream name 'inbox' is message-ish, body carries no heuristic signal, but
  // the declared types describe money — declaration beats the stream guess.
  assert.equal(classifyRecordKind("inbox", { id: "1" }, { total_cents: "currency", id: "string" }).kind, "money");
});

test("declared types: a person + text pair dispatches message", () => {
  assert.equal(
    classifyRecordKind("entries", { who: "ada", what: "hi" }, { who: "person", what: "text" }).kind,
    "message"
  );
});

test("declared types: a lone text field dispatches titled (no person pairing)", () => {
  assert.equal(classifyRecordKind("things", { note: "hello" }, { note: "text" }).kind, "titled");
});

test("declared types: a leading temporal field dispatches event when nothing stronger is declared", () => {
  assert.equal(
    classifyRecordKind("opaque", { occurred_at: "2026-05-29T15:30:00Z" }, { occurred_at: "timestamp" }).kind,
    "event"
  );
});

test("declared types: money beats a temporal declaration in the same stream", () => {
  assert.equal(
    classifyRecordKind(
      "opaque",
      { posted_at: "2026-05-29T00:00:00Z", amount_minor: 999 },
      { posted_at: "timestamp", amount_minor: "currency_minor_units" }
    ).kind,
    "money"
  );
});

test("declared types: an unrecognized declared type falls through to the heuristic", () => {
  // 'geo' is not in the vocabulary; 'transactions' stream-name heuristic decides.
  assert.equal(classifyRecordKind("transactions", { lat: 1 }, { lat: "geo" }).kind, "money");
});

test("declared types: a declared type for a no-body search hit still yields a kind tag", () => {
  // No body (search hit). Declared types are a manifest hint here; the kind
  // tag is allowed, but buildRecordPreview still returns null without a body,
  // so no precise card is invented (asserted in record-preview.test.ts).
  assert.equal(classifyRecordKind("opaque", null, { fee: "currency" }).kind, "money");
});

test("declared types: empty declared-type map falls through to the heuristic", () => {
  assert.equal(classifyRecordKind("transactions", null, {}).kind, "money");
  assert.equal(classifyRecordKind("xyz", { content: "x" }, {}).kind, "generic");
});

test("declared types: declared types take precedence over a conflicting body field signal", () => {
  // Body has a *_cents money field (strong heuristic = money), but the manifest
  // declares the leading field as a timestamp and nothing money-typed, so the
  // declared signal (event) wins over the heuristic money guess.
  assert.equal(
    classifyRecordKind(
      "opaque",
      { started_at: "2026-05-29T00:00:00Z", duration_cents: 12 },
      { started_at: "timestamp" }
    ).kind,
    "event"
  );
});
