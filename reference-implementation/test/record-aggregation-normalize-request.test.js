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

import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeAggregateRequest } from '../server/record-aggregation.js';

const STREAM = {
  name: 'events',
  schema: {
    properties: {
      category: { type: 'string' },
      amount: { type: 'number' },
      occurred_at: { type: 'string', format: 'date-time' },
    },
  },
  query: {
    aggregations: {
      count: true,
      sum: ['amount'],
      group_by: ['category'],
      group_by_time: ['occurred_at'],
      count_distinct: ['category'],
    },
  },
};
const GRANT = { fields: ['category', 'amount', 'occurred_at'] };

function assertReject(params, { code = 'invalid_request', messageIncludes } = {}) {
  let thrown;
  try {
    normalizeAggregateRequest(params, GRANT, STREAM);
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, `expected ${JSON.stringify(params)} to throw`);
  assert.equal(thrown.code, code, `expected code=${code} got ${JSON.stringify(thrown.code)} (${thrown.message})`);
  if (messageIncludes !== undefined) {
    assert.ok(String(thrown.message).includes(messageIncludes), `message="${thrown.message}"`);
  }
  return thrown;
}

test('normalizeAggregateRequest: happy paths for count, grouped count, sum, and group_by_time', () => {
  assert.deepEqual(normalizeAggregateRequest({ metric: 'count' }, GRANT, STREAM), {
    metric: 'count',
    field: null,
    groupBy: null,
    groupByTime: null,
    granularity: null,
    timeZone: null,
    limit: null,
  });

  const grouped = normalizeAggregateRequest({ metric: 'count', group_by: 'category' }, GRANT, STREAM);
  assert.equal(grouped.groupBy, 'category');
  assert.equal(grouped.limit, 10, 'grouped count gets the default group limit');

  const sum = normalizeAggregateRequest({ metric: 'sum', field: 'amount' }, GRANT, STREAM);
  assert.equal(sum.metric, 'sum');
  assert.equal(sum.field, 'amount');

  const byTime = normalizeAggregateRequest(
    { metric: 'count', group_by_time: 'occurred_at', granularity: 'day', time_zone: 'UTC' },
    GRANT,
    STREAM,
  );
  assert.equal(byTime.groupByTime, 'occurred_at');
  assert.equal(byTime.granularity, 'day');
  assert.equal(byTime.timeZone, 'UTC');
});

test('normalizeAggregateRequest: rejects unsupported params and undeclared aggregations', () => {
  assertReject({ metric: 'count', bogus_param: '1' }, { messageIncludes: 'Unsupported query parameter' });

  // A stream with no aggregations declared -> rejected.
  let thrown;
  try {
    normalizeAggregateRequest({ metric: 'count' }, GRANT, { name: 'events', query: {} });
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown && /Aggregations are not declared/.test(thrown.message), thrown?.message);
});

test('normalizeAggregateRequest: metric vocabulary is enforced', () => {
  assertReject({ metric: 'median' }, { messageIncludes: 'metric must be one of' });
  assertReject({ metric: '' }, { messageIncludes: 'metric must be one of' });
});

test('normalizeAggregateRequest: group_by and group_by_time are mutually exclusive', () => {
  assertReject(
    { metric: 'count', group_by: 'category', group_by_time: 'occurred_at' },
    { messageIncludes: 'cannot be combined' },
  );
});

test('normalizeAggregateRequest: granularity is required with group_by_time and forbidden without', () => {
  // Required when group_by_time present.
  assertReject({ metric: 'count', group_by_time: 'occurred_at' }, { messageIncludes: 'granularity is required' });
  // Invalid granularity unit.
  assertReject(
    { metric: 'count', group_by_time: 'occurred_at', granularity: 'fortnight' },
    { messageIncludes: 'granularity must be one of' },
  );
  // Forbidden without group_by_time.
  assertReject({ metric: 'count', granularity: 'day' }, { messageIncludes: 'granularity is only supported with group_by_time' });
  // time_zone forbidden without group_by_time.
  assertReject({ metric: 'count', time_zone: 'UTC' }, { messageIncludes: 'time_zone is only supported with group_by_time' });
});

test('normalizeAggregateRequest: count forbids a field; count_distinct requires one and forbids grouping', () => {
  // count must not carry a field.
  assertReject({ metric: 'count', field: 'amount' }, { messageIncludes: 'field is not supported for count' });

  // count_distinct requires a field.
  assertReject({ metric: 'count_distinct' }, { messageIncludes: 'field is required for count_distinct' });
  // count_distinct cannot be grouped.
  assertReject(
    { metric: 'count_distinct', field: 'category', group_by: 'category' },
    { messageIncludes: 'count_distinct does not support grouping' },
  );
  // count_distinct happy path.
  const cd = normalizeAggregateRequest({ metric: 'count_distinct', field: 'category' }, GRANT, STREAM);
  assert.equal(cd.metric, 'count_distinct');
  assert.equal(cd.field, 'category');
});

test('normalizeAggregateRequest: unknown/ungranted fields get specialized error codes', () => {
  // A field absent from the schema -> unknown_field.
  assertReject({ metric: 'sum', field: 'ghost' }, { code: 'unknown_field', messageIncludes: 'Unknown field' });

  // A field present in schema + aggregations but NOT in the grant -> field_not_granted.
  const narrowGrant = { fields: ['category'] }; // amount not granted
  let thrown;
  try {
    normalizeAggregateRequest({ metric: 'sum', field: 'amount' }, narrowGrant, STREAM);
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, 'ungranted field must throw');
  assert.equal(thrown.code, 'field_not_granted');
});

test('normalizeAggregateRequest: limit is only valid with grouping and must be an integer in [1, MAX]', () => {
  // limit without grouping -> rejected.
  assertReject({ metric: 'count', limit: '5' }, { messageIncludes: 'limit is only supported with group_by' });
  // Non-integer limit with grouping -> rejected.
  assertReject(
    { metric: 'count', group_by: 'category', limit: 'abc' },
    { messageIncludes: 'limit must be an integer' },
  );
  // Below range.
  assertReject({ metric: 'count', group_by: 'category', limit: '0' }, { messageIncludes: 'between 1 and' });
  // A valid grouped limit is honored.
  const ok = normalizeAggregateRequest({ metric: 'count', group_by: 'category', limit: '7' }, GRANT, STREAM);
  assert.equal(ok.limit, 7);
});
