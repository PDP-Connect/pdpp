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

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveAggregateTimeZone,
  bucketStartForGranularity,
  normalizeAggregateRequest,
} from '../server/record-aggregation.js';

test('resolveAggregateTimeZone defaults to UTC and rejects unknown zones', () => {
  assert.equal(resolveAggregateTimeZone(null), 'UTC');
  assert.equal(resolveAggregateTimeZone(''), 'UTC');
  assert.equal(resolveAggregateTimeZone('America/New_York'), 'America/New_York');
  assert.throws(() => resolveAggregateTimeZone('Mars/Phobos'), /Unknown time_zone/);
});

test('bucketStartForGranularity truncates to calendar buckets in UTC', () => {
  const ts = '2026-07-02T13:45:30Z'; // Thursday
  assert.equal(bucketStartForGranularity(ts, 'minute', 'UTC'), '2026-07-02T13:45');
  assert.equal(bucketStartForGranularity(ts, 'hour', 'UTC'), '2026-07-02T13:00');
  assert.equal(bucketStartForGranularity(ts, 'day', 'UTC'), '2026-07-02');
  assert.equal(bucketStartForGranularity(ts, 'month', 'UTC'), '2026-07-01');
  assert.equal(bucketStartForGranularity(ts, 'quarter', 'UTC'), '2026-07-01'); // Q3 -> July
  assert.equal(bucketStartForGranularity(ts, 'year', 'UTC'), '2026-01-01');
});

test('bucketStartForGranularity snaps weeks back to Monday', () => {
  // 2026-07-02 is a Thursday; the Monday of that ISO week is 2026-06-29.
  assert.equal(bucketStartForGranularity('2026-07-02T00:00:00Z', 'week', 'UTC'), '2026-06-29');
  // A Monday maps to itself.
  assert.equal(bucketStartForGranularity('2026-06-29T12:00:00Z', 'week', 'UTC'), '2026-06-29');
  // A Sunday belongs to the week that started the previous Monday.
  assert.equal(bucketStartForGranularity('2026-07-05T23:00:00Z', 'week', 'UTC'), '2026-06-29');
});

test('bucketStartForGranularity picks the correct quarter start month', () => {
  assert.equal(bucketStartForGranularity('2026-02-15T00:00:00Z', 'quarter', 'UTC'), '2026-01-01'); // Q1
  assert.equal(bucketStartForGranularity('2026-05-15T00:00:00Z', 'quarter', 'UTC'), '2026-04-01'); // Q2
  assert.equal(bucketStartForGranularity('2026-11-15T00:00:00Z', 'quarter', 'UTC'), '2026-10-01'); // Q4
});

test('bucketStartForGranularity returns null for null/unparseable/unknown granularity', () => {
  assert.equal(bucketStartForGranularity(null, 'day', 'UTC'), null);
  assert.equal(bucketStartForGranularity('not-a-date', 'day', 'UTC'), null);
  assert.equal(bucketStartForGranularity('2026-07-02T00:00:00Z', 'fortnight', 'UTC'), null);
});

// --- normalizeAggregateRequest -------------------------------------------

function manifestFixture() {
  return {
    name: 'orders',
    query: {
      aggregations: {
        count: true,
        sum: ['total'],
        min: ['created_at'],
        count_distinct: ['status'],
        group_by: ['status'],
        group_by_time: ['created_at'],
      },
    },
    schema: {
      properties: {
        total: { type: 'number' },
        status: { type: 'string' },
        created_at: { type: 'string', format: 'date-time' },
      },
    },
  };
}

test('normalizeAggregateRequest accepts a bare count', () => {
  const out = normalizeAggregateRequest({ metric: 'count' }, {}, manifestFixture());
  assert.deepEqual(out, {
    metric: 'count', field: null, groupBy: null, groupByTime: null,
    granularity: null, timeZone: null, limit: null,
  });
});

