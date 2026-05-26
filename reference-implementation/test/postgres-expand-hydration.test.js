/**
 * Postgres expand hydration parity tests (env-gated).
 *
 * Verifies that the Postgres records backend implements the same
 * grant-scoped one-hop parent → child relationship expansion contract
 * the SQLite backend implements in `records.js#hydrateExpandedRelations`.
 *
 * Environment gate:
 *   - When `PDPP_TEST_POSTGRES_URL` is set, each scenario provisions a
 *     fresh Postgres database/schema state via `initPostgresStorage` /
 *     `closePostgresStorage` and exercises the public
 *     `queryRecords` / `getRecord` API end-to-end against Postgres.
 *   - When unset, this file registers one skipped test so the suite
 *     still acknowledges the proof exists.
 *
 * Spec: openspec/changes/add-postgres-expand-hydration/specs/
 *       reference-implementation-architecture/spec.md
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { initDb, closeDb } from '../server/db.js';
import { registerConnector } from '../server/auth.js';
import {
  closePostgresStorage,
  initPostgresStorage,
  isPostgresStorageBackend,
  postgresQuery,
} from '../server/postgres-storage.js';
import {
  getRecord,
  ingestRecord,
  queryRecords,
} from '../server/records.js';

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

if (!POSTGRES_URL) {
  test('postgres expand hydration parity (skipped: PDPP_TEST_POSTGRES_URL unset)', { skip: true }, () => {});
} else {
  test('postgres expand hydration parity', async (t) => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorId = `pg_expand_${suffix}`;
    const parentStream = 'saved_tracks';
    const childStream = 'recently_played';

    const manifest = {
      protocol_version: '0.1.0',
      connector_id: connectorId,
      version: '1.0.0',
      display_name: 'Postgres Expand Hydration Test',
      capabilities: { human_interaction: [] },
      streams: [
        {
          name: parentStream,
          primary_key: ['id'],
          cursor_field: 'saved_at',
          consent_time_field: 'saved_at',
          selection: { fields: true, resources: false },
          schema: {
            type: 'object',
            required: ['id'],
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              saved_at: { type: 'string', format: 'date-time' },
            },
          },
          relationships: [
            {
              name: 'recently_played',
              stream: childStream,
              foreign_key: 'track_id',
              cardinality: 'has_many',
            },
          ],
          query: {
            expand: [
              { name: 'recently_played', default_limit: 10, max_limit: 50 },
            ],
          },
        },
        {
          name: childStream,
          primary_key: ['id'],
          cursor_field: 'played_at',
          consent_time_field: 'played_at',
          selection: { fields: true, resources: false },
          schema: {
            type: 'object',
            required: ['id', 'track_id'],
            properties: {
              id: { type: 'string' },
              track_id: { type: 'string' },
              track_name: { type: 'string' },
              played_at: { type: 'string', format: 'date-time' },
            },
          },
        },
      ],
    };

    const grantWithChild = {
      streams: [
        { name: parentStream, fields: ['id', 'name', 'saved_at'] },
        { name: childStream, fields: ['id', 'track_id', 'played_at'] },
      ],
    };

    const grantWithoutChild = {
      streams: [
        { name: parentStream, fields: ['id', 'name', 'saved_at'] },
      ],
    };

    initDb(':memory:');
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });

    t.after(async () => {
      // Clean up our records / record_changes / version_counter rows for
      // this connector so parallel runs don't leak. We do not drop schema
      // because other suites may share the connection.
      try {
        await postgresQuery(
          `DELETE FROM record_changes WHERE connector_id = $1;
           DELETE FROM records WHERE connector_id = $1;
           DELETE FROM version_counter WHERE connector_id = $1;
           DELETE FROM connector_instances WHERE connector_id = $1;
           DELETE FROM connectors WHERE connector_id = $1;`,
          [connectorId],
        );
      } catch {}
      await closePostgresStorage();
      closeDb();
    });

    await registerConnector(manifest);

    await ingestRecord(connectorId, {
      stream: parentStream,
      key: 'track_1',
      data: {
        id: 'track_1',
        name: 'Track 1',
        saved_at: '2026-02-01T00:00:00Z',
      },
    });
    await ingestRecord(connectorId, {
      stream: parentStream,
      key: 'track_2',
      data: {
        id: 'track_2',
        name: 'Track 2',
        saved_at: '2026-02-02T00:00:00Z',
      },
    });
    for (const play of [
      { id: 'play_1', track_id: 'track_1', track_name: 'Track 1', played_at: '2026-02-02T00:00:00Z' },
      { id: 'play_2', track_id: 'track_1', track_name: 'Track 1', played_at: '2026-02-03T00:00:00Z' },
      { id: 'play_3', track_id: 'track_1', track_name: 'Track 1', played_at: '2026-02-04T00:00:00Z' },
      { id: 'play_4', track_id: 'track_2', track_name: 'Track 2', played_at: '2026-02-05T00:00:00Z' },
    ]) {
      await ingestRecord(connectorId, { stream: childStream, key: play.id, data: play });
    }

    await t.test('Postgres backend is active for these assertions', () => {
      assert.equal(isPostgresStorageBackend(), true, 'Postgres backend should be active');
    });

    await t.test('list endpoint hydrates has_many with per-parent has_more and child grant projection', async () => {
      const result = await queryRecords(
        connectorId,
        parentStream,
        grantWithChild,
        { expand: 'recently_played', expand_limit: { recently_played: 1 }, order: 'asc' },
        manifest,
      );
      assert.equal(result.object, 'list');
      assert.equal(result.data.length, 2);
      const track1 = result.data.find((row) => row.id === 'track_1');
      assert.ok(track1?.expanded?.recently_played, 'expanded.recently_played should exist on track_1');
      assert.equal(track1.expanded.recently_played.object, 'list');
      assert.equal(track1.expanded.recently_played.has_more, true);
      assert.equal(track1.expanded.recently_played.data.length, 1);
      const child = track1.expanded.recently_played.data[0];
      assert.equal(child.id, 'play_1');
      assert.deepEqual(Object.keys(child.data || {}).sort(), ['id', 'played_at', 'track_id']);
      assert.ok(!('track_name' in (child.data || {})));

      const track2 = result.data.find((row) => row.id === 'track_2');
      assert.equal(track2.expanded.recently_played.has_more, false);
      assert.equal(track2.expanded.recently_played.data.length, 1);
      assert.equal(track2.expanded.recently_played.data[0].id, 'play_4');
    });

    await t.test('list endpoint hydrates the default limit when expand_limit is omitted', async () => {
      const result = await queryRecords(
        connectorId,
        parentStream,
        grantWithChild,
        { expand: 'recently_played', order: 'asc' },
        manifest,
      );
      const track1 = result.data.find((row) => row.id === 'track_1');
      // 3 children for track_1, default_limit=10, so all 3 fit without has_more.
      assert.equal(track1.expanded.recently_played.data.length, 3);
      assert.equal(track1.expanded.recently_played.has_more, false);
      assert.deepEqual(
        track1.expanded.recently_played.data.map((c) => c.id),
        ['play_1', 'play_2', 'play_3'],
      );
    });

    await t.test('detail endpoint hydrates the same expansion shape', async () => {
      const detail = await getRecord(
        connectorId,
        parentStream,
        'track_1',
        grantWithChild,
        manifest,
        { expand: 'recently_played', expand_limit: { recently_played: 2 } },
      );
      assert.equal(detail.id, 'track_1');
      assert.ok(detail.expanded?.recently_played);
      assert.equal(detail.expanded.recently_played.has_more, true);
      assert.equal(detail.expanded.recently_played.data.length, 2);
      assert.deepEqual(
        detail.expanded.recently_played.data.map((c) => c.id),
        ['play_1', 'play_2'],
      );
    });

    await t.test('insufficient_scope when child stream is not in grant', async () => {
      await assert.rejects(
        () => queryRecords(
          connectorId,
          parentStream,
          grantWithoutChild,
          { expand: 'recently_played' },
          manifest,
        ),
        (err) => err.code === 'insufficient_scope',
      );
    });

    await t.test('invalid_expand on unsupported relation', async () => {
      await assert.rejects(
        () => queryRecords(
          connectorId,
          parentStream,
          grantWithChild,
          { expand: 'not_a_relation' },
          manifest,
        ),
        (err) => err.code === 'invalid_expand',
      );
    });

    await t.test('invalid_expand when combined with changes_since', async () => {
      await assert.rejects(
        () => queryRecords(
          connectorId,
          parentStream,
          grantWithChild,
          { expand: 'recently_played', changes_since: 'beginning' },
          manifest,
        ),
        (err) => err.code === 'invalid_expand',
      );
    });

    await t.test('invalid_expand when expand_limit exceeds max_limit', async () => {
      await assert.rejects(
        () => queryRecords(
          connectorId,
          parentStream,
          grantWithChild,
          { expand: 'recently_played', expand_limit: { recently_played: 9999 } },
          manifest,
        ),
        (err) => err.code === 'invalid_expand',
      );
    });

    await t.test('cross-connector-instance isolation: children from another instance are not visible', async () => {
      const otherInstance = {
        connector_id: connectorId,
        connector_instance_id: `cin_${suffix}_isolation`,
      };
      // Seed a play row in a different connector instance that points to
      // the same parent FK. It must NOT appear in the expansion.
      await ingestRecord(otherInstance, {
        stream: childStream,
        key: 'play_iso',
        data: {
          id: 'play_iso',
          track_id: 'track_1',
          track_name: 'Cross instance leak',
          played_at: '2026-02-06T00:00:00Z',
        },
      });

      const result = await queryRecords(
        connectorId,
        parentStream,
        grantWithChild,
        { expand: 'recently_played', order: 'asc' },
        manifest,
      );
      const track1 = result.data.find((row) => row.id === 'track_1');
      assert.equal(track1.expanded.recently_played.data.length, 3);
      assert.ok(
        track1.expanded.recently_played.data.every((c) => c.id !== 'play_iso'),
        'cross-connector-instance child must not leak into expansion',
      );
    });
  });
}
