/**
 * Dual-backend conformance test for the rs.explore.timeline k-way merge.
 *
 * ACCEPTANCE (from spec P3):
 *   - Merged feed returns a composite cursor (`next_cursor`).
 *   - Paging forward yields strictly non-increasing `emitted_at` (no timestamps
 *     go up as pages advance), and no duplicates (record_key × connector_instance_id
 *     × stream is globally unique across all pages).
 *   - Records span multiple (connector_instance_id, stream) partitions.
 *   - Inserting a new record AFTER page 1 does NOT appear in or shift
 *     already-returned pages (snapshot stability).
 *   - The inserted new record IS counted in `new_since_snapshot`.
 *
 * Runs on BOTH SQLite (in-memory) and Postgres (PDPP_TEST_POSTGRES_URL).
 * The Postgres path is skipped when the env var is absent.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { closeDb, initDb } from '../server/db.js';
import { ingestRecord } from '../server/records.js';
import { registerConnector } from '../server/auth.js';
import { closePostgresStorage, initPostgresStorage, postgresQuery } from '../server/postgres-storage.js';
import {
  buildSqliteExploreTimelineDeps,
  buildPostgresExploreTimelineDeps,
} from '../server/explore-timeline-substrate.ts';
import { executeExploreTimeline } from '../operations/rs-explore-timeline/index.ts';

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

// Unique suffix prevents collisions with other test runs.
const SUFFIX = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

// Two (connector_instance_id, stream) partitions across two "connections".
const PARTITION_A = {
  connectorId: `explore_c1_${SUFFIX}`,
  connectorInstanceId: `explore_cin1_${SUFFIX}`,
  stream: 'orders',
};
const PARTITION_B = {
  connectorId: `explore_c2_${SUFFIX}`,
  connectorInstanceId: `explore_cin2_${SUFFIX}`,
  stream: 'transactions',
};

/**
 * A fixed corpus of 12 records (6 per partition) with deterministic timestamps
 * so we can reason about the expected merge order without depending on wall time.
 *
 * emitted_at values interleave across partitions to guarantee the merge must
 * actually pick from both.
 *
 * Timestamps descending: T12 > T11 > … > T1.
 */
const BASE_TS = '2026-01-';
function ts(day) {
  const d = String(day).padStart(2, '0');
  return `2026-01-${d}T12:00:00.000Z`;
}

// Partition A records: days 1, 3, 5, 7, 9, 11
const RECORDS_A = [
  { key: 'a1', data: { id: 'a1', source: 'A' }, emitted_at: ts(1) },
  { key: 'a3', data: { id: 'a3', source: 'A' }, emitted_at: ts(3) },
  { key: 'a5', data: { id: 'a5', source: 'A' }, emitted_at: ts(5) },
  { key: 'a7', data: { id: 'a7', source: 'A' }, emitted_at: ts(7) },
  { key: 'a9', data: { id: 'a9', source: 'A' }, emitted_at: ts(9) },
  { key: 'a11', data: { id: 'a11', source: 'A' }, emitted_at: ts(11) },
];
// Partition B records: days 2, 4, 6, 8, 10, 12
const RECORDS_B = [
  { key: 'b2', data: { id: 'b2', source: 'B' }, emitted_at: ts(2) },
  { key: 'b4', data: { id: 'b4', source: 'B' }, emitted_at: ts(4) },
  { key: 'b6', data: { id: 'b6', source: 'B' }, emitted_at: ts(6) },
  { key: 'b8', data: { id: 'b8', source: 'B' }, emitted_at: ts(8) },
  { key: 'b10', data: { id: 'b10', source: 'B' }, emitted_at: ts(10) },
  { key: 'b12', data: { id: 'b12', source: 'B' }, emitted_at: ts(12) },
];
// "New" record inserted AFTER page 1, to test snapshot stability.
const NEW_RECORD = {
  partition: PARTITION_A,
  key: 'a_new',
  data: { id: 'a_new', source: 'A_NEW' },
  emitted_at: ts(15), // Newer than all existing records.
};

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

