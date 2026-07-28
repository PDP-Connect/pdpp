const TOP_LEVEL_REGEX_1 = /field is required for sum/;
const TOP_LEVEL_REGEX_2 = /metric must be one of/;
const TOP_LEVEL_REGEX_3 = /Unknown time_zone/;
const TOP_LEVEL_REGEX_4 = /field is not supported for count/;
const TOP_LEVEL_REGEX_5 = /cannot be combined/;
const TOP_LEVEL_REGEX_6 = /granularity is required/;
const TOP_LEVEL_REGEX_7 = /granularity is only supported with group_by_time/;
const TOP_LEVEL_REGEX_8 = /limit is only supported with group_by/;
const TOP_LEVEL_REGEX_9 = /limit must be an integer between 1 and 100/;
const TOP_LEVEL_REGEX_10 = /limit must be an integer between 1 and 100/;
const TOP_LEVEL_REGEX_11 = /Unsupported query parameter: bogus/;

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the pure aggregate request-normalization + time-bucketing.
 *
 * record-aggregation.js exports are only exercised end-to-end today (through
 * records.js in aggregate-time-buckets.test.js, which needs a DB). These
 * unit tests pin the pure exports directly:
 *   - resolveAggregateTimeZone (UTC default + unknown-zone throw),
 *   - bucketStartForGranularity calendar truncation incl. Monday week start,
 *     quarter/month snapping, and the null-bucket fallback,
 *   - normalizeAggregateRequest metric/field/grouping/limit validation and
 *     the invalid_request / unknown_field / field_not_granted error codes.
 * Grant shape is OBSERVED only (no behavior change).
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  bucketStartForGranularity,
  normalizeAggregateRequest,
  resolveAggregateTimeZone,
} from "../server/record-aggregation.ts";

interface QueryError extends Error {
  code?: string;
}

function isQueryError(value: unknown): value is QueryError {
  return value instanceof Error;
}

test("resolveAggregateTimeZone defaults to UTC and rejects unknown zones", () => {
  assert.equal(resolveAggregateTimeZone(null), "UTC");
  assert.equal(resolveAggregateTimeZone(""), "UTC");
  assert.equal(resolveAggregateTimeZone("America/New_York"), "America/New_York");
  assert.throws(() => resolveAggregateTimeZone("Mars/Phobos"), TOP_LEVEL_REGEX_3);
});

test("bucketStartForGranularity truncates to calendar buckets in UTC", () => {
  const ts = "2026-07-02T13:45:30Z"; // Thursday
  assert.equal(bucketStartForGranularity(ts, "minute", "UTC"), "2026-07-02T13:45");
  assert.equal(bucketStartForGranularity(ts, "hour", "UTC"), "2026-07-02T13:00");
  assert.equal(bucketStartForGranularity(ts, "day", "UTC"), "2026-07-02");
  assert.equal(bucketStartForGranularity(ts, "month", "UTC"), "2026-07-01");
  assert.equal(bucketStartForGranularity(ts, "quarter", "UTC"), "2026-07-01"); // Q3 -> July
  assert.equal(bucketStartForGranularity(ts, "year", "UTC"), "2026-01-01");
});

test("bucketStartForGranularity snaps weeks back to Monday", () => {
  // 2026-07-02 is a Thursday; the Monday of that ISO week is 2026-06-29.
  assert.equal(bucketStartForGranularity("2026-07-02T00:00:00Z", "week", "UTC"), "2026-06-29");
  // A Monday maps to itself.
  assert.equal(bucketStartForGranularity("2026-06-29T12:00:00Z", "week", "UTC"), "2026-06-29");
  // A Sunday belongs to the week that started the previous Monday.
  assert.equal(bucketStartForGranularity("2026-07-05T23:00:00Z", "week", "UTC"), "2026-06-29");
});

test("bucketStartForGranularity picks the correct quarter start month", () => {
  assert.equal(bucketStartForGranularity("2026-02-15T00:00:00Z", "quarter", "UTC"), "2026-01-01"); // Q1
  assert.equal(bucketStartForGranularity("2026-05-15T00:00:00Z", "quarter", "UTC"), "2026-04-01"); // Q2
  assert.equal(bucketStartForGranularity("2026-11-15T00:00:00Z", "quarter", "UTC"), "2026-10-01"); // Q4
});

test("bucketStartForGranularity returns null for null/unparseable/unknown granularity", () => {
  assert.equal(bucketStartForGranularity(null, "day", "UTC"), null);
  assert.equal(bucketStartForGranularity("not-a-date", "day", "UTC"), null);
  assert.equal(bucketStartForGranularity("2026-07-02T00:00:00Z", "fortnight", "UTC"), null);
});

// --- normalizeAggregateRequest -------------------------------------------

