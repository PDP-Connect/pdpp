/**
 * OpenSpec task 6.1 (openspec/changes/reconcile-active-summary-evidence
 * design.md "Acceptance Strategy"): production-entry-point proof that
 * connector-wide invalidation and manifest/backfill registration ordering
 * preserve BOTH throughput fencing (already proven independently by
 * `record-reset-generation-checkpoint.test.js` and
 * `device-ingest-conformance.test.js`'s `runManifestRegistrationOracle`) AND
 * summary convergence — the two named cases in task 6.1's list that were not
 * yet directly asserted against `connector_summary_evidence`.
 *
 * `test/record-reset-generation-checkpoint.test.js` exercises
 * `deleteAllRecordsForConnector` and proves the reset-generation checkpoint
 * mechanics, but never asserts the summary primitive actually converges
 * afterward. `device-ingest-conformance.test.js`'s manifest-registration
 * oracle proves durable-prefix/registration ordering at the device-driver
 * layer, but likewise never touches `connector_summary_evidence`. This file
 * closes exactly that gap using the real production entry points
 * (`deleteAllRecordsForConnector`, `registerConnector`, `ingestRecord`),
 * which internally take the same `withConnectorInstanceWrite` fence every
 * other production write path uses — no bypass.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { registerConnector } from '../server/auth.js';
import { closeDb, getDb, initDb } from '../server/db.js';
import { reconcileConnectorSummaryEvidence } from '../server/connector-summary-evidence-engine.ts';
import { deleteAllRecordsForConnector, ingestRecord } from '../server/records.js';
import { closePostgresStorage, initPostgresStorage, postgresQuery } from '../server/postgres-storage.js';
import { dedicatedPostgresTestUrl } from './helpers/dedicated-postgres-test-url.js';

const OWNER = 'owner_local';
const NOW = '2026-07-17T00:00:00.000Z';
const DEDICATED_POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);

async function withTempDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'pdpp-summary-throughput-'));
  try {
    initDb(join(dir, 'pdpp.sqlite'));
    return await fn();
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
}

// `registerConnector` (server/auth.js's `normalizeConnectorManifestForStorage`)
// derives the stored connector_key from `canonicalConnectorKeyFromManifest`,
// which only canonicalizes known first-party registry URLs and falls back to
// the raw `connector_id` otherwise — an arbitrary test URL then fails
// `isConnectorKey`'s "not a URL" check on the next read-time re-validation.
// A slug-shaped `connector_key` plus `manifest_uri` (the registry/document
// provenance) is the real production shape for a non-first-party connector.
function manifestFor(connectorKey, streams) {
  return {
    protocol_version: '0.1.0',
    connector_id: connectorKey,
    connector_key: connectorKey,
    manifest_uri: `https://test.pdpp.dev/connectors/${connectorKey}`,
    version: '1.0.0',
    display_name: connectorKey,
    capabilities: {
      public_listing: { listed: true, status: 'test' },
    },
    streams: streams.map((name) => ({
      name,
      primary_key: ['id'],
      coverage_strategy: 'full_inventory',
      schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    })),
  };
}

function seedInstance(connectorInstanceId, connectorId) {
  getDb()
    .prepare(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       ) VALUES (?, ?, ?, ?, 'active', 'account', ?, '{}', ?, ?, NULL)`,
    )
    .run(connectorInstanceId, OWNER, connectorId, connectorId, connectorInstanceId, NOW, NOW);
}

async function seedInstancePostgres(connectorInstanceId, connectorId) {
  await postgresQuery(
    `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
     ) VALUES ($1, $2, $3, $4, 'active', 'account', $1, '{}'::jsonb, $5, $5, NULL)`,
    [connectorInstanceId, OWNER, connectorId, connectorId, NOW],
  );
}

function databaseUrl(url, name) {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

function adminUrl(url) {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

let uniquePgDb = 0;

/**
 * Provision and tear down a real disposable PostgreSQL database, matching
 * the pattern `device-ingest-conformance.test.js` and
 * `reconcile-active-summary-evidence-oracle.test.js`'s Postgres-gated test
 * both use: a fresh database per test run against the dedicated
 * loopback-only test listener, dropped again on the way out.
 */
async function withTemporaryPostgres(fn) {
  const pg = await import('pg');
  const { Pool } = pg.default;
  uniquePgDb += 1;
  const admin = new Pool({ connectionString: adminUrl(DEDICATED_POSTGRES_URL) });
  const database = `pdpp_summary_throughput_${process.pid}_${Date.now()}_${uniquePgDb}`;
  await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
  await admin.query(`CREATE DATABASE "${database}"`);
  try {
    await initPostgresStorage({ backend: 'postgres', databaseUrl: databaseUrl(DEDICATED_POSTGRES_URL, database) });
    await fn();
  } finally {
    await closePostgresStorage().catch(() => undefined);
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [database],
    ).catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${database}"`).catch(() => undefined);
    await admin.end();
  }
}

function storageTargetFor(connectorId, connectorInstanceId) {
  return { connector_id: connectorId, connector_instance_id: connectorInstanceId };
}

