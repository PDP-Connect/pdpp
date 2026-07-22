// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * rs.explore.timeline — the `order=oldest` ASCENDING re-page (sort cell §2/§3).
 *
 * THE BUG THIS FIXES: "oldest" used to be a CLIENT reverse of the loaded window
 * (`[...list].reverse()` in explore-canvas), which only re-ordered the most-recent
 * slice — it could NEVER reach the true earliest record, silently contradicting
 * the descriptor's `exhaustive` claim ("a sort that cannot page to the bottom of
 * the order it claims is a count==reachability break").
 *
 * THE FIX: `direction=asc` drives a REAL server keyset merge ASCENDING from the
 * earliest record forward, reusing the same snapshot + nowCeiling machinery.
 *
 * These tests prove, on SQLite:
 *   T17  oldest pages ASCENDING from the earliest PAST record (not a reverse of
 *        the recent window), reaches the end, monotone-non-decreasing across pages.
 *   T11  membership is INVARIANT under direction: the exact same record id set is
 *        reachable newest-first and oldest-first; only the sequence differs.
 *   §2   the future partition is NEVER surfaced into the main feed in EITHER
 *        direction (the nowCeiling past/future clamp is preserved under asc).
 *   cur  the oldest-first traversal keeps paging ascending across the composite
 *        cursor (direction is pinned in the cursor, not re-decided per page).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { closeDb, initDb } from '../server/db.js';
import { ingestRecord } from '../server/records.js';
import { buildSqliteExploreTimelineDeps } from '../server/explore-timeline-substrate.ts';
import { executeExploreTimeline } from '../operations/rs-explore-timeline/index.ts';

function ts(day) {
  return `2026-01-${String(day).padStart(2, '0')}T12:00:00.000Z`;
}

/** Page the feed to exhaustion in a given direction; returns the record list in order. */
async function pageAll(deps, direction, pageSize = 3) {
  const out = [];
  let cursor = null;
  let guard = 0;
  for (;;) {
    const page = await executeExploreTimeline({ limit: pageSize, cursor, direction }, deps);
    out.push(...page.data);
    if (!page.has_more) {
      assert.equal(page.next_cursor, null, 'last page must have null next_cursor');
      break;
    }
    assert.ok(typeof page.next_cursor === 'string' && page.next_cursor.length > 0, 'non-last page needs a cursor');
    cursor = page.next_cursor;
    if (++guard > 100) throw new Error('pageAll: too many pages — possible infinite loop');
  }
  return out;
}

async function seedTwoPartitions(suffix) {
  const A = { connectorId: `old_c1_${suffix}`, connectorInstanceId: `old_cin1_${suffix}`, stream: 'orders' };
  const B = { connectorId: `old_c2_${suffix}`, connectorInstanceId: `old_cin2_${suffix}`, stream: 'transactions' };
  // Interleaved across partitions so the k-way merge must pick from both in BOTH
  // directions. Days 1,3,5,7,9,11 in A; 2,4,6,8,10,12 in B.
  for (const day of [1, 3, 5, 7, 9, 11]) {
    await ingestRecord(
      { connectorId: A.connectorId, connectorInstanceId: A.connectorInstanceId },
      { stream: A.stream, key: `a${day}`, data: { id: `a${day}` }, emitted_at: ts(day) }
    );
  }
  for (const day of [2, 4, 6, 8, 10, 12]) {
    await ingestRecord(
      { connectorId: B.connectorId, connectorInstanceId: B.connectorInstanceId },
      { stream: B.stream, key: `b${day}`, data: { id: `b${day}` }, emitted_at: ts(day) }
    );
  }
  return { A, B };
}

