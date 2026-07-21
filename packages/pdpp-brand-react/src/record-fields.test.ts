// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  displayTitle,
  findImageField,
  isImageVal,
  isLongVal,
  kindOf,
  labelFor,
  nounFor,
  prettify,
  resolveFieldValue,
} from "./record-fields.ts";

// ─── labelFor / prettify ──────────────────────────────────────────

test("labelFor uses the curated lexicon for known wire keys", () => {
  assert.equal(labelFor("gross_pay"), "Gross pay");
  assert.equal(labelFor("bank_routing"), "Deposited to");
});

test("labelFor prettifies unknown snake_case keys and strips ref", () => {
  assert.equal(labelFor("some_unknown_key"), "Some unknown key");
  assert.equal(prettify("account_ref"), "Account");
});

// ─── nounFor ──────────────────────────────────────────────────────

test("nounFor maps streams to a singular human noun, with a fallback", () => {
  assert.equal(nounFor("pay_statements"), "pay statement");
  assert.equal(nounFor("listening_history"), "play");
  assert.equal(nounFor("totally_unknown_stream"), "record");
});

// ─── kindOf (by field signature) ──────────────────────────────────

test("kindOf classifies a declared-currency record as money", () => {
  const kind = kindOf({ amount: 3000, merchant: "Acme" }, { amount: "currency" });
  assert.equal(kind, "money");
});

test("kindOf classifies money by gross_pay/net_pay keys even without declared types", () => {
  assert.equal(kindOf({ gross_pay: 500_000, net_pay: 412_300 }), "money");
});

test("kindOf classifies an image-bearing record as attachment", () => {
  assert.equal(kindOf({ photo: "https://cdn.example.com/a.png" }), "attachment");
});

test("kindOf classifies media / agent / email / code / generic by signature", () => {
  assert.equal(kindOf({ track: "Song", artist: "Band" }), "media");
  assert.equal(kindOf({ role: "assistant", content: "hi" }), "agent");
  assert.equal(kindOf({ from: "a@b.com", subject: "Hi" }), "email");
  assert.equal(kindOf({ repo: "pdpp", commits: 12 }), "code");
  assert.equal(kindOf({ note: "just a note" }), "generic");
});

test("kindOf does NOT guess money from a bare integer with no declared type", () => {
  // a 3000 with no declared currency type is not money — magnitude is not a unit.
  assert.equal(kindOf({ score: 3000 }), "generic");
});

// ─── displayTitle ─────────────────────────────────────────────────

test("displayTitle uses display_name when present, no kicker", () => {
  const t = displayTitle({ data: {}, stream: "messages", display_name: "Re: lunch" });
  assert.deepEqual(t, { primary: "Re: lunch", kicker: null });
});

test("displayTitle derives a quiet kicker + fact when untitled", () => {
  const t = displayTitle({ data: { from: "alice@example.com" }, stream: "messages" });
  assert.equal(t.kicker, "untitled message");
  assert.equal(t.primary, "from alice@example.com");
});

test("displayTitle falls back to the stream noun when no hint field exists", () => {
  const t = displayTitle({ data: { opaque: 1 }, stream: "pay_statements" });
  assert.equal(t.primary, "pay statement");
  assert.equal(t.kicker, "untitled pay statement");
});

// ─── image heuristic (the reality gap) ────────────────────────────

test("isImageVal matches image URLs and data URIs, rejects other strings", () => {
  assert.ok(isImageVal("https://x.test/a.JPG?sig=1"));
  assert.ok(isImageVal("data:image/png;base64,AAAA"));
  assert.equal(isImageVal("https://x.test/page.html"), false);
  assert.equal(isImageVal(3000), false);
});

test("findImageField returns the first image-shaped field, or null", () => {
  assert.deepEqual(findImageField({ title: "x", avatar: "https://x.test/a.webp" }), [
    "avatar",
    "https://x.test/a.webp",
  ]);
  assert.equal(findImageField({ title: "x", url: "https://x.test/page" }), null);
});

// ─── isLongVal ────────────────────────────────────────────────────

test("isLongVal flags long body/content strings, not short ones or non-body keys", () => {
  assert.ok(isLongVal("content", "x".repeat(80)));
  assert.equal(isLongVal("content", "short"), false);
  assert.equal(isLongVal("merchant", "x".repeat(80)), false);
});

// ─── resolveFieldValue (money / null / empty) ─────────────────────

test("resolveFieldValue formats a declared-currency minor-units integer as money", () => {
  const r = resolveFieldValue(3000, "currency");
  assert.deepEqual(r, { text: "$30.00", empty: false, money: true, negative: false });
});

test("resolveFieldValue marks a negative declared amount", () => {
  const r = resolveFieldValue(-2500, "currency");
  assert.equal(r.text, "-$25.00");
  assert.equal(r.money, true);
  assert.equal(r.negative, true);
});

test("resolveFieldValue does NOT reinterpret an undeclared integer as cents", () => {
  assert.deepEqual(resolveFieldValue(3000, undefined), {
    text: "3000",
    empty: false,
    money: false,
    negative: false,
  });
});

test("resolveFieldValue renders null / undefined / empty as explicit empty tokens", () => {
  assert.deepEqual(resolveFieldValue(null, undefined), { text: "null", empty: true, money: false, negative: false });
  assert.equal(resolveFieldValue(undefined, undefined).text, "—");
  assert.deepEqual(resolveFieldValue("", undefined), { text: "empty", empty: true, money: false, negative: false });
});

test("resolveFieldValue stringifies objects as JSON", () => {
  assert.equal(resolveFieldValue({ a: 1 }, undefined).text, '{"a":1}');
});
