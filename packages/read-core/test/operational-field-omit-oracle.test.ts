// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRecordContentLadder } from '../src/index.js';

test('buildRecordContentLadder omits operational fields from evidence projections', () => {
  const ladder = buildRecordContentLadder({
    id: 'cin_a/messages:m1',
    data: {
      connection_id: 'cin_a',
      stream: 'messages',
      id: 'm1',
      metadata: { x: 1 },
      body: 'hello',
    },
  });

  assert.deepEqual(
    ladder.field_windows.map((field) => field.field_path),
    ['body'],
  );

  assert.ok(
    !(ladder.json_fields ?? []).some((field) => field.field_path === 'metadata'),
  );
});
