/**
 * Mutation-killing unit tests for the pure epoch-aware timestamp coercion in
 * `server/record-ingest-semantic-time.ts`.
 *
 * `coerceSemanticTimeValue` is the storage-independent piece of the ingest
 * semantic-time path (the sibling helpers read the manifest from the DB and
 * are exercised through the ingest integration tests). It is the same
 * seconds-vs-milliseconds epoch coercion the search timestamp path uses, and
 * it has no by-name unit coverage.
 *
 * The load-bearing boundary is SEMANTIC_TIME_EPOCH_MS_THRESHOLD (1e12): a
 * numeric value BELOW it is Unix SECONDS (multiplied by 1000), AT/ABOVE it is
 * Unix MILLISECONDS. A mutant that flips the comparison or drops the *1000
 * would shift every seconds-epoch record by three orders of magnitude and
 * turns red here.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SEMANTIC_TIME_EPOCH_MS_THRESHOLD,
  coerceSemanticTimeValue,
} from '../server/record-ingest-semantic-time.ts';

test('coerceSemanticTimeValue: ISO strings pass through trimmed; blank/non-string -> null', () => {
  assert.equal(coerceSemanticTimeValue('2026-03-15T12:00:00Z'), '2026-03-15T12:00:00Z');
  // Leading/trailing whitespace is trimmed.
  assert.equal(coerceSemanticTimeValue('  2026-03-15T12:00:00Z  '), '2026-03-15T12:00:00Z');
  // Blank / whitespace-only -> null.
  assert.equal(coerceSemanticTimeValue(''), null);
  assert.equal(coerceSemanticTimeValue('   '), null);
  // Non-string, non-number -> null.
  assert.equal(coerceSemanticTimeValue(null), null);
  assert.equal(coerceSemanticTimeValue(undefined), null);
  assert.equal(coerceSemanticTimeValue({}), null);
  assert.equal(coerceSemanticTimeValue(true), null);
});

test('coerceSemanticTimeValue: non-positive / non-finite numbers -> null', () => {
  assert.equal(coerceSemanticTimeValue(0), null, '0 is not a valid positive epoch');
  assert.equal(coerceSemanticTimeValue(-1000), null);
  assert.equal(coerceSemanticTimeValue(Number.NaN), null);
  assert.equal(coerceSemanticTimeValue(Number.POSITIVE_INFINITY), null);
});

test('coerceSemanticTimeValue: SECONDS below the threshold are multiplied by 1000', () => {
  // 1_700_000_000 seconds == 2023-11-14T22:13:20Z. Below 1e12 -> treated as seconds.
  const seconds = 1_700_000_000;
  assert.ok(seconds < SEMANTIC_TIME_EPOCH_MS_THRESHOLD, 'fixture must be below the ms threshold');
  assert.equal(coerceSemanticTimeValue(seconds), new Date(seconds * 1000).toISOString());
  assert.equal(coerceSemanticTimeValue(seconds), '2023-11-14T22:13:20.000Z');
});

test('coerceSemanticTimeValue: MILLISECONDS at/above the threshold are used as-is', () => {
  // 1_700_000_000_000 ms == the same instant, but at/above 1e12 -> treated as ms.
  const ms = 1_700_000_000_000;
  assert.ok(ms >= SEMANTIC_TIME_EPOCH_MS_THRESHOLD, 'fixture must be at/above the ms threshold');
  assert.equal(coerceSemanticTimeValue(ms), new Date(ms).toISOString());
  assert.equal(coerceSemanticTimeValue(ms), '2023-11-14T22:13:20.000Z');

  // Exactly at the threshold is treated as milliseconds (the boundary is >=).
  assert.equal(
    coerceSemanticTimeValue(SEMANTIC_TIME_EPOCH_MS_THRESHOLD),
    new Date(SEMANTIC_TIME_EPOCH_MS_THRESHOLD).toISOString(),
  );
});

test('coerceSemanticTimeValue: seconds vs ms interpretation are three orders of magnitude apart', () => {
  // The SAME numeric magnitude just below vs at the threshold must map to very
  // different years — this is what the threshold protects and what a flipped
  // comparison would break.
  const belowYear = new Date(coerceSemanticTimeValue(999_999_999_999)).getUTCFullYear(); // seconds -> far future
  const atYear = new Date(coerceSemanticTimeValue(1_000_000_000_000)).getUTCFullYear(); // ms -> 2001
  assert.notEqual(belowYear, atYear, 'below-threshold (seconds) and at-threshold (ms) must differ');
  assert.equal(atYear, 2001, '1e12 ms is the year 2001');
});
