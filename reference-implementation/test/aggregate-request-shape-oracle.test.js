// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure-logic oracle for the grant-independent request-shape validation of
// normalizeAggregateRequest (server/record-aggregation.js), the MCP aggregate
// read-model contract. These branches all reject (or accept the bare count
// case) BEFORE any grant/field-declaration check, so they are exercised with a
// plain manifest and no grant surface. Previously untested by name. No DB.
//
// (The field-scoped success paths that reach requireAggregateFieldGranted are
// intentionally NOT exercised here — this oracle pins only the request-shape
// guards.)

import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeAggregateRequest } from '../server/record-aggregation.js';

const MANIFEST_STREAM = {
  name: 'orders',
  query: { aggregations: { count: true, group_by: ['status'], group_by_time: ['created_at'] } },
  schema: {
    properties: {
      status: { type: 'string' },
      created_at: { type: 'string', format: 'date-time' },
    },
  },
};

function invalidRequest(messageSubstring) {
  return (err) => {
    assert.ok(
      err.message.includes(messageSubstring),
      `expected message to include ${JSON.stringify(messageSubstring)}, got ${JSON.stringify(err.message)}`
    );
    return true;
  };
}

test('normalizeAggregateRequest accepts a bare count with no field or grouping', () => {
  const normalized = normalizeAggregateRequest({ metric: 'count' }, null, MANIFEST_STREAM);
  assert.deepEqual(normalized, {
    metric: 'count',
    field: null,
    groupBy: null,
    groupByTime: null,
    granularity: null,
    timeZone: null,
    limit: null,
  });
});

test('normalizeAggregateRequest rejects combining group_by and group_by_time', () => {
  assert.throws(
    () => normalizeAggregateRequest({ metric: 'count', group_by: 'status', group_by_time: 'created_at' }, null, MANIFEST_STREAM),
    invalidRequest('group_by and group_by_time cannot be combined')
  );
});

test('normalizeAggregateRequest rejects a field on a count metric', () => {
  assert.throws(
    () => normalizeAggregateRequest({ metric: 'count', field: 'status' }, null, MANIFEST_STREAM),
    invalidRequest('field is not supported for count')
  );
});

test('normalizeAggregateRequest enforces the granularity/group_by_time coupling', () => {
  // group_by_time without granularity is rejected...
  assert.throws(
    () => normalizeAggregateRequest({ metric: 'count', group_by_time: 'created_at' }, null, MANIFEST_STREAM),
    invalidRequest('granularity is required when group_by_time is present')
  );
  // ...and granularity without group_by_time is rejected.
  assert.throws(
    () => normalizeAggregateRequest({ metric: 'count', granularity: 'day' }, null, MANIFEST_STREAM),
    invalidRequest('granularity is only supported with group_by_time')
  );
  // time_zone without group_by_time is rejected.
  assert.throws(
    () => normalizeAggregateRequest({ metric: 'count', time_zone: 'UTC' }, null, MANIFEST_STREAM),
    invalidRequest('time_zone is only supported with group_by_time')
  );
});

test('normalizeAggregateRequest rejects an unknown metric, a missing aggregations block, and an unsupported param', () => {
  assert.throws(
    () => normalizeAggregateRequest({ metric: 'fuzzy' }, null, MANIFEST_STREAM),
    invalidRequest('metric must be one of count, sum, min, max, count_distinct')
  );
  assert.throws(
    () => normalizeAggregateRequest({ metric: 'count' }, null, { name: 'x', query: {} }),
    invalidRequest("Aggregations are not declared for stream 'x'")
  );
  assert.throws(
    () => normalizeAggregateRequest({ metric: 'count', bogus: 'x' }, null, MANIFEST_STREAM),
    invalidRequest('Unsupported query parameter: bogus')
  );
});
