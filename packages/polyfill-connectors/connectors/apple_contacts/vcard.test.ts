// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { categoriesOf, escapeVCardValue, parseVCards, unescapeVCardValue } from "./vcard.ts";

test("parseVCards: parses core identity fields", () => {
  const raw = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    "UID:abc-123",
    "FN:Ada Lovelace",
    "N:Lovelace;Ada;;;",
    "ORG:Analytical Engines Ltd",
    "TITLE:Mathematician",
    "END:VCARD",
  ].join("\r\n");
  const [card] = parseVCards(raw);
  assert.ok(card);
  assert.equal(card?.uid, "abc-123");
  assert.equal(card?.fn, "Ada Lovelace");
  assert.equal(card?.familyName, "Lovelace");
  assert.equal(card?.givenName, "Ada");
  assert.equal(card?.org, "Analytical Engines Ltd");
  assert.equal(card?.title, "Mathematician");
});

test("parseVCards: unfolds long lines per RFC 6350 line folding", () => {
  // The continuation line's single leading space is the fold marker itself
  // and is stripped on unfolding; a second leading space (here, the space
  // before "note") survives as real content — that is how a folded vCard
  // preserves a word boundary across the fold point.
  const raw = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    "UID:folded-1",
    "NOTE:This is a very long",
    "  note that wraps.",
    "END:VCARD",
  ].join("\r\n");
  const [card] = parseVCards(raw);
  assert.equal(card?.note, "This is a very long note that wraps.");
});

test("parseVCards: parses typed EMAIL and TEL with multiple TYPE params", () => {
  const raw = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    "UID:typed-1",
    "EMAIL;TYPE=HOME,INTERNET:home@example.com",
    "EMAIL;TYPE=WORK:work@example.com",
    "TEL;TYPE=CELL,VOICE:+1-555-0100",
    "END:VCARD",
  ].join("\r\n");
  const [card] = parseVCards(raw);
  assert.deepEqual(card?.emails, [
    { types: ["HOME", "INTERNET"], value: "home@example.com" },
    { types: ["WORK"], value: "work@example.com" },
  ]);
  assert.deepEqual(card?.phones, [{ types: ["CELL", "VOICE"], value: "+1-555-0100" }]);
});

test("parseVCards: parses structured ADR components", () => {
  const raw = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    "UID:addr-1",
    "ADR;TYPE=HOME:;;123 Main St;Springfield;IL;62701;USA",
    "END:VCARD",
  ].join("\r\n");
  const [card] = parseVCards(raw);
  const [addr] = card?.addresses ?? [];
  assert.equal(addr?.street, "123 Main St");
  assert.equal(addr?.city, "Springfield");
  assert.equal(addr?.region, "IL");
  assert.equal(addr?.postalCode, "62701");
  assert.equal(addr?.country, "USA");
  assert.deepEqual(addr?.types, ["HOME"]);
});

test("parseVCards: unescapes commas, semicolons, backslashes, and newlines", () => {
  const raw = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    "UID:escape-1",
    "NOTE:Line one\\nLine two\\, with a comma\\; and a semicolon\\\\ backslash",
    "END:VCARD",
  ].join("\r\n");
  const [card] = parseVCards(raw);
  assert.equal(card?.note, "Line one\nLine two, with a comma; and a semicolon\\ backslash");
});

test("escapeVCardValue: round-trips through unescapeVCardValue", () => {
  const original = "a, b; c\\d\ne";
  assert.equal(unescapeVCardValue(escapeVCardValue(original)), original);
});

test("parseVCards: parses vCard 4 data-URI PHOTO", () => {
  const raw = ["BEGIN:VCARD", "VERSION:4.0", "UID:photo-1", "PHOTO:data:image/jpeg;base64,QUJD", "END:VCARD"].join(
    "\r\n"
  );
  const [card] = parseVCards(raw);
  assert.deepEqual(card?.photo, { mediaType: "image/jpeg", base64: "QUJD" });
});

test("parseVCards: parses vCard 3 ENCODING=b PHOTO", () => {
  const raw = ["BEGIN:VCARD", "VERSION:3.0", "UID:photo-2", "PHOTO;ENCODING=b;TYPE=JPEG:QUJD", "END:VCARD"].join(
    "\r\n"
  );
  const [card] = parseVCards(raw);
  assert.deepEqual(card?.photo, { base64: "QUJD", mediaType: "image/jpeg" });
});

test("categoriesOf: splits CATEGORIES on unescaped commas", () => {
  const raw = ["BEGIN:VCARD", "VERSION:3.0", "UID:cat-1", "CATEGORIES:Friends,Work\\, Team,VIPs", "END:VCARD"].join(
    "\r\n"
  );
  const [card] = parseVCards(raw);
  assert.ok(card);
  assert.deepEqual(categoriesOf(card as NonNullable<typeof card>), ["Friends", "Work, Team", "VIPs"]);
});

test("parseVCards: parses multiple vCards in one text blob", () => {
  const raw = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    "UID:multi-1",
    "FN:First Person",
    "END:VCARD",
    "BEGIN:VCARD",
    "VERSION:3.0",
    "UID:multi-2",
    "FN:Second Person",
    "END:VCARD",
  ].join("\r\n");
  const cards = parseVCards(raw);
  assert.equal(cards.length, 2);
  assert.equal(cards[0]?.fn, "First Person");
  assert.equal(cards[1]?.fn, "Second Person");
});

test("parseVCards: ignores malformed lines without a colon", () => {
  const raw = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    "UID:malformed-1",
    "THIS_LINE_HAS_NO_COLON",
    "FN:Still Parses",
    "END:VCARD",
  ].join("\r\n");
  const [card] = parseVCards(raw);
  assert.equal(card?.fn, "Still Parses");
});
