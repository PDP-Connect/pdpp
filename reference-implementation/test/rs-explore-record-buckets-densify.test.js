import test from 'node:test';
import assert from 'node:assert/strict';

import {
  executeExploreRecordBuckets,
  InvalidExploreRecordBucketsRequestError,
} from '../operations/rs-explore-record-buckets/index.ts';

// Mutation-killing unit tests for the PURE calendar-densification read model in
// `rs.explore.record_buckets`. The operation takes SPARSE aggregate rows (only
// populated buckets) plus an extent, and DERIVES a dense, gap-filled calendar
// series — flooring each boundary to the granularity's UTC edge, stepping the
// cursor one granularity at a time, and zero-filling every missing bucket. It
// also validates the request (granularity, since/until instants, time zone).
//
// The existing suite drives this over a real SQLite/Postgres backend at MONTH
// granularity only. Here we inject an in-memory `fetchBucketRows` so we can pin
// the boundary math for EVERY granularity, the zero-fill, the extent echo, and
// every request-validation branch — with NO DB. Each assertion is chosen so a
// mutation to a boundary step, a comparison, or a validation guard flips it.

/** A deps stub that echoes fixed sparse rows and captures the resolved query. */
function depsReturning(rows) {
  const calls = [];
  return {
    calls,
    fetchBucketRows(input) {
      calls.push(input);
      return rows;
    },
  };
}

/** A single sparse aggregate row. */
function row(overrides = {}) {
  return {
    bucketStart: null,
    count: 0,
    extentStart: null,
    extentEnd: null,
    extentCount: 0,
    granularity: 'day',
    ...overrides,
  };
}

// --------------------------------------------------------------------------
// Dense fill + boundary math per granularity
// --------------------------------------------------------------------------

test('day granularity: dense zero-fills the gap between two populated days', async () => {
  const deps = depsReturning([
    // extent spans 3 days; only day 1 and day 3 are populated.
    row({
      granularity: 'day',
      extentStart: '2026-01-01T08:00:00.000Z',
      extentEnd: '2026-01-03T22:00:00.000Z',
      extentCount: 3,
      bucketStart: '2026-01-01T00:00:00.000Z',
      count: 2,
    }),
    row({ granularity: 'day', bucketStart: '2026-01-03T00:00:00.000Z', count: 1 }),
  ]);
  const out = await executeExploreRecordBuckets({ granularity: 'day' }, deps);
  assert.equal(out.granularity, 'day');
  // 3 dense day buckets, floored to midnight UTC, middle one zero-filled.
  assert.deepEqual(out.buckets, [
    { start: '2026-01-01T00:00:00.000Z', end: '2026-01-02T00:00:00.000Z', count: 2 },
    { start: '2026-01-02T00:00:00.000Z', end: '2026-01-03T00:00:00.000Z', count: 0 },
    { start: '2026-01-03T00:00:00.000Z', end: '2026-01-04T00:00:00.000Z', count: 1 },
  ]);
  assert.deepEqual(out.extent, { start: '2026-01-01T08:00:00.000Z', end: '2026-01-03T22:00:00.000Z', count: 3 });
});

test('hour granularity: floors to the top of the hour and steps by one hour', async () => {
  const deps = depsReturning([
    row({
      granularity: 'hour',
      extentStart: '2026-01-01T10:15:00.000Z',
      extentEnd: '2026-01-01T12:45:00.000Z',
      extentCount: 5,
      bucketStart: '2026-01-01T10:00:00.000Z',
      count: 5,
    }),
  ]);
  const out = await executeExploreRecordBuckets({ granularity: 'hour' }, deps);
  assert.deepEqual(out.buckets.map((b) => b.start), [
    '2026-01-01T10:00:00.000Z',
    '2026-01-01T11:00:00.000Z',
    '2026-01-01T12:00:00.000Z',
  ]);
  assert.equal(out.buckets[0].count, 5);
  assert.equal(out.buckets[1].count, 0);
});

test('week granularity: floors to Monday (ISO week start), steps by 7 days', async () => {
  // 2026-01-01 is a Thursday; the Monday of that week is 2025-12-29.
  const deps = depsReturning([
    row({
      granularity: 'week',
      extentStart: '2026-01-01T00:00:00.000Z',
      extentEnd: '2026-01-08T00:00:00.000Z',
      extentCount: 2,
      bucketStart: '2025-12-29T00:00:00.000Z',
      count: 2,
    }),
  ]);
  const out = await executeExploreRecordBuckets({ granularity: 'week' }, deps);
  assert.equal(out.buckets[0].start, '2025-12-29T00:00:00.000Z', 'floors to Monday, not Sunday/Thursday');
  assert.equal(out.buckets[0].end, '2026-01-05T00:00:00.000Z', 'week bucket is exactly 7 days wide');
  assert.equal(out.buckets[1].start, '2026-01-05T00:00:00.000Z');
});

test('quarter granularity: floors to the quarter start month (Apr→Apr), steps 3 months', async () => {
  const deps = depsReturning([
    row({
      granularity: 'quarter',
      extentStart: '2026-05-15T00:00:00.000Z', // Q2 → floors to Apr 1
      extentEnd: '2026-08-01T00:00:00.000Z', // Q3 → floors to Jul 1
      extentCount: 4,
      bucketStart: '2026-04-01T00:00:00.000Z',
      count: 4,
    }),
  ]);
  const out = await executeExploreRecordBuckets({ granularity: 'quarter' }, deps);
  assert.deepEqual(out.buckets.map((b) => b.start), [
    '2026-04-01T00:00:00.000Z',
    '2026-07-01T00:00:00.000Z',
  ]);
  assert.equal(out.buckets[1].end, '2026-10-01T00:00:00.000Z');
});

