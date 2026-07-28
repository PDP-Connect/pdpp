// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Mutation-killing unit tests for the pure `normalizeAggregateRequest`
 * validator in `server/record-aggregation.js`. It takes the request params +
 * manifest stream + grant as arguments (no DB) and enforces the entire
 * aggregate-request contract; no test imports it by name (the storage-layer
 * aggregate tests exercise `aggregateRecords`, not this validator).
 *
 * Pinned branches: unsupported-param rejection, undeclared-aggregations,
 * metric vocabulary, the group_by XOR group_by_time rule, granularity
 * required-with / forbidden-without group_by_time, time_zone gating, the
 * count field-forbidden rule, count_distinct field-required + no-grouping,
 * the limit-only-with-grouping + integer-range rule, and the happy path.
 *
 * Each error assertion checks the thrown `.code` (mostly invalid_request,
 * with field_not_granted / unknown_field where the source specializes it), so
 * a mutant that flips a guard or downgrades a specialized code turns red here.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { normalizeAggregateRequest } from "../server/record-aggregation.ts";

const TOP_LEVEL_REGEX_1 = /Aggregations are not declared/;

const STREAM = {
  name: "events",
  query: {
    aggregations: {
      count: true,
      count_distinct: ["category"],
      group_by: ["category"],
      group_by_time: ["occurred_at"],
      sum: ["amount"],
    },
  },
  schema: {
    properties: {
      amount: { type: "number" },
      category: { type: "string" },
      occurred_at: { format: "date-time", type: "string" },
    },
  },
};
const GRANT = { fields: ["category", "amount", "occurred_at"] };

// normalizeAggregateRequest is imported from the untyped JS validator; its
// request-params shape is deliberately loose here because these tests probe
// malformed/unsupported param combinations by design.
type AggregateRequestParams = Record<string, unknown>;

interface QueryError extends Error {
  code?: string;
}

function isQueryError(value: unknown): value is QueryError {
  return value instanceof Error;
}

function assertReject(
  params: AggregateRequestParams,
  { code = "invalid_request", messageIncludes }: { code?: string; messageIncludes?: string } = {}
): QueryError {
  let thrown: unknown;
  try {
    normalizeAggregateRequest(params, GRANT, STREAM);
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, `expected ${JSON.stringify(params)} to throw`);
  assert.ok(isQueryError(thrown), `expected an Error, got ${JSON.stringify(thrown)}`);
  assert.equal(thrown.code, code, `expected code=${code} got ${JSON.stringify(thrown.code)} (${thrown.message})`);
  if (messageIncludes !== undefined) {
    assert.ok(String(thrown.message).includes(messageIncludes), `message="${thrown.message}"`);
  }
  return thrown;
}

test("normalizeAggregateRequest: happy paths for count, grouped count, sum, and group_by_time", () => {
  assert.deepEqual(normalizeAggregateRequest({ metric: "count" }, GRANT, STREAM), {
    field: null,
    granularity: null,
    groupBy: null,
    groupByTime: null,
    limit: null,
    metric: "count",
    timeZone: null,
  });

  const grouped = normalizeAggregateRequest({ group_by: "category", metric: "count" }, GRANT, STREAM);
  assert.equal(grouped.groupBy, "category");
  assert.equal(grouped.limit, 10, "grouped count gets the default group limit");

  const sum = normalizeAggregateRequest({ field: "amount", metric: "sum" }, GRANT, STREAM);
  assert.equal(sum.metric, "sum");
  assert.equal(sum.field, "amount");

  const byTime = normalizeAggregateRequest(
    { granularity: "day", group_by_time: "occurred_at", metric: "count", time_zone: "UTC" },
    GRANT,
    STREAM
  );
  assert.equal(byTime.groupByTime, "occurred_at");
  assert.equal(byTime.granularity, "day");
  assert.equal(byTime.timeZone, "UTC");
});

