import assert from 'node:assert/strict';
import test from 'node:test';

import { __internal } from '../src/tools.js';

const { parseRecordResultId } = __internal;

test('parseRecordResultId parses self-contained result ids', () => {
  assert.deepEqual(parseRecordResultId('conn_a/orders:o1'), {
    connectionId: 'conn_a',
    stream: 'orders',
    recordId: 'o1',
  });
});

test('parseRecordResultId parses legacy stream record ids', () => {
  assert.deepEqual(parseRecordResultId('orders:o1'), {
    connectionId: null,
    stream: 'orders',
    recordId: 'o1',
  });
});

test('parseRecordResultId parses canonical record resource uris', () => {
  const id =
    'pdpp://record/' +
    Buffer.from(
      JSON.stringify({
        v: 1,
        kind: 'record',
        connection_id: 'conn_a',
        stream: 'orders',
        record_id: 'o1',
      }),
    ).toString('base64url');

  assert.deepEqual(parseRecordResultId(id), {
    connectionId: 'conn_a',
    stream: 'orders',
    recordId: 'o1',
  });
});

test('parseRecordResultId falls back to embedded result grammar in record uris', () => {
  const id = 'pdpp://record/' + encodeURIComponent('conn_a/orders:o1');

  assert.deepEqual(parseRecordResultId(id), {
    connectionId: 'conn_a',
    stream: 'orders',
    recordId: 'o1',
  });
});

test('parseRecordResultId rejects malformed ids', () => {
  assert.throws(() => parseRecordResultId(''));
  assert.throws(() => parseRecordResultId(123));
  assert.throws(() => parseRecordResultId('noseparator'));
  assert.throws(() => parseRecordResultId('orders:'));
  assert.throws(() => parseRecordResultId(':o1'));
});
