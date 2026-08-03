/**
 * `listStreams` grant-scoping parity: SQLite vs Postgres (env-gated).
 *
 * Confirmed P1: `postgresListStreams` (server/postgres-records.js) returned
 * `record_count` / `last_updated` straight from `postgresListAllStreams` --
 * the connection's RAW UNSCOPED totals -- without ever applying the stream
 * grant's `resources` allowlist or `time_range` (via `buildEffectiveFilter` +
 * `passesTimeRange` against the manifest's `consent_time_field`). The SQLite
 * counterpart `listStreams` (server/records.js) applies both. A client
 * holding a narrow grant could call stream discovery on Postgres and learn
 * the connection's TRUE total record count and freshness -- data outside its
 * grant. This is a metadata/existence leak (record *content* stayed
 * correctly scoped via `postgresQueryRecords`).
 *
 * This test seeds the SAME records into both a SQLite (`:memory:`) store and
 * a live Postgres store, then asserts that `listStreams` (dispatches to
 * `postgresListStreams` when the Postgres backend is active) returns
 * IDENTICAL `record_count` / `last_updated` for:
 *   - a grant narrowed by `resources` (subset of stream records)
 *   - a grant narrowed by `time_range` (subset by consent_time_field)
 * and that both counts are the SCOPED count, not the connection's raw total.
 *
 * Environment gate:
 *   - When `PDPP_TEST_POSTGRES_URL` is set, this test provisions Postgres
 *     storage via `initPostgresStorage` (which bootstraps its own schema)
 *     alongside an in-memory SQLite store and compares both backends.
 *   - When unset, this file registers one skipped test so the suite still
 *     acknowledges the proof exists.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { initDb, closeDb } from '../server/db.ts';
import { registerConnector } from '../server/auth.ts';
import {
  closePostgresStorage,
  initPostgresStorage,
  isPostgresStorageBackend,
  postgresQuery,
} from '../server/postgres-storage.ts';
import { ingestRecord, listStreams } from '../server/records.ts';

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

if (!POSTGRES_URL) {
  test('listStreams grant-scope parity (skipped: PDPP_TEST_POSTGRES_URL unset)', { skip: true }, () => {});
} else {
  test('listStreams grant-scope parity: SQLite vs Postgres', async (t) => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorId = `streamscope_${suffix}`;
    const stream = 'orders';

    const manifest = {
      protocol_version: '0.1.0',
      connector_id: connectorId,
      version: '1.0.0',
      display_name: 'Stream Scope Parity Test',
      capabilities: { human_interaction: [] },
      streams: [
        {
          name: stream,
          primary_key: ['id'],
          cursor_field: 'placed_at',
          consent_time_field: 'placed_at',
          selection: { fields: true, resources: true },
          schema: {
            type: 'object',
            required: ['id'],
            properties: {
              id: { type: 'string' },
              placed_at: { type: 'string', format: 'date-time' },
              amount: { type: 'number' },
            },
          },
        },
      ],
    };

    // 5 records spread across time; only 2 fall inside the narrow time_range
    // grant below, and only 2 are named by the resources grant below -- the
    // two subsets are deliberately different records so a bug that returns
    // the raw total (5) is unambiguously distinguishable from either scoped
    // count (2). `placed_at` doubles as the ingest-level `emitted_at` (passed
    // explicitly at each `ingestRecord` call below, rather than left to
    // default to ingest wall-clock time) so the SQLite pass and the Postgres
    // pass -- which ingest at different real times -- produce byte-identical
    // `last_updated` values for a true backend-parity comparison.
    const records = [
      { id: 'order_1', placed_at: '2026-01-01T00:00:00Z', amount: 10 },
      { id: 'order_2', placed_at: '2026-01-05T00:00:00Z', amount: 20 },
      { id: 'order_3', placed_at: '2026-02-10T00:00:00Z', amount: 30 },
      { id: 'order_4', placed_at: '2026-02-15T00:00:00Z', amount: 40 },
      { id: 'order_5', placed_at: '2026-03-20T00:00:00Z', amount: 50 },
    ];

    const grantResourcesSubset = {
      streams: [
        { name: stream, fields: ['id', 'placed_at', 'amount'], resources: ['order_2', 'order_4'] },
      ],
    };

    const grantTimeRange = {
      streams: [
        {
          name: stream,
          fields: ['id', 'placed_at', 'amount'],
          time_range: { since: '2026-02-01T00:00:00Z', until: '2026-03-01T00:00:00Z' },
        },
      ],
    };

    const grantFull = {
      streams: [{ name: stream, fields: ['id', 'placed_at', 'amount'] }],
    };

    // --- SQLite pass ---
    initDb(':memory:');
    await registerConnector(manifest);
    for (const r of records) {
      await ingestRecord(connectorId, { stream, key: r.id, data: r, emitted_at: r.placed_at });
    }
    const sqliteResourcesResult = await listStreams(connectorId, grantResourcesSubset, manifest);
    const sqliteTimeRangeResult = await listStreams(connectorId, grantTimeRange, manifest);
    const sqliteFullResult = await listStreams(connectorId, grantFull, manifest);
    closeDb();

    // --- Postgres pass ---
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });
    t.after(async () => {
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
    });

    await registerConnector(manifest);
    for (const r of records) {
      await ingestRecord(connectorId, { stream, key: r.id, data: r, emitted_at: r.placed_at });
    }

    await t.test('Postgres backend is active for these assertions', () => {
      assert.equal(isPostgresStorageBackend(), true, 'Postgres backend should be active');
    });

    const pgResourcesResult = await listStreams(connectorId, grantResourcesSubset, manifest);
    const pgTimeRangeResult = await listStreams(connectorId, grantTimeRange, manifest);
    const pgFullResult = await listStreams(connectorId, grantFull, manifest);

    await t.test('raw connection total is 5 (sanity check on seed data)', () => {
      assert.equal(sqliteFullResult[0].record_count, 5);
      assert.equal(pgFullResult[0].record_count, 5);
    });

    await t.test('resources-subset grant: Postgres matches SQLite and is the SCOPED count, not the raw total', () => {
      assert.equal(sqliteResourcesResult[0].record_count, 2, 'SQLite must return the scoped count (2), not the raw total (5)');
      assert.equal(
        pgResourcesResult[0].record_count,
        sqliteResourcesResult[0].record_count,
        'Postgres record_count must match SQLite for a resources-narrowed grant',
      );
      assert.notEqual(pgResourcesResult[0].record_count, 5, 'Postgres must not leak the connection raw total (5) under a narrow resources grant');
      assert.equal(
        pgResourcesResult[0].last_updated,
        sqliteResourcesResult[0].last_updated,
        'Postgres last_updated must match SQLite (scoped freshness, not the raw connection freshness)',
      );
    });

    await t.test('time_range grant: Postgres matches SQLite and is the SCOPED count, not the raw total', () => {
      assert.equal(sqliteTimeRangeResult[0].record_count, 2, 'SQLite must return the scoped count (2), not the raw total (5)');
      assert.equal(
        pgTimeRangeResult[0].record_count,
        sqliteTimeRangeResult[0].record_count,
        'Postgres record_count must match SQLite for a time_range-narrowed grant',
      );
      assert.notEqual(pgTimeRangeResult[0].record_count, 5, 'Postgres must not leak the connection raw total (5) under a narrow time_range grant');
      assert.equal(
        pgTimeRangeResult[0].last_updated,
        sqliteTimeRangeResult[0].last_updated,
        'Postgres last_updated must match SQLite (scoped freshness, not the raw connection freshness)',
      );
    });
  });
}