// Sequential ingest to avoid bursting too many Postgres connections simultaneously.
async function seedAll() {
  const items = [
    ...RECORDS_A.map((r) => ({ partition: PARTITION_A, r })),
    ...RECORDS_B.map((r) => ({ partition: PARTITION_B, r })),
  ];
  for (const { partition, r } of items) {
    await ingestRecord(
      { connectorId: partition.connectorId, connectorInstanceId: partition.connectorInstanceId },
      { stream: partition.stream, key: r.key, data: r.data, emitted_at: r.emitted_at }
    );
  }
}

async function seedNewRecord() {
  await ingestRecord(
    { connectorId: NEW_RECORD.partition.connectorId, connectorInstanceId: NEW_RECORD.partition.connectorInstanceId },
    { stream: NEW_RECORD.partition.stream, key: NEW_RECORD.key, data: NEW_RECORD.data, emitted_at: NEW_RECORD.emitted_at }
  );
}

// ---------------------------------------------------------------------------
// Assertions shared across backends
// ---------------------------------------------------------------------------

/**
 * Page the merged feed to completion, collecting all records.
 * Verifies:
 *   1. Each page returns a composite cursor (except the last).
 *   2. Overall order is strictly non-increasing emitted_at.
 *   3. No duplicate (connectorId, stream, recordKey) across all pages.
 *   4. Records come from both partitions.
 */
async function pageToEnd(deps, pageSize = 3) {
  const allRecords = [];
  let cursor = null;
  let pageCount = 0;

  while (true) {
    const page = await executeExploreTimeline({ limit: pageSize, cursor }, deps);

    assert.equal(page.object, 'list', 'each page must have object=list');
    assert.ok(Array.isArray(page.data), 'each page must have data array');
    assert.equal(typeof page.snapshot_at, 'string', 'each page must carry snapshot_at');
    assert.equal(typeof page.new_since_snapshot, 'number', 'each page must carry new_since_snapshot');

    allRecords.push(...page.data);
    pageCount++;

    if (!page.has_more) {
      assert.equal(page.next_cursor, null, 'last page must have null next_cursor');
      break;
    }
    assert.ok(
      typeof page.next_cursor === 'string' && page.next_cursor.length > 0,
      'non-last page must have a non-empty next_cursor string'
    );
    cursor = page.next_cursor;

    // Safety guard against infinite loop in a bug.
    if (pageCount > 100) throw new Error('pageToEnd: too many pages — possible infinite loop');
  }

  return { allRecords, pageCount };
}