test('normalizeAggregateRequest resolves a grouped count with default + custom limit', () => {
  const ms = manifestFixture();
  const def = normalizeAggregateRequest({ metric: 'count', group_by: 'status' }, {}, ms);
  assert.equal(def.groupBy, 'status');
  assert.equal(def.limit, 10);
  const custom = normalizeAggregateRequest({ metric: 'count', group_by: 'status', limit: '25' }, {}, ms);
  assert.equal(custom.limit, 25);
});

test('normalizeAggregateRequest resolves a group_by_time count with granularity + zone', () => {
  const ms = manifestFixture();
  const out = normalizeAggregateRequest(
    { metric: 'count', group_by_time: 'created_at', granularity: 'month', time_zone: 'America/New_York' },
    {}, ms,
  );
  assert.equal(out.groupByTime, 'created_at');
  assert.equal(out.granularity, 'month');
  assert.equal(out.timeZone, 'America/New_York');
});

test('normalizeAggregateRequest rejects an unsupported metric', () => {
  assert.throws(
    () => normalizeAggregateRequest({ metric: 'median' }, {}, manifestFixture()),
    (e) => e.code === 'invalid_request' && /metric must be one of/.test(e.message),
  );
});

test('normalizeAggregateRequest rejects a field for count and requires one for sum', () => {
  const ms = manifestFixture();
  assert.throws(
    () => normalizeAggregateRequest({ metric: 'count', field: 'total' }, {}, ms),
    /field is not supported for count/,
  );
  assert.throws(
    () => normalizeAggregateRequest({ metric: 'sum' }, {}, ms),
    /field is required for sum/,
  );
});

test('normalizeAggregateRequest flags an unknown field with unknown_field', () => {
  assert.throws(
    () => normalizeAggregateRequest({ metric: 'sum', field: 'nope' }, {}, manifestFixture()),
    (e) => e.code === 'unknown_field',
  );
});

test('normalizeAggregateRequest surfaces field_not_granted from the grant', () => {
  const grant = { fields: ['status'] }; // total not granted
  assert.throws(
    () => normalizeAggregateRequest({ metric: 'sum', field: 'total' }, grant, manifestFixture()),
    (e) => e.code === 'field_not_granted',
  );
});

test('normalizeAggregateRequest rejects combining group_by with group_by_time', () => {
  assert.throws(
    () => normalizeAggregateRequest(
      { metric: 'count', group_by: 'status', group_by_time: 'created_at', granularity: 'day' }, {}, manifestFixture(),
    ),
    /cannot be combined/,
  );
});

test('normalizeAggregateRequest requires granularity with group_by_time and forbids it otherwise', () => {
  const ms = manifestFixture();
  assert.throws(
    () => normalizeAggregateRequest({ metric: 'count', group_by_time: 'created_at' }, {}, ms),
    /granularity is required/,
  );
  assert.throws(
    () => normalizeAggregateRequest({ metric: 'count', group_by: 'status', granularity: 'day' }, {}, ms),
    /granularity is only supported with group_by_time/,
  );
});

test('normalizeAggregateRequest limit must be a positive bounded integer', () => {
  const ms = manifestFixture();
  assert.throws(
    () => normalizeAggregateRequest({ metric: 'count', limit: '5' }, {}, ms),
    /limit is only supported with group_by/,
  );
  assert.throws(
    () => normalizeAggregateRequest({ metric: 'count', group_by: 'status', limit: '0' }, {}, ms),
    /limit must be an integer between 1 and 100/,
  );
  assert.throws(
    () => normalizeAggregateRequest({ metric: 'count', group_by: 'status', limit: '101' }, {}, ms),
    /limit must be an integer between 1 and 100/,
  );
});

test('normalizeAggregateRequest rejects unsupported top-level query params', () => {
  assert.throws(
    () => normalizeAggregateRequest({ metric: 'count', bogus: '1' }, {}, manifestFixture()),
    /Unsupported query parameter: bogus/,
  );
});
