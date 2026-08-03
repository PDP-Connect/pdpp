/**
 * EXECUTABLE cross-backend filter parity for spine correlation listing.
 *
 * Why this exists, and why the static oracle is not enough
 * -------------------------------------------------------
 * `scripts/audit-pg-sqlite-parity.mjs` compares which `filters.X` keys each
 * backend's source TEXT mentions. An independent gate demonstrated a concrete
 * false-negative against that approach: patching the Postgres path to
 * `if (false && filters.since)` leaves the literal token `filters.since`
 * present, so the static oracle reports "no gaps" (exit 0) while Postgres
 * really does leak a pre-cutoff row. Textual presence is not application.
 *
 * This file closes that class by construction. It seeds IDENTICAL data into
 * both backends, runs the SAME filter set through each, and diffs the
 * observable results. Dead code, commented-out handling, a stray token in a
 * string, or a filter that is parsed and dropped all fail here, because
 * nothing is inferred from source text — only from what the query returns.
 *
 * The static oracle stays useful as a fast local diagnostic that points at a
 * specific line; this is the authority. Per the gate: do not treat a clean
 * run of the static script alone as proof of parity.
 *
 * Gated on PDPP_TEST_POSTGRES_URL so it is a clean skip without a live PG.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { emitSpineEvent, listSpineCorrelations } from '../lib/spine.ts';
import { closeDb, getDb, initDb } from '../server/db.ts';
import {
  closePostgresStorage,
  initPostgresStorage,
  isPostgresStorageBackend,
  postgresQuery,
} from '../server/postgres-storage.ts';

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const RUN_TAG = `parity${process.pid}${Date.now().toString(36)}`;

const CUTOFF = '2031-03-01T00:00:00.000Z';

/**
 * Fixture spans the cutoff, uses two clients and two sources, and includes a
 * timestamp tie — so `since`/`until`/`client_id`/`source_id`/`q` and the
 * cursor tiebreak each have something to discriminate. A filter that is
 * silently dropped returns MORE rows than its counterpart, which is exactly
 * the leak shape the gate demonstrated.
 */
const FIXTURE = [
  { id: `grt_${RUN_TAG}_old1`, at: '2031-01-10T00:00:00.000Z', client: `cli_${RUN_TAG}_a`, source: 'connectors/amazon' },
  { id: `grt_${RUN_TAG}_old2`, at: '2031-02-10T00:00:00.000Z', client: `cli_${RUN_TAG}_b`, source: 'connectors/gmail' },
  { id: `grt_${RUN_TAG}_new1`, at: '2031-04-10T00:00:00.000Z', client: `cli_${RUN_TAG}_a`, source: 'connectors/gmail' },
  { id: `grt_${RUN_TAG}_new2`, at: '2031-05-10T00:00:00.000Z', client: `cli_${RUN_TAG}_b`, source: 'connectors/amazon' },
  { id: `grt_${RUN_TAG}_tie1`, at: '2031-06-01T00:00:00.000Z', client: `cli_${RUN_TAG}_a`, source: 'connectors/amazon' },
  { id: `grt_${RUN_TAG}_tie2`, at: '2031-06-01T00:00:00.000Z', client: `cli_${RUN_TAG}_a`, source: 'connectors/amazon' },
];

/** The filter matrix under parity. Each entry must behave identically on both backends. */
const FILTER_CASES = [
  { name: 'no filters', filters: {} },
  { name: 'since (cutoff)', filters: { since: CUTOFF } },
  { name: 'until (cutoff)', filters: { until: CUTOFF } },
  { name: 'clientId', filters: { clientId: `cli_${RUN_TAG}_a` } },
  { name: 'sourceId', filters: { sourceId: 'connectors/amazon' } },
  { name: 'sourceKind', filters: { sourceKind: 'connector' } },
  { name: 'q substring', filters: { q: `${RUN_TAG}_tie` } },
  { name: 'since + clientId', filters: { since: CUTOFF, clientId: `cli_${RUN_TAG}_a` } },
  { name: 'limit 2', filters: { limit: 2 } },
];