async function assertConformance(deps, label) {
  await seedAll();

  // --- Full traversal ---
  const { allRecords, pageCount } = await pageToEnd(deps, 3);

  // 12 records seeded across 2 partitions.
  assert.equal(allRecords.length, 12, `${label}: must return all 12 seeded records`);
  assert.ok(pageCount >= 2, `${label}: must require at least 2 pages (page_size=3, 12 records)`);

  // --- Strictly non-increasing emitted_at order ---
  for (let i = 1; i < allRecords.length; i++) {
    const prev = allRecords[i - 1].emitted_at;
    const curr = allRecords[i].emitted_at;
    assert.ok(
      prev >= curr,
      `${label}: order violation at index ${i}: ${prev} < ${curr}`
    );
  }

  // --- No duplicates ---
  const seen = new Set();
  for (const r of allRecords) {
    const key = `${r.connector_id}\0${r.stream}\0${r.record_key}`;
    assert.ok(!seen.has(key), `${label}: duplicate record at ${key}`);
    seen.add(key);
  }

  // --- Spans both partitions ---
  const partitions = new Set(allRecords.map((r) => `${r.connector_id}\0${r.stream}`));
  assert.ok(partitions.size >= 2, `${label}: must span at least 2 partitions, got ${partitions.size}`);

  // --- Snapshot stability: inserting a new record after page 1 does not shift prior pages ---
  {
    // Load page 1 (snapshot anchor is captured here).
    const page1 = await executeExploreTimeline({ limit: 3, cursor: null }, deps);
    assert.ok(page1.has_more, `${label}: page 1 must have more records`);
    assert.ok(page1.next_cursor, `${label}: page 1 must return a cursor`);

    const page1Ids = page1.data.map((r) => r.record_key);
    const snapshotAt = page1.snapshot_at;

    // Insert a record with emitted_at AFTER the snapshot.
    await seedNewRecord();

    // Page 2 must NOT include the new record and must have the same snapshot_at.
    const page2 = await executeExploreTimeline({ limit: 3, cursor: page1.next_cursor }, deps);
    assert.equal(
      page2.snapshot_at,
      snapshotAt,
      `${label}: page 2 snapshot_at must match page 1's anchor`
    );
    const page2Ids = page2.data.map((r) => r.record_key);
    assert.ok(
      !page2Ids.includes(NEW_RECORD.key),
      `${label}: new record must not appear in page 2 (snapshot stability)`
    );

    // The new record must NOT appear in any page using the original snapshot cursor.
    // Continue paging from page2 to exhaustion using the SAME snapshot anchor.
    const remainingRecordKeys = [...page1Ids, ...page2Ids];
    let nextCursor = page2.next_cursor;
    let safetyLimit = 50;
    while (nextCursor && safetyLimit-- > 0) {
      const nextPage = await executeExploreTimeline({ limit: 3, cursor: nextCursor }, deps);
      assert.equal(
        nextPage.snapshot_at,
        snapshotAt,
        `${label}: all pages must share the same snapshot_at anchor`
      );
      for (const r of nextPage.data) {
        assert.ok(
          r.record_key !== NEW_RECORD.key,
          `${label}: new record must not appear in any subsequent page (snapshot stability), found on key ${r.record_key}`
        );
      }
      nextCursor = nextPage.next_cursor;
    }

    // BUT the new record must be counted in new_since_snapshot.
    // Re-request page 2 from the same cursor: it was anchored before the insert,
    // so new_since_snapshot must be >= 1.
    const page2After = await executeExploreTimeline({ limit: 3, cursor: page1.next_cursor }, deps);
    assert.ok(
      page2After.new_since_snapshot >= 1,
      `${label}: new_since_snapshot must be >= 1 after inserting a post-snapshot record`
    );
  }
}

async function assertScopedConformance(deps, label) {
  await seedAll();

  const allRecords = [];
  let cursor = null;
  let pageCount = 0;
  while (true) {
    const page = await executeExploreTimeline({
      connectionIds: [PARTITION_A.connectorInstanceId],
      limit: 2,
      cursor,
    }, deps);
    allRecords.push(...page.data);
    pageCount++;
    if (!page.has_more) {
      assert.equal(page.next_cursor, null, `${label}: last scoped page must have null cursor`);
      break;
    }
    assert.ok(page.next_cursor, `${label}: scoped non-last page must carry a cursor`);
    cursor = page.next_cursor;
    if (pageCount > 20) throw new Error(`${label}: scoped traversal did not terminate`);
  }

  assert.equal(allRecords.length, RECORDS_A.length, `${label}: scoped traversal must reach all partition A records`);
  assert.ok(allRecords.every((r) => r.connector_instance_id === PARTITION_A.connectorInstanceId));
  assert.ok(allRecords.every((r) => r.stream === PARTITION_A.stream));
  assert.equal(
    allRecords.some((r) => r.connector_instance_id === PARTITION_B.connectorInstanceId),
    false,
    `${label}: scoped traversal must not include partition B records`
  );

  const streamScoped = await executeExploreTimeline({
    streams: [PARTITION_B.stream],
    limit: 20,
  }, deps);
  assert.equal(streamScoped.data.length, RECORDS_B.length, `${label}: stream scope must include all partition B records`);
  assert.ok(streamScoped.data.every((r) => r.stream === PARTITION_B.stream));
}

