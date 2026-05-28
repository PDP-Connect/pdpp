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