test('T17 oldest pages ASCENDING from the earliest record, reaches the end (not a window reverse)', async () => {
  initDb(':memory:');
  try {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    await seedTwoPartitions(suffix);
    // Pin now AFTER all records so nothing is future (all 12 are past).
    const deps = { ...buildSqliteExploreTimelineDeps(), now: () => '2026-02-01T00:00:00.000Z' };

    const asc = await pageAll(deps, 'asc', 3);

    // All 12 reachable.
    assert.equal(asc.length, 12, 'oldest-first must reach all 12 records to the end');
    // The FIRST record is the globally EARLIEST (day 1) — proof it is not a reverse
    // of the most-recent window (a window reverse would start near day 12, not day 1).
    assert.equal(asc[0].emitted_at, ts(1), 'oldest-first must START at the true earliest record (day 1)');
    assert.equal(asc[asc.length - 1].emitted_at, ts(12), 'oldest-first must END at the latest record (day 12)');
    // Monotone non-DECREASING across every page boundary (display == sort, ascending).
    for (let i = 1; i < asc.length; i++) {
      assert.ok(asc[i - 1].emitted_at <= asc[i].emitted_at, `asc order violation at ${i}`);
    }
  } finally {
    closeDb();
  }
});

test('T11 membership is INVARIANT under direction (same record set, reversed sequence)', async () => {
  initDb(':memory:');
  try {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    await seedTwoPartitions(suffix);
    const deps = { ...buildSqliteExploreTimelineDeps(), now: () => '2026-02-01T00:00:00.000Z' };

    const desc = await pageAll(deps, 'desc', 3);
    const asc = await pageAll(deps, 'asc', 3);

    const idOf = (r) => `${r.connector_id}\0${r.stream}\0${r.record_key}`;
    const descSet = new Set(desc.map(idOf));
    const ascSet = new Set(asc.map(idOf));
    // Same set membership (no sort option shrinks/grows the reachable set).
    assert.equal(descSet.size, 12);
    assert.equal(ascSet.size, 12);
    for (const id of descSet) {
      assert.ok(ascSet.has(id), `record ${id} reachable newest-first must also be reachable oldest-first`);
    }
    // Only the SEQUENCE differs: asc is the exact reverse of desc.
    assert.deepEqual(asc.map(idOf), desc.map(idOf).reverse(), 'oldest-first is the exact reverse sequence of newest-first');
  } finally {
    closeDb();
  }
});

test('oldest asc keeps reachability when one partition exhausts on page 1', async () => {
  initDb(':memory:');

  try {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const exhausted = {
      connectorId: `old_exhausted_c_${suffix}`,
      connectorInstanceId: `old_exhausted_cin_${suffix}`,
      stream: 'orders',
    };
    const paging = {
      connectorId: `old_paging_c_${suffix}`,
      connectorInstanceId: `old_paging_cin_${suffix}`,
      stream: 'transactions',
    };

    for (const day of [1, 2]) {
      await ingestRecord(
        { connectorId: exhausted.connectorId, connectorInstanceId: exhausted.connectorInstanceId },
        { stream: exhausted.stream, key: `a${day}`, data: { id: `a${day}` }, emitted_at: ts(day) }
      );
    }

    for (const day of [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]) {
      await ingestRecord(
        { connectorId: paging.connectorId, connectorInstanceId: paging.connectorInstanceId },
        { stream: paging.stream, key: `b${day}`, data: { id: `b${day}` }, emitted_at: ts(day) }
      );
    }

    const deps = { ...buildSqliteExploreTimelineDeps(), now: () => '2026-02-01T00:00:00.000Z' };
    const page1 = await executeExploreTimeline({ limit: 3, cursor: null, direction: 'asc' }, deps);

    assert.equal(page1.has_more, true, 'page 1 must keep paging after the small partition exhausts');
    assert.deepEqual(
      page1.data.map((r) => r.record_key),
      ['a1', 'a2', 'b3'],
      'page 1 drains partition A while partition B still has older-to-newer records to page'
    );

    const rest = [];
    let cursor = page1.next_cursor;
    let guard = 0;
    while (cursor) {
      const page = await executeExploreTimeline({ limit: 3, cursor }, deps);
      rest.push(...page.data);
      cursor = page.next_cursor;
      if (++guard > 100) throw new Error('exhausted-partition reachability: too many pages');
    }

    const all = [...page1.data, ...rest];
    assert.equal(all.length, 13, 'every record from both partitions remains reachable');

    const keys = all.map((r) => `${r.connector_id}\0${r.stream}\0${r.record_key}`);
    assert.equal(new Set(keys).size, 13, 'pagination must not duplicate records');
    assert.deepEqual(
      all.map((r) => r.record_key),
      ['a1', 'a2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9', 'b10', 'b11', 'b12', 'b13'],
      'asc traversal must keep the exhausted partition records and continue through paging partition B'
    );

    const exhaustedKeys = all.filter((r) => r.connector_id === exhausted.connectorId).map((r) => r.record_key);
    assert.deepEqual(exhaustedKeys, ['a1', 'a2'], 'the exhausted partition records are reached exactly once');
  } finally {
    closeDb();
  }
});

