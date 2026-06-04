/**
 * Regression test for the Postgres record-version allocator floor.
 *
 * `allocateNextVersion` must never return a stream version at or below the
 * durable history/current state. The live defect (GitHub current-projection
 * drift, connection cin_b110e71fb14fb61450d2d427): `records.version` and
 * `record_changes.version` had already advanced past
 * `version_counter.max_version` (counter lagging by one). The plain
 * `max_version + 1` allocator then re-issued an already-used version, and the
 * `record_changes` insert collided on
 * `PRIMARY KEY(connector_instance_id, stream, version)` — rows rejected inside
 * a "succeeded" batch.
 *
 * These tests pin that the allocator now allocates strictly above ALL of:
 *   - version_counter.max_version,
 *   - max retained record_changes.version,
 *   - max current records.version,
 * in one atomic statement, appends a contiguous history row, and leaves no
 * current/history/counter drift. A no-regression monotonic case proves the
 * fix does not perturb the normal in-sync path.
 *
 * Env gate: PDPP_TEST_POSTGRES_URL must be set (Compose/throwaway Postgres).
 * Each test uses a uniquely-named connector_instance_id and deletes its rows
 * on teardown so the shared schema does not accumulate detritus.
 *
 * Spec: openspec/changes/repair-record-version-noop-detection/specs/
 *       reference-implementation-architecture/spec.md (sibling allocator
 *       invariant; the floor guard hardens the same Postgres ingest path).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { closeDb, initDb } from '../server/db.js';
import { postgresIngestRecord } from '../server/postgres-records.js';
import {
  closePostgresStorage,
  initPostgresStorage,
  postgresQuery,
} from '../server/postgres-storage.js';

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

if (!POSTGRES_URL) {
  test('postgres record-version floor (skipped: PDPP_TEST_POSTGRES_URL unset)', {
    skip: true,
  }, () => {});
} else {
  async function cleanup(connectorInstanceId) {
    try {
      await postgresQuery(`DELETE FROM record_changes WHERE connector_instance_id = $1`, [connectorInstanceId]);
      await postgresQuery(`DELETE FROM records WHERE connector_instance_id = $1`, [connectorInstanceId]);
      await postgresQuery(`DELETE FROM version_counter WHERE connector_instance_id = $1`, [connectorInstanceId]);
    } catch {}
  }

  async function readCounter(connectorInstanceId, stream) {
    const r = await postgresQuery(
      `SELECT max_version FROM version_counter WHERE connector_instance_id = $1 AND stream = $2`,
      [connectorInstanceId, stream],
    );
    return r.rows[0] ? Number(r.rows[0].max_version) : null;
  }

  async function readCurrentVersion(connectorInstanceId, stream, recordKey) {
    const r = await postgresQuery(
      `SELECT version FROM records WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3`,
      [connectorInstanceId, stream, recordKey],
    );
    return r.rows[0] ? Number(r.rows[0].version) : null;
  }

  async function readMaxChangeVersion(connectorInstanceId, stream) {
    const r = await postgresQuery(
      `SELECT MAX(version)::bigint AS v FROM record_changes WHERE connector_instance_id = $1 AND stream = $2`,
      [connectorInstanceId, stream],
    );
    return r.rows[0]?.v == null ? null : Number(r.rows[0].v);
  }

  test('lagging version_counter beneath existing history/current allocates above the floor', async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorId = `pg_floor_${suffix}`;
    const connectorInstanceId = `cin_pg_floor_${suffix}`;
    const stream = 'issues';
    const recordKey = 'issue-1';
    const terminalVersion = 7083; // mirrors the live github/issues terminal
    const laggingCounter = terminalVersion - 1; // version_counter lags by one

    initDb(':memory:');
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });

    try {
      const storageTarget = { connectorId, connectorInstanceId };
      const data = { id: recordKey, title: 'Original', state: 'open' };

      // Seed the live drift shape directly: the current `records` row and the
      // matching `record_changes` anchor both sit at the terminal version,
      // while `version_counter` lags one behind. This is exactly the orphaned
      // counter state observed live before this guard.
      await postgresQuery(
        `INSERT INTO records
           (connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted, deleted_at, cursor_value, primary_key_text)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, FALSE, NULL, $4, $4)`,
        [connectorId, connectorInstanceId, stream, recordKey, JSON.stringify(data), '2026-05-26T12:00:00.000Z', terminalVersion],
      );
      await postgresQuery(
        `INSERT INTO record_changes
           (connector_id, connector_instance_id, stream, record_key, version, record_json, emitted_at, deleted, deleted_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, FALSE, NULL)`,
        [connectorId, connectorInstanceId, stream, recordKey, terminalVersion, JSON.stringify(data), '2026-05-26T12:00:00.000Z'],
      );
      await postgresQuery(
        `INSERT INTO version_counter (connector_id, connector_instance_id, stream, max_version)
         VALUES ($1, $2, $3, $4)`,
        [connectorId, connectorInstanceId, stream, laggingCounter],
      );

      assert.equal(await readCounter(connectorInstanceId, stream), laggingCounter, 'counter seeded lagging');
      assert.equal(await readMaxChangeVersion(connectorInstanceId, stream), terminalVersion, 'history seeded at terminal');

      // A genuinely changed write. With the pre-fix allocator this would
      // return laggingCounter + 1 === terminalVersion, colliding with the
      // existing record_changes anchor on the PK and rejecting the row.
      const changed = await postgresIngestRecord(storageTarget, {
        stream,
        key: recordKey,
        data: { ...data, state: 'closed' },
        op: 'upsert',
        emitted_at: '2026-05-26T13:00:00.000Z',
      });
      assert.equal(changed.accepted, true);
      assert.equal(changed.changed, true, 'changed write must be accepted (not a collision)');

      const newVersion = await readCurrentVersion(connectorInstanceId, stream, recordKey);
      assert.equal(
        newVersion,
        terminalVersion + 1,
        'allocated version must be strictly above the highest durable floor',
      );

      // Counter is now at the new version (no longer lagging).
      assert.equal(
        await readCounter(connectorInstanceId, stream),
        terminalVersion + 1,
        'counter re-synced to the freshly allocated version',
      );

      // History gained exactly one new anchor at the new version; the old
      // terminal anchor is untouched. No duplicate version, no drift.
      const changeRows = await postgresQuery(
        `SELECT version FROM record_changes
          WHERE connector_instance_id = $1 AND stream = $2
          ORDER BY version ASC`,
        [connectorInstanceId, stream],
      );
      const versions = changeRows.rows.map((r) => Number(r.version));
      assert.deepEqual(
        versions,
        [terminalVersion, terminalVersion + 1],
        'history holds the original terminal anchor plus exactly one new anchor',
      );
      assert.equal(new Set(versions).size, versions.length, 'no duplicate history version');

      // Current/history convergence: the current row version equals the max
      // history version equals the counter — zero drift.
      assert.equal(newVersion, await readMaxChangeVersion(connectorInstanceId, stream));
      assert.equal(newVersion, await readCounter(connectorInstanceId, stream));
    } finally {
      await cleanup(connectorInstanceId);
      await closePostgresStorage();
      closeDb();
    }
  });

  test('self-heal of an unanchored row clears a lagging counter without re-using a version', async () => {
    // The live trigger was a self-heal (unchanged reingest of an unanchored
    // current row) landing on a lagging counter. Here the current row's
    // anchor is pruned (orphan) AND the counter lags behind a DIFFERENT hot
    // key's retained history. The self-heal must allocate above the history
    // floor, not at counter+1 (which would collide with the hot key's anchor).
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorId = `pg_floor_heal_${suffix}`;
    const connectorInstanceId = `cin_pg_floor_heal_${suffix}`;
    const stream = 'pull_requests';
    const coldKey = 'pr-cold';
    const hotKey = 'pr-hot';
    const coldData = { id: coldKey, title: 'Cold' };
    const hotData = { id: hotKey, title: 'Hot' };
    const hotVersion = 1015; // mirrors live github/pull_requests terminal
    const laggingCounter = hotVersion - 1;

    initDb(':memory:');
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });

    try {
      const storageTarget = { connectorId, connectorInstanceId };

      // Hot key: current row + retained anchor at the terminal version.
      await postgresQuery(
        `INSERT INTO records
           (connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted, deleted_at, cursor_value, primary_key_text)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, FALSE, NULL, $4, $4)`,
        [connectorId, connectorInstanceId, stream, hotKey, JSON.stringify(hotData), '2026-05-26T12:00:00.000Z', hotVersion],
      );
      await postgresQuery(
        `INSERT INTO record_changes
           (connector_id, connector_instance_id, stream, record_key, version, record_json, emitted_at, deleted, deleted_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, FALSE, NULL)`,
        [connectorId, connectorInstanceId, stream, hotKey, hotVersion, JSON.stringify(hotData), '2026-05-26T12:00:00.000Z'],
      );
      // Cold key: current row at an old version, NO retained anchor (pruned).
      await postgresQuery(
        `INSERT INTO records
           (connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted, deleted_at, cursor_value, primary_key_text)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, 3, FALSE, NULL, $4, $4)`,
        [connectorId, connectorInstanceId, stream, coldKey, JSON.stringify(coldData), '2026-05-26T11:00:00.000Z'],
      );
      // Counter lags one behind the hot key's terminal.
      await postgresQuery(
        `INSERT INTO version_counter (connector_id, connector_instance_id, stream, max_version)
         VALUES ($1, $2, $3, $4)`,
        [connectorId, connectorInstanceId, stream, laggingCounter],
      );

      // Source resends cold's byte-identical payload → unanchored self-heal.
      const healed = await postgresIngestRecord(storageTarget, {
        stream, key: coldKey, data: coldData, op: 'upsert',
        emitted_at: '2026-05-26T11:00:00.000Z',
      });
      assert.equal(healed.changed, true, 'unanchored unchanged reingest self-heals (not a no-op)');
      assert.equal(healed.self_healed, true);

      // Cold re-anchored strictly above the hot key's terminal — not at
      // counter+1 (=== hotVersion), which would collide with hot's anchor.
      const coldVersion = await readCurrentVersion(connectorInstanceId, stream, coldKey);
      assert.equal(coldVersion, hotVersion + 1, 'cold re-anchored above the history floor');

      const anchor = await postgresQuery(
        `SELECT version FROM record_changes
          WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3`,
        [connectorInstanceId, stream, coldKey],
      );
      assert.equal(anchor.rows.length, 1, 'one fresh anchor for the cold key');
      assert.equal(Number(anchor.rows[0].version), hotVersion + 1);

      // Hot key's terminal anchor is untouched (no collision, no overwrite).
      const hotAnchor = await postgresQuery(
        `SELECT version FROM record_changes
          WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3`,
        [connectorInstanceId, stream, hotKey],
      );
      assert.equal(hotAnchor.rows.length, 1);
      assert.equal(Number(hotAnchor.rows[0].version), hotVersion);

      assert.equal(await readCounter(connectorInstanceId, stream), hotVersion + 1, 'counter cleared its lag');
    } finally {
      await cleanup(connectorInstanceId);
      await closePostgresStorage();
      closeDb();
    }
  });

  test('no-regression: in-sync counter still allocates monotonically by one', async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorId = `pg_floor_mono_${suffix}`;
    const connectorInstanceId = `cin_pg_floor_mono_${suffix}`;
    const stream = 'items';
    const recordKey = 'rec-1';

    initDb(':memory:');
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });

    try {
      const storageTarget = { connectorId, connectorInstanceId };
      const base = { id: recordKey, n: 0 };

      const first = await postgresIngestRecord(storageTarget, {
        stream, key: recordKey, data: base, op: 'upsert', emitted_at: '2026-05-26T12:00:00.000Z',
      });
      assert.equal(first.changed, true);
      assert.equal(await readCurrentVersion(connectorInstanceId, stream, recordKey), 1, 'first allocation is 1');

      const second = await postgresIngestRecord(storageTarget, {
        stream, key: recordKey, data: { ...base, n: 1 }, op: 'upsert', emitted_at: '2026-05-26T12:01:00.000Z',
      });
      assert.equal(second.changed, true);
      assert.equal(await readCurrentVersion(connectorInstanceId, stream, recordKey), 2, 'monotonic +1');

      const third = await postgresIngestRecord(storageTarget, {
        stream, key: recordKey, data: { ...base, n: 2 }, op: 'upsert', emitted_at: '2026-05-26T12:02:00.000Z',
      });
      assert.equal(third.changed, true);
      assert.equal(await readCurrentVersion(connectorInstanceId, stream, recordKey), 3, 'monotonic +1');

      assert.equal(await readCounter(connectorInstanceId, stream), 3);
      assert.equal(await readMaxChangeVersion(connectorInstanceId, stream), 3, 'history matches counter');
    } finally {
      await cleanup(connectorInstanceId);
      await closePostgresStorage();
      closeDb();
    }
  });
}
