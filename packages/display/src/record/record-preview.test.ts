// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
    { amount: -1245, currency: "USD", memo: "Lunch", merchant: "Bluebird Bakery" },
    { amount: "currency" },
    { amount: "amount", memo: "secondary", merchant: "primary-title" }
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
  const preview = buildRecordPreview("message", { content: "Hello", sender: "Ada", subject: "Thread" }, null, {
    content: "secondary",
    sender: "actor",
    subject: "primary-title",
  });

  assert.deepEqual(
    { author: preview?.author, body: preview?.body, kind: preview?.kind, title: preview?.title },
    { author: "Ada", body: "Hello", kind: "message", title: "Thread" }
  );
});

test("builds a role-backed event preview with a UTC time label", () => {
  const preview = buildRecordPreview(
    "event",
    { notes: "Room 1", starts_at: "2026-05-22T18:00:00Z", title: "Launch" },
    null,
    { notes: "secondary", starts_at: "event-time", title: "primary-title" }
  );

  assert.deepEqual(
    { body: preview?.body, eventTime: preview?.eventTime, kind: preview?.kind, title: preview?.title },
    { body: "Room 1", eventTime: "6:00 PM", kind: "event", title: "Launch" }
  );
});

test("a zoneless declared event time renders as UTC, not host local time", () => {
  // Date.parse reads a zoneless ISO datetime as host local time while
  // TIME_FMT pins UTC, so the same declared event-time rendered differently
  // on SSR and client hosts. A zoneless value must render as UTC.
  // The defect only shows on a non-UTC host, so pin one for this case.
  const hostZone = process.env.TZ;
  process.env.TZ = "America/Chicago";
  try {
    const preview = buildRecordPreview(
      "event",
      { notes: "Room 1", starts_at: "2026-05-22T18:00:00", title: "Launch" },
      null,
      { notes: "secondary", starts_at: "event-time", title: "primary-title" }
    );

    assert.equal(preview?.eventTime, "6:00 PM");
  } finally {
    if (hostZone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = hostZone;
    }
  }
});

test("an event-kind record with a declared-but-EMPTY primary-title renders a placeholder, not the id", () => {
  // A codex/messages-shaped record: content (primary-title) is blank, but the
  // event-time role keeps it kind=event. It must show "(no content)" — not fall
  // through title-less to the row's identity-key (bare-UUID) fallback.
  const preview = buildRecordPreview(
    "event",
    { content: "", id: "019dfeb4-...:208455", timestamp: "2026-06-25T17:00:00Z" },
    null,
    { content: "primary-title", role: "actor", timestamp: "event-time" }
  );

  assert.equal(preview?.kind, "event");
  assert.equal(preview?.title, "(no content)");
  assert.equal(preview?.eventTime, "5:00 PM");
});

test("builds a role-backed titled preview", () => {
  const preview = buildRecordPreview("titled", { author: "Ada", body: "Long form", title: "On Protocols" }, null, {
    author: "actor",
    body: "secondary",
    title: "primary-title",
  });

  assert.deepEqual(
    { author: preview?.author, body: preview?.body, kind: preview?.kind, title: preview?.title },
    { author: "Ada", body: "Long form", kind: "titled", title: "On Protocols" }
  );
});

test("truncates a titled preview without leaving half of an astral character", () => {
  const previewTitle = (title: string) =>
    buildRecordPreview("titled", { title }, null, { title: "primary-title" })?.title;
  const glyph = "\u{1F9EA}";
  const split = "a".repeat(88);
  assert.equal(previewTitle(split + glyph + "z"), split + "…");
  assert.equal(previewTitle(split + glyph), split + glyph);

  const fitsBeforeEllipsis = "a".repeat(87) + glyph;
  assert.equal(previewTitle(fitsBeforeEllipsis + "zz"), fitsBeforeEllipsis + "…");
  assert.equal(previewTitle("\t" + "a".repeat(91) + "\n"), "a".repeat(89) + "…");
});

test("generic preview uses declared title and body roles only", () => {
  const preview = buildRecordPreview(
    "generic",
    { amount_cents: 1245, id: "rec_1", name: "Opaque record", summary: "Declared summary" },
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
      from_name: null,
      id: "rec_1",
      is_draft: false,
      is_seen: false,
      labels: ["\\Inbox"],
      snippet: null,
      subject: null,
    },
    null,
    { from_name: "actor", snippet: "secondary", subject: "primary-title" }
  );
  assert.equal(preview?.kind, "generic");
  assert.equal(preview?.title, "(no subject)");
  // NEVER surfaces the undeclared operational fields as a key/value table.
  assert.equal(preview?.fields, undefined);
});

test("kinds without role-backed card slots render as generic previews", () => {
  for (const kind of ["activity", "location", "reader"] as const) {
    const preview = buildRecordPreview(kind, { distance: 5000, lat: 37.77, lng: -122.41, name: "Run" });

    assert.equal(preview?.kind, "generic");
    assert.equal(preview?.coordinates, undefined);
    assert.equal(preview?.stats, undefined);
  }
});
