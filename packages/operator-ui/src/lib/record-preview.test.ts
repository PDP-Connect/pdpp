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

test("builds an activity preview with a formatted stat strip", () => {
  const preview = buildRecordPreview("activity", {
    name: "Morning Run",
    distance: 5200,
    duration: 1830,
    elevation: 42,
  });
  assert.equal(preview?.kind, "activity");
  assert.equal(preview?.title, "Morning Run");
  assert.deepEqual(preview?.stats, [
    { label: "distance", value: "5.2 km" },
    { label: "duration", value: "30m 30s" },
    { label: "elevation", value: "42 m" },
  ]);
});

test("activity preview falls back to a lone score for sleep-style records", () => {
  const preview = buildRecordPreview("activity", { type: "Sleep", score: 88 });
  assert.equal(preview?.title, "Sleep");
  assert.deepEqual(preview?.stats, [{ label: "score", value: "88" }]);
});

test("activity preview formats sub-kilometer distance in meters", () => {
  const preview = buildRecordPreview("activity", { name: "Walk", distance: 800 });
  assert.deepEqual(preview?.stats, [{ label: "distance", value: "800 m" }]);
});

test("builds a reader preview with a long body excerpt and optional author", () => {
  const body = `${"Long-form content. ".repeat(20)}`;
  const preview = buildRecordPreview("reader", { title: "On Protocols", body, author: "Ada Lovelace" });
  assert.equal(preview?.kind, "reader");
  assert.equal(preview?.title, "On Protocols");
  assert.equal(preview?.author, "Ada Lovelace");
  assert.ok((preview?.body?.length ?? 0) > 0);
});

test("builds a location preview with a 4-decimal coordinate pair", () => {
  assert.deepEqual(buildRecordPreview("location", { name: "Dolores Park", lat: 37.7596, lng: -122.4269 }), {
    kind: "location",
    title: "Dolores Park",
    coordinates: "37.7596, -122.4269",
  });
});

test("location preview defaults the title to 'Location' when none is present", () => {
  const preview = buildRecordPreview("location", { latitude: 1.234_56, longitude: 6.543_21 });
  assert.equal(preview?.title, "Location");
  assert.equal(preview?.coordinates, "1.2346, 6.5432");
});

test("location preview coerces string coordinates", () => {
  const preview = buildRecordPreview("location", { caption: "Trailhead", lat: "44.5", lon: "-110.5" });
  assert.equal(preview?.coordinates, "44.5000, -110.5000");
});
