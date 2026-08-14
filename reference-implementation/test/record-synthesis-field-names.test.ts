// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { deriveCursorValue } from "../scripts/migrate-storage/record-synthesis.ts";

const LITERAL_FIELDS = [" leading and trailing ", "event-time", "occurred.at", 'said "when"', "時刻"];

test("migration cursor synthesis reads arbitrary literal top-level field names", () => {
  for (const [index, field] of LITERAL_FIELDS.entries()) {
    const value = `2026-01-0${index + 1}T00:00:00.000Z`;
    const stream = { cursor_field: field };
    assert.equal(deriveCursorValue(stream, { [field]: value }), value, field);
    assert.equal(deriveCursorValue(stream, JSON.stringify({ [field]: value })), value, field);
  }
});

test("migration cursor synthesis treats dotted names as literal keys", () => {
  assert.equal(
    deriveCursorValue(
      { cursor_field: "occurred.at" },
      JSON.stringify({ occurred: { at: "nested" }, "occurred.at": "literal" })
    ),
    "literal"
  );
});

test("migration cursor synthesis returns null only for absent, null, or empty cursor fields", () => {
  assert.equal(deriveCursorValue({ cursor_field: "event-time" }, {}), null);
  assert.equal(deriveCursorValue({ cursor_field: "event-time" }, { "event-time": null }), null);
  assert.equal(deriveCursorValue({ cursor_field: "" }, { "": "not declared" }), null);
});
