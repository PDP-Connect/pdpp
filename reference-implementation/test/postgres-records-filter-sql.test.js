// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { __buildPostgresFilterClauseForTest } from '../server/postgres-records.js';

const transactionsStream = {
  name: 'transactions',
  schema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      date: { type: 'string', format: 'date' },
      amount: { type: 'integer' },
      description: { type: 'string' },
    },
  },
  query: {
    range_filters: {
      date: ['gte', 'lte'],
      amount: ['gte', 'lte'],
    },
  },
};

const ownerGrant = { name: 'transactions' };

test('Postgres records SQL casts declared amount ranges numerically, not as text', () => {
  const { clause, params } = __buildPostgresFilterClauseForTest(
    { amount: { gte: '0', lte: '-50000' } },
    ownerGrant,
    transactionsStream,
  );

  assert.match(clause, /\(record_json->>'amount'\)::numeric >= \$1::numeric/);
  assert.match(clause, /\(record_json->>'amount'\)::numeric <= \$2::numeric/);
  assert.deepEqual(params, ['0', '-50000']);
});

test('Postgres records SQL casts declared date ranges as dates', () => {
  const { clause, params } = __buildPostgresFilterClauseForTest(
    { date: { gte: '2026-05-01', lte: '2026-05-05' } },
    ownerGrant,
    transactionsStream,
  );

  assert.match(clause, /\(record_json->>'date'\)::date >= \$1::date/);
  assert.match(clause, /\(record_json->>'date'\)::date <= \$2::date/);
  assert.deepEqual(params, ['2026-05-01', '2026-05-05']);
});

test('Postgres records SQL builder rejects unsupported range operators before SQL generation', () => {
  assert.throws(
    () => __buildPostgresFilterClauseForTest(
      { amount: { between: '0..10' } },
      ownerGrant,
      transactionsStream,
    ),
    /Unsupported range operator 'between'/,
  );
});
