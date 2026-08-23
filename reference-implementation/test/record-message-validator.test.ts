// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { assertValidRecordEnvelope, type RecordMessageLike } from "../runtime/record-message-validator.ts";

function record(overrides: Partial<RecordMessageLike> = {}): RecordMessageLike {
  return { data: { id: "m1" }, emitted_at: "2026-04-18T00:00:00Z", key: "m1", ...overrides };
}

test("assertValidRecordEnvelope accepts a well-formed upsert and a well-formed delete", () => {
  assert.doesNotThrow(() => assertValidRecordEnvelope(record()));
  assert.doesNotThrow(() => assertValidRecordEnvelope(record({ op: "upsert" })));
  assert.doesNotThrow(() => assertValidRecordEnvelope({ emitted_at: "2026-04-18T00:00:00Z", key: "m1", op: "delete" }));
});

test("assertValidRecordEnvelope accepts an array key for compound primary keys", () => {
  assert.doesNotThrow(() => assertValidRecordEnvelope(record({ key: ["user_1", "2026-04-01"] })));
});

const INVALID_CASES: [string, RecordMessageLike, RegExp][] = [
  ["legacy nested record (no top-level key/data)", { record: { data: { id: "m1" }, key: "m1" } }, /invalid key/],
  ["missing key", record({ key: undefined }), /invalid key/],
  ["empty string key", record({ key: "" }), /invalid key/],
  ["empty array key", record({ key: [] }), /invalid key/],
  ["array key with an empty element", record({ key: ["m1", ""] }), /invalid key/],
  ["numeric key", record({ key: 42 }), /invalid key/],
  ["missing data (non-delete op)", record({ data: undefined }), /invalid data/],
  ["array data", record({ data: ["m1"] }), /invalid data/],
  ["null data", record({ data: null }), /invalid data/],
  ["invalid op", record({ op: "replace" }), /invalid op/],
  ["missing emitted_at", record({ emitted_at: undefined }), /invalid emitted_at/],
  ["empty string emitted_at", record({ emitted_at: "" }), /invalid emitted_at/],
  ["numeric emitted_at", record({ emitted_at: "0" }), /invalid emitted_at/],
  ["invalid date emitted_at", record({ emitted_at: "not-a-date" }), /invalid emitted_at/],
];

for (const [name, msg, messageRe] of INVALID_CASES) {
  test(`assertValidRecordEnvelope rejects: ${name}`, () => {
    assert.throws(() => assertValidRecordEnvelope(msg), messageRe);
  });
}