// ---------------------------------------------------------------------------
// Postgres cleanup helper
// ---------------------------------------------------------------------------

async function cleanupPostgres() {
  const cids = [PARTITION_A.connectorInstanceId, PARTITION_B.connectorInstanceId];
  for (const cid of cids) {
    await postgresQuery(
      `DELETE FROM records WHERE connector_instance_id = $1`,
      [cid]
    ).catch(() => {});
    await postgresQuery(
      `DELETE FROM record_changes WHERE connector_instance_id = $1`,
      [cid]
    ).catch(() => {});
    await postgresQuery(
      `DELETE FROM version_counter WHERE connector_instance_id = $1`,
      [cid]
    ).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// SQLite test
// ---------------------------------------------------------------------------

test('rs.explore.timeline: SQLite dual-backend conformance', async () => {
  initDb(':memory:');
  try {
    const deps = buildSqliteExploreTimelineDeps();
    await assertConformance(deps, 'sqlite');
  } finally {
    closeDb();
  }
});

test('rs.explore.timeline: SQLite scoped timeline conformance', async () => {
  initDb(':memory:');
  try {
    const deps = buildSqliteExploreTimelineDeps();
    await assertScopedConformance(deps, 'sqlite');
  } finally {
    closeDb();
  }
});

// Reproduce-the-bug: when the records with the NEWEST semantic dates are all in the
// FUTURE (e.g. YNAB budget months dated months ahead), they must NOT dominate the
// newest-first main feed above today. The main feed is clamped to <= nowCeiling; the
// future set is a separate Upcoming projection with a TRUE total. Pre-fix, the first
// page was entirely future → the main feed showed empty-state above today.
test('rs.explore.timeline: future-dated records go to a separate Upcoming projection, not above today (SQLite)', async () => {
  initDb(':memory:');
  try {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const part = { connectorId: `fut_c_${suffix}`, connectorInstanceId: `fut_cin_${suffix}`, stream: 'months' };
    // 3 PAST records (Jan 2026) + 4 FUTURE records (Jul/Aug 2026), all dated via
    // emitted_at (these test connectors have no manifest → semantic_time falls back
    // to emitted_at). The future ones are the NEWEST by date.
    const past = [ts(5), ts(7), ts(9)];
    const future = ['2026-07-01T00:00:00.000Z', '2026-07-15T00:00:00.000Z', '2026-08-01T00:00:00.000Z', '2026-08-15T00:00:00.000Z'];
    let n = 0;
    for (const at of [...past, ...future]) {
      const key = `r_${n++}`;
      await ingestRecord(
        { connectorId: part.connectorId, connectorInstanceId: part.connectorInstanceId },
        { stream: part.stream, key, data: { id: key }, emitted_at: at }
      );
    }
    // Pin "now" to 2026-06-21 (between the past and future records).
    const NOW = '2026-06-21T00:00:00.000Z';
    const deps = { ...buildSqliteExploreTimelineDeps(), now: () => NOW };

    const page = await executeExploreTimeline({ limit: 50 }, deps);

    // MAIN feed: only the 3 PAST records, NOT empty, none future.
    assert.equal(page.data.length, 3, 'main feed must contain the 3 past records, not the future ones');
    for (const r of page.data) {
      const semDay = r.emitted_at.slice(0, 10);
      assert.ok(semDay <= '2026-06-21', `main feed record ${r.record_key} (${semDay}) must be <= now`);
    }
    // UPCOMING: the 4 future records, soonest-first, with a TRUE total of 4.
    assert.equal(page.upcoming_total, 4, 'upcoming_total must be the true count of all future records');
    assert.equal(page.upcoming.length, 4, 'upcoming head must carry the future records');
    const upcomingDays = page.upcoming.map((r) => r.emitted_at.slice(0, 10));
    assert.deepEqual(
      upcomingDays,
      ['2026-07-01', '2026-07-15', '2026-08-01', '2026-08-15'],
      'upcoming must be FORWARD-chronological (soonest future first)'
    );
  } finally {
    closeDb();
  }
});

// Pin-stability: the past/future boundary is captured at first-page and carried in the
// cursor (v4). Even if wall-clock advances between pages, the split must NOT change —
// the same `nowCeiling` is used on page 2+. We simulate an advancing clock via deps.now
// and assert the cursor's pinned boundary wins (a future record does not leak into the
// past feed mid-traversal).
test('rs.explore.timeline: the past/future boundary is PINNED in the cursor across pages (SQLite)', async () => {
  initDb(':memory:');
  try {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const part = { connectorId: `pin_c_${suffix}`, connectorInstanceId: `pin_cin_${suffix}`, stream: 'orders' };
    // 4 past records + 1 record dated 2026-06-25 (future at page-1 capture, becomes
    // "past" if the clock advances past it mid-traversal).
    const ats = [ts(2), ts(4), ts(6), ts(8), '2026-06-25T00:00:00.000Z'];
    let n = 0;
    for (const at of ats) {
      const key = `p_${n++}`;
      await ingestRecord(
        { connectorId: part.connectorId, connectorInstanceId: part.connectorInstanceId },
        { stream: part.stream, key, data: { id: key }, emitted_at: at }
      );
    }
    // Advancing clock: page 1 at 2026-06-21 (the 06-25 record is FUTURE); a later page
    // would be at 2026-06-30 (06-25 now in the PAST) — but the pinned cursor must keep
    // it OUT of the main feed for the whole traversal.
    let calls = 0;
    const clock = () => (calls++ === 0 ? '2026-06-21T00:00:00.000Z' : '2026-06-30T00:00:00.000Z');
    const deps = { ...buildSqliteExploreTimelineDeps(), now: clock };

    const collected = [];
    let cursor = null;
    let guard = 20;
    do {
      const page = await executeExploreTimeline({ limit: 2, cursor }, deps);
      collected.push(...page.data.map((r) => r.record_key));
      cursor = page.has_more ? page.next_cursor : null;
    } while (cursor && guard-- > 0);

    // The 06-25 record must NEVER appear in the main feed across ALL pages, because
    // nowCeiling was pinned to 2026-06-21 on page 1 — even though the clock later says
    // it is past. If the boundary were recomputed per page, it would leak in (or skip).
    assert.ok(!collected.includes('p_4'), 'the boundary-crossing record must stay OUT of the main feed (pinned now)');
    assert.equal(collected.length, 4, 'main feed must contain exactly the 4 originally-past records');
  } finally {
    closeDb();
  }
});

// The server returns the authoritative `semantic_time` it ORDERED by, so the client
// uses it directly as displayAt (display == sort by construction) — no manifest-
// metadata re-derivation seam (the canonical-connector-key bug surfaced exactly there).
test('rs.explore.timeline: each record carries semantic_time and the feed is ordered by it (SQLite)', async () => {
  initDb(':memory:');
  try {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const part = { connectorId: `sem_c_${suffix}`, connectorInstanceId: `sem_cin_${suffix}`, stream: 'messages' };
    // Ingest ascending emitted_at; semantic_time falls back to emitted_at (no manifest).
    for (const day of [3, 6, 9, 12]) {
      await ingestRecord(
        { connectorId: part.connectorId, connectorInstanceId: part.connectorInstanceId },
        { stream: part.stream, key: `m_${day}`, data: { id: `m_${day}` }, emitted_at: ts(day) }
      );
    }
    const deps = { ...buildSqliteExploreTimelineDeps(), now: () => '2026-06-21T00:00:00.000Z' };
    const page = await executeExploreTimeline({ limit: 50 }, deps);

    assert.equal(page.data.length, 4);
    for (const r of page.data) {
      assert.equal(typeof r.semantic_time, 'string', 'every record must carry semantic_time');
      assert.ok(r.semantic_time.length > 0, 'semantic_time must be non-empty');
    }
    // The feed is DESC by semantic_time — strictly non-increasing across records.
    for (let i = 1; i < page.data.length; i += 1) {
      assert.ok(
        page.data[i - 1].semantic_time >= page.data[i].semantic_time,
        `feed must be ordered by semantic_time: ${page.data[i - 1].semantic_time} >= ${page.data[i].semantic_time}`
      );
    }
    // Newest first: m_12 leads, m_3 trails — and semantic_time == the emitted_at here.
    assert.deepEqual(page.data.map((r) => r.record_key), ['m_12', 'm_9', 'm_6', 'm_3']);
    assert.equal(page.data[0].semantic_time, ts(12));
  } finally {
    closeDb();
  }
});

// Regression: the composite cursor blob is O(partition-count). Before the
// server-side cursor store, next_cursor was the raw blob in the URL, which
// overflowed the proxy URL limit (HTTP 431) at scale. With the store, the URL
// carries a short opaque handle regardless of partition count. See
// docs/research/explore-cursor-431-diagnosis-2026-06-20.md.
test('rs.explore.timeline: next_cursor is a short opaque handle, not an O(partitions) blob (HTTP 431 regression)', async () => {
  initDb(':memory:');
  try {
    const deps = buildSqliteExploreTimelineDeps();

    // Seed MANY partitions so the underlying blob would be large. One record
    // per (connection, stream) across 120 partitions = 120 entries the blob
    // must remember for snapshot stability.
    const PARTITION_COUNT = 120;
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    for (let i = 0; i < PARTITION_COUNT; i += 1) {
      const connectorInstanceId = `cin_blob_${suffix}_${String(i).padStart(4, '0')}`;
      const key = `r_${i}`;
      await ingestRecord(
        { connectorId: `conn_blob_${suffix}`, connectorInstanceId },
        { stream: 'records', key, data: { id: key }, emitted_at: ts((i % 27) + 1) }
      );
    }

    // Small page so the feed does NOT exhaust on page 1 — the cursor must
    // therefore carry the full snapshot-time partition set forward.
    const page1 = await executeExploreTimeline({ limit: 5, cursor: null }, deps);
    assert.ok(page1.has_more, 'with 120 partitions and limit 5 there must be more pages');
    assert.ok(page1.next_cursor, 'page 1 must return a cursor');

    // The cursor in the URL must be a short opaque handle, NOT the multi-KB blob.
    // The raw blob for 120 partitions is many KB; a handle is well under 100 chars.
    assert.ok(
      page1.next_cursor.startsWith('ecr1_'),
      `next_cursor must be an opaque handle (got: ${page1.next_cursor.slice(0, 24)}...)`
    );
    assert.ok(
      page1.next_cursor.length < 100,
      `next_cursor handle must be short to stay under URL limits (got ${page1.next_cursor.length} chars)`
    );

    // The handle must resolve: pagination continues and reaches the end without
    // dropping records (snapshot stability + full visibility preserved).
    const seen = new Set();
    const collect = (page) => {
      for (const r of page.data) {
        seen.add(`${r.connector_instance_id} ${r.stream} ${r.record_key}`);
      }
    };
    collect(page1);
    let cursor = page1.next_cursor;
    let guard = 0;
    while (cursor) {
      const page = await executeExploreTimeline({ limit: 5, cursor }, deps);
      collect(page);
      cursor = page.next_cursor;
      guard += 1;
      assert.ok(guard < 200, 'pagination must terminate');
    }
    assert.equal(
      seen.size,
      PARTITION_COUNT,
      'exhaustive paging via the handle must reach every record across all 120 partitions (no silent cap)'
    );

    // An unknown/expired handle is rejected with a typed invalid_cursor error,
    // not a crash.
    await assert.rejects(
      () => executeExploreTimeline({ limit: 5, cursor: 'ecr1_deadbeefdeadbeefdeadbeefdeadbeef' }, deps),
      (err) => err && err.code === 'invalid_cursor',
      'an unknown cursor handle must raise a typed invalid_cursor error'
    );
  } finally {
    closeDb();
  }
});

// ---------------------------------------------------------------------------
// Postgres test
// ---------------------------------------------------------------------------

if (!POSTGRES_URL) {
  test('rs.explore.timeline: Postgres dual-backend conformance (skipped: PDPP_TEST_POSTGRES_URL unset)', {
    skip: true,
  }, () => {});
} else {
  test('rs.explore.timeline: Postgres dual-backend conformance', async () => {
    initDb(':memory:');
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });
    try {
      await cleanupPostgres();
      const deps = buildPostgresExploreTimelineDeps();
      await assertConformance(deps, 'postgres');
    } finally {
      await cleanupPostgres();
      await closePostgresStorage();
      closeDb();
    }
  });

  test('rs.explore.timeline: Postgres scoped timeline conformance', async () => {
    initDb(':memory:');
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });
    try {
      await cleanupPostgres();
      const deps = buildPostgresExploreTimelineDeps();
      await assertScopedConformance(deps, 'postgres');
    } finally {
      await cleanupPostgres();
      await closePostgresStorage();
      closeDb();
    }
  });
}

