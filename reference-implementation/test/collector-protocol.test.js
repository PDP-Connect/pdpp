// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Unit tests for the collector protocol compatibility surface
// (server/collector-protocol.ts).
//
// These are pure, deterministic helpers: an accepted-version classifier, a
// header normalizer (string | string[] | undefined), and a mismatch-body
// builder. Assertions pin the empty-string guard, the array-takes-first
// rule, the trim behavior, and the snapshot semantics of the accepted set.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  COLLECTOR_PROTOCOL_HEADER,
  COLLECTOR_PROTOCOL_VERSION,
  SUPPORTED_COLLECTOR_PROTOCOL_VERSIONS,
  buildCollectorProtocolMismatchBody,
  isAcceptedCollectorProtocolVersion,
  readCollectorProtocolHeader,
} from '../server/collector-protocol.ts';

test('isAcceptedCollectorProtocolVersion accepts the current version by default', () => {
  assert.equal(isAcceptedCollectorProtocolVersion(COLLECTOR_PROTOCOL_VERSION), true);
  assert.ok(SUPPORTED_COLLECTOR_PROTOCOL_VERSIONS.includes(COLLECTOR_PROTOCOL_VERSION));
});

test('isAcceptedCollectorProtocolVersion rejects non-strings and empty string', () => {
  // Guard: `typeof version !== "string" || version.length === 0`.
  assert.equal(isAcceptedCollectorProtocolVersion(null), false);
  assert.equal(isAcceptedCollectorProtocolVersion(undefined), false);
  assert.equal(isAcceptedCollectorProtocolVersion(1), false);
  assert.equal(isAcceptedCollectorProtocolVersion(''), false);
});

test('isAcceptedCollectorProtocolVersion rejects a version outside the accepted set', () => {
  assert.equal(isAcceptedCollectorProtocolVersion('999'), false);
  // Honors a caller-supplied accepted set.
  assert.equal(isAcceptedCollectorProtocolVersion('2', ['1', '2']), true);
  assert.equal(isAcceptedCollectorProtocolVersion('3', ['1', '2']), false);
});

test('readCollectorProtocolHeader reads and trims a string header', () => {
  assert.equal(readCollectorProtocolHeader({ [COLLECTOR_PROTOCOL_HEADER]: '  1  ' }), '1');
  assert.equal(readCollectorProtocolHeader({ [COLLECTOR_PROTOCOL_HEADER]: '2' }), '2');
});

test('readCollectorProtocolHeader takes the first element of an array header', () => {
  assert.equal(readCollectorProtocolHeader({ [COLLECTOR_PROTOCOL_HEADER]: ['  1 ', '2'] }), '1');
});

test('readCollectorProtocolHeader returns null for absent / blank / empty-array headers', () => {
  assert.equal(readCollectorProtocolHeader({}), null);
  assert.equal(readCollectorProtocolHeader({ [COLLECTOR_PROTOCOL_HEADER]: '   ' }), null);
  assert.equal(readCollectorProtocolHeader({ [COLLECTOR_PROTOCOL_HEADER]: [] }), null);
  assert.equal(readCollectorProtocolHeader({ [COLLECTOR_PROTOCOL_HEADER]: [''] }), null);
});

test('buildCollectorProtocolMismatchBody echoes received version and snapshots accepted set', () => {
  const body = buildCollectorProtocolMismatchBody('7');
  assert.equal(body.received_version, '7');
  assert.deepEqual(body.accepted_versions, [...SUPPORTED_COLLECTOR_PROTOCOL_VERSIONS]);
  // received null is preserved (legacy_unknown drift path).
  assert.equal(buildCollectorProtocolMismatchBody(null).received_version, null);
});

test('buildCollectorProtocolMismatchBody copies the accepted set (not the same reference)', () => {
  const accepted = ['1', '2'];
  const body = buildCollectorProtocolMismatchBody('3', accepted);
  assert.deepEqual(body.accepted_versions, ['1', '2']);
  // Mutating the returned array must not affect the caller's source array.
  body.accepted_versions.push('mutated');
  assert.deepEqual(accepted, ['1', '2']);
});
