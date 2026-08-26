// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { formatStructuredCell } from "./structured-value.ts";

test("returns null for scalars — caller's plain stringification handles them", () => {
  assert.equal(formatStructuredCell("hello"), null);
  assert.equal(formatStructuredCell(3000), null);
  assert.equal(formatStructuredCell(true), null);
  assert.equal(formatStructuredCell(null), null);
  assert.equal(formatStructuredCell(undefined), null);
});

test("an empty array reads as an explicit empty state, not a blank or raw '[]'", () => {
  assert.deepEqual(formatStructuredCell([]), { text: "None" });
});

test("an array of objects with `name` fields renders as joined names — the Gmail `cc` case", () => {
  const cc = [
    { email: "rowan.diaz@example.edu", name: "Rowan Diaz" },
    { email: "sasha.lindqvist@example.org", name: "Sasha Lindqvist" },
  ];
  const result = formatStructuredCell(cc);
  assert.equal(result?.text, "Rowan Diaz, Sasha Lindqvist");
  assert.equal(result?.detail, undefined, "under the item cap, no separate detail is needed");
});

test("an array longer than the item cap bounds the joined text and carries the full list as detail", () => {
  const items = [{ name: "A" }, { name: "B" }, { name: "C" }, { name: "D" }, { name: "E" }];
  const result = formatStructuredCell(items);
  assert.equal(result?.text, "A, B, C, +2 more");
  assert.equal(result?.detail, "A, B, C, D, E");
});

test("a scalar array joins directly, bounded the same way", () => {
  assert.deepEqual(formatStructuredCell(["read", "unread", "starred"]), { text: "read, unread, starred" });
  const long = formatStructuredCell(["a", "b", "c", "d"]);
  assert.equal(long?.text, "a, b, c, +1 more");
});

test("an object with no string field falls back to compact JSON, never a half-rendered fragment", () => {
  assert.deepEqual(formatStructuredCell({ count: 3, ok: true }), { text: '{"count":3,"ok":true}' });
});

test("a plain object with a name-like field renders that field, not the whole object", () => {
  assert.deepEqual(formatStructuredCell({ email: "a@b.com", name: "A B" }), { text: "A B" });
});

test("carries zero connector-specific vocabulary — the same structural rule applies regardless of field names", () => {
  // No connector's field names appear in structured-value.ts. The rule is purely
  // structural: prefer a field literally named `name`, else take the first
  // string-valued field in the object — applied identically whether the shape
  // came from Gmail, GroupMe, or a connector that does not exist yet.
  const withName = formatStructuredCell([{ group_id: "g1", name: "General" }]);
  const withoutName = formatStructuredCell([{ label: "main", ref_type: "branch" }]);
  assert.equal(withName?.text, "General", "a `name` field wins over any other field, regardless of key order");
  assert.equal(withoutName?.text, "main", "with no `name` field, the first string-valued field is used");
});
