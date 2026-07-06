/**
 * Unit coverage for two UNTESTED record-version-stats read-model input shapers
 * in `server/record-version-stats.ts` (the sibling test covers
 * classifyRecordVersionChurn / isVersionChurnCandidate, not these):
 *
 *   - clampRecordVersionStatsLimit(value): coerces to a number and clamps to
 *     [1, 500]; a non-finite or <= 0 value (and NaN) falls back to the default
 *     100; fractional values are floored.
 *
 *   - normalizeRecordVersionStatsRisk(value): null/empty => null; a value in the
 *     strict allowlist {normal, watch, high} passes through; anything else throws
 *     `invalid_request` with `param: 'risk'`. The match is strict (not trimmed).
 *
 * Pure — no DB, no server, no fixtures.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clampRecordVersionStatsLimit,
  normalizeRecordVersionStatsRisk,
} from '../server/record-version-stats.ts';

// --- clampRecordVersionStatsLimit -------------------------------------------

test('clampRecordVersionStatsLimit: passes a valid in-range integer through', () => {
  assert.equal(clampRecordVersionStatsLimit(5), 5);
  assert.equal(clampRecordVersionStatsLimit(1), 1, 'the minimum');
  assert.equal(clampRecordVersionStatsLimit(500), 500, 'the maximum');
});

test('clampRecordVersionStatsLimit: clamps above the max to 500', () => {
  assert.equal(clampRecordVersionStatsLimit(99999), 500);
  assert.equal(clampRecordVersionStatsLimit(501), 500);
});

test('clampRecordVersionStatsLimit: <= 0, non-finite, or NaN falls back to the default 100', () => {
  assert.equal(clampRecordVersionStatsLimit(0), 100, 'zero => default');
  assert.equal(clampRecordVersionStatsLimit(-3), 100, 'negative => default');
  assert.equal(clampRecordVersionStatsLimit(undefined), 100, 'undefined => default');
  assert.equal(clampRecordVersionStatsLimit('not-a-number'), 100, 'NaN => default');
  assert.equal(clampRecordVersionStatsLimit(Infinity), 100, 'Infinity => default');
});

test('clampRecordVersionStatsLimit: floors a fractional value', () => {
  assert.equal(clampRecordVersionStatsLimit(1.9), 1, 'floor toward the minimum');
  assert.equal(clampRecordVersionStatsLimit(4.7), 4);
  // A fraction in (0,1) passes the > 0 guard, floors to 0, then the min-of-1
  // floor lifts it back to 1 (never 0).
  assert.equal(clampRecordVersionStatsLimit(0.5), 1, 'sub-1 positive floors to 0 then lifts to the minimum 1');
});

test('clampRecordVersionStatsLimit: accepts a numeric string', () => {
  assert.equal(clampRecordVersionStatsLimit('42'), 42, 'coerced via Number()');
});

// --- normalizeRecordVersionStatsRisk ----------------------------------------

test('normalizeRecordVersionStatsRisk: null / empty string => null', () => {
  assert.equal(normalizeRecordVersionStatsRisk(null), null);
  assert.equal(normalizeRecordVersionStatsRisk(undefined), null);
  assert.equal(normalizeRecordVersionStatsRisk(''), null);
});

test('normalizeRecordVersionStatsRisk: each allowlisted value passes through', () => {
  for (const risk of ['normal', 'watch', 'high']) {
    assert.equal(normalizeRecordVersionStatsRisk(risk), risk, risk);
  }
});

test('normalizeRecordVersionStatsRisk: an unknown risk throws invalid_request with param risk', () => {
  for (const bad of ['all', 'bogus', 'HIGH', '  high  ']) {
    assert.throws(
      () => normalizeRecordVersionStatsRisk(bad),
      (err) => {
        assert.equal(err.code, 'invalid_request', `code for ${JSON.stringify(bad)}: ${err.code}`);
        assert.equal(err.param, 'risk', `param for ${JSON.stringify(bad)}: ${err.param}`);
        return true;
      },
      `expected ${JSON.stringify(bad)} to be rejected`,
    );
  }
});
