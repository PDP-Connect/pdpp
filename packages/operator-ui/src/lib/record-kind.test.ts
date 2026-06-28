import assert from "node:assert/strict";
import test from "node:test";
import { classifyRecordKind } from "./record-kind.ts";

test("falls back to generic when stream names have no declared type", () => {
  for (const stream of ["messages", "transactions", "appointments", "workouts", "check_ins"]) {
    assert.deepEqual(classifyRecordKind(stream, null), { kind: "generic", label: "record" });
  }
});

test("manifest fields: record body takes precedence over manifest hints", () => {
  assert.equal(classifyRecordKind("accounts", { id: "acct_1" }, null, ["id", "balance_cents"]).kind, "generic");
});

test("manifest fields: lone content field without author does not force message", () => {
  assert.equal(classifyRecordKind("opaque", null, null, ["id", "content"]).kind, "generic");
});

test("falls back to generic when the body has no declared type", () => {
  assert.equal(classifyRecordKind("opaque", { amount_cents: 100 }).kind, "generic");
  assert.equal(classifyRecordKind("opaque", { lat: 37.77, lng: -122.41 }).kind, "generic");
  assert.equal(classifyRecordKind("notes", { title: "t", body: "z".repeat(400) }).kind, "generic");
});

test("a lone content field without an author does not force message", () => {
  assert.equal(classifyRecordKind("opaque", { content: "hello" }).kind, "generic");
});

test("a lone latitude without longitude does not force location", () => {
  assert.equal(classifyRecordKind("opaque", { lat: 37.77 }).kind, "generic");
});

test("declared types: a currency field dispatches money", () => {
  assert.deepEqual(classifyRecordKind("opaque", null, { fee: "currency" }), { kind: "money", label: "money" });
});

test("declared types: a person and text pair dispatches message", () => {
  assert.deepEqual(classifyRecordKind("entries", { who: "Ada", what: "Hi" }, { who: "person", what: "text" }), {
    kind: "message",
    label: "message",
  });
});

test("declared types: a lone text field dispatches titled", () => {
  assert.deepEqual(classifyRecordKind("things", { note: "Hello" }, { note: "text" }), {
    kind: "titled",
    label: "item",
  });
});

test("declared types: a temporal field dispatches event", () => {
  assert.deepEqual(
    classifyRecordKind("opaque", { occurred_at: "2026-05-29T15:30:00Z" }, { occurred_at: "timestamp" }),
    { kind: "event", label: "event" }
  );
});

test("declared types: a geo type dispatches location", () => {
  assert.deepEqual(classifyRecordKind("opaque", { coords: "37.77,-122.41" }, { coords: "coordinates" }), {
    kind: "location",
    label: "place",
  });
});

test("declared types: a distance or duration type dispatches activity", () => {
  assert.deepEqual(classifyRecordKind("sessions", { distance: 5000 }, { distance: "distance" }), {
    kind: "activity",
    label: "activity",
  });
});

test("declared types: money beats weaker declared signals", () => {
  assert.deepEqual(
    classifyRecordKind(
      "opaque",
      { amount: 100, distance: 5000, coords: "37.77,-122.41", occurred_at: "2026-05-29T15:30:00Z" },
      { amount: "currency", distance: "distance", coords: "coordinates", occurred_at: "timestamp" }
    ),
    { kind: "money", label: "money" }
  );
});

test("declared types: unrecognized declarations fall back to generic", () => {
  assert.deepEqual(classifyRecordKind("transactions", { attachment: 1 }, { attachment: "blob" }), {
    kind: "generic",
    label: "record",
  });
});

test("declared types: an empty declaration map falls back to generic", () => {
  assert.deepEqual(classifyRecordKind("sessions", { started_at: "2026-05-29T00:00:00Z", duration_cents: 12 }, {}), {
    kind: "generic",
    label: "record",
  });
});

test("labels for current reachable kinds are short eyebrow strings", () => {
  assert.equal(classifyRecordKind("entries", null, { actor: "person", content: "text" }).label, "message");
  assert.equal(classifyRecordKind("accounts", null, { balance: "currency" }).label, "money");
  assert.equal(classifyRecordKind("appointments", null, { starts_at: "timestamp" }).label, "event");
  assert.equal(classifyRecordKind("sessions", null, { distance: "distance" }).label, "activity");
  assert.equal(classifyRecordKind("places", null, { coords: "coordinates" }).label, "place");
  assert.equal(classifyRecordKind("notes", null, { body: "text" }).label, "item");
  assert.equal(classifyRecordKind("opaque", null).label, "record");
});
