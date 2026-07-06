import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildReadRequest } from '../src/read/commands.js';
import { PdppUsageError } from '../src/ref/errors.js';

test('read aggregate rejects group-by and group-by-time together', () => {
  assert.throws(
    () =>
      buildReadRequest(
        'aggregate',
        ['messages'],
        {
          metric: 'count',
          'group-by': 'author',
          'group-by-time': 'sent_at',
          granularity: 'day',
        },
        'https://provider.test',
      ),
    (error) => error instanceof PdppUsageError && /Use only one/.test(error.message),
  );
});

test('read aggregate builds group-by-time query shape', () => {
  const request = buildReadRequest(
    'aggregate',
    ['messages'],
    {
      metric: 'count',
      'group-by-time': 'sent_at',
      granularity: 'day',
    },
    'https://provider.test',
  );
  const url = new URL(request.url);

  assert.equal(request.method, 'GET');
  assert.equal(url.pathname, '/v1/streams/messages/aggregate');
  assert.equal(url.searchParams.get('metric'), 'count');
  assert.equal(url.searchParams.get('group_by_time'), 'sent_at');
  assert.equal(url.searchParams.get('granularity'), 'day');
  assert.equal(url.searchParams.has('group_by'), false);
});