// ---------------------------------------------------------------------------
// Reproduce-the-bug: order by SEMANTIC time, not ingest time
// ---------------------------------------------------------------------------
//
// Bug: ChatGPT (and any backfilled source) ingests many records in ONE run, so
// their emitted_at clusters at backfill time while their authored create_time
// spans months. Ordering the merged feed by emitted_at made "the bottom stay at
// the bottom": records sorted by COLLECTION time, not when the conversation
// actually happened. The fix orders by each record's SEMANTIC time
// (manifest consent_time_field/cursor_field, here `create_time`), keyset-paged
// on semantic time, while MEMBERSHIP stays anchored on the ingest sequence id.
//
// This test seeds records whose SEMANTIC order is the INVERSE of their INGEST /
// emitted_at order, then asserts the feed comes back in semantic order. It FAILS
// on the pre-fix emitted_at sort (which would return the inverse) and PASSES
// after. Runs on SQLite and (when PDPP_TEST_POSTGRES_URL is set) Postgres.

const SEM_SUFFIX = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const SEM_CONNECTOR_ID = `explore_sem_${SEM_SUFFIX}`;
const SEM_INSTANCE_ID = `explore_sem_cin_${SEM_SUFFIX}`;
const SEM_STREAM = 'conversations';

// `create_time` is the declared semantic field. Manifest mirrors a ChatGPT-shaped
// stream: an authored timestamp distinct from ingest time.
const SEM_MANIFEST = {
  protocol_version: '0.1.0',
  connector_id: SEM_CONNECTOR_ID,
  version: '1.0.0',
  display_name: 'Explore Semantic-Time Test Connector',
  capabilities: { human_interaction: [] },
  streams: [
    {
      name: SEM_STREAM,
      primary_key: ['id'],
      cursor_field: 'create_time',
      consent_time_field: 'create_time',
      schema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
          title: { type: ['string', 'null'] },
          create_time: { type: ['string', 'null'], format: 'date-time' },
        },
      },
    },
  ],
};

