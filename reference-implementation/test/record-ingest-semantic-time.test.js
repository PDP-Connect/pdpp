/**
 * Unit tests for the pure semantic-time coercion in the SQLite ingest helper.
 *
 * record-ingest-semantic-time.js has no co-named test and none of its exports
 * are exercised elsewhere. The manifest-resolving functions need the DB and
 * are out of scope here; these tests pin the pure epoch-aware coercion:
 *   - ISO strings pass through trimmed (blank -> null),
 *   - positive numbers are Unix epochs: seconds below the threshold, ms
 *     at/above it, with the threshold boundary itself treated as ms,
 *   - non-positive / non-finite / non-string-non-number -> null.
 *
 * The threshold semantics mirror search-record-timestamps.ts so ingest and
 * search coerce identically.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  coerceSemanticTimeValue,
  SEMANTIC_TIME_EPOCH_MS_THRESHOLD,
} from '../server/record-ingest-semantic-time.ts';

test('SEMANTIC_TIME_EPOCH_MS_THRESHOLD is 1e12', () => {
  assert.equal(SEMANTIC_TIME_EPOCH_MS_THRESHOLD, 1e12);
});

test('coerceSemanticTimeValue passes through a trimmed ISO string', () => {
  assert.equal(coerceSemanticTimeValue('  2026-01-01T00:00:00Z  '), '2026-01-01T00:00:00Z');
  // Any non-empty string is returned as-is (not re-parsed).
  assert.equal(coerceSemanticTimeValue('whenever'), 'whenever');
  assert.equal(coerceSemanticTimeValue('   '), null);
});

test('coerceSemanticTimeValue treats a sub-threshold number as Unix seconds', () => {
  // 1e9 seconds -> 1e12 ms -> the same instant as the ms threshold.
  assert.equal(coerceSemanticTimeValue(1e9), new Date(1e9 * 1000).toISOString());
});

test('coerceSemanticTimeValue treats an at/above-threshold number as Unix ms', () => {
  const ms = 1.7e12;
  assert.equal(coerceSemanticTimeValue(ms), new Date(ms).toISOString());
  // The threshold value itself is interpreted as ms (>= comparison), NOT seconds.
  assert.equal(
    coerceSemanticTimeValue(SEMANTIC_TIME_EPOCH_MS_THRESHOLD),
    new Date(SEMANTIC_TIME_EPOCH_MS_THRESHOLD).toISOString(),
  );
});

test('coerceSemanticTimeValue rejects non-positive, non-finite, and non-scalar values', () => {
  assert.equal(coerceSemanticTimeValue(0), null);
  assert.equal(coerceSemanticTimeValue(-5), null);
  assert.equal(coerceSemanticTimeValue(Infinity), null);
  assert.equal(coerceSemanticTimeValue(NaN), null);
  assert.equal(coerceSemanticTimeValue({}), null);
  assert.equal(coerceSemanticTimeValue(null), null);
  assert.equal(coerceSemanticTimeValue(undefined), null);
});
