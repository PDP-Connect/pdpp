/**
 * Tests for the backfill-point-in-time-stats operational tool.
 *
 * Two layers:
 *   1. Pure-helper tests (no DB): observation transform, real-field
 *      detection, per-day dedup (last-write-wins), prunable-version
 *      selection across the rule matrix, registry shape, argv parsing.
 *   2. Postgres-backed integration tests (gated on PDPP_TEST_POSTGRES_URL):
 *      seeded pre-split history → backfill → idempotent re-backfill →
 *      prune, asserting losslessness end to end.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import pg from 'pg';

import {
  BACKFILL_POLICIES,
  applyBackfill,
  applyPrune,
  carriesRealFields,
  findPolicy,
  observedOnFromEmittedAt,
  parseLimitKeys,
  planBackfill,
  planObservationsForKey,
  planPrune,
  selectPrunableVersions,
} from '../scripts/backfill-point-in-time-stats.mjs';

const { Pool } = pg;
const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

const githubPolicy = findPolicy('github', 'user');
const slackPolicy = findPolicy('slack', 'channels');
const ynabPolicy = findPolicy('ynab', 'accounts');

// ─── Registry ───────────────────────────────────────────────────────────

test('BACKFILL_POLICIES covers exactly the three point-in-time real-field streams', () => {
  const pairs = BACKFILL_POLICIES.map((p) => `${p.connectorIds[0]}/${p.sourceStream}→${p.targetStream}`).sort();
  assert.deepEqual(pairs, [
    'github/user→user_stats',
    'slack/channels→channel_stats',
    'ynab/accounts→account_stats',
  ]);
});

test('findPolicy resolves short and registry-URL connector ids, and rejects unknowns', () => {
  assert.ok(findPolicy('github', 'user'));
  assert.ok(findPolicy('https://registry.pdpp.org/connectors/github', 'user'));
  assert.equal(findPolicy('github', 'repositories'), null);
  assert.equal(findPolicy('amazon', 'orders'), null);
});

// ─── observedOnFromEmittedAt ────────────────────────────────────────────

test('observedOnFromEmittedAt extracts the UTC calendar date', () => {
  assert.equal(observedOnFromEmittedAt('2026-05-26T14:26:27.323Z'), '2026-05-26');
  // Offset-bearing timestamp projects to UTC (this instant is the 27th UTC).
  assert.equal(observedOnFromEmittedAt('2026-05-26T23:30:00-02:00'), '2026-05-27');
  assert.equal(observedOnFromEmittedAt('not-a-date'), null);
  assert.equal(observedOnFromEmittedAt(''), null);
  assert.equal(observedOnFromEmittedAt(null), null);
});

// ─── carriesRealFields ──────────────────────────────────────────────────

test('carriesRealFields detects pre-split vs post-split bodies', () => {
  // Pre-split github body: has the metric keys.
  assert.equal(carriesRealFields({ id: '1', followers: 10 }, githubPolicy.realFields), true);
  // followers present even if null still counts (key present = observation).
  assert.equal(carriesRealFields({ id: '1', followers: null }, githubPolicy.realFields), true);
  // Post-split identity-only body: none of the metric keys.
  assert.equal(carriesRealFields({ id: '1', login: 'x', name: 'y' }, githubPolicy.realFields), false);
  assert.equal(carriesRealFields(null, githubPolicy.realFields), false);
});

// ─── buildStat parity with connector builders ───────────────────────────

test('github buildStat mirrors userStatsRecord shape', () => {
  const body = { id: '1095217', login: 'owner', followers: 39, following: 23, public_repos: 85, public_gists: 7 };
  assert.deepEqual(githubPolicy.buildStat(body, '2026-05-26'), {
    id: '1095217:2026-05-26',
    user_id: '1095217',
    observed_on: '2026-05-26',
    public_repos: 85,
    public_gists: 7,
    followers: 39,
    following: 23,
  });
});

test('slack buildStat mirrors buildChannelStatsRecord shape', () => {
  const body = { id: 'C123', name: 'general', num_members: 42 };
  assert.deepEqual(slackPolicy.buildStat(body, '2026-05-26'), {
    id: 'C123:2026-05-26',
    channel_id: 'C123',
    observed_on: '2026-05-26',
    num_members: 42,
  });
});

test('ynab buildStat mirrors accountStatsRecord shape', () => {
  const body = { id: 'A9', budget_id: 'B1', balance: 1000, cleared_balance: 900, uncleared_balance: 100 };
  assert.deepEqual(ynabPolicy.buildStat(body, '2026-05-26'), {
    id: 'A9:2026-05-26',
    account_id: 'A9',
    budget_id: 'B1',
    observed_on: '2026-05-26',
    balance: 1000,
    cleared_balance: 900,
    uncleared_balance: 100,
  });
});

test('buildStat returns null when entity id is missing', () => {
  assert.equal(githubPolicy.buildStat({ followers: 1 }, '2026-05-26'), null);
});

// ─── planObservationsForKey (per-day dedup, last-write-wins) ─────────────

test('planObservationsForKey collapses same-day versions to the latest value', () => {
  const rows = [
    { version: 1, emitted_at: '2026-05-26T08:00:00Z', deleted: false, record_json: { id: '1', followers: 10, following: 1, public_repos: 5, public_gists: 0 } },
    { version: 2, emitted_at: '2026-05-26T20:00:00Z', deleted: false, record_json: { id: '1', followers: 12, following: 1, public_repos: 5, public_gists: 0 } },
    { version: 3, emitted_at: '2026-05-27T09:00:00Z', deleted: false, record_json: { id: '1', followers: 13, following: 2, public_repos: 6, public_gists: 0 } },
  ];
  const byDay = planObservationsForKey(rows, githubPolicy);
  assert.deepEqual([...byDay.keys()].sort(), ['2026-05-26', '2026-05-27']);
  // 26th keeps version 2's value (12 followers), not version 1's (10).
  assert.equal(byDay.get('2026-05-26').statBody.followers, 12);
  assert.equal(byDay.get('2026-05-26').sourceVersion, 2);
  assert.equal(byDay.get('2026-05-27').statBody.followers, 13);
});

test('planObservationsForKey skips tombstones and post-split identity-only versions', () => {
  const rows = [
    { version: 1, emitted_at: '2026-05-26T08:00:00Z', deleted: false, record_json: { id: '1', followers: 10, following: 1, public_repos: 5, public_gists: 0 } },
    { version: 2, emitted_at: '2026-05-27T08:00:00Z', deleted: true, record_json: null },
    // post-split identity-only re-emit (no metric keys): not an observation.
    { version: 3, emitted_at: '2026-05-28T08:00:00Z', deleted: false, record_json: { id: '1', login: 'x', name: 'y' } },
  ];
  const byDay = planObservationsForKey(rows, githubPolicy);
  assert.deepEqual([...byDay.keys()], ['2026-05-26']);
});

// ─── selectPrunableVersions (the losslessness rule matrix) ───────────────

test('selectPrunableVersions removes only migrated, non-current, non-first, real-field rows', () => {
  const rows = [
    { version: 1, emitted_at: '2026-05-25T08:00:00Z', deleted: false, record_json: { id: '1', followers: 9, following: 1, public_repos: 5, public_gists: 0 } },
    { version: 2, emitted_at: '2026-05-26T08:00:00Z', deleted: false, record_json: { id: '1', followers: 10, following: 1, public_repos: 5, public_gists: 0 } },
    { version: 3, emitted_at: '2026-05-27T08:00:00Z', deleted: false, record_json: { id: '1', followers: 11, following: 1, public_repos: 5, public_gists: 0 } },
    { version: 4, emitted_at: '2026-05-28T08:00:00Z', deleted: false, record_json: { id: '1', login: 'x' } }, // current, identity-only (post-split)
  ];
  const currentVersion = 4;
  // All observed days represented in stats.
  const represented = new Set(['2026-05-25', '2026-05-26', '2026-05-27']);
  const removable = selectPrunableVersions(rows, currentVersion, githubPolicy, represented);
  // v1 = first version → kept. v2,v3 = migrated, older, real-field → removable.
  // v4 = current → kept.
  assert.deepEqual(removable.sort((a, b) => a - b), [2, 3]);
});

test('selectPrunableVersions keeps versions whose day is not yet represented', () => {
  const rows = [
    { version: 1, emitted_at: '2026-05-25T08:00:00Z', deleted: false, record_json: { id: '1', followers: 9, following: 1, public_repos: 5, public_gists: 0 } },
    { version: 2, emitted_at: '2026-05-26T08:00:00Z', deleted: false, record_json: { id: '1', followers: 10, following: 1, public_repos: 5, public_gists: 0 } },
    { version: 3, emitted_at: '2026-05-27T08:00:00Z', deleted: false, record_json: { id: '1', followers: 11, following: 1, public_repos: 5, public_gists: 0 } },
  ];
  const currentVersion = 3;
  // 26th NOT represented → version 2 must be kept even though it's older.
  const represented = new Set(['2026-05-25']);
  const removable = selectPrunableVersions(rows, currentVersion, githubPolicy, represented);
  // v1 first → kept; v2 not represented → kept; v3 current → kept.
  assert.deepEqual(removable, []);
});

test('selectPrunableVersions never removes the current, first, or tombstone versions', () => {
  const rows = [
    { version: 1, emitted_at: '2026-05-25T08:00:00Z', deleted: false, record_json: { id: '1', followers: 9, following: 1, public_repos: 5, public_gists: 0 } },
    { version: 2, emitted_at: '2026-05-26T08:00:00Z', deleted: true, record_json: null },
    { version: 3, emitted_at: '2026-05-27T08:00:00Z', deleted: false, record_json: { id: '1', followers: 11, following: 1, public_repos: 5, public_gists: 0 } },
  ];
  const represented = new Set(['2026-05-25', '2026-05-27']);
  // current = 3.
  const removable = selectPrunableVersions(rows, 3, githubPolicy, represented);
  // v1 first → kept; v2 tombstone → kept; v3 current → kept.
  assert.deepEqual(removable, []);
});

// ─── parseLimitKeys ─────────────────────────────────────────────────────

test('parseLimitKeys validates positive integers', () => {
  assert.equal(parseLimitKeys(undefined), null);
  assert.equal(parseLimitKeys(''), null);
  assert.equal(parseLimitKeys('5'), 5);
  assert.equal(parseLimitKeys('0'), 'invalid');
  assert.equal(parseLimitKeys('-1'), 'invalid');
  assert.equal(parseLimitKeys('1.5'), 'invalid');
  assert.equal(parseLimitKeys(true), 'invalid');
});

// ─── Postgres-backed integration ────────────────────────────────────────

const itPg = POSTGRES_URL ? test : test.skip;

async function setupSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS connector_instances (
      connector_instance_id TEXT PRIMARY KEY,
      connector_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS records (
      id BIGSERIAL PRIMARY KEY,
      connector_id TEXT NOT NULL,
      connector_instance_id TEXT NOT NULL,
      stream TEXT NOT NULL,
      record_key TEXT NOT NULL,
      record_json JSONB NOT NULL,
      emitted_at TEXT NOT NULL,
      version BIGINT NOT NULL DEFAULT 1,
      deleted BOOLEAN NOT NULL DEFAULT FALSE,
      deleted_at TEXT,
      cursor_value TEXT,
      primary_key_text TEXT NOT NULL,
      UNIQUE(connector_instance_id, stream, record_key)
    );
    CREATE TABLE IF NOT EXISTS record_changes (
      connector_id TEXT NOT NULL,
      connector_instance_id TEXT NOT NULL,
      stream TEXT NOT NULL,
      record_key TEXT NOT NULL,
      version BIGINT NOT NULL,
      record_json JSONB,
      emitted_at TEXT NOT NULL,
      deleted BOOLEAN NOT NULL DEFAULT FALSE,
      deleted_at TEXT,
      PRIMARY KEY(connector_instance_id, stream, version)
    );
    CREATE TABLE IF NOT EXISTS version_counter (
      connector_id TEXT NOT NULL,
      connector_instance_id TEXT NOT NULL,
      stream TEXT NOT NULL,
      max_version BIGINT NOT NULL DEFAULT 0,
      PRIMARY KEY(connector_instance_id, stream)
    );
    CREATE TABLE IF NOT EXISTS retained_size_stream (
      connector_instance_id TEXT, stream TEXT, dirty INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS retained_size_connection (
      connector_instance_id TEXT, dirty INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS retained_size_global (
      projection_key TEXT, dirty INTEGER DEFAULT 0
    );
  `);
}

async function resetTables(pool) {
  await pool.query(`
    TRUNCATE records, record_changes, version_counter, connector_instances,
             retained_size_stream, retained_size_connection, retained_size_global;
  `);
  // Drop any leftover backup tables from prior runs.
  const tabs = await pool.query(
    `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'backfill_point_in_time_stats_backup_%'`,
  );
  for (const { tablename } of tabs.rows) {
    await pool.query(`DROP TABLE IF EXISTS "${tablename}"`);
  }
}

/**
 * Seed a pre-split entity stream: N history versions carrying real fields,
 * the latest being the current (post-split, identity-only) record. Mimics
 * the live shape: the current `records` row is identity-only; the older
 * `record_changes` rows carry the metrics.
 */