test('connector-wide invalidation (deleteAllRecordsForConnector) is detected and repaired by the summary primitive without a per-record dirty hook', () =>
  withTempDb(async () => {
    const connectorId = await registerConnector(manifestFor('connector-invalidation', ['messages']), {
      backfillRetrievalIndexes: false,
    });
    seedInstance('cin_invalidation_a', connectorId);
    seedInstance('cin_invalidation_b', connectorId);

    const targetA = storageTargetFor(connectorId, 'cin_invalidation_a');
    const targetB = storageTargetFor(connectorId, 'cin_invalidation_b');
    await ingestRecord(targetA, { stream: 'messages', key: 'a_1', data: { id: 'a_1' }, emitted_at: NOW });
    await ingestRecord(targetA, { stream: 'messages', key: 'a_2', data: { id: 'a_2' }, emitted_at: NOW });
    await ingestRecord(targetB, { stream: 'messages', key: 'b_1', data: { id: 'b_1' }, emitted_at: NOW });

    const warm = await reconcileConnectorSummaryEvidence(null);
    assert.equal(warm.repaired, 2, 'fixture premise: both sibling connections converge before invalidation');

    // Connector-wide invalidation takes one instance fence at a time (in
    // stable id order — see records.js's deleteAllRecordsForConnector) and
    // marks each instance's summary evidence dirty as it goes, but the
    // primitive must ALSO converge correctly from the checkpoint alone if
    // that marker were ever missed.
    const invalidation = await deleteAllRecordsForConnector(connectorId);
    assert.equal(invalidation.deletedCount, 3, 'fixture premise: all 3 records across both sibling connections are invalidated');

    const result = await reconcileConnectorSummaryEvidence(null);
    assert.equal(result.repaired, 2, 'both sibling connections converge on the post-invalidation zero state');

    for (const instanceId of ['cin_invalidation_a', 'cin_invalidation_b']) {
      const row = getDb()
        .prepare('SELECT total_records FROM connector_summary_evidence WHERE connector_instance_id = ?')
        .get(instanceId);
      assert.equal(row.total_records, 0, `${instanceId} reads zero records after connector-wide invalidation`);
    }

    // A second reconcile pass is idempotent: invalidation must not leave the
    // primitive perpetually "dirty" once genuinely converged.
    const secondPass = await reconcileConnectorSummaryEvidence(null);
    assert.equal(secondPass.repaired, 0, 'a second pass after convergence repairs nothing further');
  }));

test('manifest registration/backfill ordering does not desynchronize the summary primitive from canonical state', () =>
  withTempDb(async () => {
    // M1: register a manifest with one stream, ingest under it, and let the
    // summary primitive converge — establishing a baseline before the
    // manifest is re-registered (an ordering scenario mirroring
    // device-ingest-conformance.test.js's runManifestRegistrationOracle,
    // but asserting summary convergence rather than durable-prefix ordering).
    const connectorId = await registerConnector(manifestFor('manifest-backfill-ordering', ['messages']), {
      backfillRetrievalIndexes: false,
    });
    seedInstance('cin_manifest_ordering', connectorId);
    const target = storageTargetFor(connectorId, 'cin_manifest_ordering');
    await ingestRecord(target, { stream: 'messages', key: 'm1_msg', data: { id: 'm1_msg' }, emitted_at: NOW });

    const afterM1 = await reconcileConnectorSummaryEvidence(null);
    assert.equal(afterM1.repaired, 1, 'fixture premise: the connection converges under the M1 manifest');

    // M2: the manifest is re-registered (e.g. a new stream declared) BEFORE
    // the next ingest lands, mirroring registration/backfill racing ahead of
    // a still-in-flight or about-to-resume writer. Real production entry
    // point: registerConnector goes through the exact same manifest-storage
    // + backfill path a live registration takes.
    await registerConnector(manifestFor('manifest-backfill-ordering', ['messages', 'files']), {
      backfillRetrievalIndexes: false,
    });
    await ingestRecord(target, { stream: 'files', key: 'm2_file', data: { id: 'm2_file' }, emitted_at: NOW });

    const afterM2 = await reconcileConnectorSummaryEvidence(null);
    assert.equal(afterM2.repaired, 1, 'the connection re-converges under the M2 manifest after the new stream lands');

    const row = getDb()
      .prepare('SELECT total_records, stream_count FROM connector_summary_evidence WHERE connector_instance_id = ?')
      .get('cin_manifest_ordering');
    assert.equal(row.total_records, 2, 'both the pre- and post-registration records are reflected, none dropped by the manifest swap');
    assert.equal(row.stream_count, 2, 'both streams (declared under M1 and M2) are visible after re-registration');
  }));

// ---------------------------------------------------------------------------
// Real disposable PostgreSQL coverage (design.md "Acceptance Strategy": every
// forced fixture runs against SQLite AND a real disposable Postgres
// database). These two cases — accepted replay and connector-wide
// invalidation — are the two simplest, highest-value forced fixtures from
// this file and from device-batch-summary-evidence-convergence.test.js,
// ported here against the SAME production entry points
// (ingestRecord/deleteAllRecordsForConnector/registerConnector/
// reconcileConnectorSummaryEvidence), with storage routed to a real
// Postgres database via initPostgresStorage rather than SQLite's initDb.
// ---------------------------------------------------------------------------

