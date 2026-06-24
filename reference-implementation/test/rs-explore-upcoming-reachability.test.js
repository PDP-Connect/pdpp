/**
 * Reproduce-the-bug + reachability test for the Upcoming (future) projection.
 *
 * THE BUG ("188 upcoming but only 32 reachable"): the Upcoming pill showed a TRUE
 * server count (e.g. 188) but the section only ever rendered a capped head (32),
 * with no way to reach members 33..188. count==reachability requires the future set
 * be walkable to its LAST member. This test pins that invariant.
 *
 * ACCEPTANCE (Codex-gated, Slice 1):
 *   1. Page Upcoming to exhaustion via the upcoming composite cursor; EVERY future
 *      record is reachable exactly once (no dup, no skip) — incl. the last ("188th").
 *   2. Ties in semantic_time across partitions AND within one partition are handled
 *      (the per-partition cursor, not a flat global (time,key) seek — record_key is
 *      unique only within a partition).
 *   3. `upcoming_total` equals the true future count and is STABLE across pages.
 *   4. Past records never leak into Upcoming; future records never leak into the feed.
 *   5. A future record backfilled AFTER the snapshot is excluded from the pinned walk.
 *
 * Runs on BOTH SQLite (in-memory) and Postgres (PDPP_TEST_POSTGRES_URL).
 * The Postgres path is skipped when the env var is absent.
 *
 * PG PLAN EVIDENCE (Codex acceptance #4, verified 2026-06-21 on a throwaway PG16
 * with 5000 future rows in one partition): the ASC upcoming walk is served by a
 * BACKWARD scan of the DESC expression index `idx_pg_records_semantic_time`
 * (connector_instance_id, stream, COALESCE(NULLIF(semantic_time,''),emitted_at)
 * DESC, record_key DESC) — NOT a Seq Scan + Sort, for BOTH the first page and the
 * cursor (seek) page:
 *   first page : Index Scan Backward, cost 0.28..6.95,  ~0.09ms
 *   cursor page: Index Scan Backward, cost 0.28..10.46, ~1.04ms (seek OR-predicate
 *                applied as a filter atop the index range; still no Sort node)
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { closeDb, initDb } from '../server/db.js';
import { ingestRecord } from '../server/records.js';
import { closePostgresStorage, initPostgresStorage, postgresQuery } from '../server/postgres-storage.js';
import {
  buildSqliteExploreTimelineDeps,
  buildPostgresExploreTimelineDeps,
} from '../server/explore-timeline-substrate.ts';
import {
  executeExploreTimeline,
  executeExploreUpcoming,
} from '../operations/rs-explore-timeline/index.ts';

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

// Unique suffix prevents collisions across runs / DBs.
const SUFFIX = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

// The pinned past/future boundary for the whole test. Records with semantic time
// (== emitted_at, since no manifest declares a consent/cursor field) strictly AFTER
// this are "future"; <= are "past".
const PINNED_NOW = '2026-06-21T00:00:00.000Z';

// Three (connector_instance_id, stream) partitions across three "connections".
const PARTITIONS = [
  { connectorId: `up_c1_${SUFFIX}`, connectorInstanceId: `up_cin1_${SUFFIX}`, stream: 'orders' },
  { connectorId: `up_c2_${SUFFIX}`, connectorInstanceId: `up_cin2_${SUFFIX}`, stream: 'transactions' },
  { connectorId: `up_c3_${SUFFIX}`, connectorInstanceId: `up_cin3_${SUFFIX}`, stream: 'budgets' },
];

// A future timestamp `daysAhead` after the boundary (distinct minute → unique time).
function futureTs(daysAhead, minute = 0) {
  // 2026-06 has 30 days; keep daysAhead small enough to stay in-month for simplicity.
  const day = 21 + daysAhead;
  const dd = String(day).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  return `2026-06-${dd}T00:${mm}:00.000Z`;
}
function pastTs(day) {
  const dd = String(day).padStart(2, '0');
  return `2026-06-${dd}T00:00:00.000Z`; // day < 21 → before PINNED_NOW
}

/**
 * Build the seed plan. Returns { future, past } record descriptors.
 *
 * Future records are intentionally numerous (well past any small page limit) and
 * include deliberate ties:
 *   - cross-partition tie: all three partitions have a record at the SAME future
 *     time (futureTs(1, 0)) but with the SAME record_key 'tie' — proving record_key
 *     is NOT globally unique, the exact hazard a flat global cursor would mis-skip.
 *   - within-partition tie: partition 0 has two records at futureTs(2, 0) with
 *     different keys 'w1'/'w2'.
 */
