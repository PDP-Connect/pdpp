// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Mutation-killing coverage for the pure helpers in
 * `server/record-version-stats.ts`:
 *
 *   - clampRecordVersionStatsLimit / normalizeRecordVersionStatsRisk had NO
 *     direct test.
 *   - classifyRecordVersionChurn's headline test hits normal/watch/high but
 *     not the exact risk BOUNDARIES (vpr 4.9 vs 5, vpr 49 vs 50) nor the
 *     history_without_current_records high path in isolation — a `>=`→`>`
 *     mutant on any threshold survives today.
 *   - isVersionChurnCandidate's dirty / history<=0 / current===0 / vpr>=5
 *     boundary branches.
 *
 * Pure classification/normalization; no auth/grant logic; no source change.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyRecordVersionChurn,
  clampRecordVersionStatsLimit,
  isVersionChurnCandidate,
  normalizeRecordVersionStatsRisk,
} from '../server/record-version-stats.ts';

// ─── clampRecordVersionStatsLimit ────────────────────────────────────────

test('clampRecordVersionStatsLimit falls back to the default (100) for non-positive / unparseable input', () => {
  assert.equal(clampRecordVersionStatsLimit(0), 100);
  assert.equal(clampRecordVersionStatsLimit(-5), 100);
  assert.equal(clampRecordVersionStatsLimit('not-a-number'), 100);
  assert.equal(clampRecordVersionStatsLimit(undefined), 100);
  assert.equal(clampRecordVersionStatsLimit(null), 100);
});

test('clampRecordVersionStatsLimit floors a fractional value and keeps an in-range limit', () => {
  assert.equal(clampRecordVersionStatsLimit(3.9), 3);
  assert.equal(clampRecordVersionStatsLimit(50), 50);
  assert.equal(clampRecordVersionStatsLimit(1), 1);
});

test('clampRecordVersionStatsLimit caps at the maximum (500)', () => {
  assert.equal(clampRecordVersionStatsLimit(999_999), 500);
  assert.equal(clampRecordVersionStatsLimit(500), 500);
  assert.equal(clampRecordVersionStatsLimit(501), 500);
});

// ─── normalizeRecordVersionStatsRisk ─────────────────────────────────────

test('normalizeRecordVersionStatsRisk treats null / empty as no filter', () => {
  assert.equal(normalizeRecordVersionStatsRisk(null), null);
  assert.equal(normalizeRecordVersionStatsRisk(undefined), null);
  assert.equal(normalizeRecordVersionStatsRisk(''), null);
});

test('normalizeRecordVersionStatsRisk passes through the three valid risk levels', () => {
  assert.equal(normalizeRecordVersionStatsRisk('normal'), 'normal');
  assert.equal(normalizeRecordVersionStatsRisk('watch'), 'watch');
  assert.equal(normalizeRecordVersionStatsRisk('high'), 'high');
});

test('normalizeRecordVersionStatsRisk throws invalid_request on an unknown risk', () => {
  assert.throws(
    () => normalizeRecordVersionStatsRisk('critical'),
    (err) => {
      assert.equal(err.code, 'invalid_request');
      assert.equal(err.param, 'risk');
      return true;
    },
  );
});

// ─── classifyRecordVersionChurn boundaries ───────────────────────────────

test('classifyRecordVersionChurn flags history with zero current records as high', () => {
  assert.deepEqual(classifyRecordVersionChurn({ currentRecordCount: 0, recordHistoryCount: 5 }), {
    riskLevel: 'high',
    riskReasons: ['history_without_current_records'],
    versionsPerRecord: 5,
  });
});

test('classifyRecordVersionChurn: versions-per-record 50 is high, 49 is only watch', () => {
  const high = classifyRecordVersionChurn({ currentRecordCount: 1, recordHistoryCount: 50 });
  assert.equal(high.riskLevel, 'high');
  assert.ok(high.riskReasons.includes('versions_per_record_ge_50'));

  const watch = classifyRecordVersionChurn({ currentRecordCount: 1, recordHistoryCount: 49 });
  assert.equal(watch.riskLevel, 'watch');
  assert.deepEqual(watch.riskReasons, ['versions_per_record_ge_5']);
});

test('classifyRecordVersionChurn: versions-per-record 5 is watch, 4.9 is normal', () => {
  const watch = classifyRecordVersionChurn({ currentRecordCount: 2, recordHistoryCount: 10 });
  assert.equal(watch.riskLevel, 'watch');
  assert.deepEqual(watch.riskReasons, ['versions_per_record_ge_5']);

  const normal = classifyRecordVersionChurn({ currentRecordCount: 10, recordHistoryCount: 49 });
  assert.equal(normal.riskLevel, 'normal');
  assert.deepEqual(normal.riskReasons, []);
  assert.equal(normal.versionsPerRecord, 4.9);
});

test('classifyRecordVersionChurn: history >= 10000 with vpr >= 10 is high', () => {
  // vpr exactly 10 (< 50) so only the 10000/10 rule fires.
  const result = classifyRecordVersionChurn({ currentRecordCount: 1000, recordHistoryCount: 10_000 });
  assert.equal(result.riskLevel, 'high');
  assert.deepEqual(result.riskReasons, ['history_ge_10000_and_versions_per_record_ge_10']);
});

test('classifyRecordVersionChurn uses recordKeyCount as the denominator when provided', () => {
  const result = classifyRecordVersionChurn({ currentRecordCount: 100, recordHistoryCount: 50, recordKeyCount: 1 });
  assert.equal(result.versionsPerRecord, 50); // 50 / max(1, keys=1)
  assert.equal(result.riskLevel, 'high');
});

// ─── isVersionChurnCandidate ─────────────────────────────────────────────

test('isVersionChurnCandidate rejects a dirty projection outright', () => {
  assert.equal(isVersionChurnCandidate({ dirty: true, currentRecordCount: 0, recordHistoryCount: 1000 }), false);
});

test('isVersionChurnCandidate rejects a stream with no history', () => {
  assert.equal(isVersionChurnCandidate({ dirty: false, currentRecordCount: 5, recordHistoryCount: 0 }), false);
});

test('isVersionChurnCandidate accepts history with zero current records', () => {
  assert.equal(isVersionChurnCandidate({ dirty: false, currentRecordCount: 0, recordHistoryCount: 1 }), true);
});

test('isVersionChurnCandidate accepts at the vpr >= 5 upper-bound and rejects just below', () => {
  assert.equal(isVersionChurnCandidate({ dirty: false, currentRecordCount: 2, recordHistoryCount: 10 }), true);
  assert.equal(isVersionChurnCandidate({ dirty: false, currentRecordCount: 10, recordHistoryCount: 49 }), false);
});

test('isVersionChurnCandidate returns false for empty/no arguments', () => {
  assert.equal(isVersionChurnCandidate(), false);
  assert.equal(isVersionChurnCandidate({}), false);
});