test('year granularity: floors to Jan 1, steps by one year', async () => {
  const deps = depsReturning([
    row({
      granularity: 'year',
      extentStart: '2024-06-01T00:00:00.000Z',
      extentEnd: '2026-02-01T00:00:00.000Z',
      extentCount: 3,
      bucketStart: '2024-01-01T00:00:00.000Z',
      count: 3,
    }),
  ]);
  const out = await executeExploreRecordBuckets({ granularity: 'year' }, deps);
  assert.deepEqual(out.buckets.map((b) => b.start), [
    '2024-01-01T00:00:00.000Z',
    '2025-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z',
  ]);
});

// --------------------------------------------------------------------------
// Empty / degenerate extents
// --------------------------------------------------------------------------

test('empty result set: no rows yields empty buckets and null extent', async () => {
  const out = await executeExploreRecordBuckets({ granularity: 'day' }, depsReturning([]));
  assert.deepEqual(out.buckets, []);
  assert.deepEqual(out.extent, { start: null, end: null, count: 0 });
  // With no rows and explicit granularity, granularity echoes the request.
  assert.equal(out.granularity, 'day');
});

test('zero extentCount: dense fill is skipped even if extent bounds are present', async () => {
  const deps = depsReturning([
    row({
      granularity: 'day',
      extentStart: '2026-01-01T00:00:00.000Z',
      extentEnd: '2026-01-05T00:00:00.000Z',
      extentCount: 0, // no records => no dense buckets
    }),
  ]);
  const out = await executeExploreRecordBuckets({ granularity: 'day' }, deps);
  assert.deepEqual(out.buckets, []);
  assert.equal(out.extent.count, 0);
});

test('granularity "auto" with no rows defaults to day in the echoed granularity', async () => {
  const out = await executeExploreRecordBuckets({ granularity: 'auto' }, depsReturning([]));
  assert.equal(out.granularity, 'day');
});

test('count coercion: a non-numeric row count degrades to a real number, missing to 0', async () => {
  const deps = depsReturning([
    row({
      granularity: 'day',
      extentStart: '2026-01-01T00:00:00.000Z',
      extentEnd: '2026-01-01T00:00:00.000Z',
      extentCount: 7,
      bucketStart: '2026-01-01T00:00:00.000Z',
      count: '7', // string count => Number()-coerced to 7
    }),
  ]);
  const out = await executeExploreRecordBuckets({ granularity: 'day' }, deps);
  assert.equal(out.buckets[0].count, 7);
  assert.equal(typeof out.buckets[0].count, 'number');
});

// --------------------------------------------------------------------------
// Request validation
// --------------------------------------------------------------------------

test('time_zone other than UTC is rejected', async () => {
  await assert.rejects(
    () => executeExploreRecordBuckets({ timeZone: 'America/New_York' }, depsReturning([])),
    InvalidExploreRecordBucketsRequestError
  );
});

test('unknown granularity is rejected; auto and blank are accepted', async () => {
  await assert.rejects(
    () => executeExploreRecordBuckets({ granularity: 'fortnight' }, depsReturning([])),
    InvalidExploreRecordBucketsRequestError
  );
  // Blank / null granularity normalize to auto (no throw).
  await executeExploreRecordBuckets({ granularity: '' }, depsReturning([]));
  await executeExploreRecordBuckets({ granularity: null }, depsReturning([]));
});

test('date-only since/until expand to start-of-day / end-of-day UTC in the query', async () => {
  const deps = depsReturning([]);
  await executeExploreRecordBuckets({ since: '2026-01-01', until: '2026-01-31', granularity: 'day' }, deps);
  const q = deps.calls[0];
  assert.equal(q.since, '2026-01-01T00:00:00.000Z', 'since date expands to start-of-day');
  assert.equal(q.until, '2026-01-31T23:59:59.999Z', 'until date expands to end-of-day');
});

test('since after until is rejected', async () => {
  await assert.rejects(
    () => executeExploreRecordBuckets(
      { since: '2026-02-01', until: '2026-01-01', granularity: 'day' },
      depsReturning([])
    ),
    InvalidExploreRecordBucketsRequestError
  );
});

test('unparseable since is rejected as invalid_request', async () => {
  await assert.rejects(
    () => executeExploreRecordBuckets({ since: 'not-a-date', granularity: 'day' }, depsReturning([])),
    (err) => {
      assert.ok(err instanceof InvalidExploreRecordBucketsRequestError);
      assert.equal(err.code, 'invalid_request');
      return true;
    }
  );
});

test('until falls back to `now` when omitted', async () => {
  const deps = depsReturning([]);
  await executeExploreRecordBuckets({ now: '2026-03-15T12:00:00.000Z', granularity: 'day' }, deps);
  assert.equal(deps.calls[0].until, '2026-03-15T12:00:00.000Z');
});

test('scope lists are trimmed, de-duplicated, and dropped when empty', async () => {
  const deps = depsReturning([]);
  await executeExploreRecordBuckets(
    {
      connectionIds: [' cin_a ', 'cin_a', 'cin_b', '  '],
      streams: [],
      granularity: 'day',
    },
    deps
  );
  const q = deps.calls[0];
  assert.deepEqual(q.connectionIds, ['cin_a', 'cin_b'], 'trimmed + deduped + blanks dropped');
  // An empty streams list is omitted entirely (not passed as []).
  assert.ok(!('streams' in q), 'empty scope list is omitted from the query input');
});
