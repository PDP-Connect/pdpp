/**
 * Spine correlation keyset pagination: Postgres production-path coverage.
 *
 * Closes a verified defect found live on the owner console's /grants page:
 * `postgresListSpineCorrelations()` accepted `filters.cursor`, emitted a
 * `next_cursor` in its response envelope, and never applied the cursor to the
 * aggregate query. Every "next page" request silently re-served page 1. The
 * SQLite path (buildCorrelationAggregateSql in lib/spine.ts) had always
 * applied it, so the whole SQLite suite stayed green while the deployed
 * Postgres backend could not paginate at all.
 *
 * Two coupled invariants are covered here, because fixing only the first
 * leaves a subtler row-skipping bug behind:
 *
 *   1. A cursor actually advances the page (no overlap with page 1).
 *   2. The ORDER BY tiebreak direction matches the cursor's comparison
 *      direction. The query sorts `last_at DESC, id DESC` and the cursor
 *      compares `id <`; an `id ASC` sort against an `id <` cursor silently
 *      SKIPS correlations that share an identical MAX(occurred_at). Ties are
 *      not hypothetical — a real deployment showed up to 5 grants on one
 *      timestamp — so this test seeds an explicit tie block.
 *
 * Union-completeness (assertion 3) is the property that actually matters to
 * an operator revoking stale grants: paging to the end must enumerate every
 * correlation exactly once, with no drops and no repeats.
 *
 * Gated on PDPP_TEST_POSTGRES_URL so it is a clean skip without a live PG.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { postgresEmitSpineEvent, postgresListSpineCorrelations } from '../lib/postgres-spine.ts';
import { closePostgresStorage, initPostgresStorage, postgresQuery } from '../server/postgres-storage.ts';

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

// The pool is process-global; initialize once and let each test reuse it.
// `initPostgresStorage` requires the resolved-config shape
// ({backend, databaseUrl}) and bootstraps the schema itself — passing any
// other shape silently falls through to the sqlite branch and leaves the
// pool uninitialized.
let storageReady: Promise<unknown> | null = null;
function ensureStorage() {
  if (!POSTGRES_URL) {
    throw new Error('ensureStorage() must not be called when PDPP_TEST_POSTGRES_URL is unset');
  }
  storageReady ??= initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });
  return storageReady;
}

// Unique per run so repeated local runs never collide in a shared database.
const RUN_TAG = `curtest${process.pid}${Date.now().toString(36)}`;
const TIE_AT = '2031-01-02T03:04:05.678Z';

async function seed() {
  // 9 distinct grants. Three share one exact timestamp (the tie block) so the
  // ASC/DESC tiebreak mismatch is exercised rather than assumed away.
  const rows = [
    { id: `grt_${RUN_TAG}_a`, at: '2031-01-05T00:00:00.000Z' },
    { id: `grt_${RUN_TAG}_b`, at: '2031-01-04T00:00:00.000Z' },
    { id: `grt_${RUN_TAG}_c`, at: '2031-01-03T00:00:00.000Z' },
    { id: `grt_${RUN_TAG}_t1`, at: TIE_AT },
    { id: `grt_${RUN_TAG}_t2`, at: TIE_AT },
    { id: `grt_${RUN_TAG}_t3`, at: TIE_AT },
    { id: `grt_${RUN_TAG}_x`, at: '2031-01-01T00:00:00.000Z' },
    { id: `grt_${RUN_TAG}_y`, at: '2030-12-31T00:00:00.000Z' },
    { id: `grt_${RUN_TAG}_z`, at: '2030-12-30T00:00:00.000Z' },
  ];
  for (const row of rows) {
    await postgresEmitSpineEvent({
      event_type: 'disclosure.served',
      occurred_at: row.at,
      actor_type: 'client',
      actor_id: `cli_${RUN_TAG}`,
      object_type: 'query',
      object_id: 'q1',
      status: 'succeeded',
      grant_id: row.id,
    });
  }
  return rows.map((r) => r.id);
}

async function cleanup() {
  await postgresQuery('DELETE FROM spine_events WHERE grant_id LIKE $1', [`grt_${RUN_TAG}%`]);
}

/** Page through with the given size, following next_cursor to exhaustion. */
async function pageAll(limit: number) {
  const pages: string[][] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 50; guard += 1) {
    const page = await postgresListSpineCorrelations('grant', { limit, cursor });
    const ids = page.summaries
      .map((s) => s.grant_id || s.id)
      .filter((id): id is string => typeof id === 'string' && id.includes(RUN_TAG));
    pages.push(ids);
    if (!(page.hasMore && page.nextCursor)) break;
    cursor = page.nextCursor;
  }
  return pages;
}

test('postgres spine correlations: cursor advances and pages are union-complete', { skip: !POSTGRES_URL }, async (t) => {
  await ensureStorage();
  t.after(cleanup);
  await cleanup();
  const seeded = await seed();

  const pages = await pageAll(2);
  assert.ok(pages.length > 1, 'expected more than one page for 9 seeded correlations at limit=2');

  // 1. The cursor must advance: page 2 must not repeat page 1. This is the
  //    exact regression — before the fix these were identical.
  assert.notDeepEqual(
    pages[1],
    pages[0],
    'page 2 repeated page 1 — filters.cursor is being ignored by the Postgres backend',
  );

  // 2. No id may appear on two different pages.
  const flat = pages.flat();
  const dupes = flat.filter((id, i) => flat.indexOf(id) !== i);
  assert.deepEqual(dupes, [], `ids repeated across pages: ${dupes.join(', ')}`);

  // 3. Union-completeness: every seeded correlation appears exactly once.
  //    This is what catches the tiebreak bug — a mismatched sort direction
  //    drops tied rows entirely rather than duplicating them.
  assert.deepEqual(
    [...flat].sort(),
    [...seeded].sort(),
    'paging to exhaustion did not enumerate every seeded correlation exactly once',
  );
});

test('postgres spine correlations: tied timestamps survive pagination boundaries', { skip: !POSTGRES_URL }, async (t) => {
  await ensureStorage();
  t.after(cleanup);
  await cleanup();
  const seeded = await seed();
  const tied = seeded.filter((id) => id.includes('_t'));

  // limit=1 forces a page boundary to fall INSIDE the 3-row tie block, which
  // is precisely where an `id ASC` sort with an `id <` cursor loses rows.
  const flat = (await pageAll(1)).flat();
  for (const id of tied) {
    assert.ok(flat.includes(id), `tied-timestamp correlation ${id} was skipped by keyset pagination`);
  }
});

test('postgres spine correlations: malformed cursor degrades to first page', { skip: !POSTGRES_URL }, async (t) => {
  await ensureStorage();
  t.after(cleanup);
  await cleanup();
  await seed();

  // A malformed cursor must not throw or silently return an empty page; it
  // degrades to "no cursor", matching parseCursor() in lib/spine.ts.
  for (const bad of ['', 'garbage-no-separator', '::', '::onlyid']) {
    const page = await postgresListSpineCorrelations('grant', { limit: 3, cursor: bad });
    assert.ok(
      page.summaries.length > 0,
      `malformed cursor ${JSON.stringify(bad)} produced an empty page instead of degrading to page 1`,
    );
  }
});

// Release the process-global pool once every test above has finished, so the
// runner exits cleanly instead of hanging on an open connection.
test('teardown: close postgres pool', { skip: !POSTGRES_URL }, async () => {
  await closePostgresStorage();
});
