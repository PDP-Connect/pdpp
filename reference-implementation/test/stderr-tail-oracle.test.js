// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { createStderrTailBuffer } from '../runtime/stderr-tail.ts';

console.log('BASELINE: stderr tail oracle present');

test('createStderrTailBuffer: strings and Buffers track observed bytes and keep only the byte-capped tail', () => {
  const tail = createStderrTailBuffer({ capBytes: 7 });

  tail.append('abcdef');
  tail.append(Buffer.from('ghij'));

  const out = tail.finalize();
  assert.deepEqual(out, {
    text: 'defghij',
    bytes_observed: 10,
    bytes_captured: 7,
    truncated: true,
  });
});

test('createStderrTailBuffer: ignored chunks do not affect counts or truncation', () => {
  const tail = createStderrTailBuffer({ capBytes: 8 });

  tail.append(null);
  tail.append(undefined);
  tail.append('');
  tail.append(Buffer.alloc(0));

  assert.deepEqual(tail.finalize(), {
    text: '',
    bytes_observed: 0,
    bytes_captured: 0,
    truncated: false,
  });
});

test('createStderrTailBuffer: bytes_captured is the kept byte length without truncation', () => {
  const tail = createStderrTailBuffer({ capBytes: 32 });

  tail.append('alpha');
  tail.append(Buffer.from('beta'));

  assert.deepEqual(tail.finalize(), {
    text: 'alphabeta',
    bytes_observed: 9,
    bytes_captured: 9,
    truncated: false,
  });
});

test('createStderrTailBuffer: leading sliced UTF-8 is repaired without throwing', () => {
  const tail = createStderrTailBuffer({ capBytes: 3 });

  tail.append(Buffer.from([0xe2, 0x82, 0xac, 0x41]));

  assert.doesNotThrow(() => {
    const out = tail.finalize();
    assert.match(out.text, /\uFFFD/);
    assert.equal(out.text.endsWith('A'), true);
    assert.equal(out.bytes_observed, 4);
    assert.equal(out.bytes_captured, 3);
    assert.equal(out.truncated, true);
  });
});
