// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Unit tests for the pure /_ref record helpers (server/ref-record-utils.ts).
//
// These functions are deterministic (no I/O, no clock) and carry dense
// boundary logic — cursor codec round-trips, inclusive time-window bounds,
// date-only boundary expansion, and the FTS match-expression classifier.
// The assertions below are written to be mutation-killing: each pins a
// specific boundary/guard so a flipped comparator or dropped guard turns
// the suite red.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  buildRecordSearchMatchExpression,
  chooseDisplayTimestamp,
  compareTimestampValues,
  decodeOffsetCursor,
  encodeOffsetCursor,
  findQueryMatch,
  timestampWithinWindow,
} from '../server/ref-record-utils.ts';

test('encodeOffsetCursor / decodeOffsetCursor round-trip', () => {
  for (const offset of [0, 1, 25, 1000]) {
    const cursor = encodeOffsetCursor(offset);
    assert.equal(typeof cursor, 'string');
    assert.equal(decodeOffsetCursor(cursor), offset);
  }
});

test('decodeOffsetCursor rejects non-string and empty input', () => {
  assert.equal(decodeOffsetCursor(undefined), null);
  assert.equal(decodeOffsetCursor(null), null);
  assert.equal(decodeOffsetCursor(123), null);
  assert.equal(decodeOffsetCursor(''), null);
});

test('decodeOffsetCursor rejects negative and non-integer offsets', () => {
  // Guards: `offset < 0` and `Number.isInteger(offset)`. A mutant that
  // drops either guard would accept these malformed cursors.
  const negative = Buffer.from(JSON.stringify({ offset: -1 }), 'utf8').toString('base64url');
  const fractional = Buffer.from(JSON.stringify({ offset: 1.5 }), 'utf8').toString('base64url');
  const stringOffset = Buffer.from(JSON.stringify({ offset: '3' }), 'utf8').toString('base64url');
  assert.equal(decodeOffsetCursor(negative), null);
  assert.equal(decodeOffsetCursor(fractional), null);
  assert.equal(decodeOffsetCursor(stringOffset), null);
  // Zero is a valid, non-negative integer offset (boundary of `< 0`).
  const zero = Buffer.from(JSON.stringify({ offset: 0 }), 'utf8').toString('base64url');
  assert.equal(decodeOffsetCursor(zero), 0);
});

test('decodeOffsetCursor returns null for non-object / unparseable payloads', () => {
  const arrayPayload = Buffer.from(JSON.stringify([1, 2]), 'utf8').toString('base64url');
  const scalarPayload = Buffer.from(JSON.stringify(5), 'utf8').toString('base64url');
  assert.equal(decodeOffsetCursor(arrayPayload), null);
  assert.equal(decodeOffsetCursor(scalarPayload), null);
  assert.equal(decodeOffsetCursor('not-valid-base64-json!!!'), null);
});

test('compareTimestampValues orders parseable dates chronologically', () => {
  assert.ok(compareTimestampValues('2026-01-01', '2026-06-01') < 0);
  assert.ok(compareTimestampValues('2026-06-01', '2026-01-01') > 0);
  assert.equal(compareTimestampValues('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'), 0);
});

test('compareTimestampValues falls back to string compare for non-dates', () => {
  // Neither side parses as a date → localeCompare of String(value).
  assert.ok(compareTimestampValues('apple', 'banana') < 0);
  assert.ok(compareTimestampValues('banana', 'apple') > 0);
  // Nullish coerces to '' via `?? ''` before localeCompare.
  assert.equal(compareTimestampValues(null, null), 0);
});

test('timestampWithinWindow rejects non-string / blank values', () => {
  assert.equal(timestampWithinWindow(null, '2026-01-01', null), false);
  assert.equal(timestampWithinWindow('   ', '2026-01-01', null), false);
  assert.equal(timestampWithinWindow(123, null, null), false);
});

test('timestampWithinWindow is inclusive on the since boundary (start-of-day)', () => {
  // Date-only `since` expands to T00:00:00.000Z; a value exactly at the
  // start of that day is INCLUDED (guard is `valueMillis < sinceMillis`).
  assert.equal(timestampWithinWindow('2026-06-01T00:00:00.000Z', '2026-06-01', null), true);
  assert.equal(timestampWithinWindow('2026-05-31T23:59:59.999Z', '2026-06-01', null), false);
  assert.equal(timestampWithinWindow('2026-06-01T00:00:00.001Z', '2026-06-01', null), true);
});

