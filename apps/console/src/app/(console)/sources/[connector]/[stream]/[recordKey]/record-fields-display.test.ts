// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { renderValue, valueClassName } from "./record-fields-display.ts";

// Hoisted per the project's `useTopLevelRegex` lint rule.
const JSON_SYNTAX_RE = /[{}[\]"]/;

test("a declared-currency integer renders as money (the live chase bug)", () => {
  // chase current_activity `amount: 3000` (declared `currency`) must read
  // `$30.00`, never the raw `3000`.
  const rendered = renderValue(3000, "currency");
  assert.deepEqual(rendered, { empty: false, money: true, text: "$30.00" });
  assert.ok(valueClassName(rendered).includes("tabular-nums"));
});

test("a null value renders an explicit token, not blank page content", () => {
  // The live Codex `messages` record has `content: null`; it must read as an
  // explicit `null`, marked empty, rather than an absent/blank cell.
  const rendered = renderValue(null, undefined);
  assert.equal(rendered.text, "null");
  assert.equal(rendered.empty, true);
  assert.ok(valueClassName(rendered).includes("italic"));
});

test("an undefined value renders an em dash", () => {
  const rendered = renderValue(undefined, undefined);
  assert.equal(rendered.text, "—");
  assert.equal(rendered.empty, true);
});

test("an empty string renders an explicit empty token", () => {
  const rendered = renderValue("", undefined);
  assert.equal(rendered.text, "empty");
  assert.equal(rendered.empty, true);
});

test("an undeclared integer is NOT reinterpreted as cents", () => {
  // Without a declared currency type the value is shown verbatim; the detail
  // table never guesses a unit from magnitude.
  const rendered = renderValue(3000, undefined);
  assert.deepEqual(rendered, { empty: false, money: false, text: "3000" });
});

test("a plain string renders verbatim and is not marked empty or money", () => {
  const rendered = renderValue("posted", "text");
  assert.deepEqual(rendered, { empty: false, money: false, text: "posted" });
  assert.equal(valueClassName(rendered), "pdpp-caption break-words");
});

test("an object with no string-valued field falls back to compact JSON", () => {
  const rendered = renderValue({ a: 1 }, undefined);
  assert.equal(rendered.text, '{"a":1}');
  assert.equal(rendered.money, false);
});

test("an array of {name, email} objects renders readable names, not raw JSON — the live Gmail `cc` bug", () => {
  const cc = [
    { email: "mmarco@law.harvard.edu", name: "Meg Marco" },
    { email: "anna@opendatalabs.xyz", name: "Anna Kazlauskas" },
  ];
  const rendered = renderValue(cc, undefined);
  assert.equal(rendered.text, "Meg Marco, Anna Kazlauskas");
  assert.doesNotMatch(rendered.text, JSON_SYNTAX_RE, "must never contain JSON syntax characters");
  assert.equal(rendered.empty, false);
});

test("an empty array renders an explicit empty state, not blank or '[]'", () => {
  const rendered = renderValue([], undefined);
  assert.equal(rendered.text, "None");
});
