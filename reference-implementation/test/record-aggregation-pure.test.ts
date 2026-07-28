// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure, no-DB unit tests for server/record-aggregation.js. No test imports this
// module by name (aggregate-time-buckets.test.js drives the same contract through
// the HTTP surface). This file pins the exported pure calendar/zone helpers and
// the normalizeAggregateRequest validation boundaries directly.
//
// Mutation surface:
//   bucketStartForGranularity -- calendar date_trunc: week snaps back to MONDAY,
//     quarter to its start month, month/year to day 1 / Jan; sub-day formats;
//     null/unparseable -> null.
//   resolveAggregateTimeZone  -- default UTC, RangeError->invalid_request.
//   normalizeAggregateRequest -- limit 1..100 inclusive bounds + integer parse,
//     metric enum, group_by XOR group_by_time, granularity required-with/
//     forbidden-without group_by_time, count/field mutual exclusion,
//     unknown_field / field_not_granted codes.

import assert from "node:assert/strict";
import test from "node:test";

import {
  bucketStartForGranularity,
  normalizeAggregateRequest,
  resolveAggregateTimeZone,
} from "../server/record-aggregation.ts";

const TOP_LEVEL_REGEX_1 = /only supported with group_by_time/;
const TOP_LEVEL_REGEX_2 = /metric must be one of/;
const TOP_LEVEL_REGEX_3 = /between 1 and 100/;
const TOP_LEVEL_REGEX_4 = /between 1 and 100/;
const TOP_LEVEL_REGEX_5 = /between 1 and 100/;
const TOP_LEVEL_REGEX_6 = /only supported with group_by/;
const TOP_LEVEL_REGEX_7 = /cannot be combined/;
const TOP_LEVEL_REGEX_8 = /does not support grouping/;

interface QueryError extends Error {
  code?: string;
}

function isQueryError(value: unknown): value is QueryError {
  return value instanceof Error;
}

// ---------------------------------------------------------------------------
// bucketStartForGranularity (calendar math)
// ---------------------------------------------------------------------------

const T = "2024-03-13T15:37:42Z"; // Wed 2024-03-13; ISO week starts Mon 2024-03-11

test("bucketStartForGranularity: day/month/quarter/year keys in UTC", () => {
  assert.equal(bucketStartForGranularity(T, "day", "UTC"), "2024-03-13");
  assert.equal(bucketStartForGranularity(T, "month", "UTC"), "2024-03-01");
  // March is in Q1 -> quarter start month is January.
  assert.equal(bucketStartForGranularity(T, "quarter", "UTC"), "2024-01-01");
  assert.equal(bucketStartForGranularity(T, "year", "UTC"), "2024-01-01");
});

test("bucketStartForGranularity: week snaps back to Monday", () => {
  // 2024-03-13 is a Wednesday; the Monday of that ISO week is 2024-03-11.
  assert.equal(bucketStartForGranularity(T, "week", "UTC"), "2024-03-11");
  // A Monday maps to itself.
  assert.equal(bucketStartForGranularity("2024-03-11T00:00:00Z", "week", "UTC"), "2024-03-11");
  // A Sunday maps back to the PRIOR Monday (ISO week, Sunday=7).
  assert.equal(bucketStartForGranularity("2024-03-17T12:00:00Z", "week", "UTC"), "2024-03-11");
  // The following Monday starts a new week bucket.
  assert.equal(bucketStartForGranularity("2024-03-18T00:00:00Z", "week", "UTC"), "2024-03-18");
});

test("bucketStartForGranularity: quarter start month for each quarter", () => {
  assert.equal(bucketStartForGranularity("2024-02-15T00:00:00Z", "quarter", "UTC"), "2024-01-01", "Q1");
  assert.equal(bucketStartForGranularity("2024-05-15T00:00:00Z", "quarter", "UTC"), "2024-04-01", "Q2");
  assert.equal(bucketStartForGranularity("2024-08-15T00:00:00Z", "quarter", "UTC"), "2024-07-01", "Q3");
  assert.equal(bucketStartForGranularity("2024-11-15T00:00:00Z", "quarter", "UTC"), "2024-10-01", "Q4");
});

test("bucketStartForGranularity: minute and hour keys", () => {
  assert.equal(bucketStartForGranularity(T, "minute", "UTC"), "2024-03-13T15:37");
  assert.equal(bucketStartForGranularity(T, "hour", "UTC"), "2024-03-13T15:00");
});

test("bucketStartForGranularity: null/unparseable value routes to null bucket", () => {
  assert.equal(bucketStartForGranularity(null, "day", "UTC"), null);
  assert.equal(bucketStartForGranularity("not-a-date", "day", "UTC"), null);
  assert.equal(bucketStartForGranularity("", "week", "UTC"), null);
});

test("bucketStartForGranularity: unknown granularity yields null", () => {
  assert.equal(bucketStartForGranularity(T, "fortnight", "UTC"), null);
});

test("bucketStartForGranularity: timezone shifts the calendar day boundary", () => {
  // 2024-03-13T02:30Z is still 2024-03-12 in America/New_York (UTC-4/-5).
  assert.equal(bucketStartForGranularity("2024-03-13T02:30:00Z", "day", "America/New_York"), "2024-03-12");
  assert.equal(bucketStartForGranularity("2024-03-13T02:30:00Z", "day", "UTC"), "2024-03-13");
});

