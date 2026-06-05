/**
 * Tests for the backfill-usaa-account-stats migration tool.
 *
 * Two layers:
 *   1. Pure-helper tests (no DB): observed_on transform, numeric-cents
 *      detection, builder parity with buildAccountStatsRecord, per-day dedup
 *      (latest-version-wins) with same-day drop accounting, argv-independent
 *      key construction.
 *   2. Postgres-backed integration tests (gated on PDPP_TEST_POSTGRES_URL):
 *      seeded pre-split usaa/accounts history under a unique
 *      connector_instance_id → dry-run → apply → idempotent re-apply →
 *      rollback, asserting anchoring, same-day resolution, idempotence,
 *      exact-set rollback, and no mutation of the source accounts history,
 *      without truncating the shared test database.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import pg from 'pg';

import {
  applyBackfill,
  applyRollback,
  buildAccountStatsRecordFromHistory,
  insertedBackupTable,
  numericCentsOrNull,
  observedOnFromEmittedAt,
  planBackfill,
  planObservationsForKey,
  sourceBackupTable,
} from '../scripts/backfill-usaa-account-stats.mjs';

const { Pool } = pg;
const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

// ─── observedOnFromEmittedAt ────────────────────────────────────────────

test('observedOnFromEmittedAt extracts the UTC calendar date', () => {
  assert.equal(observedOnFromEmittedAt('2026-06-03T14:26:27.323Z'), '2026-06-03');
  // Offset-bearing timestamp projects to UTC (this instant is the 4th UTC).
  assert.equal(observedOnFromEmittedAt('2026-06-03T23:30:00-02:00'), '2026-06-04');
  assert.equal(observedOnFromEmittedAt('not-a-date'), null);
  assert.equal(observedOnFromEmittedAt(''), null);
  assert.equal(observedOnFromEmittedAt(null), null);
});

// ─── numericCentsOrNull ─────────────────────────────────────────────────

test('numericCentsOrNull accepts integers (number or string), rejects the rest', () => {
  assert.equal(numericCentsOrNull(12345), 12345);
  assert.equal(numericCentsOrNull(-50), -50);
  assert.equal(numericCentsOrNull(0), 0);
  assert.equal(numericCentsOrNull('12345'), 12345);
  assert.equal(numericCentsOrNull('-50'), -50);
  assert.equal(numericCentsOrNull(null), null);
  assert.equal(numericCentsOrNull(undefined), null);
  assert.equal(numericCentsOrNull(1.5), null);
  assert.equal(numericCentsOrNull('1.5'), null);
  assert.equal(numericCentsOrNull('abc'), null);
});

// ─── buildAccountStatsRecordFromHistory (builder parity) ─────────────────

test('builder mirrors buildAccountStatsRecord shape exactly', () => {
  // Parity target: packages/polyfill-connectors/connectors/usaa/parsers.ts
  //   buildAccountStatsRecord(a, observedOn) =>
  //     { id: `${id}:${observedOn}`, account_id: id, observed_on: observedOn,
  //       balance_cents: a.balance_cents, available_balance_cents: null }
  // The stored entity body already carries the resolved `id`.
  const body = { id: '0002-AbCdEf', balance_cents: 1234567, available_balance_cents: 999, name: 'redacted' };
  assert.deepEqual(buildAccountStatsRecordFromHistory(body, '2026-06-03'), {
    id: '0002-AbCdEf:2026-06-03',
    account_id: '0002-AbCdEf',
    observed_on: '2026-06-03',
    balance_cents: 1234567,
    // hardcoded null even when the history body carried a value — matches the
    // connector builder, which always emits null for available_balance_cents.
    available_balance_cents: null,
  });
});

test('builder returns null when id or numeric balance is absent', () => {
  assert.equal(buildAccountStatsRecordFromHistory({ balance_cents: 100 }, '2026-06-03'), null);
  assert.equal(buildAccountStatsRecordFromHistory({ id: 'A1' }, '2026-06-03'), null);
  assert.equal(buildAccountStatsRecordFromHistory({ id: 'A1', balance_cents: null }, '2026-06-03'), null);
  assert.equal(buildAccountStatsRecordFromHistory({ id: '', balance_cents: 1 }, '2026-06-03'), null);
  assert.equal(buildAccountStatsRecordFromHistory(null, '2026-06-03'), null);
});

test('builder produces the {account_id}:{observed_on} key contract', () => {
  const rec = buildAccountStatsRecordFromHistory({ id: 'ACT-9', balance_cents: 0 }, '2026-05-30');
  assert.equal(rec.id, 'ACT-9:2026-05-30');
  assert.equal(rec.id, `${rec.account_id}:${rec.observed_on}`);
});

// ─── planObservationsForKey (latest-version-wins, drop accounting) ───────

test('planObservationsForKey collapses same-day versions to the latest, recording drops', () => {
  const rows = [
    { version: 1, emitted_at: '2026-06-01T08:00:00Z', deleted: false, record_json: { id: 'A1', balance_cents: 100 } },
    { version: 2, emitted_at: '2026-06-01T20:00:00Z', deleted: false, record_json: { id: 'A1', balance_cents: 250 } }, // same day, later
    { version: 3, emitted_at: '2026-06-02T09:00:00Z', deleted: false, record_json: { id: 'A1', balance_cents: 300 } },
  ];
  const byDay = planObservationsForKey(rows);
  assert.deepEqual([...byDay.keys()].sort(), ['2026-06-01', '2026-06-02']);
  // 06-01 keeps version 2's value (250), not version 1's (100); v1 is dropped.
  const day1 = byDay.get('2026-06-01');
  assert.equal(day1.statBody.balance_cents, 250);
  assert.equal(day1.sourceVersion, 2);
  assert.deepEqual(day1.droppedVersions, [1]);
  // 06-02 single version, no drops.
  assert.deepEqual(byDay.get('2026-06-02').droppedVersions, []);
});

test('planObservationsForKey skips tombstones and non-numeric-balance versions', () => {
  const rows = [
    { version: 1, emitted_at: '2026-06-01T08:00:00Z', deleted: false, record_json: { id: 'A1', balance_cents: 100 } },
    { version: 2, emitted_at: '2026-06-02T08:00:00Z', deleted: true, record_json: null },
    // post-split shape: balance moved out, no numeric balance → not an observation.
    { version: 3, emitted_at: '2026-06-03T08:00:00Z', deleted: false, record_json: { id: 'A1', name: 'x', status: 'open' } },
  ];
  const byDay = planObservationsForKey(rows);
  assert.deepEqual([...byDay.keys()], ['2026-06-01']);
});

test('planObservationsForKey is order-independent for same-day latest-wins', () => {
  // Rows presented out of version order: the higher version must still win.
  const rows = [
    { version: 2, emitted_at: '2026-06-01T20:00:00Z', deleted: false, record_json: { id: 'A1', balance_cents: 250 } },
    { version: 1, emitted_at: '2026-06-01T08:00:00Z', deleted: false, record_json: { id: 'A1', balance_cents: 100 } },
  ];
  const byDay = planObservationsForKey(rows);
  const day1 = byDay.get('2026-06-01');
  assert.equal(day1.statBody.balance_cents, 250);
  assert.equal(day1.sourceVersion, 2);
  assert.deepEqual(day1.droppedVersions, [1]);
});

// ─── table name helpers ─────────────────────────────────────────────────

test('per-run backup table names are run-scoped', () => {
  assert.equal(sourceBackupTable('R1'), 'backfill_usaa_account_stats_source_R1');
  assert.equal(insertedBackupTable('R1'), 'backfill_usaa_account_stats_inserted_R1');
});

// ─── Postgres-backed integration ────────────────────────────────────────

const itPg = POSTGRES_URL ? test : test.skip;

async function setupSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS connector_instances (
      connector_instance_id TEXT PRIMARY KEY,
      owner_subject_id TEXT NOT NULL DEFAULT 'test-owner',
      connector_id TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT 'test connection',
      status TEXT NOT NULL DEFAULT 'active',
      source_kind TEXT NOT NULL DEFAULT 'account',
      source_binding_key TEXT NOT NULL DEFAULT 'test-binding',
      source_binding_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TEXT NOT NULL DEFAULT '2026-06-04T00:00:00.000Z',
      updated_at TEXT NOT NULL DEFAULT '2026-06-04T00:00:00.000Z',
      revoked_at TEXT
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

function testSuffix() {
  return `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

async function cleanupTestData(pool, connectorInstanceId, backupTables = []) {
  await pool.query(`DELETE FROM record_changes WHERE connector_instance_id = $1`, [connectorInstanceId]);
  await pool.query(`DELETE FROM records WHERE connector_instance_id = $1`, [connectorInstanceId]);
  await pool.query(`DELETE FROM version_counter WHERE connector_instance_id = $1`, [connectorInstanceId]);
  await pool.query(`DELETE FROM retained_size_stream WHERE connector_instance_id = $1`, [connectorInstanceId]);
  await pool.query(`DELETE FROM retained_size_connection WHERE connector_instance_id = $1`, [connectorInstanceId]);
  await pool.query(`DELETE FROM connector_instances WHERE connector_instance_id = $1`, [connectorInstanceId]);
  for (const backupTable of backupTables) {
    await pool.query(`DROP TABLE IF EXISTS "${String(backupTable).replaceAll('"', '""')}"`);
  }
}

async function insertConnectorInstance(pool, connectorInstanceId, connectorId) {
  await pool.query(
    `INSERT INTO connector_instances
       (connector_instance_id, owner_subject_id, connector_id, display_name, status,
        source_kind, source_binding_key, source_binding_json, created_at, updated_at)
     VALUES ($1, 'test-owner', $2, $3, 'active', 'account', $1, '{}'::jsonb,
             '2026-06-04T00:00:00.000Z', '2026-06-04T00:00:00.000Z')
     ON CONFLICT (connector_instance_id) DO NOTHING`,
    [connectorInstanceId, connectorId, `${connectorId} test connection`],
  );
}

/**
 * Seed a pre-split usaa/accounts entity stream that mirrors the live shape:
 *   - account A1: pre-split balances on 06-01 (two versions, same day) and
 *     06-02; current (post-split) identity-only version.
 *   - account A2: pre-split balance on 06-02; a forward account_stats row
 *     already exists for A2 on 06-03 (the split shipped that day) — that
 *     overlap key must be skipped, not rewritten.
 * Net-new daily observations to backfill: A1:06-01, A1:06-02, A2:06-02 = 3.
 * Already present: A2:06-03 (forward). Same-day resolved: A1:06-01 (2 → 1).
 */
