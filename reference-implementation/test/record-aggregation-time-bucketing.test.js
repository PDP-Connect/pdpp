// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Mutation-killing unit tests for the pure time-bucketing helpers in
 * `server/record-aggregation.js`:
 *
 *   - resolveAggregateTimeZone   (default UTC; throws invalid_request on an
 *                                 unknown IANA zone)
 *   - bucketStartForGranularity  (calendar date_trunc semantics: minute,
 *                                 hour, day, Monday-start week, month,
 *                                 quarter-start-month, year; null for
 *                                 unparseable input; null for unknown unit)
 *
 * No test currently imports this module by name. These assertions pin the
 * calendar arithmetic exactly — the Monday-snap offset, the
 * `month - ((month-1) % 3)` quarter-start, and the per-unit ISO key shape —
 * so a mutant in any of those turns red. All inputs are UTC-anchored ISO
 * instants evaluated in `UTC`, keeping the expected keys deterministic and
 * free of host-locale / DST drift.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bucketStartForGranularity,
  resolveAggregateTimeZone,
} from '../server/record-aggregation.js';

test('resolveAggregateTimeZone: defaults to UTC, echoes valid zones, throws on unknown', () => {
  // Falsy input -> UTC default.
  assert.equal(resolveAggregateTimeZone(undefined), 'UTC');
  assert.equal(resolveAggregateTimeZone(''), 'UTC');
  assert.equal(resolveAggregateTimeZone(null), 'UTC');

  // Valid IANA zones are echoed back unchanged.
  assert.equal(resolveAggregateTimeZone('UTC'), 'UTC');
  assert.equal(resolveAggregateTimeZone('America/New_York'), 'America/New_York');

  // An unknown zone (Intl throws RangeError) -> typed invalid_request.
  let thrown;
  try {
    resolveAggregateTimeZone('Mars/Olympus_Mons');
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, 'expected unknown zone to throw');
  assert.equal(thrown.code, 'invalid_request');
  assert.ok(/Unknown time_zone/.test(thrown.message), thrown.message);
});

test('bucketStartForGranularity: null / unparseable value routes to the null bucket', () => {
  assert.equal(bucketStartForGranularity(null, 'day', 'UTC'), null);
  assert.equal(bucketStartForGranularity('', 'day', 'UTC'), null);
  assert.equal(bucketStartForGranularity('not-a-date', 'day', 'UTC'), null);
  // A non-string value is not parsed (parseDateValue rejects it) -> null.
  assert.equal(bucketStartForGranularity(1735776000000, 'day', 'UTC'), null);
});

test('bucketStartForGranularity: unknown granularity returns null (default branch)', () => {
  assert.equal(bucketStartForGranularity('2026-03-15T12:34:56Z', 'fortnight', 'UTC'), null);
});

test('bucketStartForGranularity: minute / hour / day truncation in UTC', () => {
  const ts = '2026-03-15T12:34:56Z';
  // minute drops seconds.
  assert.equal(bucketStartForGranularity(ts, 'minute', 'UTC'), '2026-03-15T12:34');
  // hour drops minutes+seconds.
  assert.equal(bucketStartForGranularity(ts, 'hour', 'UTC'), '2026-03-15T12:00');
  // day drops the whole time part.
  assert.equal(bucketStartForGranularity(ts, 'day', 'UTC'), '2026-03-15');
});

test('bucketStartForGranularity: week snaps back to Monday (ISO week start)', () => {
  // 2026-03-15 is a Sunday -> its ISO week started Monday 2026-03-09.
  assert.equal(bucketStartForGranularity('2026-03-15T00:00:00Z', 'week', 'UTC'), '2026-03-09');
  // 2026-03-09 is itself a Monday -> snaps to itself (offset 0).
  assert.equal(bucketStartForGranularity('2026-03-09T23:59:59Z', 'week', 'UTC'), '2026-03-09');
  // 2026-03-10 is a Tuesday -> still snaps back to Monday 2026-03-09.
  assert.equal(bucketStartForGranularity('2026-03-10T06:00:00Z', 'week', 'UTC'), '2026-03-09');
  // A week that crosses a month boundary: Wed 2026-04-01 -> Monday 2026-03-30.
  assert.equal(bucketStartForGranularity('2026-04-01T00:00:00Z', 'week', 'UTC'), '2026-03-30');
});

test('bucketStartForGranularity: month truncates to the first of the month', () => {
  assert.equal(bucketStartForGranularity('2026-03-15T12:00:00Z', 'month', 'UTC'), '2026-03-01');
  assert.equal(bucketStartForGranularity('2026-12-31T23:59:59Z', 'month', 'UTC'), '2026-12-01');
});

test('bucketStartForGranularity: quarter snaps to the first month of the calendar quarter', () => {
  // Q1 = Jan; Q2 = Apr; Q3 = Jul; Q4 = Oct. Pin one instant per quarter and
  // the quarter boundaries, which kill a mutant in `month - ((month-1) % 3)`.
  assert.equal(bucketStartForGranularity('2026-01-15T00:00:00Z', 'quarter', 'UTC'), '2026-01-01');
  assert.equal(bucketStartForGranularity('2026-03-31T00:00:00Z', 'quarter', 'UTC'), '2026-01-01');
  assert.equal(bucketStartForGranularity('2026-04-01T00:00:00Z', 'quarter', 'UTC'), '2026-04-01');
  assert.equal(bucketStartForGranularity('2026-06-30T00:00:00Z', 'quarter', 'UTC'), '2026-04-01');
  assert.equal(bucketStartForGranularity('2026-07-01T00:00:00Z', 'quarter', 'UTC'), '2026-07-01');
  assert.equal(bucketStartForGranularity('2026-09-30T00:00:00Z', 'quarter', 'UTC'), '2026-07-01');
  assert.equal(bucketStartForGranularity('2026-10-01T00:00:00Z', 'quarter', 'UTC'), '2026-10-01');
  assert.equal(bucketStartForGranularity('2026-12-31T00:00:00Z', 'quarter', 'UTC'), '2026-10-01');
});

test('bucketStartForGranularity: year truncates to Jan 1', () => {
  assert.equal(bucketStartForGranularity('2026-08-20T10:11:12Z', 'year', 'UTC'), '2026-01-01');
  assert.equal(bucketStartForGranularity('2026-01-01T00:00:00Z', 'year', 'UTC'), '2026-01-01');
});
