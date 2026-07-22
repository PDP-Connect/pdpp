// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure, no-DB unit tests for the explore-timeline composite + upcoming CURSOR
// CODECS in operations/rs-explore-timeline/index.ts. None are imported by name.
// These encode/decode the pagination cursors for the explore feed; a codec
// regression corrupts pagination (skipped/duplicated rows) or fails to reject a
// forged/incompatible cursor. Base64url+JSON round-trip, version gating, and
// per-partition shape validation are the mutation surface.
//
// Mutation surface:
//   encode/decodeCompositeCursor -- base64url<->JSON round-trip; version gate
//     (only the current version decodes); required fields (snapshotAt string,
//     snapshotSeq number, nowCeiling string, partitions array); per-partition
//     connectorId/stream strings; direction OPTIONAL (defaults to 'desc').
//   encode/decodeUpcomingCursor -- same envelope with the independent upcoming
//     version and connectorType-carrying partitions.
//   All decode failures throw InvalidCompositeCursorError.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  InvalidCompositeCursorError,
  UPCOMING_CURSOR_VERSION,
  decodeCompositeCursor,
  decodeUpcomingCursor,
  encodeCompositeCursor,
  encodeUpcomingCursor,
} from '../operations/rs-explore-timeline/index.ts';

// The composite CURSOR_VERSION is not exported; a valid cursor round-trips, so we
// derive the accepted version by decoding a freshly-encoded valid payload.
const validComposite = {
  version: 4,
  snapshotSeq: 100,
  snapshotAt: '2024-01-01T00:00:00.000Z',
  nowCeiling: '2024-06-01T00:00:00.000Z',
  direction: 'asc',
  partitions: [
    { connectorId: 'ci-1', stream: 'orders', lastSemanticTime: '2024-03-01T00:00:00Z', lastRecordKey: 'k1' },
  ],
};

// ---------------------------------------------------------------------------
// composite cursor
// ---------------------------------------------------------------------------

test('decodeCompositeCursor: round-trips a valid encoded payload', () => {
  const decoded = decodeCompositeCursor(encodeCompositeCursor(validComposite));
  assert.deepEqual(decoded, validComposite, 'encode -> decode is the identity for a valid payload');
});

test('decodeCompositeCursor: direction is optional and defaults to desc', () => {
  const noDirection = { ...validComposite };
  delete noDirection.direction;
  const decoded = decodeCompositeCursor(encodeCompositeCursor(noDirection));
  assert.equal(decoded.direction, 'desc', 'a cursor minted without direction decodes as desc');
});

test('decodeCompositeCursor: an unrecognized direction value falls back to desc', () => {
  const decoded = decodeCompositeCursor(encodeCompositeCursor({ ...validComposite, direction: 'sideways' }));
  assert.equal(decoded.direction, 'desc', 'only "asc" is honored; anything else -> desc');
});

test('decodeCompositeCursor: an incompatible version is rejected', () => {
  assert.throws(
    () => decodeCompositeCursor(encodeCompositeCursor({ ...validComposite, version: 3 })),
    InvalidCompositeCursorError,
  );
});

test('decodeCompositeCursor: garbage / non-JSON / missing fields are rejected', () => {
  assert.throws(() => decodeCompositeCursor('%%% not base64url %%%'), InvalidCompositeCursorError);
  const notJson = Buffer.from('not json at all', 'utf8').toString('base64url');
  assert.throws(() => decodeCompositeCursor(notJson), InvalidCompositeCursorError);
  const missingFields = Buffer.from(JSON.stringify({ version: 4 }), 'utf8').toString('base64url');
  assert.throws(() => decodeCompositeCursor(missingFields), InvalidCompositeCursorError);
});

test('decodeCompositeCursor: a partition missing connectorId/stream is rejected', () => {
  assert.throws(
    () => decodeCompositeCursor(encodeCompositeCursor({ ...validComposite, partitions: [{ connectorId: 'ci-1' }] })),
    InvalidCompositeCursorError,
  );
});

test('decodeCompositeCursor: non-string partition seek fields normalize to null', () => {
  const decoded = decodeCompositeCursor(encodeCompositeCursor({
    ...validComposite,
    partitions: [{ connectorId: 'ci-1', stream: 'orders', lastSemanticTime: 123, lastRecordKey: {} }],
  }));
  assert.equal(decoded.partitions[0].lastSemanticTime, null, 'non-string semantic time -> null');
  assert.equal(decoded.partitions[0].lastRecordKey, null, 'non-string record key -> null');
});

// ---------------------------------------------------------------------------
// upcoming cursor
// ---------------------------------------------------------------------------

const validUpcoming = {
  version: UPCOMING_CURSOR_VERSION,
  snapshotSeq: 5,
  snapshotAt: '2024-01-01T00:00:00.000Z',
  nowCeiling: '2024-06-01T00:00:00.000Z',
  partitions: [
    { connectorId: 'ci-1', connectorType: 'amazon', stream: 'orders', lastSemanticTime: null, lastRecordKey: null },
  ],
};

test('UPCOMING_CURSOR_VERSION is 1', () => {
  assert.equal(UPCOMING_CURSOR_VERSION, 1);
});

test('decodeUpcomingCursor: round-trips a valid payload (carrying connectorType)', () => {
  const decoded = decodeUpcomingCursor(encodeUpcomingCursor(validUpcoming));
  assert.deepEqual(decoded, validUpcoming);
  assert.equal(decoded.partitions[0].connectorType, 'amazon', 'connectorType preserved for partition rebuild');
});

test('decodeUpcomingCursor: an incompatible version is rejected', () => {
  assert.throws(
    () => decodeUpcomingCursor(encodeUpcomingCursor({ ...validUpcoming, version: 2 })),
    InvalidCompositeCursorError,
  );
});

test('decodeUpcomingCursor: garbage and missing-field payloads are rejected', () => {
  assert.throws(() => decodeUpcomingCursor('@@@ invalid @@@'), InvalidCompositeCursorError);
  const missing = Buffer.from(JSON.stringify({ version: UPCOMING_CURSOR_VERSION, snapshotSeq: 5 }), 'utf8').toString('base64url');
  assert.throws(() => decodeUpcomingCursor(missing), InvalidCompositeCursorError);
});
