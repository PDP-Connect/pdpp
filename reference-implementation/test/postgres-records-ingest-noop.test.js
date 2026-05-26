/**
 * Regression test for the Postgres-backed `records` ingest no-op detection.
 *
 * Asserts that two successive byte-identical `postgresIngestRecord` calls
 * for the same `(connector_id, stream, record_key)` triple allocate at
 * most one version and append at most one `record_changes` row — and that
 * the second call returns `{ accepted: true, changed: false }`.
 *
 * The bug this guards: parsing jsonb back to a JS object reorders keys
 * to match Postgres' internal storage, and `JSON.stringify` of the parsed
 * object never round-trips to the bytes the connector sent. The fix
 * compares structurally at the jsonb level so layout differences are
 * ignored.
 *
 * Env gate: PDPP_TEST_POSTGRES_URL must be set (Compose Postgres proof
 * service). The test creates a uniquely-named connector_instance_id so
 * concurrent runs do not collide on the shared schema.
 *
 * Spec: openspec/changes/repair-record-version-noop-detection/specs/
 *       reference-implementation-architecture/spec.md
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { closeDb, initDb } from '../server/db.js';
import {
  postgresIngestRecord,
} from '../server/postgres-records.js';
import {
  closePostgresStorage,
  initPostgresStorage,
  postgresQuery,
} from '../server/postgres-storage.js';

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

if (!POSTGRES_URL) {
  test('postgres records ingest no-op suppression (skipped: PDPP_TEST_POSTGRES_URL unset)', {
    skip: true,
  }, () => {});
} else {
  test('postgres byte-identical re-ingest does not allocate a new version', async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorId = `pg_noop_${suffix}`;
    const connectorInstanceId = `cin_pg_noop_${suffix}`;
    const stream = 'items';
    const recordKey = 'rec-1';

    initDb(':memory:');
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });

    try {
      // Seed the connector reference so the FK on connector_instances (if any)
      // does not block insertion. records table has no FK on connector_id,
      // but version_counter/record_changes share the same set of columns.
      const storageTarget = { connectorId, connectorInstanceId };
      const data = {
        // Choose key order so `JSON.stringify(data)` is in JS source order;
        // postgres' jsonb storage will canonicalize whitespace and key
        // order independently. The naive comparison from before this fix
        // was always false here.
        id: recordKey,
        name: 'Workspace',
        url: 'https://example.com/',
        domain: null,
        icon_url: null,
        fetched_at: '2026-05-26T12:00:00.000Z',
        email_domain: null,
        enterprise_id: null,
        enterprise_name: null,
      };

      const first = await postgresIngestRecord(storageTarget, {
        stream,
        key: recordKey,
        data,
        op: 'upsert',
        emitted_at: '2026-05-26T12:00:00.000Z',
      });
      assert.equal(first.accepted, true);
      assert.equal(first.changed, true, 'first ingest must register as changed');

      const second = await postgresIngestRecord(storageTarget, {
        stream,
        key: recordKey,
        data,
        op: 'upsert',
        emitted_at: '2026-05-26T12:00:00.000Z',
      });
      assert.equal(second.accepted, true);
      assert.equal(
        second.changed,
        false,
        'second byte-identical ingest must be suppressed as a no-op',
      );

      const counter = await postgresQuery(
        `SELECT max_version FROM version_counter
         WHERE connector_instance_id = $1 AND stream = $2`,
        [connectorInstanceId, stream],
      );
      assert.equal(
        Number(counter.rows[0]?.max_version || 0),
        1,
        'version_counter must not advance for a no-op re-ingest',
      );

      const changes = await postgresQuery(
        `SELECT COUNT(*)::int AS count FROM record_changes
         WHERE connector_instance_id = $1 AND stream = $2`,
        [connectorInstanceId, stream],
      );
      assert.equal(
        Number(changes.rows[0]?.count || 0),
        1,
        'record_changes must not gain a row for a no-op re-ingest',
      );

      // A third call with a semantically changed payload must still allocate.
      const third = await postgresIngestRecord(storageTarget, {
        stream,
        key: recordKey,
        data: { ...data, name: 'Workspace 2' },
        op: 'upsert',
        emitted_at: '2026-05-26T12:00:00.000Z',
      });
      assert.equal(third.changed, true, 'semantically changed write must allocate');

      const counterAfter = await postgresQuery(
        `SELECT max_version FROM version_counter
         WHERE connector_instance_id = $1 AND stream = $2`,
        [connectorInstanceId, stream],
      );
      assert.equal(
        Number(counterAfter.rows[0]?.max_version || 0),
        2,
        'version_counter advances exactly once for the changed write',
      );
    } finally {
      // Cleanup: drop rows for this test's unique instance id so the
      // shared schema does not accumulate test detritus.
      try {
        await postgresQuery(
          `DELETE FROM record_changes WHERE connector_instance_id = $1`,
          [connectorInstanceId],
        );
        await postgresQuery(
          `DELETE FROM records WHERE connector_instance_id = $1`,
          [connectorInstanceId],
        );
        await postgresQuery(
          `DELETE FROM version_counter WHERE connector_instance_id = $1`,
          [connectorInstanceId],
        );
      } catch {}
      await closePostgresStorage();
      closeDb();
    }
  });

  test('postgres re-ingest with whitespace-differing payload still suppressed (jsonb structural equality)', async () => {
    // This pins the equivalence behavior: incoming JSON.stringify produces
    // no whitespace; postgres stores jsonb that round-trips to text with
    // whitespace. Structural equality must ignore that difference.
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorId = `pg_noop_ws_${suffix}`;
    const connectorInstanceId = `cin_pg_noop_ws_${suffix}`;
    const stream = 'items';
    const recordKey = 'rec-1';

    initDb(':memory:');
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });

    try {
      const storageTarget = { connectorId, connectorInstanceId };
      const data = { id: recordKey, a: 1, b: 2, c: null };

      const first = await postgresIngestRecord(storageTarget, {
        stream, key: recordKey, data, op: 'upsert',
        emitted_at: '2026-05-26T12:00:00.000Z',
      });
      assert.equal(first.changed, true);

      // Re-ingest the *same* data — JS may serialize in the same order,
      // but the comparison happens against postgres' stored jsonb form
      // which may differ. Either way, structural equality must catch this.
      const second = await postgresIngestRecord(storageTarget, {
        stream, key: recordKey, data, op: 'upsert',
        emitted_at: '2026-05-26T12:00:00.000Z',
      });
      assert.equal(second.changed, false);

      // Re-ingest with explicitly reordered keys (semantically identical).
      const reordered = { c: null, b: 2, a: 1, id: recordKey };
      const third = await postgresIngestRecord(storageTarget, {
        stream, key: recordKey, data: reordered, op: 'upsert',
        emitted_at: '2026-05-26T12:00:00.000Z',
      });
      assert.equal(
        third.changed,
        false,
        'reordered-key payload that is structurally equal must be a no-op',
      );

      // Sanity: counter still at 1.
      const counter = await postgresQuery(
        `SELECT max_version FROM version_counter
         WHERE connector_instance_id = $1 AND stream = $2`,
        [connectorInstanceId, stream],
      );
      assert.equal(Number(counter.rows[0]?.max_version || 0), 1);
    } finally {
      try {
        await postgresQuery(`DELETE FROM record_changes WHERE connector_instance_id = $1`, [connectorInstanceId]);
        await postgresQuery(`DELETE FROM records WHERE connector_instance_id = $1`, [connectorInstanceId]);
        await postgresQuery(`DELETE FROM version_counter WHERE connector_instance_id = $1`, [connectorInstanceId]);
      } catch {}
      await closePostgresStorage();
      closeDb();
    }
  });
}