test(
  'PostgreSQL: connector-wide invalidation (deleteAllRecordsForConnector) is detected and repaired by the summary primitive without a per-record dirty hook',
  { skip: !DEDICATED_POSTGRES_URL },
  () =>
    withTemporaryPostgres(async () => {
      const connectorId = await registerConnector(manifestFor('pg-connector-invalidation', ['messages']), {
        backfillRetrievalIndexes: false,
      });
      await seedInstancePostgres('cin_pg_invalidation_a', connectorId);
      await seedInstancePostgres('cin_pg_invalidation_b', connectorId);

      const targetA = storageTargetFor(connectorId, 'cin_pg_invalidation_a');
      const targetB = storageTargetFor(connectorId, 'cin_pg_invalidation_b');
      await ingestRecord(targetA, { stream: 'messages', key: 'a_1', data: { id: 'a_1' }, emitted_at: NOW });
      await ingestRecord(targetA, { stream: 'messages', key: 'a_2', data: { id: 'a_2' }, emitted_at: NOW });
      await ingestRecord(targetB, { stream: 'messages', key: 'b_1', data: { id: 'b_1' }, emitted_at: NOW });

      const warm = await reconcileConnectorSummaryEvidence(null);
      assert.equal(warm.repaired, 2, 'fixture premise: both sibling connections converge before invalidation');

      const invalidation = await deleteAllRecordsForConnector(connectorId);
      assert.equal(invalidation.deletedCount, 3, 'fixture premise: all 3 records across both sibling connections are invalidated');

      const result = await reconcileConnectorSummaryEvidence(null);
      assert.equal(result.repaired, 2, 'both sibling connections converge on the post-invalidation zero state against real PostgreSQL');

      for (const instanceId of ['cin_pg_invalidation_a', 'cin_pg_invalidation_b']) {
        const row = (
          await postgresQuery('SELECT total_records FROM connector_summary_evidence WHERE connector_instance_id = $1', [instanceId])
        ).rows[0];
        assert.equal(Number(row.total_records), 0, `${instanceId} reads zero records after connector-wide invalidation`);
      }

      const secondPass = await reconcileConnectorSummaryEvidence(null);
      assert.equal(secondPass.repaired, 0, 'a second pass after convergence repairs nothing further');
    }),
);

test(
  'PostgreSQL: an accepted replay of an already-committed batch prefix advances neither the checkpoint nor repair work',
  { skip: !DEDICATED_POSTGRES_URL },
  () =>
    withTemporaryPostgres(async () => {
      const connectorId = await registerConnector(manifestFor('pg-accepted-replay', ['messages']), {
        backfillRetrievalIndexes: false,
      });
      await seedInstancePostgres('cin_pg_accepted_replay', connectorId);
      const target = storageTargetFor(connectorId, 'cin_pg_accepted_replay');

      await ingestRecord(target, { stream: 'messages', key: 'msg_1', data: { id: 'msg_1' }, emitted_at: NOW });
      await ingestRecord(target, { stream: 'messages', key: 'msg_2', data: { id: 'msg_2' }, emitted_at: NOW });
      await reconcileConnectorSummaryEvidence(null);
      const checkpointAfterBatch = (
        await postgresQuery(
          'SELECT record_checkpoint_json::text AS record_checkpoint_json FROM connector_summary_evidence WHERE connector_instance_id = $1',
          ['cin_pg_accepted_replay'],
        )
      ).rows[0]?.record_checkpoint_json;

      const replay1 = await ingestRecord(target, { stream: 'messages', key: 'msg_1', data: { id: 'msg_1' }, emitted_at: NOW });
      const replay2 = await ingestRecord(target, { stream: 'messages', key: 'msg_2', data: { id: 'msg_2' }, emitted_at: NOW });
      assert.equal(replay1.changed, false);
      assert.equal(replay2.changed, false);

      const result = await reconcileConnectorSummaryEvidence(null);
      assert.equal(result.repaired, 0, 'an accepted replay triggers zero repair work against real PostgreSQL');
      const checkpointAfterReplay = (
        await postgresQuery(
          'SELECT record_checkpoint_json::text AS record_checkpoint_json FROM connector_summary_evidence WHERE connector_instance_id = $1',
          ['cin_pg_accepted_replay'],
        )
      ).rows[0]?.record_checkpoint_json;
      assert.equal(checkpointAfterReplay, checkpointAfterBatch, 'the composite checkpoint is unchanged by the replay');

      const row = (
        await postgresQuery('SELECT total_records FROM connector_summary_evidence WHERE connector_instance_id = $1', ['cin_pg_accepted_replay'])
      ).rows[0];
      assert.equal(Number(row.total_records), 2, 'the replay does not double-count the two records');
    }),
);