// Ingest order (the order of this array) ASCENDS by emitted_at: r1 ingested
// first/oldest emitted_at, r4 last/newest emitted_at. create_time is INVERTED:
// r1 is the semantically-NEWEST, r4 the semantically-OLDEST. So:
//   - emitted_at DESC (pre-fix bug) would order: r4, r3, r2, r1
//   - semantic_time DESC (the fix)   orders:     r1, r2, r3, r4
const SEM_RECORDS = [
  { key: 'r1', emitted_at: ts(1), create_time: ts(28) },
  { key: 'r2', emitted_at: ts(2), create_time: ts(20) },
  { key: 'r3', emitted_at: ts(3), create_time: ts(12) },
  { key: 'r4', emitted_at: ts(4), create_time: ts(5) },
];
// Order the feed MUST come back in (semantic time DESC).
const SEM_EXPECTED_ORDER = ['r1', 'r2', 'r3', 'r4'];
// The order the pre-fix emitted_at sort produced (proves the keys differ).
const SEM_INGEST_ORDER = ['r4', 'r3', 'r2', 'r1'];

async function seedSemanticRecords() {
  for (const r of SEM_RECORDS) {
    await ingestRecord(
      { connectorId: SEM_CONNECTOR_ID, connectorInstanceId: SEM_INSTANCE_ID },
      {
        stream: SEM_STREAM,
        key: r.key,
        data: { id: r.key, title: `conv ${r.key}`, create_time: r.create_time },
        emitted_at: r.emitted_at,
      }
    );
  }
}

