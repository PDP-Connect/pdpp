// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Bounded-work oracle for polyfill manifest reconciliation — Postgres driver
 * (env-gated on `PDPP_TEST_POSTGRES_URL`).
 *
 * Production incident context: on 2026-07-17 a live deploy's manifest
 * reconciliation pass exceeded Docker's health budget (>8 minutes) because
 * byte-identical shipped manifests were wrongly treated as CHANGED on every
 * startup. `registerConnector` unconditionally re-runs
 * `postgresBackfillRecordSortPositionsForManifest`, which paginates every
 * record of every stream for every connector instance (256 rows/page) under
 * the per-instance writer fence — O(records), not O(connectors). Root cause:
 * `manifestsEqual` compared the raw shipped manifest file (long-form
 * `connector_id`, e.g. `https://registry.pdpp.org/connectors/amazon`)
 * against the PERSISTED row, which `registerConnector` always rewrites to
 * the short canonical key (`amazon`) before storing. Those two shapes can
 * never be byte-equal, so every first-party manifest reconciled as
 * "changed" on every single startup, forever. See
 * `normalizeForComparison` in `polyfill-manifest-reconcile.ts`.
 *
 * This oracle proves the fix holds at production-ish record scale: an
 * ordinary startup reconcile pass over an already-registered, unchanged
 * connector with thousands of persisted records issues ZERO SQL statements
 * against the `records` table (the backfill pagination is the O(records)
 * cost; skipping it is the whole point of detecting "unchanged" correctly).
 * It measures Postgres query COUNT, not wall-clock, and is non-vacuous: with
 * the fix reverted (comparing raw shipped bytes instead of the
 * normalized-for-storage shape), this test fails because the backfill
 * pagination loop runs and issues real `records` queries.
 *
 * Target for local runs:
 *   docker run -d --name pg-pilot -p 55463:5432 \
 *     -e POSTGRES_USER=pdpp -e POSTGRES_PASSWORD=pdpp \
 *     -e POSTGRES_DB=pdpp_pilot \
 *     pgvector/pgvector:pg16
 *   PDPP_TEST_POSTGRES_URL=postgres://pdpp:pdpp@localhost:55463/pdpp_pilot \
 *     node --import tsx --test test/polyfill-manifest-reconcile-bounded-work-postgres.test.js
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { closeDb, initDb } from '../server/db.js';
import { registerConnector } from '../server/auth.js';
import {
  closePostgresStorage,
  getPostgresPool,
  initPostgresStorage,
  postgresQuery,
} from '../server/postgres-storage.js';
import { reconcilePolyfillManifests } from '../server/polyfill-manifest-reconcile.ts';

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

