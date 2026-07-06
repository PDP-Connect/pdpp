// Pure, no-DB unit tests for the epoch-aware semantic-time coercion in
// server/record-ingest-semantic-time.ts. No test imports this module by name.
// coerceSemanticTimeValue + SEMANTIC_TIME_EPOCH_MS_THRESHOLD are standalone pure
// functions (the manifest-loading siblings call the DB and are out of scope here).
//
// The seconds-vs-milliseconds epoch boundary is the mutation surface: a numeric
// timestamp at/above 1e12 is Unix MILLISECONDS; below it is Unix SECONDS (*1000).
// Ingest and search MUST coerce identically (mirrors search-record-timestamps.ts),
// so a boundary regression silently mis-dates every record with a numeric time.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SEMANTIC_TIME_EPOCH_MS_THRESHOLD,
  coerceSemanticTimeValue,
} from '../server/record-ingest-semantic-time.ts';

test('SEMANTIC_TIME_EPOCH_MS_THRESHOLD is 1e12', () => {
  assert.equal(SEMANTIC_TIME_EPOCH_MS_THRESHOLD, 1e12);
});

test('coerceSemanticTimeValue: ISO string passes through trimmed', () => {
  assert.equal(coerceSemanticTimeValue('2024-01-02T03:04:05Z'), '2024-01-02T03:04:05Z');
  assert.equal(coerceSemanticTimeValue('  2024-01-02T03:04:05Z  '), '2024-01-02T03:04:05Z');
});

test('coerceSemanticTimeValue: empty / whitespace string -> null', () => {
  assert.equal(coerceSemanticTimeValue(''), null);
  assert.equal(coerceSemanticTimeValue('   '), null);
});

test('coerceSemanticTimeValue: a number BELOW the threshold is treated as Unix SECONDS', () => {
  // 1_700_000_000 s = 2023-11-14T22:13:20Z. If it were (wrongly) treated as ms it
  // would be 1970-01-20, so this pins the *1000 seconds branch precisely.
  assert.equal(coerceSemanticTimeValue(1_700_000_000), '2023-11-14T22:13:20.000Z');
});

test('coerceSemanticTimeValue: a number AT/ABOVE the threshold is treated as Unix MILLISECONDS', () => {
  // 1e12 ms = 2001-09-09T01:46:40Z. If it were (wrongly) treated as seconds it
  // would overflow far into the future, so this pins the >= boundary.
  assert.equal(coerceSemanticTimeValue(1e12), '2001-09-09T01:46:40.000Z');
  // A realistic ms timestamp: 1_700_000_000_000 ms = 2023-11-14T22:13:20Z.
  assert.equal(coerceSemanticTimeValue(1_700_000_000_000), '2023-11-14T22:13:20.000Z');
});

test('coerceSemanticTimeValue: the boundary is INCLUSIVE at the threshold (>= is ms)', () => {
  // Exactly at 1e12 -> ms path -> 2001; one below -> seconds path -> *1000.
  const atThreshold = coerceSemanticTimeValue(SEMANTIC_TIME_EPOCH_MS_THRESHOLD);
  const belowThreshold = coerceSemanticTimeValue(SEMANTIC_TIME_EPOCH_MS_THRESHOLD - 1);
  assert.equal(atThreshold, '2001-09-09T01:46:40.000Z', 'at threshold uses ms');
  // (1e12 - 1) seconds is a far-future date; the key point is it is NOT the ms date.
  assert.notEqual(belowThreshold, atThreshold, 'below-threshold takes the seconds (*1000) path');
  assert.ok(belowThreshold.startsWith('+') || Number(new Date(belowThreshold).getUTCFullYear()) > 2001,
    'seconds interpretation lands far in the future, distinct from the ms date');
});

test('coerceSemanticTimeValue: non-positive / non-finite numbers -> null', () => {
  assert.equal(coerceSemanticTimeValue(0), null, 'zero is not a positive epoch');
  assert.equal(coerceSemanticTimeValue(-5), null);
  assert.equal(coerceSemanticTimeValue(NaN), null);
  assert.equal(coerceSemanticTimeValue(Infinity), null);
});

test('coerceSemanticTimeValue: non-string non-number inputs -> null', () => {
  assert.equal(coerceSemanticTimeValue(null), null);
  assert.equal(coerceSemanticTimeValue(undefined), null);
  assert.equal(coerceSemanticTimeValue({}), null);
  assert.equal(coerceSemanticTimeValue(true), null);
  assert.equal(coerceSemanticTimeValue([1]), null);
});
