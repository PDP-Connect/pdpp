import assert from 'node:assert/strict';
import { test } from 'node:test';

import { __internal } from '../src/tools.js';

test('pickQuery drops route and nested query objects while keeping supported scalar args', () => {
  const args = {
    stream: 'messages',
    filter: { sent_at: { gte: '2026-01-01' } },
    expand_limit: { line_items: 2 },
    cursor: 'cur_1',
    limit: 5,
    connection_id: 'cin_a',
  };
  const supportedKeys = new Set(Object.keys(args));

  const query = __internal.pickQuery(args, supportedKeys);

  assert.deepEqual(query, {
    cursor: 'cur_1',
    limit: 5,
    connection_id: 'cin_a',
  });
  assert.equal('stream' in query, false);
  assert.equal('filter' in query, false);
  assert.equal('expand_limit' in query, false);
});