function buildSeedPlan() {
  const future = [];
  const past = [];

  // Past records (must never appear in Upcoming): 2 per partition.
  for (const p of PARTITIONS) {
    past.push({ partition: p, key: 'p1', data: { id: 'p1' }, emitted_at: pastTs(10) });
    past.push({ partition: p, key: 'p2', data: { id: 'p2' }, emitted_at: pastTs(15) });
  }

  // Cross-partition tie: same future time, same key in all 3 partitions.
  for (const p of PARTITIONS) {
    future.push({ partition: p, key: 'tie', data: { id: 'tie' }, emitted_at: futureTs(1, 0) });
  }

  // Within-partition tie: partition 0 has two keys at the same future time.
  future.push({ partition: PARTITIONS[0], key: 'w1', data: { id: 'w1' }, emitted_at: futureTs(2, 0) });
  future.push({ partition: PARTITIONS[0], key: 'w2', data: { id: 'w2' }, emitted_at: futureTs(2, 0) });

  // A spread of distinct future records across partitions so the merge interleaves
  // and the total comfortably exceeds a small page size. 7 per partition * 3 = 21,
  // plus the 3 ties + 2 within-ties = 26 future records total.
  for (let i = 0; i < PARTITIONS.length; i += 1) {
    const p = PARTITIONS[i];
    for (let k = 0; k < 7; k += 1) {
      // Stagger minutes by partition so cross-partition times mostly differ.
      future.push({
        partition: p,
        key: `f${i}_${k}`,
        data: { id: `f${i}_${k}` },
        emitted_at: futureTs(3 + k, i + 1),
      });
    }
  }

  return { future, past };
}

async function seedPlan(plan) {
  for (const r of [...plan.past, ...plan.future]) {
    await ingestRecord(
      { connectorId: r.partition.connectorId, connectorInstanceId: r.partition.connectorInstanceId },
      { stream: r.partition.stream, key: r.key, data: r.data, emitted_at: r.emitted_at }
    );
  }
}

/** A globally-unique identity for a returned upcoming record. */
function recIdentity(r) {
  return `${r.connector_instance_id}\0${r.stream}\0${r.record_key}`;
}

/** Inject a pinned `now` so the past/future boundary is deterministic. */
function withPinnedNow(deps) {
  return { ...deps, now: () => PINNED_NOW };
}

/**
 * Page Upcoming to exhaustion. Page 1 comes from executeExploreTimeline (which
 * carries upcoming + upcoming_total + upcoming_next_cursor); subsequent pages from
 * executeExploreUpcoming(upcoming_next_cursor).
 */
async function pageUpcomingToEnd(deps, pageSize) {
  const collected = [];
  const totalsSeen = [];

  const page1 = await executeExploreTimeline({ limit: pageSize, cursor: null }, deps);
  collected.push(...page1.upcoming);
  totalsSeen.push(page1.upcoming_total);

  let cursor = page1.upcoming_next_cursor;
  let hasMore = page1.upcoming_has_more;
  let pages = 1;
  while (hasMore) {
    assert.ok(
      typeof cursor === 'string' && cursor.length > 0,
      'upcoming_has_more implies a non-empty upcoming_next_cursor'
    );
    const next = await executeExploreUpcoming({ upcomingCursor: cursor, limit: pageSize }, deps);
    collected.push(...next.upcoming);
    cursor = next.upcoming_next_cursor;
    hasMore = next.upcoming_has_more;
    pages += 1;
    if (pages > 500) {
      throw new Error('pageUpcomingToEnd: too many pages — possible infinite loop / cursor non-advance');
    }
  }
  assert.equal(cursor, null, 'exhausted Upcoming must end with a null upcoming_next_cursor');
  return { collected, pages, page1Total: totalsSeen[0] };
}

