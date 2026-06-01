import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRecordPreview } from "./record-preview.ts";

test("returns null when no record body is available", () => {
  assert.equal(buildRecordPreview("message", null), null);
});

test("builds a money preview from cents fields without inventing schema semantics", () => {
  assert.deepEqual(buildRecordPreview("money", { amount_cents: -1245, merchant: "Cafe", memo: "Lunch" }), {
    kind: "money",
    amount: "-$12.45",
    amountPositive: false,
    title: "Cafe",
    body: "Lunch",
  });
});

test("formats a chase bare `amount` declared `currency` as integer cents", () => {
  // The live UAT bug: chase `amount` is signed integer cents (declared
  // `x_pdpp_type: currency`). Without the declared-type signal the small
  // magnitude (-1245) fell through to the whole-dollars branch and rendered
  // `-$1245.00`. The declared type must pin it to cents → `-$12.45`.
  assert.deepEqual(
    buildRecordPreview("money", { amount: -1245, currency: "USD", name: "Bluebird Bakery" }, { amount: "currency" }),
    {
      kind: "money",
      amount: "-$12.45",
      amountPositive: false,
      title: "Bluebird Bakery",
      body: undefined,
    }
  );
});

test("a declared `currency` amount above the milliunit threshold still formats as cents", () => {
  // 438120 cents = $4381.20. The magnitude heuristic would have mis-divided this
  // by 1000 (→ $438.12); the declared type must win regardless of magnitude.
  const preview = buildRecordPreview("money", { amount: 438_120, currency: "USD" }, { amount: "currency" });
  assert.equal(preview?.amount, "$4381.20");
  assert.equal(preview?.amountPositive, true);
});

test("an explicit declared milliunits type divides by 1000", () => {
  const preview = buildRecordPreview("money", { amount: -12_450 }, { amount: "currency_milliunits" });
  assert.equal(preview?.amount, "-$12.45");
});

test("preserves the legacy milliunit magnitude heuristic when no type is declared", () => {
  // YNAB-style: no declared field type. A large bare `amount` is milliunits
  // (÷1000); a small one is whole dollars. This is the un-annotated fallback
  // the sandbox/YNAB summaries still rely on.
  assert.equal(buildRecordPreview("money", { amount: -12_450 })?.amount, "-$12.45");
  assert.equal(buildRecordPreview("money", { amount: 42 })?.amount, "$42.00");
});

test("builds a message preview from author and body fields", () => {
  assert.deepEqual(buildRecordPreview("message", { role: "user", content: "hello from the thread" }), {
    kind: "message",
    author: "user",
    title: undefined,
    body: "hello from the thread",
  });
});

test("builds an event preview with a stable UTC time label", () => {
  assert.deepEqual(buildRecordPreview("event", { title: "Dentist", start: "2026-05-29T15:30:00Z" }), {
    kind: "event",
    title: "Dentist",
    eventTime: "3:30 PM",
    body: undefined,
  });
});

test("does not produce a preview for generic records", () => {
  assert.equal(buildRecordPreview("generic", { content: "opaque" }), null);
});