async function seedGithubUser(pool, cin) {
  const cid = 'github';
  await pool.query(
    `INSERT INTO connector_instances(connector_instance_id, connector_id) VALUES ($1,$2)`,
    [cin, cid],
  );
  const history = [
    { v: 1, day: '2026-05-25', followers: 30 },
    { v: 2, day: '2026-05-25', followers: 31 }, // same-day later → wins for the 25th
    { v: 3, day: '2026-05-26', followers: 33 },
    { v: 4, day: '2026-05-27', followers: 35 },
  ];
  for (const h of history) {
    const body = { id: '1095217', login: 'owner', followers: h.followers, following: 5, public_repos: 80, public_gists: 2 };
    await pool.query(
      `INSERT INTO record_changes(connector_id, connector_instance_id, stream, record_key, version, record_json, emitted_at, deleted)
       VALUES ($1,$2,'user','1095217',$3,$4::jsonb,$5,FALSE)`,
      [cid, cin, h.v, JSON.stringify(body), `${h.day}T08:00:00.000Z`],
    );
  }
  // Current (post-split) version: identity only, version 5.
  const currentBody = { id: '1095217', login: 'owner', name: 'the owner' };
  await pool.query(
    `INSERT INTO record_changes(connector_id, connector_instance_id, stream, record_key, version, record_json, emitted_at, deleted)
     VALUES ($1,$2,'user','1095217',5,$3::jsonb,'2026-06-03T14:00:00.000Z',FALSE)`,
    [cid, cin, JSON.stringify(currentBody)],
  );
  await pool.query(
    `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, primary_key_text)
     VALUES ($1,$2,'user','1095217',$3::jsonb,'2026-06-03T14:00:00.000Z',5,'1095217')`,
    [cid, cin, JSON.stringify(currentBody)],
  );
  // Forward observation already present for 06-03 (the split shipped that day).
  const fwd = { id: '1095217:2026-06-03', user_id: '1095217', observed_on: '2026-06-03', public_repos: 85, public_gists: 7, followers: 39, following: 23 };
  await pool.query(
    `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, primary_key_text)
     VALUES ($1,$2,'user_stats','1095217:2026-06-03',$3::jsonb,'2026-06-03T14:00:00.000Z',1,'1095217:2026-06-03')`,
    [cid, cin, JSON.stringify(fwd)],
  );
  await pool.query(
    `INSERT INTO record_changes(connector_id, connector_instance_id, stream, record_key, version, record_json, emitted_at, deleted)
     VALUES ($1,$2,'user_stats','1095217:2026-06-03',1,$3::jsonb,'2026-06-03T14:00:00.000Z',FALSE)`,
    [cid, cin, JSON.stringify(fwd)],
  );
  await pool.query(
    `INSERT INTO version_counter(connector_id, connector_instance_id, stream, max_version) VALUES
       ($1,$2,'user',5), ($1,$2,'user_stats',1)`,
    [cid, cin],
  );
}