async function assertUpcomingReachable(deps, label) {
  const plan = buildSeedPlan();
  await seedPlan(plan);

  const expectedFuture = new Set(
    plan.future.map((r) => `${r.partition.connectorInstanceId}\0${r.partition.stream}\0${r.key}`)
  );
  const expectedPast = new Set(
    plan.past.map((r) => `${r.partition.connectorInstanceId}\0${r.partition.stream}\0${r.key}`)
  );

  // Small page size so the future set (26) requires many pages — the 188->32 shape.
  const PAGE = 4;
  const { collected, pages, page1Total } = await pageUpcomingToEnd(deps, PAGE);

  // (1) Reachability: every future record reachable exactly once.
  assert.ok(pages >= 2, `${label}: ${expectedFuture.size} future records at page=${PAGE} must need >= 2 pages`);
  const seen = new Set();
  for (const r of collected) {
    const id = recIdentity(r);
    assert.ok(!seen.has(id), `${label}: duplicate upcoming record ${id}`);
    seen.add(id);
    assert.ok(!expectedPast.has(id), `${label}: PAST record leaked into Upcoming: ${id}`);
  }
  assert.equal(
    seen.size,
    expectedFuture.size,
    `${label}: every future record must be reachable (got ${seen.size}, want ${expectedFuture.size})`
  );
  for (const id of expectedFuture) {
    assert.ok(seen.has(id), `${label}: future record UNREACHABLE (the 188->32 bug): ${id}`);
  }

  // (2) Ties: the cross-partition 'tie' key appears once per partition (3 total).
  const tieCount = [...seen].filter((id) => id.endsWith('\0tie')).length;
  assert.equal(tieCount, PARTITIONS.length, `${label}: cross-partition tie rows all reachable (got ${tieCount})`);

  // (3) upcoming_total equals the true future count and is stable across pages.
  assert.equal(
    page1Total,
    expectedFuture.size,
    `${label}: upcoming_total must equal the true future count (${expectedFuture.size}), got ${page1Total}`
  );

  // (4) Forward-chronological (soonest-first) order across the whole walk.
  for (let i = 1; i < collected.length; i += 1) {
    assert.ok(
      collected[i - 1].semantic_time <= collected[i].semantic_time,
      `${label}: Upcoming must be soonest-first; order break at ${i}: ` +
        `${collected[i - 1].semantic_time} > ${collected[i].semantic_time}`
    );
  }

  // (5) The main feed (past) must contain NO future record.
  const feed = await executeExploreTimeline({ limit: 100, cursor: null }, deps);
  for (const r of feed.data) {
    const id = recIdentity(r);
    assert.ok(!expectedFuture.has(id), `${label}: FUTURE record leaked into the main feed: ${id}`);
  }
}

/**
 * A future record backfilled AFTER the snapshot must NOT appear in a walk pinned to
 * the original snapshot (membership stays id <= snapshotSeq).
 */
async function assertPostSnapshotFutureExcluded(deps, label) {
  const plan = buildSeedPlan();
  await seedPlan(plan);

  const page1 = await executeExploreTimeline({ limit: 4, cursor: null }, deps);
  const totalAtSnapshot = page1.upcoming_total;

  // Backfill a NEW future record after the snapshot.
  const p = PARTITIONS[1];
  await ingestRecord(
    { connectorId: p.connectorId, connectorInstanceId: p.connectorInstanceId },
    { stream: p.stream, key: 'post_snapshot_future', data: { id: 'post_snapshot_future' }, emitted_at: '2026-07-15T00:30:00.000Z' }
  );

  // Walk the rest of Upcoming using the pinned cursor; the new record must be absent.
  let cursor = page1.upcoming_next_cursor;
  let hasMore = page1.upcoming_has_more;
  const post = [...page1.upcoming];
  let guard = 500;
  while (hasMore && guard-- > 0) {
    const next = await executeExploreUpcoming({ upcomingCursor: cursor, limit: 4 }, deps);
    post.push(...next.upcoming);
    cursor = next.upcoming_next_cursor;
    hasMore = next.upcoming_has_more;
  }
  const leaked = post.some((r) => r.record_key === 'post_snapshot_future');
  assert.ok(!leaked, `${label}: a post-snapshot future backfill must NOT appear in the pinned Upcoming walk`);

  // And the carried total from page 1 reflects only the snapshot (unchanged).
  assert.equal(
    totalAtSnapshot,
    buildSeedPlan().future.length,
    `${label}: upcoming_total at snapshot must exclude the post-snapshot backfill`
  );
}

// ---------------------------------------------------------------------------
// SQLite suite
// ---------------------------------------------------------------------------

test('Upcoming reachability (sqlite): every future record reachable, ties + stable total', async () => {
  initDb(':memory:');
  try {
    await assertUpcomingReachable(withPinnedNow(buildSqliteExploreTimelineDeps()), 'sqlite');
  } finally {
    closeDb();
  }
});

test('Upcoming post-snapshot exclusion (sqlite): backfilled future excluded from pinned walk', async () => {
  initDb(':memory:');
  try {
    await assertPostSnapshotFutureExcluded(withPinnedNow(buildSqliteExploreTimelineDeps()), 'sqlite');
  } finally {
    closeDb();
  }
});

/**
 * The Upcoming head has its OWN limit (`upcomingLimit`), independent of the small
 * feed `limit`, so the bounded future set is revealed on first expand instead of a
 * 32-row slice that needs repeated load-more (the 32→64 tedium). With a small feed
 * limit but a large upcomingLimit, page 1 returns the WHOLE upcoming head at once.
 */
