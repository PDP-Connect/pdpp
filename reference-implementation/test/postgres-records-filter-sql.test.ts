// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { __buildPostgresFilterClauseForTest } from "../server/postgres-records.ts";

const RE_AMOUNT_GTE = /\(record_json->>'amount'\)::numeric >= \$1::numeric/;
const RE_AMOUNT_LTE = /\(record_json->>'amount'\)::numeric <= \$2::numeric/;
const RE_DATE_GTE = /\(record_json->>'date'\)::date >= \$1::date/;
const RE_DATE_LTE = /\(record_json->>'date'\)::date <= \$2::date/;
const RE_UNSUPPORTED_OP = /Unsupported range operator 'between'/;

const transactionsStream = {
  name: "transactions",
  query: {
    range_filters: {
      amount: ["gte", "lte"],
      date: ["gte", "lte"],
    },
  },
  schema: {
    properties: {
      amount: { type: "integer" },
      date: { format: "date", type: "string" },
      description: { type: "string" },
      id: { type: "string" },
    },
    type: "object",
  },
};

const ownerGrant = { name: "transactions" };

test("Postgres records SQL casts declared amount ranges numerically, not as text", () => {
  const { clause, params } = __buildPostgresFilterClauseForTest(
    { amount: { gte: "0", lte: "-50000" } },
    ownerGrant,
    transactionsStream
  );

  assert.match(clause, RE_AMOUNT_GTE);
  assert.match(clause, RE_AMOUNT_LTE);
  assert.deepEqual(params, ["0", "-50000"]);
});

test("Postgres records SQL casts declared date ranges as dates", () => {
  const { clause, params } = __buildPostgresFilterClauseForTest(
    { date: { gte: "2026-05-01", lte: "2026-05-05" } },
    ownerGrant,
    transactionsStream
  );

  assert.match(clause, RE_DATE_GTE);
  assert.match(clause, RE_DATE_LTE);
  assert.deepEqual(params, ["2026-05-01", "2026-05-05"]);
});

test("Postgres records SQL builder rejects unsupported range operators before SQL generation", () => {
  assert.throws(
    () => __buildPostgresFilterClauseForTest({ amount: { between: "0..10" } }, ownerGrant, transactionsStream),
    RE_UNSUPPORTED_OP
  );
});