function manifestFixture() {
  return {
    name: "orders",
    query: {
      aggregations: {
        count: true,
        count_distinct: ["status"],
        group_by: ["status"],
        group_by_time: ["created_at"],
        min: ["created_at"],
        sum: ["total"],
      },
    },
    schema: {
      properties: {
        created_at: { format: "date-time", type: "string" },
        status: { type: "string" },
        total: { type: "number" },
      },
    },
  };
}

test("normalizeAggregateRequest accepts a bare count", () => {
  const out = normalizeAggregateRequest({ metric: "count" }, {}, manifestFixture());
  assert.deepEqual(out, {
    field: null,
    granularity: null,
    groupBy: null,
    groupByTime: null,
    limit: null,
    metric: "count",
    timeZone: null,
  });
});

test("normalizeAggregateRequest resolves a grouped count with default + custom limit", () => {
  const ms = manifestFixture();
  const def = normalizeAggregateRequest({ group_by: "status", metric: "count" }, {}, ms);
  assert.equal(def.groupBy, "status");
  assert.equal(def.limit, 10);
  const custom = normalizeAggregateRequest({ group_by: "status", limit: "25", metric: "count" }, {}, ms);
  assert.equal(custom.limit, 25);
});

test("normalizeAggregateRequest resolves a group_by_time count with granularity + zone", () => {
  const ms = manifestFixture();
  const out = normalizeAggregateRequest(
    { granularity: "month", group_by_time: "created_at", metric: "count", time_zone: "America/New_York" },
    {},
    ms
  );
  assert.equal(out.groupByTime, "created_at");
  assert.equal(out.granularity, "month");
  assert.equal(out.timeZone, "America/New_York");
});

test("normalizeAggregateRequest rejects an unsupported metric", () => {
  assert.throws(
    () => normalizeAggregateRequest({ metric: "median" }, {}, manifestFixture()),
    (e: unknown) => isQueryError(e) && e.code === "invalid_request" && TOP_LEVEL_REGEX_2.test(e.message)
  );
});

test("normalizeAggregateRequest rejects a field for count and requires one for sum", () => {
  const ms = manifestFixture();
  assert.throws(() => normalizeAggregateRequest({ field: "total", metric: "count" }, {}, ms), TOP_LEVEL_REGEX_4);
  assert.throws(() => normalizeAggregateRequest({ metric: "sum" }, {}, ms), TOP_LEVEL_REGEX_1);
});

test("normalizeAggregateRequest flags an unknown field with unknown_field", () => {
  assert.throws(
    () => normalizeAggregateRequest({ field: "nope", metric: "sum" }, {}, manifestFixture()),
    (e: unknown) => isQueryError(e) && e.code === "unknown_field"
  );
});

test("normalizeAggregateRequest surfaces field_not_granted from the grant", () => {
  const grant = { fields: ["status"] }; // total not granted
  assert.throws(
    () => normalizeAggregateRequest({ field: "total", metric: "sum" }, grant, manifestFixture()),
    (e: unknown) => isQueryError(e) && e.code === "field_not_granted"
  );
});

test("normalizeAggregateRequest rejects combining group_by with group_by_time", () => {
  assert.throws(
    () =>
      normalizeAggregateRequest(
        { granularity: "day", group_by: "status", group_by_time: "created_at", metric: "count" },
        {},
        manifestFixture()
      ),
    TOP_LEVEL_REGEX_5
  );
});

test("normalizeAggregateRequest requires granularity with group_by_time and forbids it otherwise", () => {
  const ms = manifestFixture();
  assert.throws(
    () => normalizeAggregateRequest({ group_by_time: "created_at", metric: "count" }, {}, ms),
    TOP_LEVEL_REGEX_6
  );
  assert.throws(
    () => normalizeAggregateRequest({ granularity: "day", group_by: "status", metric: "count" }, {}, ms),
    TOP_LEVEL_REGEX_7
  );
});

test("normalizeAggregateRequest limit must be a positive bounded integer", () => {
  const ms = manifestFixture();
  assert.throws(() => normalizeAggregateRequest({ limit: "5", metric: "count" }, {}, ms), TOP_LEVEL_REGEX_8);
  assert.throws(
    () => normalizeAggregateRequest({ group_by: "status", limit: "0", metric: "count" }, {}, ms),
    TOP_LEVEL_REGEX_9
  );
  assert.throws(
    () => normalizeAggregateRequest({ group_by: "status", limit: "101", metric: "count" }, {}, ms),
    TOP_LEVEL_REGEX_10
  );
});

test("normalizeAggregateRequest rejects unsupported top-level query params", () => {
  assert.throws(
    () => normalizeAggregateRequest({ bogus: "1", metric: "count" }, {}, manifestFixture()),
    TOP_LEVEL_REGEX_11
  );
});
