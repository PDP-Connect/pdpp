/**
 * Tests for the compact-record-history operational tool.
 *
 * Two layers:
 *   1. Pure-helper tests (no DB): fingerprint stability, retention
 *      selector across the rule matrix, parseLimitKeys, registry shape.
 *   2. Postgres-backed integration tests (gated on PDPP_TEST_POSTGRES_URL):
 *      seeded fixture per acceptance scenario from design.md.
 *
 * Spec: openspec/changes/compact-retained-record-history/specs/
 *       reference-implementation-architecture/spec.md
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import assert from 'node:assert/strict';
import test from 'node:test';

import pg from 'pg';

import {
  COMPACTION_POLICIES,
  applyCompaction,
  findPolicy,
  markScopeDirty,
  parseLimitKeys,
  planCompaction,
  recordFingerprint,
  selectRemovableVersions,
} from '../scripts/compact-record-history.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.resolve(__dirname, '..', 'scripts', 'compact-record-history.mjs');

const { Pool } = pg;
const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

// ─── Pure-helper tests ──────────────────────────────────────────────────

test('recordFingerprint is stable across key order', () => {
  const a = { a: 1, b: 2, c: [3, 4] };
  const b = { c: [3, 4], b: 2, a: 1 };
  assert.equal(recordFingerprint(a), recordFingerprint(b));
});

test('recordFingerprint drops excluded keys before hashing', () => {
  const a = { id: 'x', fetched_at: '2026-05-26T00:00:00Z', name: 'n' };
  const b = { id: 'x', fetched_at: '2026-05-26T00:00:01Z', name: 'n' };
  assert.notEqual(recordFingerprint(a), recordFingerprint(b));
  assert.equal(
    recordFingerprint(a, ['fetched_at']),
    recordFingerprint(b, ['fetched_at']),
  );
});

test('recordFingerprint changes when a non-excluded field changes', () => {
  const a = { id: 'x', name: 'A' };
  const b = { id: 'x', name: 'B' };
  assert.notEqual(recordFingerprint(a), recordFingerprint(b));
});

test('COMPACTION_POLICIES exposes only the five registered policies (short-name canonical form)', () => {
  const expected = [
    ['gmail', 'threads'],
    ['slack', 'workspace'],
    ['slack', 'users'],
    ['slack', 'files'],
    ['ynab', 'payee_locations'],
  ];
  const actual = COMPACTION_POLICIES.map((p) => [p.connectorIds[0], p.stream]);
  assert.deepEqual(actual, expected);
});

test('findPolicy returns null for unknown streams', () => {
  assert.equal(findPolicy('slack', 'messages'), null);
  assert.equal(findPolicy('gmail', 'messages'), null);
  assert.equal(findPolicy('codex', 'sessions'), null);
});

test('findPolicy matches both short name and registry URL form for connector_id', () => {
  const a = findPolicy('slack', 'workspace');
  const b = findPolicy('https://registry.pdpp.org/connectors/slack', 'workspace');
  assert.ok(a);
  assert.ok(b);
  assert.equal(a, b, 'short-name and URL lookups must resolve to the same policy entry');
});

test('findPolicy returns the registered policy for Slack workspace with excludeKeys=[fetched_at]', () => {
  const p = findPolicy('slack', 'workspace');
  assert.ok(p);
  assert.deepEqual(p.excludeKeys, ['fetched_at']);
});

test('parseLimitKeys accepts positive integers, rejects everything else', () => {
  assert.equal(parseLimitKeys('1'), 1);
  assert.equal(parseLimitKeys('42'), 42);
  assert.equal(parseLimitKeys(undefined), null);
  assert.equal(parseLimitKeys(null), null);
  assert.equal(parseLimitKeys(''), null);
  assert.equal(parseLimitKeys('0'), 'invalid');
  assert.equal(parseLimitKeys('-3'), 'invalid');
  assert.equal(parseLimitKeys('1.5'), 'invalid');
  assert.equal(parseLimitKeys('abc'), 'invalid');
  assert.equal(parseLimitKeys(true), 'invalid');
});

// selectRemovableVersions ───────────────────────────────────────────────

const WORKSPACE_POLICY = findPolicy('slack', 'workspace');
const THREADS_POLICY = findPolicy('gmail', 'threads');

function row(version, payload, { deleted = false } = {}) {
  return { version, record_json: payload, deleted };
}

test('selectRemovableVersions: empty history → nothing to remove', () => {
  assert.deepEqual(selectRemovableVersions([], 0, THREADS_POLICY), []);
});

test('selectRemovableVersions: single-version history → nothing to remove', () => {
  const rows = [row(1, { id: 'x', name: 'A' })];
  assert.deepEqual(selectRemovableVersions(rows, 1, THREADS_POLICY), []);
});

test('selectRemovableVersions: all distinct fingerprints → nothing to remove', () => {
  const rows = [
    row(1, { id: 'x', n: 1 }),
    row(2, { id: 'x', n: 2 }),
    row(3, { id: 'x', n: 3 }),
    row(4, { id: 'x', n: 4 }),
  ];
  assert.deepEqual(selectRemovableVersions(rows, 4, THREADS_POLICY), []);
});

test('selectRemovableVersions: adjacent same-fingerprint runs collapse to first; current and first retained', () => {
  // versions: 1 (first, A) 2 (A) 3 (A) 4 (B) 5 (current, B)
  const rows = [
    row(1, { id: 'x', kind: 'A' }),
    row(2, { id: 'x', kind: 'A' }),
    row(3, { id: 'x', kind: 'A' }),
    row(4, { id: 'x', kind: 'B' }),
    row(5, { id: 'x', kind: 'B' }),
  ];
  // 2 and 3 collapse to 1; 5 is current so retained; 4 is the most-recent-prior
  // with a different fingerprint from current (wait — 4 and 5 have the same
  // fingerprint so 4 is also same-as-current; the most-recent-differing-prior
  // is version 3, but 3 is being marked removable). Let's reason carefully:
  //   - current is v5, fingerprint B
  //   - most recent prior with different fingerprint = v3 (A) — must be retained
  //   - v1: first → retain
  //   - v2: prev surviving is v1 (A), same fp → remove
  //   - v3: prev surviving is v1 (A), same fp BUT v3 is pinned as the
  //         most-recent-differing-prior → retain
  //   - v4: prev surviving is v3 (A), different fp (B) → retain
  //   - v5: current → retain
  // Hold on — v3's fingerprint IS A, current is B, so v3 IS the most-recent
  // prior with different fingerprint. Retained. Result: [2].
  const removable = selectRemovableVersions(rows, 5, WORKSPACE_POLICY);
  assert.deepEqual(removable.sort((a, b) => a - b), [2]);
});

test('selectRemovableVersions: long same-fingerprint run before current collapses to first', () => {
  // versions: 1 (A) 2 (A) 3 (A) 4 (A) 5 (current, A)
  const rows = [
    row(1, { id: 'x', kind: 'A' }),
    row(2, { id: 'x', kind: 'A' }),
    row(3, { id: 'x', kind: 'A' }),
    row(4, { id: 'x', kind: 'A' }),
    row(5, { id: 'x', kind: 'A' }),
  ];
  //   - current=5 (A); no prior version with different fp exists
  //   - v1: first → retain
  //   - v2, v3, v4: same fp as surviving anchor v1 → remove
  //   - v5: current → retain
  const removable = selectRemovableVersions(rows, 5, WORKSPACE_POLICY);
  assert.deepEqual(removable.sort((a, b) => a - b), [2, 3, 4]);
});

test('selectRemovableVersions: tombstones bound compaction', () => {
  // versions: 1 (A) 2 (A) 3 (tombstone) 4 (A) 5 (current, A)
  const rows = [
    row(1, { id: 'x', kind: 'A' }),
    row(2, { id: 'x', kind: 'A' }),
    row(3, null, { deleted: true }),
    row(4, { id: 'x', kind: 'A' }),
    row(5, { id: 'x', kind: 'A' }),
  ];
  //   - v1: first → retain
  //   - v2: same fp as v1 → remove
  //   - v3: tombstone → retain (boundary)
  //   - v4: predecessor is a tombstone → retain (resurrection)
  //   - v5: current → retain
  // The "most recent prior with different fingerprint" from current is the
  // tombstone v3 (fingerprint != A); v3 is already retained.
  const removable = selectRemovableVersions(rows, 5, WORKSPACE_POLICY);
  assert.deepEqual(removable.sort((a, b) => a - b), [2]);
});

test('selectRemovableVersions: workspace fetched_at-only churn collapses under fetched_at exclusion', () => {
  // versions whose only difference is fetched_at — the slack workspace
  // case the policy is designed for.
  const rows = [
    row(1, { id: 'T1', name: 'W', fetched_at: '2026-05-26T00:00:00Z' }),
    row(2, { id: 'T1', name: 'W', fetched_at: '2026-05-26T00:01:00Z' }),
    row(3, { id: 'T1', name: 'W', fetched_at: '2026-05-26T00:02:00Z' }),
    row(4, { id: 'T1', name: 'W', fetched_at: '2026-05-26T00:03:00Z' }),
    row(5, { id: 'T1', name: 'W', fetched_at: '2026-05-26T00:04:00Z' }),
  ];
  const removable = selectRemovableVersions(rows, 5, WORKSPACE_POLICY);
  assert.deepEqual(removable.sort((a, b) => a - b), [2, 3, 4]);
});

test('selectRemovableVersions: workspace fetched_at-only churn does NOT collapse under threads policy (no exclude)', () => {
  // Same rows, but a hypothetical policy with no exclude would treat each
  // fetched_at change as a real fingerprint change.
  const rows = [
    row(1, { id: 'T1', name: 'W', fetched_at: '2026-05-26T00:00:00Z' }),
    row(2, { id: 'T1', name: 'W', fetched_at: '2026-05-26T00:01:00Z' }),
    row(3, { id: 'T1', name: 'W', fetched_at: '2026-05-26T00:02:00Z' }),
  ];
  // Gmail threads policy has excludeKeys: [] — every row's fp differs.
  const removable = selectRemovableVersions(rows, 3, THREADS_POLICY);
  assert.deepEqual(removable, []);
});

test('selectRemovableVersions: current-row pin holds even when current matches a removable run', () => {
  // versions: 1 (A) 2 (A) 3 (current, A) 4 (A)
  // (a possible state if compaction is run while a later equal-fingerprint row exists
  //  — shouldn't happen in practice but the selector must be robust)
  const rows = [
    row(1, { id: 'x', kind: 'A' }),
    row(2, { id: 'x', kind: 'A' }),
    row(3, { id: 'x', kind: 'A' }),
    row(4, { id: 'x', kind: 'A' }),
  ];
  const removable = selectRemovableVersions(rows, 3, WORKSPACE_POLICY);
  // v1 first, v3 current. v2 collapses into v1. v4 same fp as surviving
  // anchor (v3, current) → removable.
  assert.deepEqual(removable.sort((a, b) => a - b), [2, 4]);
});

// ─── Postgres-backed integration tests ──────────────────────────────────

if (!POSTGRES_URL) {
  test('compact-record-history DB tests (skipped: PDPP_TEST_POSTGRES_URL unset)', { skip: true }, () => {});
} else {
  async function withFixture(fn) {
    const pool = new Pool({ connectionString: POSTGRES_URL });
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorInstanceId = `cin_compact_${suffix}`;
    const connectorId = `slack_compact_${suffix}`;
    const stream = 'workspace';
    const runId = `test_${suffix}`;
    const backupTable = `compact_record_history_backup_${runId}`;
    try {
      await fn({ pool, connectorInstanceId, connectorId, stream, runId, backupTable });
    } finally {
      try { await pool.query(`DROP TABLE IF EXISTS "${backupTable}"`); } catch {}
      await pool.query(`DELETE FROM record_changes WHERE connector_instance_id = $1`, [connectorInstanceId]);
      await pool.query(`DELETE FROM records WHERE connector_instance_id = $1`, [connectorInstanceId]);
      await pool.query(`DELETE FROM version_counter WHERE connector_instance_id = $1`, [connectorInstanceId]);
      try {
        await pool.query(`DELETE FROM retained_size_stream WHERE connector_instance_id = $1`, [connectorInstanceId]);
      } catch {}
      try {
        await pool.query(`DELETE FROM retained_size_connection WHERE connector_instance_id = $1`, [connectorInstanceId]);
      } catch {}
      await pool.end();
    }
  }

  async function seedWorkspaceChurn({ pool, connectorInstanceId, connectorId, stream, recordKey }) {
    // Seed the canonical churn shape — every version has the same
    // record_json modulo fetched_at, which is excluded from the slack
    // workspace fingerprint. v6 is the current row; the three
    // intermediates (v2, v3, v4) collapse into the v1 anchor; v5 is
    // retained because the selector pins the most-recent prior row
    // whose fingerprint differs from the current row when one exists.
    // In this fixture every row's fingerprint matches v6, so no such
    // pin exists and v5 collapses into v1 too — giving the canonical
    // shape: 6 versions in, removable = {2, 3, 4, 5}, retained = {1, 6}.
    //
    // We assert removableVersions === 4 (not 3) — the design.md hint of
    // "three intermediate, one fingerprint-differing" matches a different
    // shape that this test does not seed; the live offender (slack
    // workspace, 31k versions for a single fingerprint-stable record)
    // is closer to this seed.
    const payloadStable = (ts) => ({
      id: recordKey,
      name: 'Workspace',
      url: 'https://example.com/',
      fetched_at: ts,
    });
    const rows = [
      { v: 1, p: payloadStable('2026-05-26T00:00:00Z') },
      { v: 2, p: payloadStable('2026-05-26T00:01:00Z') },
      { v: 3, p: payloadStable('2026-05-26T00:02:00Z') },
      { v: 4, p: payloadStable('2026-05-26T00:03:00Z') },
      { v: 5, p: payloadStable('2026-05-26T00:04:00Z') },
      { v: 6, p: payloadStable('2026-05-26T00:05:00Z') },
    ];

    await pool.query(
      `INSERT INTO version_counter(connector_id, connector_instance_id, stream, max_version)
       VALUES($1, $2, $3, $4)
       ON CONFLICT (connector_instance_id, stream) DO UPDATE SET max_version = EXCLUDED.max_version`,
      [connectorId, connectorInstanceId, stream, 6],
    );
    for (const r of rows) {
      await pool.query(
        `INSERT INTO record_changes(connector_id, connector_instance_id, stream, record_key, version, record_json, emitted_at, deleted)
         VALUES($1, $2, $3, $4, $5, $6::jsonb, $7, FALSE)`,
        [connectorId, connectorInstanceId, stream, recordKey, r.v, JSON.stringify(r.p), '2026-05-26T00:00:00Z'],
      );
    }
    // Current row points at v6.
    await pool.query(
      `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted, primary_key_text)
       VALUES($1, $2, $3, $4, $5::jsonb, $6, $7, FALSE, $4)`,
      [connectorId, connectorInstanceId, stream, recordKey, JSON.stringify(rows[5].p), '2026-05-26T00:05:00Z', 6],
    );
  }

  test('plan reports removableVersions=4 for the canonical workspace fetched_at-only churn fixture', async () => {
    await withFixture(async ({ pool, connectorInstanceId, connectorId, stream }) => {
      const recordKey = 'T-AAA';
      await seedWorkspaceChurn({ pool, connectorInstanceId, connectorId, stream, recordKey });
      const policy = findPolicy('slack', 'workspace');
      const plan = await planCompaction({ pool, connectorInstanceId, stream, policy, limitKeys: null });
      assert.equal(plan.scannedKeys, 1);
      assert.equal(plan.scannedVersions, 6);
      assert.equal(plan.removableVersions, 4);
      assert.equal(plan.retainedVersionsAfter, 2);
      assert.ok(plan.estimatedRemovedBytes > 0, 'estimatedRemovedBytes should be positive');
    });
  });

  test('apply removes exactly the planned versions, populates backup, leaves current/version_counter untouched', async () => {
    await withFixture(async ({ pool, connectorInstanceId, connectorId, stream, runId, backupTable }) => {
      const recordKey = 'T-BBB';
      await seedWorkspaceChurn({ pool, connectorInstanceId, connectorId, stream, recordKey });
      const policy = findPolicy('slack', 'workspace');

      // Snapshot the surviving rows + current + counter for byte-identity check.
      const beforeChanges = await pool.query(
        `SELECT version, record_json::text AS rj, emitted_at, deleted FROM record_changes
          WHERE connector_instance_id = $1 AND stream = $2 ORDER BY version`,
        [connectorInstanceId, stream],
      );
      const beforeRecord = await pool.query(
        `SELECT record_json::text AS rj, version FROM records WHERE connector_instance_id = $1`,
        [connectorInstanceId],
      );
      const beforeCounter = await pool.query(
        `SELECT max_version FROM version_counter WHERE connector_instance_id = $1 AND stream = $2`,
        [connectorInstanceId, stream],
      );

      const plan = await planCompaction({ pool, connectorInstanceId, stream, policy, limitKeys: null });
      const result = await applyCompaction({ pool, plan, runId });

      assert.equal(result.deleted, 4);
      assert.equal(result.inserted, 4);
      assert.equal(result.backupTable, backupTable);

      // Backup table has exactly four rows.
      const backupRows = await pool.query(`SELECT COUNT(*)::int AS c FROM "${backupTable}"`);
      assert.equal(backupRows.rows[0].c, 4);

      // The retained versions are 1 (first) and 6 (current).
      const remainingVersions = (await pool.query(
        `SELECT version FROM record_changes WHERE connector_instance_id = $1 AND stream = $2 ORDER BY version`,
        [connectorInstanceId, stream],
      )).rows.map((r) => Number(r.version));
      assert.deepEqual(remainingVersions, [1, 6]);

      // Surviving rows are byte-identical to before (compare on the rows that remain).
      const afterChangesMap = new Map(
        (await pool.query(
          `SELECT version, record_json::text AS rj, emitted_at, deleted FROM record_changes
            WHERE connector_instance_id = $1 AND stream = $2 ORDER BY version`,
          [connectorInstanceId, stream],
        )).rows.map((r) => [Number(r.version), r]),
      );
      for (const b of beforeChanges.rows) {
        const v = Number(b.version);
        if (![1, 6].includes(v)) continue;
        const a = afterChangesMap.get(v);
        assert.ok(a, `version ${v} must survive`);
        assert.equal(a.rj, b.rj, `version ${v} record_json must be byte-identical`);
        assert.equal(a.emitted_at, b.emitted_at);
        assert.equal(!!a.deleted, !!b.deleted);
      }

      // Current row untouched.
      const afterRecord = await pool.query(
        `SELECT record_json::text AS rj, version FROM records WHERE connector_instance_id = $1`,
        [connectorInstanceId],
      );
      assert.equal(afterRecord.rows[0].rj, beforeRecord.rows[0].rj);
      assert.equal(Number(afterRecord.rows[0].version), Number(beforeRecord.rows[0].version));

      // version_counter untouched.
      const afterCounter = await pool.query(
        `SELECT max_version FROM version_counter WHERE connector_instance_id = $1 AND stream = $2`,
        [connectorInstanceId, stream],
      );
      assert.equal(
        Number(afterCounter.rows[0].max_version),
        Number(beforeCounter.rows[0].max_version),
      );
    });
  });

  test('markScopeDirty flips retained_size_stream.dirty for the scope', async () => {
    await withFixture(async ({ pool, connectorInstanceId, connectorId, stream }) => {
      // Seed a retained_size_stream row in the clean state so we can
      // observe the flip.
      await pool.query(
        `INSERT INTO retained_size_stream
           (connector_instance_id, connector_id, stream,
            current_record_json_bytes, record_history_json_bytes, blob_bytes,
            record_count, record_history_count, blob_count,
            dirty, computed_at)
         VALUES($1, $2, $3, 0, 0, 0, 0, 0, 0, 0, NOW()::text)
         ON CONFLICT (connector_instance_id, stream) DO UPDATE
           SET dirty = 0`,
        [connectorInstanceId, connectorId, stream],
      );
      const before = await pool.query(
        `SELECT dirty FROM retained_size_stream
           WHERE connector_instance_id = $1 AND stream = $2`,
        [connectorInstanceId, stream],
      );
      assert.equal(Number(before.rows[0].dirty), 0);

      await markScopeDirty({ pool, connectorInstanceId, stream });

      const after = await pool.query(
        `SELECT dirty FROM retained_size_stream
           WHERE connector_instance_id = $1 AND stream = $2`,
        [connectorInstanceId, stream],
      );
      assert.equal(Number(after.rows[0].dirty), 1, 'markScopeDirty must flip dirty=1');
    });
  });

  test('CLI: unknown (connector_id, stream) pair refuses to run', () => {
    const r = spawnSync(
      process.execPath,
      [SCRIPT_PATH, '--connector-instance-id=cin_unknown', '--stream=messages', '--connector-id=slack'],
      { env: { ...process.env, PDPP_TEST_POSTGRES_URL: POSTGRES_URL }, encoding: 'utf8' },
    );
    assert.notEqual(r.status, 0, 'must exit non-zero for unknown policy');
    assert.match(r.stderr + r.stdout, /no compaction policy registered/);
    assert.match(r.stderr + r.stdout, /Registered policies/);
  });

  test('CLI: --apply without database credentials refuses to run', () => {
    const env = { ...process.env };
    delete env.PDPP_DATABASE_URL;
    delete env.PDPP_TEST_POSTGRES_URL;
    const r = spawnSync(
      process.execPath,
      [SCRIPT_PATH, '--connector-instance-id=cin_anything', '--stream=workspace', '--connector-id=slack', '--apply'],
      { env, encoding: 'utf8' },
    );
    assert.notEqual(r.status, 0, 'must exit non-zero without DB creds');
    assert.match(r.stderr + r.stdout, /PDPP_DATABASE_URL/);
  });

  test('CLI: invalid --limit-keys refuses to run', () => {
    const r = spawnSync(
      process.execPath,
      [SCRIPT_PATH, '--connector-instance-id=cin_x', '--stream=workspace', '--connector-id=slack', '--limit-keys=-3'],
      { env: { ...process.env, PDPP_TEST_POSTGRES_URL: POSTGRES_URL }, encoding: 'utf8' },
    );
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /--limit-keys must be a positive integer/);
  });

  test('apply on an already-clean stream removes zero rows and creates no rows in backup', async () => {
    await withFixture(async ({ pool, connectorInstanceId, connectorId, stream, runId }) => {
      const recordKey = 'T-CCC';
      // Seed only two distinct-fingerprint versions and current.
      await pool.query(
        `INSERT INTO version_counter(connector_id, connector_instance_id, stream, max_version)
         VALUES($1, $2, $3, 2)`,
        [connectorId, connectorInstanceId, stream],
      );
      for (const v of [
        { v: 1, p: { id: recordKey, name: 'A' } },
        { v: 2, p: { id: recordKey, name: 'B' } },
      ]) {
        await pool.query(
          `INSERT INTO record_changes(connector_id, connector_instance_id, stream, record_key, version, record_json, emitted_at, deleted)
           VALUES($1, $2, $3, $4, $5, $6::jsonb, '2026-05-26T00:00:00Z', FALSE)`,
          [connectorId, connectorInstanceId, stream, recordKey, v.v, JSON.stringify(v.p)],
        );
      }
      await pool.query(
        `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted, primary_key_text)
         VALUES($1, $2, $3, $4, $5::jsonb, '2026-05-26T00:00:00Z', 2, FALSE, $4)`,
        [connectorId, connectorInstanceId, stream, recordKey, JSON.stringify({ id: recordKey, name: 'B' })],
      );
      const policy = findPolicy('slack', 'workspace');
      const plan = await planCompaction({ pool, connectorInstanceId, stream, policy, limitKeys: null });
      assert.equal(plan.removableVersions, 0);
      const result = await applyCompaction({ pool, plan, runId });
      assert.equal(result.deleted, 0);
      assert.equal(result.inserted, 0);
      assert.equal(result.backupTable, null, 'no-op apply does not create a backup table');
    });
  });
}