// ---------------------------------------------------------------------------
// resolveAggregateTimeZone
// ---------------------------------------------------------------------------

test("resolveAggregateTimeZone: empty -> UTC, valid IANA passes through", () => {
  assert.equal(resolveAggregateTimeZone(null), "UTC");
  assert.equal(resolveAggregateTimeZone(""), "UTC");
  assert.equal(resolveAggregateTimeZone("America/New_York"), "America/New_York");
});

test("resolveAggregateTimeZone: unknown zone throws invalid_request", () => {
  assert.throws(
    () => resolveAggregateTimeZone("Mars/Olympus_Mons"),
    (err: unknown) => {
      assert.ok(isQueryError(err), `expected an Error, got ${JSON.stringify(err)}`);
      assert.equal(err.code, "invalid_request");
      assert.ok(err.message.includes("Unknown time_zone"));
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// normalizeAggregateRequest: validation boundaries
// ---------------------------------------------------------------------------

// A manifest stream that declares count + sum(amount) + group_by(category).
function aggManifest() {
  return {
    name: "orders",
    query: {
      aggregations: {
        count: true,
        group_by: ["category"],
        sum: ["amount"],
      },
    },
    schema: { properties: { amount: { type: "number" }, category: { type: "string" } } },
  };
}
const openGrant = {}; // no field restriction

test("normalizeAggregateRequest: count with no field is accepted", () => {
  const out = normalizeAggregateRequest({ metric: "count" }, openGrant, aggManifest());
  assert.equal(out.metric, "count");
  assert.equal(out.field, null);
  assert.equal(out.limit, null, "ungrouped count has null limit");
});

test("normalizeAggregateRequest: unknown metric is rejected", () => {
  assert.throws(() => normalizeAggregateRequest({ metric: "median" }, openGrant, aggManifest()), TOP_LEVEL_REGEX_2);
});

test("normalizeAggregateRequest: sum requires a declared numeric field", () => {
  const out = normalizeAggregateRequest({ field: "amount", metric: "sum" }, openGrant, aggManifest());
  assert.equal(out.metric, "sum");
  assert.equal(out.field, "amount");
});

test("normalizeAggregateRequest: sum on an unknown field is unknown_field", () => {
  assert.throws(
    () => normalizeAggregateRequest({ field: "nope", metric: "sum" }, openGrant, aggManifest()),
    (err: unknown) => {
      assert.ok(isQueryError(err), `expected an Error, got ${JSON.stringify(err)}`);
      assert.equal(err.code, "unknown_field");
      return true;
    }
  );
});

test("normalizeAggregateRequest: field not in grant is field_not_granted", () => {
  assert.throws(
    () => normalizeAggregateRequest({ field: "amount", metric: "sum" }, { fields: ["category"] }, aggManifest()),
    (err: unknown) => {
      assert.ok(isQueryError(err), `expected an Error, got ${JSON.stringify(err)}`);
      assert.equal(err.code, "field_not_granted");
      return true;
    }
  );
});

test("normalizeAggregateRequest: group_by and group_by_time together are rejected", () => {
  assert.throws(
    () =>
      normalizeAggregateRequest(
        { granularity: "day", group_by: "category", group_by_time: "created_at", metric: "count" },
        openGrant,
        aggManifest()
      ),
    TOP_LEVEL_REGEX_7
  );
});

test("normalizeAggregateRequest: limit outside 1..100 is rejected, boundaries inclusive", () => {
  const base = { group_by: "category", metric: "count" };
  // 1 and 100 accepted
  assert.equal(normalizeAggregateRequest({ ...base, limit: "1" }, openGrant, aggManifest()).limit, 1);
  assert.equal(normalizeAggregateRequest({ ...base, limit: "100" }, openGrant, aggManifest()).limit, 100);
  // 0 and 101 rejected
  assert.throws(() => normalizeAggregateRequest({ ...base, limit: "0" }, openGrant, aggManifest()), TOP_LEVEL_REGEX_3);
  assert.throws(
    () => normalizeAggregateRequest({ ...base, limit: "101" }, openGrant, aggManifest()),
    TOP_LEVEL_REGEX_4
  );
  // non-integer rejected
  assert.throws(
    () => normalizeAggregateRequest({ ...base, limit: "3.5" }, openGrant, aggManifest()),
    TOP_LEVEL_REGEX_5
  );
});

test("normalizeAggregateRequest: limit without grouping is rejected", () => {
  assert.throws(
    () => normalizeAggregateRequest({ limit: "5", metric: "count" }, openGrant, aggManifest()),
    TOP_LEVEL_REGEX_6
  );
});

test("normalizeAggregateRequest: grouped count defaults limit to 10", () => {
  const out = normalizeAggregateRequest({ group_by: "category", metric: "count" }, openGrant, aggManifest());
  assert.equal(out.limit, 10, "default group limit");
  assert.equal(out.groupBy, "category");
});

test("normalizeAggregateRequest: sum does not support grouping", () => {
  assert.throws(
    () => normalizeAggregateRequest({ field: "amount", group_by: "category", metric: "sum" }, openGrant, aggManifest()),
    TOP_LEVEL_REGEX_8
  );
});

test("normalizeAggregateRequest: granularity forbidden without group_by_time", () => {
  assert.throws(
    () => normalizeAggregateRequest({ granularity: "day", metric: "count" }, openGrant, aggManifest()),
    TOP_LEVEL_REGEX_1
  );
});
