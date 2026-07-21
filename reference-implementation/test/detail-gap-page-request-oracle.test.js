// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { validateDetailGapsPageRequest } from '../runtime/detail-gap-paging.js';

const scopeByStream = new Map([['messages', {}], ['threads', {}]]);

test('BASELINE: validateDetailGapsPageRequest normalizes a valid page request', () => {
  assert.deepEqual(
    validateDetailGapsPageRequest({
      reference_only: true,
      request_id: 'req1',
      max_bytes: 123.9,
      streams: ['messages', 'messages', 'threads'],
    }, scopeByStream),
    {
      requestId: 'req1',
      maxBytes: 123,
      streams: ['messages', 'threads'],
    },
  );
});

test('validateDetailGapsPageRequest normalizes absent or empty streams to null', () => {
  for (const streams of [null, undefined, []]) {
    assert.equal(
      validateDetailGapsPageRequest({
        reference_only: true,
        request_id: 'req1',
        max_bytes: 123,
        streams,
      }, scopeByStream).streams,
      null,
    );
  }
});

test('validateDetailGapsPageRequest rejects malformed page requests', () => {
  assert.throws(
    () => validateDetailGapsPageRequest({ request_id: 'req1', max_bytes: 123 }, scopeByStream),
    /reference_only/,
  );
  assert.throws(
    () => validateDetailGapsPageRequest({ reference_only: false, request_id: 'req1', max_bytes: 123 }, scopeByStream),
    /reference_only/,
  );
  assert.throws(
    () => validateDetailGapsPageRequest({ reference_only: true, request_id: '   ', max_bytes: 123 }, scopeByStream),
    /request_id/,
  );

  for (const max_bytes of [0, -1, Infinity]) {
    assert.throws(
      () => validateDetailGapsPageRequest({ reference_only: true, request_id: 'req1', max_bytes }, scopeByStream),
      /max_bytes/,
    );
  }

  assert.throws(
    () => validateDetailGapsPageRequest({
      reference_only: true,
      request_id: 'req1',
      max_bytes: 123,
      streams: 'messages',
    }, scopeByStream),
    /streams/,
  );

  for (const stream of ['', '   ', 1]) {
    assert.throws(
      () => validateDetailGapsPageRequest({
        reference_only: true,
        request_id: 'req1',
        max_bytes: 123,
        streams: [stream],
      }, scopeByStream),
      /streams/,
    );
  }

  assert.throws(
    () => validateDetailGapsPageRequest({
      reference_only: true,
      request_id: 'req1',
      max_bytes: 123,
      streams: ['messages', 'profiles'],
    }, scopeByStream),
    /undeclared stream/,
  );
});