async function assertSemanticOrder(deps, label) {
  await registerConnector(SEM_MANIFEST);
  await seedSemanticRecords();

  const page = await executeExploreTimeline({ limit: 50 }, deps);
  const order = page.data.map((r) => r.record_key);

  assert.equal(order.length, SEM_RECORDS.length, `${label}: must return all seeded records`);

  // The merged feed is ordered by SEMANTIC time (create_time) DESC.
  assert.deepEqual(
    order,
    SEM_EXPECTED_ORDER,
    `${label}: feed must be ordered by semantic time DESC (got ${order.join(',')})`
  );

  // And that order is genuinely DIFFERENT from the ingest/emitted_at order —
  // otherwise the test would pass trivially even with the pre-fix sort.
  assert.notDeepEqual(
    order,
    SEM_INGEST_ORDER,
    `${label}: semantic order must differ from the emitted_at/ingest order (the bug)`
  );

  // emitted_at is NOT monotonic in the returned feed (proves we did not sort by
  // it): the semantically-newest record r1 has the OLDEST emitted_at.
  const emittedSeq = page.data.map((r) => r.emitted_at);
  assert.equal(emittedSeq[0], ts(1), `${label}: head record (semantic-newest) carries the oldest emitted_at`);
}

async function cleanupSemanticPostgres() {
  await postgresQuery(`DELETE FROM records WHERE connector_instance_id = $1`, [SEM_INSTANCE_ID]).catch(() => {});
  await postgresQuery(`DELETE FROM record_changes WHERE connector_instance_id = $1`, [SEM_INSTANCE_ID]).catch(() => {});
  await postgresQuery(`DELETE FROM version_counter WHERE connector_instance_id = $1`, [SEM_INSTANCE_ID]).catch(() => {});
}

test('rs.explore.timeline: SQLite orders by SEMANTIC time, not ingest time (bug 2)', async () => {
  initDb(':memory:');
  try {
    const deps = buildSqliteExploreTimelineDeps();
    await assertSemanticOrder(deps, 'sqlite');
  } finally {
    closeDb();
  }
});

if (!POSTGRES_URL) {
  test('rs.explore.timeline: Postgres orders by SEMANTIC time (skipped: PDPP_TEST_POSTGRES_URL unset)', {
    skip: true,
  }, () => {});
} else {
  test('rs.explore.timeline: Postgres orders by SEMANTIC time, not ingest time (bug 2)', async () => {
    initDb(':memory:');
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });
    try {
      await cleanupSemanticPostgres();
      const deps = buildPostgresExploreTimelineDeps();
      await assertSemanticOrder(deps, 'postgres');
    } finally {
      await cleanupSemanticPostgres();
      await closePostgresStorage();
      closeDb();
    }
  });
}
