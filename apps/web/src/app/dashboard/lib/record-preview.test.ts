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