test("normalizeAggregateRequest: rejects unsupported params and undeclared aggregations", () => {
  assertReject({ bogus_param: "1", metric: "count" }, { messageIncludes: "Unsupported query parameter" });

  // A stream with no aggregations declared -> rejected.
  let thrown: unknown;
  try {
    normalizeAggregateRequest({ metric: "count" }, GRANT, { name: "events", query: {} });
  } catch (e) {
    thrown = e;
  }
  assert.ok(isQueryError(thrown), `expected an Error, got ${JSON.stringify(thrown)}`);
  assert.ok(TOP_LEVEL_REGEX_1.test(thrown.message), thrown.message);
});

test("normalizeAggregateRequest: metric vocabulary is enforced", () => {
  assertReject({ metric: "median" }, { messageIncludes: "metric must be one of" });
  assertReject({ metric: "" }, { messageIncludes: "metric must be one of" });
});

test("normalizeAggregateRequest: group_by and group_by_time are mutually exclusive", () => {
  assertReject(
    { group_by: "category", group_by_time: "occurred_at", metric: "count" },
    { messageIncludes: "cannot be combined" }
  );
});

test("normalizeAggregateRequest: granularity is required with group_by_time and forbidden without", () => {
  // Required when group_by_time present.
  assertReject({ group_by_time: "occurred_at", metric: "count" }, { messageIncludes: "granularity is required" });
  // Invalid granularity unit.
  assertReject(
    { granularity: "fortnight", group_by_time: "occurred_at", metric: "count" },
    { messageIncludes: "granularity must be one of" }
  );
  // Forbidden without group_by_time.
  assertReject(
    { granularity: "day", metric: "count" },
    { messageIncludes: "granularity is only supported with group_by_time" }
  );
  // time_zone forbidden without group_by_time.
  assertReject(
    { metric: "count", time_zone: "UTC" },
    { messageIncludes: "time_zone is only supported with group_by_time" }
  );
});

test("normalizeAggregateRequest: count forbids a field; count_distinct requires one and forbids grouping", () => {
  // count must not carry a field.
  assertReject({ field: "amount", metric: "count" }, { messageIncludes: "field is not supported for count" });

  // count_distinct requires a field.
  assertReject({ metric: "count_distinct" }, { messageIncludes: "field is required for count_distinct" });
  // count_distinct cannot be grouped.
  assertReject(
    { field: "category", group_by: "category", metric: "count_distinct" },
    { messageIncludes: "count_distinct does not support grouping" }
  );
  // count_distinct happy path.
  const cd = normalizeAggregateRequest({ field: "category", metric: "count_distinct" }, GRANT, STREAM);
  assert.equal(cd.metric, "count_distinct");
  assert.equal(cd.field, "category");
});

test("normalizeAggregateRequest: unknown/ungranted fields get specialized error codes", () => {
  // A field absent from the schema -> unknown_field.
  assertReject({ field: "ghost", metric: "sum" }, { code: "unknown_field", messageIncludes: "Unknown field" });

  // A field present in schema + aggregations but NOT in the grant -> field_not_granted.
  const narrowGrant = { fields: ["category"] }; // amount not granted
  let thrown: unknown;
  try {
    normalizeAggregateRequest({ field: "amount", metric: "sum" }, narrowGrant, STREAM);
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, "ungranted field must throw");
  assert.ok(isQueryError(thrown), `expected an Error, got ${JSON.stringify(thrown)}`);
  assert.equal(thrown.code, "field_not_granted");
});

test("normalizeAggregateRequest: limit is only valid with grouping and must be an integer in [1, MAX]", () => {
  // limit without grouping -> rejected.
  assertReject({ limit: "5", metric: "count" }, { messageIncludes: "limit is only supported with group_by" });
  // Non-integer limit with grouping -> rejected.
  assertReject(
    { group_by: "category", limit: "abc", metric: "count" },
    { messageIncludes: "limit must be an integer" }
  );
  // Below range.
  assertReject({ group_by: "category", limit: "0", metric: "count" }, { messageIncludes: "between 1 and" });
  // A valid grouped limit is honored.
  const ok = normalizeAggregateRequest({ group_by: "category", limit: "7", metric: "count" }, GRANT, STREAM);
  assert.equal(ok.limit, 7);
});