async function seedAll() {
  for (const row of FIXTURE) {
    await emitSpineEvent({
      event_type: 'disclosure.served',
      occurred_at: row.at,
      actor_type: 'client',
      actor_id: row.client,
      object_type: 'query',
      object_id: 'q1',
      status: 'succeeded',
      grant_id: row.id,
      client_id: row.client,
      source_kind: 'connector',
      source_id: row.source,
    });
  }
}

/** Observable projection: ids in returned order, plus paging flags. */
async function observe(filters) {
  const page = await listSpineCorrelations('grant', { limit: 50, ...filters });
  return {
    ids: page.summaries.map((s) => s.grant_id || s.id).filter((id) => String(id).includes(RUN_TAG)),
    hasMore: Boolean(page.hasMore),
  };
}

test('spine correlation filters behave identically on Postgres and SQLite', { skip: !POSTGRES_URL }, async (t) => {
  const sqliteResults = new Map();
  const postgresResults = new Map();

  // --- SQLite leg (in-memory; no file, no shared state) ---
  process.env.PDPP_STORAGE_BACKEND = 'sqlite';
  delete process.env.PDPP_DATABASE_URL;
  initDb(':memory:');
  assert.ok(getDb(), 'sqlite db failed to initialize');
  await seedAll();
  for (const testCase of FILTER_CASES) {
    sqliteResults.set(testCase.name, await observe(testCase.filters));
  }
  closeDb();

  // --- Postgres leg ---
  process.env.PDPP_STORAGE_BACKEND = 'postgres';
  process.env.PDPP_DATABASE_URL = POSTGRES_URL;
  // Bootstrap only if this process has not already initialized the pool.
  // `bootstrapPostgresSchema()` is NOT idempotent against an already-migrated
  // database — `migratePostgresLegacyConnectorInstancesToDefaultAccount` issues
  // an unguarded `ADD CONSTRAINT connector_instances_source_kind_check`, which
  // throws "constraint already exists" on a second init. That is pre-existing
  // behaviour in server/postgres-storage.js, not something this branch changed;
  // the project's own runner hides it by spawning one process per test file.
  // Re-initializing here would make this test fail for a reason unrelated to
  // the parity property it exists to prove.
  if (!isPostgresStorageBackend()) {
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });
  }
  t.after(async () => {
    await postgresQuery('DELETE FROM spine_events WHERE grant_id LIKE $1', [`grt_${RUN_TAG}%`]).catch(() => {});
    await closePostgresStorage();
  });
  await postgresQuery('DELETE FROM spine_events WHERE grant_id LIKE $1', [`grt_${RUN_TAG}%`]);
  await seedAll();
  for (const testCase of FILTER_CASES) {
    postgresResults.set(testCase.name, await observe(testCase.filters));
  }

  // --- Diff ---
  const mismatches = [];
  for (const testCase of FILTER_CASES) {
    const lite = sqliteResults.get(testCase.name);
    const pg = postgresResults.get(testCase.name);
    // Compare as SETS: the two backends are allowed to differ in physical
    // ordering for equal-ranked rows, but never in WHICH rows are visible.
    // Membership divergence is what a dropped filter produces.
    const liteSet = [...lite.ids].sort();
    const pgSet = [...pg.ids].sort();
    if (JSON.stringify(liteSet) !== JSON.stringify(pgSet)) {
      mismatches.push(
        `${testCase.name}: sqlite=[${liteSet.join(',')}] postgres=[${pgSet.join(',')}]` +
          (pgSet.length > liteSet.length ? '  <-- Postgres returned MORE rows: filter likely accepted then dropped' : '')
      );
    }
  }

  assert.deepEqual(mismatches, [], `cross-backend filter parity diverged:\n  ${mismatches.join('\n  ')}`);

  // Guard the fixture itself: if `since` returns everything on BOTH backends,
  // the filter is not discriminating and the whole matrix proves nothing.
  const sinceIds = sqliteResults.get('since (cutoff)').ids;
  assert.ok(
    sinceIds.length > 0 && sinceIds.length < FIXTURE.length,
    `fixture does not discriminate: since returned ${sinceIds.length}/${FIXTURE.length} rows, so a dropped filter would be invisible`
  );
});
