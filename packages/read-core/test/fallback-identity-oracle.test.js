import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRecordContentLadder } from '../src/index.js';

test('buildRecordContentLadder preserves fallback identity for projected records', () => {
  const ladder = buildRecordContentLadder(
    {
      data: {
        body: 'hello world',
      },
    },
    {
      fallback: {
        stream: 'messages',
        recordId: 'm1',
        connectionId: 'cin_a',
      },
    },
  );

  assert.equal(ladder.id, 'cin_a/messages:m1');
  assert.equal(ladder.connection_id, 'cin_a');
  assert.equal(ladder.stream, 'messages');
  assert.equal(ladder.record_id, 'm1');
  assert.deepEqual(ladder.field_windows[0].read.args, {
    id: 'cin_a/messages:m1',
    field_path: 'body',
    offset_chars: 0,
    limit_chars: 2048,
  });
});