test('§2 the future partition never leaks into the main feed under direction=asc', async () => {
  initDb(':memory:');
  try {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const part = { connectorId: `oldf_c_${suffix}`, connectorInstanceId: `oldf_cin_${suffix}`, stream: 'months' };
    // 3 PAST + 4 FUTURE (relative to the pinned now between them).
    const past = [ts(5), ts(7), ts(9)];
    const future = ['2026-07-01T00:00:00.000Z', '2026-07-15T00:00:00.000Z', '2026-08-01T00:00:00.000Z'];
    let n = 0;
    for (const at of [...past, ...future]) {
      const key = `f${n++}`;
      await ingestRecord(
        { connectorId: part.connectorId, connectorInstanceId: part.connectorInstanceId },
        { stream: part.stream, key, data: { id: key }, emitted_at: at }
      );
    }
    const NOW = '2026-06-21T00:00:00.000Z';
    const deps = { ...buildSqliteExploreTimelineDeps(), now: () => NOW };

    const asc = await pageAll(deps, 'asc', 50);
    // Oldest-first pages the PAST partition floor→ceiling; the 3 future records stay
    // in the separate Upcoming projection, NOT the main feed.
    assert.equal(asc.length, 3, 'asc main feed must contain ONLY the 3 past records');
    for (const r of asc) {
      assert.ok(r.emitted_at.slice(0, 10) <= '2026-06-21', `asc feed record ${r.record_key} must be <= now`);
    }
    assert.equal(asc[0].emitted_at, ts(5), 'asc starts at the earliest PAST record');
    // The Upcoming projection is unchanged by direction (always soonest-future-first).
    const page1 = await executeExploreTimeline({ limit: 50, direction: 'asc' }, deps);
    assert.equal(page1.upcoming_total, 3, 'the bounded future set still has its true total of 3');
  } finally {
    closeDb();
  }
});

test('cursor pins direction: an oldest-first traversal keeps paging ascending across pages', async () => {
  initDb(':memory:');
  try {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    await seedTwoPartitions(suffix);
    const deps = { ...buildSqliteExploreTimelineDeps(), now: () => '2026-02-01T00:00:00.000Z' };

    // Page 1 oldest-first.
    const page1 = await executeExploreTimeline({ limit: 4, direction: 'asc' }, deps);
    assert.equal(page1.data[0].emitted_at, ts(1), 'page 1 starts at the earliest record');
    assert.ok(page1.has_more, 'page 1 has more');
    // Page 2 WITHOUT re-passing direction — the cursor must carry it so the walk
    // stays ascending (a desc default would re-seek backward and break monotonicity).
    const page2 = await executeExploreTimeline({ limit: 4, cursor: page1.next_cursor }, deps);
    const lastOfPage1 = page1.data[page1.data.length - 1].emitted_at;
    for (const r of page2.data) {
      assert.ok(r.emitted_at >= lastOfPage1, `page 2 must continue ASCENDING after ${lastOfPage1}, got ${r.emitted_at}`);
    }
  } finally {
    closeDb();
  }
});
