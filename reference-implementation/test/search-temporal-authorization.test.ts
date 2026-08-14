// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { __filterLexicalCandidateRecordKeysForTest } from "../server/search.ts";

test("lexical candidate scan applies the frozen grant time field before ranking", () => {
  const rows = [
    {
      record_json: JSON.stringify({ mutable_time: "1999-01-01T00:00:00Z", occurred_at: "2026-01-01T00:00:00Z" }),
      record_key: "since-inclusive",
    },
    {
      record_json: JSON.stringify({ mutable_time: "2026-01-02T00:00:00Z", occurred_at: "2026-01-02T00:00:00Z" }),
      record_key: "inside",
    },
    {
      record_json: JSON.stringify({ mutable_time: "2026-01-02T00:00:00Z", occurred_at: "2026-01-03T00:00:00Z" }),
      record_key: "until-exclusive",
    },
    { record_json: JSON.stringify({ mutable_time: "2026-01-02T00:00:00Z" }), record_key: "missing" },
    { record_json: JSON.stringify({ occurred_at: "not-a-time" }), record_key: "malformed" },
  ];

  const allowed = __filterLexicalCandidateRecordKeysForTest(
    rows,
    {
      name: "events",
      time_constraint: {
        field: "occurred_at",
        since: "2026-01-01T00:00:00Z",
        until: "2026-01-03T00:00:00Z",
      },
    },
    { consent_time_field: "mutable_time", name: "events" }
  );

  assert.deepEqual(allowed, ["since-inclusive", "inside"]);
});