test('timestampWithinWindow is inclusive on the until boundary (end-of-day)', () => {
  // Date-only `until` expands to T23:59:59.999Z; a value at the very end
  // of that day is INCLUDED (guard is `valueMillis > untilMillis`).
  assert.equal(timestampWithinWindow('2026-06-01T23:59:59.999Z', null, '2026-06-01'), true);
  assert.equal(timestampWithinWindow('2026-06-02T00:00:00.000Z', null, '2026-06-01'), false);
  assert.equal(timestampWithinWindow('2026-06-01T12:00:00.000Z', null, '2026-06-01'), true);
});

test('timestampWithinWindow honors both bounds together', () => {
  assert.equal(timestampWithinWindow('2026-06-15', '2026-06-01', '2026-06-30'), true);
  assert.equal(timestampWithinWindow('2026-07-01', '2026-06-01', '2026-06-30'), false);
  assert.equal(timestampWithinWindow('2026-05-15', '2026-06-01', '2026-06-30'), false);
});

test('timestampWithinWindow uses lexical fallback when values are non-dates', () => {
  // Non-parseable strings fall to `String(value) < String(since)` etc.
  assert.equal(timestampWithinWindow('mango', 'apple', 'zebra'), true);
  assert.equal(timestampWithinWindow('apple', 'mango', 'zebra'), false);
  assert.equal(timestampWithinWindow('zzz', 'apple', 'mango'), false);
});

test('buildRecordSearchMatchExpression tokenizes into quoted AND terms', () => {
  assert.equal(buildRecordSearchMatchExpression('hello world'), '"hello" AND "world"');
  assert.equal(buildRecordSearchMatchExpression('  single  '), '"single"');
});

test('buildRecordSearchMatchExpression returns null for empty / token-less input', () => {
  assert.equal(buildRecordSearchMatchExpression(''), null);
  assert.equal(buildRecordSearchMatchExpression('   '), null);
  assert.equal(buildRecordSearchMatchExpression('!!!'), null);
  assert.equal(buildRecordSearchMatchExpression(null), null);
});

test('buildRecordSearchMatchExpression accepts a single-token phrase', () => {
  // A lone informative word wraps in one quoted term (no AND join).
  assert.equal(buildRecordSearchMatchExpression('lovelace'), '"lovelace"');
});

test('buildRecordSearchMatchExpression rejects short non-word queries', () => {
  // A query with punctuation (not word-or-phrase) whose tokens are all
  // single-char is NOT informative → null. `a+b` → tokens ['a','b'],
  // isWordOrPhrase false (has '+'), allInformative false (len 1) → null.
  assert.equal(buildRecordSearchMatchExpression('a+b'), null);
  // But `ab+cd` has informative tokens → accepted despite the '+'.
  assert.equal(buildRecordSearchMatchExpression('ab+cd'), '"ab" AND "cd"');
});

test('findQueryMatch locates a substring and reports its field path', () => {
  const match = findQueryMatch({ profile: { name: 'Ada Lovelace' } }, 'lovelace');
  assert.ok(match);
  assert.equal(match.field, 'profile.name');
  assert.ok(match.snippet.toLowerCase().includes('lovelace'));
});

test('findQueryMatch respects word boundaries for simple word queries', () => {
  // 'cat' should NOT match inside 'category' (both sides alphanumeric).
  assert.equal(findQueryMatch({ x: 'category listing' }, 'cat'), null);
  // But matches as a standalone word.
  const hit = findQueryMatch({ x: 'the cat sat' }, 'cat');
  assert.ok(hit);
  assert.equal(hit.field, 'x');
});

test('findQueryMatch returns null for blank query', () => {
  assert.equal(findQueryMatch({ x: 'anything' }, ''), null);
  assert.equal(findQueryMatch({ x: 'anything' }, '   '), null);
});

test('chooseDisplayTimestamp prefers semantic value in native mode', () => {
  const semantic = { field: 'created_at', value: '2026-01-01T00:00:00Z' };
  assert.equal(
    chooseDisplayTimestamp({ semanticTimestamp: semantic, emittedAt: '2026-12-31T00:00:00Z' }),
    '2026-01-01T00:00:00Z'
  );
});

test('chooseDisplayTimestamp falls back to emittedAt when emitted mode or no semantic', () => {
  const semantic = { field: 'created_at', value: '2026-01-01T00:00:00Z' };
  assert.equal(
    chooseDisplayTimestamp({ semanticTimestamp: semantic, emittedAt: '2026-12-31T00:00:00Z', mode: 'emitted' }),
    '2026-12-31T00:00:00Z'
  );
  assert.equal(
    chooseDisplayTimestamp({ semanticTimestamp: null, emittedAt: '2026-12-31T00:00:00Z' }),
    '2026-12-31T00:00:00Z'
  );
});