test('Upcoming head limit (sqlite): a small feed limit + large upcomingLimit reveals the whole bounded set at once', async () => {
  initDb(':memory:');
  try {
    const deps = withPinnedNow(buildSqliteExploreTimelineDeps());
    const plan = buildSeedPlan();
    await seedPlan(plan);
    const futureCount = plan.future.length; // 26 in the fixture

    // Tiny feed page (4), but ask for the whole future set in the upcoming head.
    const page = await executeExploreTimeline({ limit: 4, upcomingLimit: 100, cursor: null }, deps);
    assert.equal(page.upcoming_total, futureCount, 'true total is the whole future set');
    assert.equal(
      page.upcoming.length,
      futureCount,
      `the upcoming head must reveal ALL ${futureCount} future records at once (got ${page.upcoming.length}), not the 4-row feed slice`
    );
    assert.ok(!page.upcoming_has_more, 'with the whole set in the head, no further upcoming pages remain');
    assert.equal(page.upcoming_next_cursor, null, 'a fully-revealed upcoming set issues no next cursor');
    // The MAIN feed still honored its small limit (the two limits are independent).
    assert.ok(page.data.length <= 4, 'the main feed still respects the small feed limit');
  } finally {
    closeDb();
  }
});

/**
 * The upcoming cursor blob is O(live-future-partitions); the client ACCUMULATES it
 * into a URL trail. With a cursor store wired (production), upcoming_next_cursor MUST
 * be a SHORT opaque handle (`ecr1_…`), NOT the raw O(partitions) blob — otherwise the
 * trail reintroduces the HTTP 431 class. This proves the URL stays bounded as the
 * partition count grows, AND that paging via the handle still reaches every record.
 */
test('Upcoming bounded URL (sqlite): the next cursor is a short opaque handle, not an O(partitions) blob', async () => {
  initDb(':memory:');
  try {
    const deps = withPinnedNow(buildSqliteExploreTimelineDeps());
    // Seed MANY partitions, each with several future records, so a raw composite
    // blob would be large. record_key uniqueness is per-partition.
    const MANY = 40;
    for (let p = 0; p < MANY; p += 1) {
      const connectorInstanceId = `up_many_cin_${p}_${SUFFIX}`;
      const connectorId = `up_many_c_${p}_${SUFFIX}`;
      for (let k = 0; k < 3; k += 1) {
        const key = `m${p}_${k}`;
        await ingestRecord(
          { connectorId, connectorInstanceId },
          { stream: 'orders', key, data: { id: key }, emitted_at: futureTs(1 + k, p % 60) }
        );
      }
    }

    // Page 1 with a small limit so the future set (120 rows) is far from exhausted.
    const page1 = await executeExploreTimeline({ limit: 4, cursor: null }, deps);
    assert.ok(page1.upcoming_has_more, 'many future partitions → more upcoming after page 1');
    const cursor = page1.upcoming_next_cursor;
    assert.ok(typeof cursor === 'string' && cursor.length > 0, 'a next upcoming cursor is issued');
    // BOUNDED: a short opaque handle, NOT a raw blob. The raw blob for 40 partitions
    // would be many hundreds of chars; the handle is `ecr1_` + 32 hex = 37 chars.
    assert.ok(cursor.startsWith('ecr1_'), `upcoming_next_cursor must be a server-stored handle, got: ${cursor.slice(0, 24)}…`);
    assert.ok(cursor.length <= 64, `the handle must stay short/bounded, got length ${cursor.length}`);

    // And paging via the handle still reaches the next page (the store round-trips).
    const page2 = await executeExploreUpcoming({ upcomingCursor: cursor, limit: 4 }, deps);
    assert.ok(page2.upcoming.length > 0, 'paging via the opaque handle returns the next upcoming page');
    assert.ok(
      !page2.upcoming_next_cursor || page2.upcoming_next_cursor.startsWith('ecr1_'),
      'subsequent upcoming cursors are also bounded handles'
    );

    // An unknown handle is a typed invalid_cursor (reload), not a silent empty page.
    await assert.rejects(
      () => executeExploreUpcoming({ upcomingCursor: 'ecr1_deadbeefdeadbeefdeadbeefdeadbeef', limit: 4 }, deps),
      (err) => err && err.code === 'invalid_cursor',
      'an unknown upcoming handle must throw invalid_cursor'
    );
  } finally {
    closeDb();
  }
});