itPg('integration: backfill is lossless, idempotent, and enables a safe prune', async () => {
  const pool = new Pool({ connectionString: POSTGRES_URL });
  const cin = 'cin_test_backfill';
  try {
    await setupSchema(pool);
    await resetTables(pool);
    await seedGithubUser(pool, cin);
    const policy = findPolicy('github', 'user');

    // ── backfill plan + apply ──
    const plan = await planBackfill({ pool, connectorId: 'github', connectorInstanceId: cin, policy });
    // 3 distinct observation days from pre-split history (25,26,27); the 25th
    // collapses two versions into one. The 06-03 forward obs already exists.
    assert.equal(plan.insertCount, 3, 'three new days to backfill');
    const applied = await applyBackfill({ pool, plan });
    assert.equal(applied.inserted, 3);

    // Stats stream now has 4 observations: backfilled 25/26/27 + forward 06-03.
    const stats = await pool.query(
      `SELECT record_key, record_json FROM records WHERE connector_instance_id=$1 AND stream='user_stats' ORDER BY record_key`,
      [cin],
    );
    assert.equal(stats.rows.length, 4);
    // The 25th carries the LATEST same-day value (31, from version 2).
    const day25 = stats.rows.find((r) => r.record_key === '1095217:2026-05-25');
    assert.equal(day25.record_json.followers, 31);
    // The forward 06-03 observation is untouched (canonical, not overwritten).
    const fwd = stats.rows.find((r) => r.record_key === '1095217:2026-06-03');
    assert.equal(fwd.record_json.followers, 39);

    // Each backfilled stats row has a matching record_changes anchor.
    const statChanges = await pool.query(
      `SELECT COUNT(*)::int AS n FROM record_changes WHERE connector_instance_id=$1 AND stream='user_stats'`,
      [cin],
    );
    assert.equal(statChanges.rows[0].n, 4);

    // ── idempotent re-backfill: inserts nothing ──
    const plan2 = await planBackfill({ pool, connectorId: 'github', connectorInstanceId: cin, policy });
    assert.equal(plan2.insertCount, 0, 're-backfill is a no-op');

    // ── prune plan + apply ──
    const prunePlan = await planPrune({ pool, connectorId: 'github', connectorInstanceId: cin, policy });
    // Removable source history: versions whose day is represented, that are
    // older than current (5), not first (1), not tombstone. Days 25(v2),
    // 26(v3), 27(v4) are represented. v1 is first → kept. So removable = v2,v3,v4.
    assert.equal(prunePlan.removableVersions, 3);
    const pruneResult = await applyPrune({ pool, plan: prunePlan, runId: 'testrun' });
    assert.equal(pruneResult.deleted, 3);
    assert.ok(pruneResult.backupTable);

    // Source history now: v1 (first, kept) + v5 (current, kept) = 2 rows.
    const remaining = await pool.query(
      `SELECT version FROM record_changes WHERE connector_instance_id=$1 AND stream='user' ORDER BY version`,
      [cin],
    );
    assert.deepEqual(remaining.rows.map((r) => Number(r.version)), [1, 5]);

    // The current records row is intact and still anchored.
    const cur = await pool.query(
      `SELECT version FROM records WHERE connector_instance_id=$1 AND stream='user' AND record_key='1095217'`,
      [cin],
    );
    assert.equal(Number(cur.rows[0].version), 5);

    // Backup table holds exactly the 3 deleted rows (rollback handle).
    const backup = await pool.query(`SELECT version FROM "${pruneResult.backupTable}" ORDER BY version`);
    assert.deepEqual(backup.rows.map((r) => Number(r.version)), [2, 3, 4]);

    // ── losslessness assertion: every deleted observation survives in stats ──
    // Each backed-up entity version's observed day must be present in stats.
    const backupFull = await pool.query(`SELECT version, record_json, emitted_at FROM "${pruneResult.backupTable}"`);
    for (const r of backupFull.rows) {
      const day = String(r.emitted_at).slice(0, 10);
      const present = await pool.query(
        `SELECT 1 FROM records WHERE connector_instance_id=$1 AND stream='user_stats' AND record_key=$2`,
        [cin, `1095217:${day}`],
      );
      assert.equal(present.rows.length, 1, `deleted version ${r.version} (day ${day}) is represented in stats`);
    }

    // ── prune is now a no-op (nothing left to migrate) ──
    const prunePlan2 = await planPrune({ pool, connectorId: 'github', connectorInstanceId: cin, policy });
    assert.equal(prunePlan2.removableVersions, 0);

    // cleanup backup table
    await pool.query(`DROP TABLE IF EXISTS "${pruneResult.backupTable}"`);
  } finally {
    await pool.end();
  }
});

