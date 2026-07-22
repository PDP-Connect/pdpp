// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure, no-DB unit tests for the collector-protocol compatibility helpers in
// server/collector-protocol.ts. The VERSION constant is referenced by HTTP tests,
// but the three pure functions had zero by-name coverage. These decide whether a
// collector's declared protocol version is accepted before any record persists —
// a wrong verdict either rejects a compatible collector or silently ingests from
// a drifted one.
//
// Mutation surface:
//   isAcceptedCollectorProtocolVersion -- non-empty-string guard + membership in
//     the accepted set (null/'' -> false).
//   readCollectorProtocolHeader -- array-first extraction, trim, blank -> null.
//   buildCollectorProtocolMismatchBody -- copies accepted_versions + echoes the
//     received (possibly null) version.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COLLECTOR_PROTOCOL_HEADER,
  COLLECTOR_PROTOCOL_VERSION,
  SUPPORTED_COLLECTOR_PROTOCOL_VERSIONS,
  buildCollectorProtocolMismatchBody,
  isAcceptedCollectorProtocolVersion,
  readCollectorProtocolHeader,
} from '../server/collector-protocol.ts';

test('isAcceptedCollectorProtocolVersion: the current version is accepted', () => {
  assert.equal(isAcceptedCollectorProtocolVersion(COLLECTOR_PROTOCOL_VERSION), true);
  assert.ok(SUPPORTED_COLLECTOR_PROTOCOL_VERSIONS.includes(COLLECTOR_PROTOCOL_VERSION), 'version is in the supported set');
});

test('isAcceptedCollectorProtocolVersion: unknown / blank / non-string versions are rejected', () => {
  assert.equal(isAcceptedCollectorProtocolVersion('999'), false, 'unlisted version rejected');
  assert.equal(isAcceptedCollectorProtocolVersion(''), false);
  assert.equal(isAcceptedCollectorProtocolVersion(null), false);
  assert.equal(isAcceptedCollectorProtocolVersion(undefined), false);
  assert.equal(isAcceptedCollectorProtocolVersion(1), false, 'a number is not an accepted version string');
});

test('isAcceptedCollectorProtocolVersion: honors a custom accepted set', () => {
  assert.equal(isAcceptedCollectorProtocolVersion('2', ['1', '2']), true, 'custom set accepts 2');
  assert.equal(isAcceptedCollectorProtocolVersion('3', ['1', '2']), false);
});

test('readCollectorProtocolHeader: reads the canonical header, trimmed', () => {
  assert.equal(readCollectorProtocolHeader({ [COLLECTOR_PROTOCOL_HEADER]: '  1  ' }), '1');
  assert.equal(readCollectorProtocolHeader({ [COLLECTOR_PROTOCOL_HEADER]: '2' }), '2');
});

test('readCollectorProtocolHeader: an array-valued header uses the first entry (trimmed)', () => {
  assert.equal(readCollectorProtocolHeader({ [COLLECTOR_PROTOCOL_HEADER]: ['  7  ', '8'] }), '7');
});

test('readCollectorProtocolHeader: absent / blank header -> null', () => {
  assert.equal(readCollectorProtocolHeader({}), null);
  assert.equal(readCollectorProtocolHeader({ [COLLECTOR_PROTOCOL_HEADER]: '   ' }), null);
  assert.equal(readCollectorProtocolHeader({ [COLLECTOR_PROTOCOL_HEADER]: [] }), null, 'empty array -> null');
  assert.equal(readCollectorProtocolHeader({ [COLLECTOR_PROTOCOL_HEADER]: [' '] }), null, 'blank first entry -> null');
});

test('buildCollectorProtocolMismatchBody: copies accepted versions and echoes the received version', () => {
  const body = buildCollectorProtocolMismatchBody('999', ['1', '2']);
  assert.deepEqual(body.accepted_versions, ['1', '2']);
  assert.equal(body.received_version, '999');
});

test('buildCollectorProtocolMismatchBody: a null received version is preserved (legacy device)', () => {
  const body = buildCollectorProtocolMismatchBody(null);
  assert.equal(body.received_version, null, 'legacy null version echoed, not defaulted');
  assert.deepEqual(body.accepted_versions, [...SUPPORTED_COLLECTOR_PROTOCOL_VERSIONS]);
});

test('buildCollectorProtocolMismatchBody: accepted_versions is a COPY, not the shared array', () => {
  const body = buildCollectorProtocolMismatchBody('x');
  assert.notEqual(body.accepted_versions, SUPPORTED_COLLECTOR_PROTOCOL_VERSIONS, 'must be a fresh array, not the module constant');
  body.accepted_versions.push('mutation');
  assert.ok(!SUPPORTED_COLLECTOR_PROTOCOL_VERSIONS.includes('mutation'), 'mutating the body must not leak into the module constant');
});