async function seedUsaaAccounts(pool, cin) {
  const cid = 'usaa';
  await insertConnectorInstance(pool, cin, cid);
  const rcInsert = (stream, key, version, body, emittedAt, deleted = false) =>
    pool.query(
      `INSERT INTO record_changes(connector_id, connector_instance_id, stream, record_key, version, record_json, emitted_at, deleted)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
      [cid, cin, stream, key, version, body === null ? null : JSON.stringify(body), emittedAt, deleted],
    );
  const recInsert = (stream, key, version, body, emittedAt) =>
    pool.query(
      `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, primary_key_text)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$4)`,
      [cid, cin, stream, key, JSON.stringify(body), emittedAt, version],
    );

  // record_changes.version is STREAM-GLOBAL (PK is
  // {connector_instance_id, stream, version}), so versions increment across all
  // keys in the accounts stream — not per-key. Mirror the live shape.
  //
  // A1 pre-split history: 06-01 v1 (100), 06-01 v2 (250, same-day later wins),
  // 06-02 v3 (300), then current identity-only v4.
  await rcInsert('accounts', 'A1', 1, { id: 'A1', name: 'Checking', balance_cents: 100, available_balance_cents: 90, status: 'open' }, '2026-06-01T08:00:00.000Z');
  await rcInsert('accounts', 'A1', 2, { id: 'A1', name: 'Checking', balance_cents: 250, available_balance_cents: 240, status: 'open' }, '2026-06-01T20:00:00.000Z');
  await rcInsert('accounts', 'A1', 3, { id: 'A1', name: 'Checking', balance_cents: 300, available_balance_cents: 290, status: 'open' }, '2026-06-02T09:00:00.000Z');
  const a1Current = { id: 'A1', name: 'Checking', last_four: '1111', status: 'open', fetched_at: '2026-06-04T00:00:00.000Z' };
  await rcInsert('accounts', 'A1', 4, a1Current, '2026-06-04T10:00:00.000Z');
  await recInsert('accounts', 'A1', 4, a1Current, '2026-06-04T10:00:00.000Z');

  // A2 pre-split history: 06-02 v5 (5000); a 06-03 balance version v6 that the
  // forward split ALSO captured into account_stats (the overlap day — its
  // candidate key is already present, so it must be skipped, not re-inserted);
  // then current identity-only v7. This mirrors the live shape where the
  // forward path and the pre-split history overlap on the split day.
  await rcInsert('accounts', 'A2', 5, { id: 'A2', name: 'Savings', balance_cents: 5000, available_balance_cents: 5000, status: 'open' }, '2026-06-02T09:00:00.000Z');
  await rcInsert('accounts', 'A2', 6, { id: 'A2', name: 'Savings', balance_cents: 5100, available_balance_cents: 5100, status: 'open' }, '2026-06-03T09:00:00.000Z');
  const a2Current = { id: 'A2', name: 'Savings', last_four: '2222', status: 'open', fetched_at: '2026-06-04T00:00:00.000Z' };
  await rcInsert('accounts', 'A2', 7, a2Current, '2026-06-04T10:00:00.000Z');
  await recInsert('accounts', 'A2', 7, a2Current, '2026-06-04T10:00:00.000Z');

  // Forward account_stats already present for A2 on 06-03 (the split day),
  // balance agreeing with the history version above (the 0-conflict overlap).
  const a2Fwd = { id: 'A2:2026-06-03', account_id: 'A2', observed_on: '2026-06-03', balance_cents: 5100, available_balance_cents: null };
  await recInsert('account_stats', 'A2:2026-06-03', 1, a2Fwd, '2026-06-03T12:00:00.000Z');
  await rcInsert('account_stats', 'A2:2026-06-03', 1, a2Fwd, '2026-06-03T12:00:00.000Z');

  await pool.query(
    `INSERT INTO version_counter(connector_id, connector_instance_id, stream, max_version) VALUES
       ($1,$2,'accounts',7), ($1,$2,'account_stats',1)`,
    [cid, cin],
  );
}

itPg('integration: dry-run enumerates candidates and net-new without writing', async () => {
  const pool = new Pool({ connectionString: POSTGRES_URL });
  const cin = `cin_test_usaa_dry_${testSuffix()}`;
  try {
    await setupSchema(pool);
    await cleanupTestData(pool, cin);
    await seedUsaaAccounts(pool, cin);

    const before = await pool.query(
      `SELECT count(*)::int AS n FROM records WHERE connector_instance_id=$1 AND stream='account_stats'`,
      [cin],
    );
    const plan = await planBackfill({ pool, connectorId: 'usaa', connectorInstanceId: cin });
    // 3 distinct net-new daily observations: A1:06-01, A1:06-02, A2:06-02.
    assert.equal(plan.candidateCount, 4, 'A1:06-01, A1:06-02, A2:06-02, A2:06-03');
    assert.equal(plan.insertCount, 3, 'net-new after subtracting the present A2:06-03');
    assert.equal(plan.skipped, 1, 'A2:06-03 already present from forward path');
    assert.equal(plan.sameDayResolved, 1, 'A1:06-01 had two versions');
    // Dry-run: account_stats unchanged.
    const after = await pool.query(
      `SELECT count(*)::int AS n FROM records WHERE connector_instance_id=$1 AND stream='account_stats'`,
      [cin],
    );
    assert.equal(after.rows[0].n, before.rows[0].n, 'dry-run wrote nothing');
  } finally {
    await cleanupTestData(pool, cin);
    await pool.end();
  }
});

itPg('integration: apply is anchored, same-day-resolved, idempotent, and rolls back exactly', async () => {
  const pool = new Pool({ connectionString: POSTGRES_URL });
  const suffix = testSuffix();
  const cin = `cin_test_usaa_apply_${suffix}`;
  const backupTables = [];
  try {
    await setupSchema(pool);
    await cleanupTestData(pool, cin);
    await seedUsaaAccounts(pool, cin);

    // Snapshot source accounts history (count + rows) to prove non-mutation.
    const sourceBefore = await pool.query(
      `SELECT count(*)::int AS n FROM record_changes WHERE connector_instance_id=$1 AND stream='accounts'`,
      [cin],
    );
    const forwardBefore = await pool.query(
      `SELECT record_json FROM records WHERE connector_instance_id=$1 AND stream='account_stats' AND record_key='A2:2026-06-03'`,
      [cin],
    );

    // ── apply ──
    const plan = await planBackfill({ pool, connectorId: 'usaa', connectorInstanceId: cin });
    const runId = `test_${suffix}`;
    const result = await applyBackfill({ pool, plan, runId });
    backupTables.push(result.sourceTable, result.insertedTable);
    assert.equal(result.inserted, 3, 'inserted the 3 net-new observations');

    // account_stats now has 4 rows: backfilled A1:06-01, A1:06-02, A2:06-02 +
    // forward A2:06-03.
    const stats = await pool.query(
      `SELECT record_key, record_json FROM records WHERE connector_instance_id=$1 AND stream='account_stats' ORDER BY record_key`,
      [cin],
    );
    assert.deepEqual(
      stats.rows.map((r) => r.record_key),
      ['A1:2026-06-01', 'A1:2026-06-02', 'A2:2026-06-02', 'A2:2026-06-03'],
    );

    // ── same-day resolution: A1:06-01 carries the LATEST version's balance (250) ──
    const a1day1 = stats.rows.find((r) => r.record_key === 'A1:2026-06-01');
    assert.equal(a1day1.record_json.balance_cents, 250);
    assert.equal(a1day1.record_json.available_balance_cents, null, 'available hardcoded null');

    // ── anchoring: the forward A2:06-03 row is byte-identical (not rewritten) ──
    const forwardAfter = await pool.query(
      `SELECT record_json FROM records WHERE connector_instance_id=$1 AND stream='account_stats' AND record_key='A2:2026-06-03'`,
      [cin],
    );
    assert.deepEqual(forwardAfter.rows[0].record_json, forwardBefore.rows[0].record_json);

    // ── each backfilled stats row has a matching record_changes anchor ──
    const statChanges = await pool.query(
      `SELECT COUNT(*)::int AS n FROM record_changes WHERE connector_instance_id=$1 AND stream='account_stats'`,
      [cin],
    );
    assert.equal(statChanges.rows[0].n, 4);

    // ── source accounts history is unchanged by apply ──
    const sourceAfter = await pool.query(
      `SELECT count(*)::int AS n FROM record_changes WHERE connector_instance_id=$1 AND stream='accounts'`,
      [cin],
    );
    assert.equal(sourceAfter.rows[0].n, sourceBefore.rows[0].n, 'apply did not touch accounts history');

    // ── source backup holds the full accounts history read; the dropped
    //    same-day version (A1 v1) is present for audit ──
    const srcBackup = await pool.query(
      `SELECT record_key, version FROM "${result.sourceTable}" WHERE stream='accounts' ORDER BY record_key, version`,
    );
    assert.equal(srcBackup.rows.length, sourceBefore.rows[0].n);
    assert.ok(
      srcBackup.rows.some((r) => r.record_key === 'A1' && Number(r.version) === 1),
      'dropped same-day version A1 v1 is in the source backup',
    );

    // ── inserted-key table holds exactly the 3 inserted keys ──
    const insertedRows = await pool.query(
      `SELECT record_key FROM "${result.insertedTable}" ORDER BY record_key`,
    );
    assert.deepEqual(
      insertedRows.rows.map((r) => r.record_key),
      ['A1:2026-06-01', 'A1:2026-06-02', 'A2:2026-06-02'],
    );

    // ── idempotent re-apply: inserts nothing ──
    const plan2 = await planBackfill({ pool, connectorId: 'usaa', connectorInstanceId: cin });
    assert.equal(plan2.insertCount, 0, 're-apply is a no-op');
    const result2 = await applyBackfill({ pool, plan: plan2, runId: `test_${suffix}_2` });
    backupTables.push(result2.sourceTable, result2.insertedTable);
    assert.equal(result2.inserted, 0);

    // ── rollback: deletes exactly the 3 inserted keys; forward + source intact ──
    const rollback = await applyRollback({ pool, connectorInstanceId: cin, runId });
    assert.equal(rollback.deleted, 3);

    const statsAfterRollback = await pool.query(
      `SELECT record_key FROM records WHERE connector_instance_id=$1 AND stream='account_stats' ORDER BY record_key`,
      [cin],
    );
    assert.deepEqual(
      statsAfterRollback.rows.map((r) => r.record_key),
      ['A2:2026-06-03'],
      'only the forward-path row remains after rollback',
    );
    const changesAfterRollback = await pool.query(
      `SELECT record_key FROM record_changes WHERE connector_instance_id=$1 AND stream='account_stats' ORDER BY record_key`,
      [cin],
    );
    assert.deepEqual(changesAfterRollback.rows.map((r) => r.record_key), ['A2:2026-06-03']);

    // ── no-source-mutation across the full apply+rollback cycle ──
    const sourceFinal = await pool.query(
      `SELECT count(*)::int AS n FROM record_changes WHERE connector_instance_id=$1 AND stream='accounts'`,
      [cin],
    );
    assert.equal(sourceFinal.rows[0].n, sourceBefore.rows[0].n, 'accounts history unchanged by apply+rollback');
  } finally {
    await cleanupTestData(pool, cin, backupTables);
    await pool.end();
  }
});

itPg('integration: rollback refuses a run with no inserted-key table', async () => {
  const pool = new Pool({ connectionString: POSTGRES_URL });
  const cin = `cin_test_usaa_norun_${testSuffix()}`;
  try {
    await setupSchema(pool);
    await cleanupTestData(pool, cin);
    await insertConnectorInstance(pool, cin, 'usaa');
    await assert.rejects(
      () => applyRollback({ pool, connectorInstanceId: cin, runId: 'does_not_exist' }),
      /inserted-key table .* not found/,
    );
  } finally {
    await cleanupTestData(pool, cin);
    await pool.end();
  }
});

itPg('integration: rollback never deletes a forward-path key absent from the inserted table', async () => {
  const pool = new Pool({ connectionString: POSTGRES_URL });
  const suffix = testSuffix();
  const cin = `cin_test_usaa_exact_${suffix}`;
  const backupTables = [];
  try {
    await setupSchema(pool);
    await cleanupTestData(pool, cin);
    await seedUsaaAccounts(pool, cin);
    const plan = await planBackfill({ pool, connectorId: 'usaa', connectorInstanceId: cin });
    const runId = `test_${suffix}`;
    const result = await applyBackfill({ pool, plan, runId });
    backupTables.push(result.sourceTable, result.insertedTable);

    // Forge a forward-path key into the SAME stream that is NOT recorded in the
    // run's inserted table; rollback must leave it untouched.
    const forged = { id: 'A1:2026-06-09', account_id: 'A1', observed_on: '2026-06-09', balance_cents: 777, available_balance_cents: null };
    await pool.query(
      `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, primary_key_text)
       VALUES ('usaa',$1,'account_stats','A1:2026-06-09',$2::jsonb,'2026-06-09T12:00:00.000Z',1,'A1:2026-06-09')`,
      [cin, JSON.stringify(forged)],
    );

    const rollback = await applyRollback({ pool, connectorInstanceId: cin, runId });
    assert.equal(rollback.deleted, 3, 'only the 3 recorded inserts are deleted');
    const forgedStill = await pool.query(
      `SELECT 1 FROM records WHERE connector_instance_id=$1 AND stream='account_stats' AND record_key='A1:2026-06-09'`,
      [cin],
    );
    assert.equal(forgedStill.rows.length, 1, 'the un-recorded forward key survives rollback');
  } finally {
    await cleanupTestData(pool, cin, backupTables);
    await pool.end();
  }
});
