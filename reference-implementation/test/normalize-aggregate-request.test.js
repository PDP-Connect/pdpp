// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit coverage for the UNTESTED aggregate-request read-model shaper
 * `normalizeAggregateRequest(requestParams, streamGrant, manifestStream)` in
 * `server/record-aggregation.js`. It validates + normalizes the `/aggregate`
 * request into a canonical `{metric, field, groupBy, groupByTime, granularity,
 * timeZone, limit}` shape, throwing `invalidQueryError` (typed code) per
 * violation.
 *
 * Pinned here (the paths reachable with a minimal manifest/grant — the full
 * time-bucket aggregation declaration is exercised by the operation-level
 * aggregate tests):
 *   - top-level: an unsupported query param is rejected; a bad metric is
 *     rejected; a stream with no declared aggregations is rejected.
 *   - grouping: group_by AND group_by_time together is rejected (XOR).
 *   - granularity: required with group_by_time; a bad granularity value is
 *     rejected; granularity/time_zone WITHOUT group_by_time is rejected.
 *   - count: `field` is not allowed; count must be declared.
 *   - count_distinct: `field` required; grouping not allowed; the field must be
 *     granted, declared, and scalar.
 *   - a valid `count` and a valid `count_distinct` normalize to the canonical
 *     shape.
 *
 * Pure given the fixtures. No DB, no server.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeAggregateRequest } from '../server/record-aggregation.js';

// A manifest declaring count + count_distinct(sku), with a scalar field `sku`.
function manifest() {
  return {
    name: 'orders',
    query: { aggregations: { count: true, count_distinct: ['sku'] } },
    schema: { properties: { sku: { type: 'string' }, ordered_at: { type: 'string', format: 'date-time' } } },
  };
}

// Grant fields as a name array (the shape requireAggregateFieldGranted expects).
function grant() {
  return { fields: ['sku', 'ordered_at'] };
}

function assertRejects(requestParams, messagePart, { m = manifest(), g = grant() } = {}) {
  assert.throws(
    () => normalizeAggregateRequest(requestParams, g, m),
    (err) => {
      assert.ok(
        String(err.message).includes(messagePart),
        `message ${JSON.stringify(err.message)} lacks ${JSON.stringify(messagePart)}`,
      );
      return true;
    },
  );
}

// --- valid normalization ----------------------------------------------------

test('normalizeAggregateRequest: a plain count normalizes to the canonical shape', () => {
  assert.deepEqual(normalizeAggregateRequest({ metric: 'count' }, grant(), manifest()), {
    metric: 'count',
    field: null,
    groupBy: null,
    groupByTime: null,
    granularity: null,
    timeZone: null,
    limit: null,
  });
});

test('normalizeAggregateRequest: a valid count_distinct on a scalar granted field normalizes', () => {
  assert.deepEqual(normalizeAggregateRequest({ metric: 'count_distinct', field: 'sku' }, grant(), manifest()), {
    metric: 'count_distinct',
    field: 'sku',
    groupBy: null,
    groupByTime: null,
    granularity: null,
    timeZone: null,
    limit: null,
  });
});

// --- top-level validation ---------------------------------------------------

test('normalizeAggregateRequest: an unsupported query parameter is rejected', () => {
  assertRejects({ metric: 'count', bogus_param: 1 }, 'Unsupported query parameter: bogus_param');
});

test('normalizeAggregateRequest: an unknown metric is rejected', () => {
  assertRejects({ metric: 'average' }, 'metric must be one of count, sum, min, max, count_distinct');
});

test('normalizeAggregateRequest: a stream with no declared aggregations is rejected', () => {
  assertRejects({ metric: 'count' }, "Aggregations are not declared for stream 'orders'", {
    m: { name: 'orders', query: {}, schema: { properties: {} } },
  });
});

// --- grouping XOR + granularity/time_zone gates -----------------------------

test('normalizeAggregateRequest: group_by and group_by_time together is rejected', () => {
  assertRejects(
    { metric: 'count', group_by: 'sku', group_by_time: 'ordered_at' },
    'group_by and group_by_time cannot be combined',
  );
});

test('normalizeAggregateRequest: group_by_time requires a granularity', () => {
  assertRejects({ metric: 'count', group_by_time: 'ordered_at' }, 'granularity is required when group_by_time is present');
});

test('normalizeAggregateRequest: an unsupported granularity value is rejected', () => {
  assertRejects(
    { metric: 'count', group_by_time: 'ordered_at', granularity: 'decade' },
    'granularity must be one of',
  );
});

test('normalizeAggregateRequest: granularity or time_zone WITHOUT group_by_time is rejected', () => {
  assertRejects({ metric: 'count', granularity: 'day' }, 'granularity is only supported with group_by_time');
  assertRejects({ metric: 'count', time_zone: 'UTC' }, 'time_zone is only supported with group_by_time');
});

// --- count metric gates -----------------------------------------------------

test('normalizeAggregateRequest: count does not accept a field', () => {
  assertRejects({ metric: 'count', field: 'sku' }, 'field is not supported for count');
});

test('normalizeAggregateRequest: count must be declared in the manifest', () => {
  assertRejects({ metric: 'count' }, "Count aggregation is not declared for stream 'orders'", {
    m: { name: 'orders', query: { aggregations: { count_distinct: ['sku'] } }, schema: { properties: { sku: { type: 'string' } } } },
  });
});

// --- count_distinct metric gates --------------------------------------------

test('normalizeAggregateRequest: count_distinct requires a field', () => {
  assertRejects({ metric: 'count_distinct' }, 'field is required for count_distinct');
});

test('normalizeAggregateRequest: count_distinct does not support grouping', () => {
  assertRejects(
    { metric: 'count_distinct', field: 'sku', group_by: 'sku' },
    'count_distinct does not support grouping',
  );
});

test('normalizeAggregateRequest: count_distinct rejects an ungranted field', () => {
  // ordered_at is a known scalar field but not in this grant.
  assertRejects({ metric: 'count_distinct', field: 'ordered_at' }, "not in grant", {
    g: { fields: ['sku'] },
  });
});

test('normalizeAggregateRequest: count_distinct rejects an unknown field', () => {
  assertRejects({ metric: 'count_distinct', field: 'nonexistent' }, 'Unknown field: nonexistent');
});
