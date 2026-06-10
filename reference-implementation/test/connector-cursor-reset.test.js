/**
 * Tests for connector-cursor-reset.mjs - the owner-gated cursor-reset tool
 * that turns the next incremental run into a full source resync by blanking
 * `connector_state.state_json` for explicit (connector_instance_id, stream)
 * pairs.
 *
 * Pure units run everywhere. The DB integration suite is env-gated on
 * PDPP_TEST_POSTGRES_URL and asserts:
 *   - dry-run writes nothing and reports present/absent streams;
 *   - apply snapshots the pre-image into a backup table and resets only the
 *     present streams to {};
 *   - an absent stream is skipped (a missing cursor already means "no since");
 *   - the backup table holds the exact prior cursor so the reset is reversible.
 *
 * The cursor-reset is the only owner step in the current-projection GitHub
 * repair that had no tooling and no test; this closes that gap. The subsequent
 * run + self-heal + reconcile are covered by current-projection-recurrence-
 * guard.test.js and postgres-records-ingest-noop.test.js.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import {
  BACKUP_TABLE_PREFIX,
  backupTableName,
  formatSummary,
  parseArgs,
  runCursorReset,
  sanitizeIdentifierToken,
  truncateId,
  validateArgs,
} from '../scripts/repair/connector-cursor-reset.mjs';

const { Pool } = pg;
const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

// Pure units

test('parseArgs collects a repeatable --stream, de-duplicating in first-seen order', () => {
  const args = parseArgs([
    '--connector-instance-id=cin_abc',
    '--stream=issues',
    '--stream=pull_requests',
    '--stream=issues',
    '--apply',
  ]);
  assert.equal(args.connectorInstanceId, 'cin_abc');
  assert.deepEqual(args.streams, ['issues', 'pull_requests']);
  assert.equal(args.apply, true);
});

test('parseArgs leaves apply false and streams empty when absent', () => {
  const args = parseArgs(['--connector-instance-id=cin_abc']);
  assert.equal(args.apply, false);
  assert.deepEqual(args.streams, []);
});

test('validateArgs requires an instance id', () => {
  assert.match(validateArgs({ connectorInstanceId: null, streams: ['issues'] }), /connector-instance-id/);
});

test('validateArgs refuses an empty stream set (no reset-all mode)', () => {
  assert.match(validateArgs({ connectorInstanceId: 'cin_abc', streams: [] }), /at least one --stream/);
});

test('validateArgs passes for a scoped request', () => {
  assert.equal(validateArgs({ connectorInstanceId: 'cin_abc', streams: ['issues'] }), null);
});

test('truncateId elides long identifiers but preserves short ones', () => {
  assert.equal(truncateId('issues'), 'issues');
  assert.equal(truncateId('cin_b110e71fb14fb61450d2d427'), 'cin_b110...d427');
});

test('sanitizeIdentifierToken lowercases and strips unsafe chars', () => {
  assert.equal(sanitizeIdentifierToken('cin_B110-e71', 'cin'), 'cin_b110_e71');
  assert.throws(() => sanitizeIdentifierToken('', 'cin'), /unsafe cin/);
});

test('backupTableName is prefixed, stable for the same scope, and within 63 bytes', () => {
  const a = backupTableName({
    connectorInstanceId: 'cin_b110e71fb14fb61450d2d427',
    streams: ['issues', 'pull_requests', 'repositories'],
    stamp: '20260604120000',
  });
  // Stream order must not change the name (sorted internally).
  const b = backupTableName({
    connectorInstanceId: 'cin_b110e71fb14fb61450d2d427',
    streams: ['repositories', 'issues', 'pull_requests'],
    stamp: '20260604120000',
  });
  assert.ok(a.startsWith(`${BACKUP_TABLE_PREFIX}_`));
  assert.equal(a, b, 'name is independent of stream argument order');
  assert.ok(a.length <= 63, `name within 63 bytes: ${a} (${a.length})`);
});

test('backupTableName diverges when the stream set differs', () => {
  const a = backupTableName({ connectorInstanceId: 'cin_x', streams: ['issues'], stamp: 's1' });
  const b = backupTableName({ connectorInstanceId: 'cin_x', streams: ['issues', 'pull_requests'], stamp: 's1' });
  assert.notEqual(a, b);
});

test('formatSummary labels dry-run vs apply and never prints cursor values', () => {
  const dry = formatSummary({
    connectorInstanceId: 'cin_b110e71fb14fb61450d2d427',
    streams: ['issues', 'gists'],
    present: ['issues'],
    absent: ['gists'],
    applied: false,
    backupTable: null,
    resetCount: 0,
    failed: false,
  });
  assert.match(dry, /\[DRY-RUN\]/);
  assert.match(dry, /would reset to \{\}/);
  assert.match(dry, /absent\s+gists/);
  assert.match(dry, /--apply/);

  const applied = formatSummary({
    connectorInstanceId: 'cin_b110e71fb14fb61450d2d427',
    streams: ['issues'],
    present: ['issues'],
    absent: [],
    applied: true,
    backupTable: 'ccr_backup_deadbeef__cin_b110__2026',
    resetCount: 1,
    failed: false,
  });
  assert.match(applied, /\[APPLY\]/);
  assert.match(applied, /reset_count=1/);
  assert.match(applied, /backup_table=ccr_backup_/);
  assert.match(applied, /POST \/v1\/owner\/connections/);
});

// DB integration (Postgres)

if (!POSTGRES_URL) {
  test('connector-cursor-reset DB tests (skipped: PDPP_TEST_POSTGRES_URL unset)', { skip: true }, () => {});
} else {
  async function ensureSchema(pool) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS connector_state (
        connector_id TEXT NOT NULL,
        connector_instance_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        state_json JSONB NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(connector_instance_id, stream)
      );
    `);
  }

  async function withFixture(fn) {
    const pool = new Pool({ connectionString: POSTGRES_URL });
    await ensureSchema(pool);
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorInstanceId = `cin_ccr_${suffix}`;
    const connectorId = `ccr_${suffix}`;
    const stamp = `t${suffix}`;
    try {
      await fn({ pool, connectorInstanceId, connectorId, stamp });
    } finally {
      // Drop backup tables this fixture created (name embeds a sanitized head
      // of the unique cin), then the seed rows.
      const cinHead = sanitizeIdentifierToken(connectorInstanceId, 'cin').slice(0, 12);
      const backups = await pool.query(
        `SELECT tablename FROM pg_tables
          WHERE tablename LIKE $1`,
        [`${BACKUP_TABLE_PREFIX}_%${cinHead}%`],
      );
      for (const r of backups.rows) {
        await pool.query(`DROP TABLE IF EXISTS "${r.tablename}"`);
      }
      await pool.query('DELETE FROM connector_state WHERE connector_instance_id = $1', [connectorInstanceId]);
      await pool.end();
    }
  }

  async function seedCursor(pool, { connectorId, connectorInstanceId, stream, stateJson }) {
    await pool.query(
      `INSERT INTO connector_state (connector_id, connector_instance_id, stream, state_json, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, '2026-06-04T05:00:00.000Z')`,
      [connectorId, connectorInstanceId, stream, JSON.stringify(stateJson)],
    );
  }

  async function readCursor(pool, connectorInstanceId, stream) {
    const r = await pool.query(
      'SELECT state_json FROM connector_state WHERE connector_instance_id = $1 AND stream = $2',
      [connectorInstanceId, stream],
    );
    return r.rows.length ? r.rows[0].state_json : null;
  }

  test('dry-run reports present/absent and writes nothing', async () => {
    await withFixture(async ({ pool, connectorId, connectorInstanceId, stamp }) => {
      await seedCursor(pool, {
        connectorId,
        connectorInstanceId,
        stream: 'issues',
        stateJson: { last_updated_at: '2026-06-04T05:37:44Z' },
      });

      const result = await runCursorReset({
        pool,
        connectorInstanceId,
        streams: ['issues', 'gists'],
        apply: false,
        stamp,
      });

      assert.deepEqual(result.present, ['issues']);
      assert.deepEqual(result.absent, ['gists']);
      assert.equal(result.applied, false);
      assert.equal(result.backupTable, null);
      assert.equal(result.resetCount, 0);

      // The stored cursor is untouched by a dry-run.
      const after = await readCursor(pool, connectorInstanceId, 'issues');
      assert.deepEqual(after, { last_updated_at: '2026-06-04T05:37:44Z' });
    });
  });

  test('apply resets only present streams to {} and snapshots the pre-image', async () => {
    await withFixture(async ({ pool, connectorId, connectorInstanceId, stamp }) => {
      await seedCursor(pool, {
        connectorId,
        connectorInstanceId,
        stream: 'issues',
        stateJson: { last_updated_at: '2026-06-04T05:37:44Z' },
      });
      await seedCursor(pool, {
        connectorId,
        connectorInstanceId,
        stream: 'repositories',
        stateJson: { last_pushed_at: '2026-06-04T05:36:23Z' },
      });

      const result = await runCursorReset({
        pool,
        connectorInstanceId,
        streams: ['issues', 'repositories', 'gists'],
        apply: true,
        stamp,
      });

      assert.equal(result.failed, false);
      assert.deepEqual(result.present.sort(), ['issues', 'repositories']);
      assert.deepEqual(result.absent, ['gists']);
      assert.equal(result.resetCount, 2);
      assert.ok(result.backupTable);

      // Both present cursors are now empty objects.
      assert.deepEqual(await readCursor(pool, connectorInstanceId, 'issues'), {});
      assert.deepEqual(await readCursor(pool, connectorInstanceId, 'repositories'), {});

      // The backup table holds the exact pre-image so the reset is reversible.
      const backup = await pool.query(
        `SELECT stream, state_json FROM "${result.backupTable}" ORDER BY stream`,
      );
      const byStream = Object.fromEntries(backup.rows.map((r) => [r.stream, r.state_json]));
      assert.deepEqual(byStream.issues, { last_updated_at: '2026-06-04T05:37:44Z' });
      assert.deepEqual(byStream.repositories, { last_pushed_at: '2026-06-04T05:36:23Z' });

      // Restore from the backup proves the undo path works.
      await pool.query(
        `UPDATE connector_state cs
            SET state_json = b.state_json
           FROM "${result.backupTable}" b
          WHERE cs.connector_instance_id = $1
            AND cs.stream = b.stream`,
        [connectorInstanceId],
      );
      assert.deepEqual(
        await readCursor(pool, connectorInstanceId, 'issues'),
        { last_updated_at: '2026-06-04T05:37:44Z' },
      );
    });
  });

  test('apply with no present streams writes nothing and creates no backup', async () => {
    await withFixture(async ({ pool, connectorInstanceId, stamp }) => {
      const result = await runCursorReset({
        pool,
        connectorInstanceId,
        streams: ['issues'],
        apply: true,
        stamp,
      });
      assert.deepEqual(result.present, []);
      assert.deepEqual(result.absent, ['issues']);
      assert.equal(result.resetCount, 0);
      assert.equal(result.backupTable, null);
      assert.equal(result.failed, false);
    });
  });
}