itPg('integration: prune uses exact stat-key membership (no prefix over-match)', async () => {
  const pool = new Pool({ connectionString: POSTGRES_URL });
  const cin = 'cin_test_exact';
  try {
    await setupSchema(pool);
    await resetTables(pool);
    await pool.query(
      `INSERT INTO connector_instances(connector_instance_id, connector_id) VALUES ($1,'github')`,
      [cin],
    );
    // Entity "1" with two pre-split history versions on 05-25 / 05-26 and a
    // current identity-only version. NO stats backfilled for entity "1".
    const mkBody = (f) => ({ id: '1', login: 'x', followers: f, following: 1, public_repos: 5, public_gists: 0 });
    await pool.query(
      `INSERT INTO record_changes(connector_id, connector_instance_id, stream, record_key, version, record_json, emitted_at, deleted) VALUES
        ('github',$1,'user','1',1,$2::jsonb,'2026-05-25T08:00:00.000Z',FALSE),
        ('github',$1,'user','1',2,$3::jsonb,'2026-05-26T08:00:00.000Z',FALSE),
        ('github',$1,'user','1',3,$4::jsonb,'2026-06-03T14:00:00.000Z',FALSE)`,
      [cin, JSON.stringify(mkBody(10)), JSON.stringify(mkBody(11)), JSON.stringify({ id: '1', login: 'x', name: 'n' })],
    );
    await pool.query(
      `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, primary_key_text)
       VALUES ('github',$1,'user','1',$2::jsonb,'2026-06-03T14:00:00.000Z',3,'1')`,
      [cin, JSON.stringify({ id: '1', login: 'x', name: 'n' })],
    );
    // A DIFFERENT entity "12" has a stats observation "12:2026-05-25". The
    // string "12:2026-05-25" starts with "1" — a naive prefix scan keyed on
    // entity "1" would wrongly treat 2026-05-25 as represented for entity "1".
    const fwd = { id: '12:2026-05-25', user_id: '12', observed_on: '2026-05-25', public_repos: 1, public_gists: 0, followers: 99, following: 1 };
    await pool.query(
      `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, primary_key_text)
       VALUES ('github',$1,'user_stats','12:2026-05-25',$2::jsonb,'2026-05-25T12:00:00.000Z',1,'12:2026-05-25')`,
      [cin, JSON.stringify(fwd)],
    );
    await pool.query(
      `INSERT INTO version_counter(connector_id, connector_instance_id, stream, max_version) VALUES
        ('github',$1,'user',3), ('github',$1,'user_stats',1)`,
      [cin],
    );

    const policy = findPolicy('github', 'user');
    const prunePlan = await planPrune({ pool, connectorId: 'github', connectorInstanceId: cin, policy });
    // Entity "1" has NO stats of its own → nothing represented → nothing prunable,
    // despite entity "12"'s stat key sharing the "1" prefix.
    assert.equal(prunePlan.removableVersions, 0);
  } finally {
    await pool.end();
  }
});

itPg('integration: prune refuses when the observation was never backfilled', async () => {
  const pool = new Pool({ connectionString: POSTGRES_URL });
  const cin = 'cin_test_no_backfill';
  try {
    await setupSchema(pool);
    await resetTables(pool);
    await seedGithubUser(pool, cin);
    const policy = findPolicy('github', 'user');
    // Skip backfill entirely. Only the forward 06-03 obs exists in stats.
    const prunePlan = await planPrune({ pool, connectorId: 'github', connectorInstanceId: cin, policy });
    // No pre-split day is represented → nothing prunable.
    assert.equal(prunePlan.removableVersions, 0);
  } finally {
    await pool.end();
  }
});