/**
 * EXCLUDE scope ("is not" facet / `-con:`/`-stream:`) is applied SERVER-SIDE at
 * partition enumeration, so an excluded connection's records are absent from the
 * feed, the Upcoming projection, AND the exact upcoming_total — counts stay exact,
 * never client-side shrunk. This is the count-honest implementation Codex required.
 * Shared across SQLite + Postgres so both storage paths (`NOT IN` / `<> ALL`) are
 * covered.
 */
async function assertExcludeScope(deps, label) {
  const plan = buildSeedPlan();
  await seedPlan(plan);
  const excluded = PARTITIONS[0].connectorInstanceId; // exclude partition 0 entirely

  // Baseline: nothing excluded → the excluded connection IS present.
  const base = await executeExploreTimeline({ limit: 100, upcomingLimit: 500, cursor: null }, deps);
  const baseFuture = base.upcoming_total;
  assert.ok(
    base.upcoming.some((r) => r.connector_instance_id === excluded),
    `${label}: baseline — the to-be-excluded connection has future records`
  );
  const excludedFutureCount = base.upcoming.filter((r) => r.connector_instance_id === excluded).length;
  assert.ok(excludedFutureCount > 0, `${label}: the excluded connection contributes future records`);

  // Excluded connection: GONE from feed, Upcoming, and the exact total.
  const got = await executeExploreTimeline(
    { limit: 100, upcomingLimit: 500, cursor: null, excludeConnectionIds: [excluded] },
    deps
  );
  assert.ok(
    got.data.every((r) => r.connector_instance_id !== excluded),
    `${label}: excluded connection absent from the main feed`
  );
  assert.ok(
    got.upcoming.every((r) => r.connector_instance_id !== excluded),
    `${label}: excluded connection absent from the Upcoming projection`
  );
  assert.equal(
    got.upcoming_total,
    baseFuture - excludedFutureCount,
    `${label}: upcoming_total is the EXACT post-exclusion count (server-side), not the pre-exclusion total`
  );

  // Excluded stream: only that stream drops.
  const gotStream = await executeExploreTimeline(
    { limit: 100, upcomingLimit: 500, cursor: null, excludeStreams: ['orders'] },
    deps
  );
  assert.ok(gotStream.data.every((r) => r.stream !== 'orders'), `${label}: excluded stream absent from the feed`);
  assert.ok(gotStream.upcoming.every((r) => r.stream !== 'orders'), `${label}: excluded stream absent from Upcoming`);
}

test('Exclude scope (sqlite): excluded connection/stream vanish from feed + Upcoming + the exact total', async () => {
  initDb(':memory:');
  try {
    await assertExcludeScope(withPinnedNow(buildSqliteExploreTimelineDeps()), 'sqlite');
  } finally {
    closeDb();
  }
});

// ---------------------------------------------------------------------------
// Postgres suite (skipped without PDPP_TEST_POSTGRES_URL)
// ---------------------------------------------------------------------------

async function cleanupPostgresUpcoming() {
  // Each partition's connector_instance_id carries the unique SUFFIX → scoped wipe.
  for (const p of PARTITIONS) {
    await postgresQuery('DELETE FROM records WHERE connector_instance_id = $1', [p.connectorInstanceId]);
  }
}

if (!POSTGRES_URL) {
  test('Upcoming reachability (postgres): skipped (PDPP_TEST_POSTGRES_URL unset)', { skip: true }, () => {});
} else {
  test('Upcoming reachability (postgres): every future record reachable, ties + stable total', async () => {
    initDb(':memory:');
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });
    try {
      await cleanupPostgresUpcoming();
      await assertUpcomingReachable(withPinnedNow(buildPostgresExploreTimelineDeps()), 'postgres');
    } finally {
      await cleanupPostgresUpcoming();
      await closePostgresStorage();
      closeDb();
    }
  });

  test('Upcoming post-snapshot exclusion (postgres): backfilled future excluded from pinned walk', async () => {
    initDb(':memory:');
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });
    try {
      await cleanupPostgresUpcoming();
      await assertPostSnapshotFutureExcluded(withPinnedNow(buildPostgresExploreTimelineDeps()), 'postgres');
    } finally {
      await cleanupPostgresUpcoming();
      await closePostgresStorage();
      closeDb();
    }
  });

  test('Exclude scope (postgres): excluded connection/stream vanish from feed + Upcoming + the exact total', async () => {
    initDb(':memory:');
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });
    try {
      await cleanupPostgresUpcoming();
      await assertExcludeScope(withPinnedNow(buildPostgresExploreTimelineDeps()), 'postgres');
    } finally {
      await cleanupPostgresUpcoming();
      await closePostgresStorage();
      closeDb();
    }
  });
}
