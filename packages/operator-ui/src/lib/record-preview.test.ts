import assert from "node:assert/strict";
import test from "node:test";
import { buildRecordPreview } from "./record-preview.ts";

test("returns null when no record body is available", () => {
  assert.equal(buildRecordPreview("message", null), null);
});

test("falls back to a generic field table when no presentation roles are declared", () => {
  const preview = buildRecordPreview("money", { amount_cents: -1245, merchant: "Cafe", memo: "Lunch" });

  assert.equal(preview?.kind, "generic");
  assert.equal(preview?.amount, undefined);
  assert.deepEqual(
    preview?.fields?.map(({ name, value }) => [name, value]),
    [
      ["amount_cents", "-1245"],
      ["merchant", "Cafe"],
      ["memo", "Lunch"],
    ]
  );
});

test("builds a role-backed money preview and formats declared currency cents", () => {
  const preview = buildRecordPreview(
    "money",
    { amount: -1245, currency: "USD", merchant: "Bluebird Bakery", memo: "Lunch" },
    { amount: "currency" },
    { amount: "amount", merchant: "primary-title", memo: "secondary" }
  );

  assert.deepEqual(
    {
      amount: preview?.amount,
      amountPositive: preview?.amountPositive,
      body: preview?.body,
      kind: preview?.kind,
      title: preview?.title,
    },
    {
      amount: "-$12.45",
      amountPositive: false,
      body: "Lunch",
      kind: "money",
      title: "Bluebird Bakery",
    }
  );
});

test("an explicit declared milliunits type divides by 1000", () => {
  const preview = buildRecordPreview(
    "money",
    { amount: -12_450 },
    { amount: "currency_milliunits" },
    { amount: "amount" }
  );

  assert.equal(preview?.amount, "-$12.45");
});

test("builds a role-backed message preview", () => {
  const preview = buildRecordPreview("message", { sender: "Ada", subject: "Thread", content: "Hello" }, null, {
    sender: "actor",
    subject: "primary-title",
    content: "secondary",
  });

  assert.deepEqual(
    { author: preview?.author, body: preview?.body, kind: preview?.kind, title: preview?.title },
    { author: "Ada", body: "Hello", kind: "message", title: "Thread" }
  );
});

test("builds a role-backed event preview with a UTC time label", () => {
  const preview = buildRecordPreview(
    "event",
    { title: "Launch", starts_at: "2026-05-22T18:00:00Z", notes: "Room 1" },
    null,
    { title: "primary-title", starts_at: "event-time", notes: "secondary" }
  );

  assert.deepEqual(
    { body: preview?.body, eventTime: preview?.eventTime, kind: preview?.kind, title: preview?.title },
    { body: "Room 1", eventTime: "6:00 PM", kind: "event", title: "Launch" }
  );
});

test("builds a role-backed titled preview", () => {
  const preview = buildRecordPreview("titled", { title: "On Protocols", body: "Long form", author: "Ada" }, null, {
    title: "primary-title",
    body: "secondary",
    author: "actor",
  });

  assert.deepEqual(
    { author: preview?.author, body: preview?.body, kind: preview?.kind, title: preview?.title },
    { author: "Ada", body: "Long form", kind: "titled", title: "On Protocols" }
  );
});

test("generic preview uses declared title and body roles only", () => {
  const preview = buildRecordPreview(
    "generic",
    { id: "rec_1", name: "Opaque record", summary: "Declared summary", amount_cents: 1245 },
    null,
    { name: "primary-title", summary: "secondary" }
  );

  assert.equal(preview?.kind, "generic");
  assert.equal(preview?.title, "Opaque record");
  assert.equal(preview?.body, "Declared summary");
  assert.deepEqual(
    preview?.fields?.map(({ name, value }) => [name, value]),
    [["amount_cents", "1245"]]
  );
});

test("declared stream with null content renders a placeholder, NOT an operational field dump", () => {
  // A gmail/messages-shaped record whose declared content (subject/snippet) was
  // not collected: subject=null, but operational fields (labels/is_seen/is_draft)
  // are present. It MUST NOT dump those as a key/value wall.
  const preview = buildRecordPreview(
    "message",
    {
      id: "rec_1",
      subject: null,
      snippet: null,
      from_name: null,
      labels: ["\\Inbox"],
      is_seen: false,
      is_draft: false,
    },
    null,
    { subject: "primary-title", snippet: "secondary", from_name: "actor" }
  );
  assert.equal(preview?.kind, "generic");
  assert.equal(preview?.title, "(no subject)");
  // NEVER surfaces the undeclared operational fields as a key/value table.
  assert.equal(preview?.fields, undefined);
});

test("kinds without role-backed card slots render as generic previews", () => {
  for (const kind of ["activity", "location", "reader"] as const) {
    const preview = buildRecordPreview(kind, { name: "Run", distance: 5000, lat: 37.77, lng: -122.41 });

    assert.equal(preview?.kind, "generic");
    assert.equal(preview?.coordinates, undefined);
    assert.equal(preview?.stats, undefined);
  }
});