if (!POSTGRES_URL) {
  test('manifest-reconcile bounded-work oracle (skipped: PDPP_TEST_POSTGRES_URL unset)', { skip: true }, () => {});
} else {
  const CONNECTOR_ID = 'amazon';
  const CONNECTOR_INSTANCE_ID = `cin_bounded_work_${Date.now()}`;
  // Production-scale: several multiples of the 256-row pagination window
  // across two streams, so an unbounded fix would issue dozens of SELECT +
  // UPDATE round-trips instead of zero.
  const RECORDS_PER_STREAM = 1200;

  function shippedAmazonManifest() {
    return {
      protocol_version: '0.1.0',
      connector_id: `https://registry.pdpp.org/connectors/${CONNECTOR_ID}`,
      connector_key: CONNECTOR_ID,
      manifest_uri: `https://registry.pdpp.org/connectors/${CONNECTOR_ID}`,
      version: '1.0.0',
      display_name: 'Amazon',
      runtime_requirements: { bindings: { network: { required: true } } },
      streams: [
        {
          name: 'orders',
          semantics: 'mutable_state',
          schema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              order_date: { type: 'string', format: 'date-time' },
            },
            required: ['id', 'order_date'],
          },
          primary_key: ['id'],
          cursor_field: 'order_date',
          selection: { fields: true, resources: true },
        },
        {
          name: 'order_items',
          semantics: 'mutable_state',
          schema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              order_date: { type: 'string', format: 'date-time' },
            },
            required: ['id', 'order_date'],
          },
          primary_key: ['id'],
          cursor_field: 'order_date',
          selection: { fields: true, resources: true },
        },
      ],
    };
  }

  async function seedRecords(stream, count) {
    const rows = [];
    for (let i = 0; i < count; i += 1) {
      const id = `${stream}-${String(i).padStart(6, '0')}`;
      const emittedAt = new Date(2026, 0, 1, 0, 0, i).toISOString();
      rows.push({ id, emittedAt });
    }
    // Batch-insert in chunks so seeding itself stays fast; this is setup,
    // not part of the measured reconcile pass.
    const CHUNK = 500;
    for (let start = 0; start < rows.length; start += CHUNK) {
      const chunk = rows.slice(start, start + CHUNK);
      const values = [];
      const params = [];
      chunk.forEach((row, idx) => {
        const base = idx * 9;
        values.push(
          `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::jsonb, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`
        );
        params.push(
          CONNECTOR_ID,
          CONNECTOR_INSTANCE_ID,
          stream,
          row.id,
          JSON.stringify({ id: row.id, order_date: row.emittedAt }),
          row.emittedAt,
          row.emittedAt,
          row.emittedAt,
          row.id
        );
      });
      await postgresQuery(
        `INSERT INTO records(
           connector_id, connector_instance_id, stream, record_key, record_json,
           emitted_at, semantic_time, cursor_value, primary_key_text
         ) VALUES ${values.join(', ')}`,
        params
      );
    }
  }

  function countPostgresQueries() {
    const pool = getPostgresPool();
    const original = pool.query.bind(pool);
    let count = 0;
    const recordsStatements = [];
    pool.query = (...args) => {
      count += 1;
      const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text;
      if (typeof sql === 'string' && /\bFROM\s+records\b|\bUPDATE\s+records\b/i.test(sql)) {
        recordsStatements.push(sql.trim().slice(0, 120));
      }
      return original(...args);
    };
    return {
      restore: () => {
        pool.query = original;
      },
      total: () => count,
      recordsStatements: () => recordsStatements.slice(),
    };
  }

  test('reconciling an unchanged, already-registered manifest issues zero records-table queries at production-ish scale', async () => {
    initDb(':memory:');
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });
    const dir = mkdtempSync(join(tmpdir(), 'pdpp-bounded-work-'));
    try {
      const shipped = shippedAmazonManifest();

      // 1. Ordinary first registration (as reconciliation would do on a
      //    fresh DB, or as the operator flow does on connect).
      await registerConnector(shipped, { backfillRetrievalIndexes: false });

      // 2. Seed production-ish record volume across both streams — the
      //    exact records the unbounded backfill would paginate through.
      await seedRecords('orders', RECORDS_PER_STREAM);
      await seedRecords('order_items', RECORDS_PER_STREAM);

      const totalRecords = RECORDS_PER_STREAM * 2;
      assert.equal(
        (await postgresQuery('SELECT COUNT(*) AS n FROM records WHERE connector_id = $1', [CONNECTOR_ID])).rows[0].n,
        String(totalRecords),
        'baseline: production-ish record volume seeded'
      );

      // 3. Ship the BYTE-IDENTICAL manifest (same shape reconciliation reads
      //    from disk on ordinary startup) and reconcile.
      const manifestsDir = join(dir, 'manifests');
      mkdirSync(manifestsDir, { recursive: true });
      writeFileSync(join(manifestsDir, 'amazon.json'), JSON.stringify(shippedAmazonManifest(), null, 2));
      const referenceFixturesDir = join(dir, 'reference');
      mkdirSync(referenceFixturesDir, { recursive: true });

      const spy = countPostgresQueries();
      let summary;
      try {
        summary = await reconcilePolyfillManifests({
          enabled: true,
          manifestsDir,
          referenceFixturesDir,
          log: () => {},
        });
      } finally {
        spy.restore();
      }

      assert.equal(summary.scanned, 1);
      assert.equal(summary.unchanged, 1, 'reconciliation must detect the byte-identical manifest as unchanged');
      assert.equal(summary.updated, 0, 'an unchanged manifest must not trigger re-registration');
      assert.equal(summary.errors, 0);

      // The bounded-work assertion: NO queries against `records` at all.
      // The backfill pagination issues a SELECT + conditional UPDATE per
      // 256-row page per stream per connector instance; at 1200 rows/stream
      // × 2 streams that is >=10 page-reads if it ran at all. Zero proves
      // the expensive path was skipped entirely, not merely fast.
      assert.deepEqual(
        spy.recordsStatements(),
        [],
        `expected zero queries against the records table, got: ${JSON.stringify(spy.recordsStatements())}`
      );
    } finally {
      await postgresQuery('DELETE FROM records WHERE connector_id = $1', [CONNECTOR_ID]).catch(() => {});
      await postgresQuery('DELETE FROM connectors WHERE connector_id = $1', [CONNECTOR_ID]).catch(() => {});
      rmSync(dir, { recursive: true, force: true });
      await closePostgresStorage();
      closeDb();
    }
  });
}
