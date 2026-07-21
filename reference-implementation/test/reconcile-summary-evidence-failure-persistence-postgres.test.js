/**
 * Real-PostgreSQL counterpart to `reconcile-summary-evidence-failure-
 * persistence.test.js`'s probe 3 / probe 4 (Sol third-verdict P1.1 minimum-
 * closure item 1): "Add SQLite + real-Postgres production-entry probes
 * starting current/fresh, forcing phase+marker double failure, one summary
 * call, affected component non-current and ProjectionReliable=false."
 *
 * Same two scenarios as the SQLite file, same production entry points
 * (`reconcileConnectorSummaryEvidence`, `listConnectorSummaries`), real
 * PostgreSQL fault injection via `CREATE TRIGGER`/`RAISE EXCEPTION` (the
 * pattern `device-exporter-postgres-proof.test.js` already establishes for
 * this codebase) instead of SQLite's `RAISE(ABORT, ...)`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { reconcileConnectorSummaryEvidence } from '../server/connector-summary-evidence-engine.ts';
import { reconcileDirtyConnectorSummaryEvidence } from '../server/connector-summary-read-model.ts';
import { invalidateConnectorSummariesCache, listConnectorSummaries } from '../server/ref-control.ts';
import { closePostgresStorage, initPostgresStorage, postgresQuery } from '../server/postgres-storage.js';
import { dedicatedPostgresTestUrl } from './helpers/dedicated-postgres-test-url.js';

const NOW = '2026-07-17T00:00:00.000Z';
const CONNECTOR_ID = 'https://test.pdpp.dev/connectors/failure-persistence-pg';
const INSTANCE_ID = 'cin_failure_persistence_pg';
const STREAM = 'messages';

const MANIFEST = {
  protocol_version: '0.1.0',
  connector_id: CONNECTOR_ID,
  version: '1.0.0',
  display_name: 'Failure Persistence Probe (Postgres)',
  capabilities: { public_listing: { listed: true, status: 'test' } },
  streams: [
    {
      name: STREAM,
      primary_key: ['id'],
      coverage_strategy: 'full_inventory',
      schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  ],
};

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);

async function seedConnector() {
  await postgresQuery('DELETE FROM connectors WHERE connector_id = $1', [CONNECTOR_ID]);
  await postgresQuery('INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3)', [
    CONNECTOR_ID,
    JSON.stringify(MANIFEST),
    NOW,
  ]);
}

async function seedInstance() {
  await postgresQuery(
    `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
     ) VALUES ($1, 'owner_local', $2, 'Failure Persistence Probe (Postgres)', 'active', 'account', $1, '{}'::jsonb, $3, $3, NULL)`,
    [INSTANCE_ID, CONNECTOR_ID, NOW],
  );
}

async function cleanup() {
  await postgresQuery('DELETE FROM connector_summary_evidence WHERE connector_id = $1', [CONNECTOR_ID]);
  await postgresQuery('DELETE FROM spine_events WHERE run_id LIKE $1', ['run_probe%pg']);
  await postgresQuery('DELETE FROM connector_instances WHERE connector_id = $1', [CONNECTOR_ID]);
  await postgresQuery('DELETE FROM connectors WHERE connector_id = $1', [CONNECTOR_ID]);
}

async function listBypassCache() {
  invalidateConnectorSummariesCache();
  const summaries = await listConnectorSummaries(null, { concurrency: 1, includeRunSummaries: false });
  invalidateConnectorSummariesCache();
  return summaries;
}

function summaryFor(summaries) {
  const summary = summaries.find((row) => row.connector_instance_id === INSTANCE_ID);
  assert.ok(summary, 'summary for the probe connection must be visible');
  return summary;
}

function projectionReliable(summary) {
  return summary.connection_health.conditions.find((condition) => condition.type === 'ProjectionReliable');
}

test(
  'real PostgreSQL probe 3: simultaneous fold failure AND terminal-facts-failed-marker write failure still fails closed through the real production read',
  { skip: !POSTGRES_URL },
  async () => {
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });
    const suffix = `${process.pid}`;
    const foldFn = `pdpp_test_probe3_fold_fn_${suffix}`;
    const foldTrigger = `pdpp_test_probe3_fold_trg_${suffix}`;
    const markerFn = `pdpp_test_probe3_marker_fn_${suffix}`;
    const markerTrigger = `pdpp_test_probe3_marker_trg_${suffix}`;
    try {
      await cleanup();
      await seedConnector();
      await seedInstance();

      await reconcileConnectorSummaryEvidence(null);
      await reconcileDirtyConnectorSummaryEvidence();
      const before = (
        await postgresQuery(
          'SELECT terminal_facts_state, dirty, state FROM connector_summary_evidence WHERE connector_instance_id = $1',
          [INSTANCE_ID],
        )
      ).rows[0];
      assert.equal(before.terminal_facts_state, 'current', 'terminal_facts starts genuinely current');
      assert.equal(Number(before.dirty), 0);
      assert.equal(before.state, 'fresh');

      const beforeSummary = summaryFor(await listBypassCache());
      assert.equal(projectionReliable(beforeSummary)?.status, 'true', 'the connection starts genuinely healthy');

      await postgresQuery(
        `INSERT INTO spine_events(
           event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
           actor_type, actor_id, object_type, object_id, status, run_id, connector_instance_id, data_json, version
         ) VALUES($1, 1, 'run.completed', $2, $2, 'test', 'trace_probe3pg', 'runtime', 'test-connector', 'run', 'run_probe3pg', 'succeeded', 'run_probe3pg', $3, $4::jsonb, '1')`,
        [
          'evt_probe3pg',
          NOW,
          INSTANCE_ID,
          JSON.stringify({
            connector_instance_id: INSTANCE_ID,
            connection_id: INSTANCE_ID,
            collection_facts: {
              reference_only: true,
              schema_version: 1,
              streams: [{ stream: STREAM, collected: 0, checkpoint: 'committed' }],
            },
          }),
        ],
      );

      // Fault injection: reject BOTH the fold's own write
      // (`stream_facts_event_seq` advance) AND the terminal-facts-failed
      // marker's own write (`terminal_facts_state` degrade) — the exact
      // simultaneous double-failure Sol's third verdict reproduced on real
      // PostgreSQL.
      await postgresQuery(`
        CREATE FUNCTION ${foldFn}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.stream_facts_event_seq IS DISTINCT FROM OLD.stream_facts_event_seq THEN
            RAISE EXCEPTION 'injected fold write fault';
          END IF;
          RETURN NEW;
        END
        $$
      `);
      await postgresQuery(
        `CREATE TRIGGER ${foldTrigger} BEFORE UPDATE ON connector_summary_evidence FOR EACH ROW EXECUTE FUNCTION ${foldFn}()`,
      );
      await postgresQuery(`
        CREATE FUNCTION ${markerFn}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.terminal_facts_state IS DISTINCT FROM OLD.terminal_facts_state THEN
            RAISE EXCEPTION 'injected terminal-facts-failed marker write fault';
          END IF;
          RETURN NEW;
        END
        $$
      `);
      await postgresQuery(
        `CREATE TRIGGER ${markerTrigger} BEFORE UPDATE ON connector_summary_evidence FOR EACH ROW EXECUTE FUNCTION ${markerFn}()`,
      );

      let summary;
      try {
        summary = summaryFor(await listBypassCache());
      } finally {
        await postgresQuery(`DROP TRIGGER IF EXISTS ${foldTrigger} ON connector_summary_evidence`);
        await postgresQuery(`DROP TRIGGER IF EXISTS ${markerTrigger} ON connector_summary_evidence`);
        await postgresQuery(`DROP FUNCTION IF EXISTS ${foldFn}()`);
        await postgresQuery(`DROP FUNCTION IF EXISTS ${markerFn}()`);
      }

      const untouchedRow = (
        await postgresQuery(
          'SELECT terminal_facts_state, dirty, state FROM connector_summary_evidence WHERE connector_instance_id = $1',
          [INSTANCE_ID],
        )
      ).rows[0];
      assert.equal(
        untouchedRow.terminal_facts_state,
        'current',
        'the durable row is genuinely untouched by the double-rejected writes on real PostgreSQL',
      );
      assert.equal(Number(untouchedRow.dirty), 0);
      assert.equal(untouchedRow.state, 'fresh');

      assert.equal(
        projectionReliable(summary)?.status,
        'false',
        'ProjectionReliable must be false on real PostgreSQL when BOTH the fold and its failure-marker write failed',
      );
    } finally {
      await cleanup();
      await closePostgresStorage();
    }
  },
);

test(
  'real PostgreSQL probe 4: simultaneous discovery failure AND discovery-failed-marker write failure still fails closed through the real production read',
  { skip: !POSTGRES_URL },
  async () => {
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });
    const suffix = `${process.pid}`;
    const markerFn = `pdpp_test_probe4_marker_fn_${suffix}`;
    const markerTrigger = `pdpp_test_probe4_marker_trg_${suffix}`;
    let renamedVersionCounter = false;
    try {
      await cleanup();
      await seedConnector();
      await seedInstance();

      const first = await reconcileConnectorSummaryEvidence(null);
      assert.equal(first.failed, 0);
      const before = (
        await postgresQuery(
          'SELECT record_snapshot_state, manifest_declaration_state, dirty, state FROM connector_summary_evidence WHERE connector_instance_id = $1',
          [INSTANCE_ID],
        )
      ).rows[0];
      assert.equal(before.record_snapshot_state, 'current');
      assert.equal(before.manifest_declaration_state, 'current');
      assert.equal(Number(before.dirty), 0);
      assert.equal(before.state, 'fresh');

      const beforeSummary = summaryFor(await listBypassCache());
      assert.equal(projectionReliable(beforeSummary)?.status, 'true', 'the connection starts genuinely healthy');

      // Fault injection: break discovery itself by renaming `version_counter`
      // (the exact table Sol's verdict named) AND simultaneously reject the
      // discovery-failed marker's own write.
      await postgresQuery('ALTER TABLE version_counter RENAME TO version_counter_hidden_probe4pg');
      renamedVersionCounter = true;
      await postgresQuery(`
        CREATE FUNCTION ${markerFn}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.record_snapshot_state IS DISTINCT FROM OLD.record_snapshot_state THEN
            RAISE EXCEPTION 'injected discovery-failed marker write fault';
          END IF;
          RETURN NEW;
        END
        $$
      `);
      await postgresQuery(
        `CREATE TRIGGER ${markerTrigger} BEFORE UPDATE ON connector_summary_evidence FOR EACH ROW EXECUTE FUNCTION ${markerFn}()`,
      );

      let summary;
      try {
        summary = summaryFor(await listBypassCache());
      } finally {
        await postgresQuery(`DROP TRIGGER IF EXISTS ${markerTrigger} ON connector_summary_evidence`);
        await postgresQuery(`DROP FUNCTION IF EXISTS ${markerFn}()`);
        await postgresQuery('ALTER TABLE version_counter_hidden_probe4pg RENAME TO version_counter');
        renamedVersionCounter = false;
      }

      const untouchedRow = (
        await postgresQuery(
          'SELECT record_snapshot_state, manifest_declaration_state, dirty, state FROM connector_summary_evidence WHERE connector_instance_id = $1',
          [INSTANCE_ID],
        )
      ).rows[0];
      assert.equal(
        untouchedRow.record_snapshot_state,
        'current',
        'the durable row is genuinely untouched by the double-rejected writes on real PostgreSQL',
      );
      assert.equal(Number(untouchedRow.dirty), 0);
      assert.equal(untouchedRow.state, 'fresh');

      assert.equal(
        projectionReliable(summary)?.status,
        'false',
        'ProjectionReliable must be false on real PostgreSQL when BOTH discovery and its failure-marker write failed',
      );
    } finally {
      if (renamedVersionCounter) {
        await postgresQuery('ALTER TABLE version_counter_hidden_probe4pg RENAME TO version_counter').catch(() => undefined);
      }
      await cleanup();
      await closePostgresStorage();
    }
  },
);
