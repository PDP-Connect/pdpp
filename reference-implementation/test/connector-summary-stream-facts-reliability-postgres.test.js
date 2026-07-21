/**
 * Real-PostgreSQL counterpart to `connector-summary-stream-facts-reliability.test.js`:
 * proves the SAME bounded-replay reliability invariants (an incomplete pass
 * never reads current, `maxEvents` is an actual per-call ceiling, exact-
 * boundary convergence, and future-version fail-closed-at-read-time-only)
 * against the real Postgres fold path (`createStreamFactsFoldStore()`'s
 * Postgres branch in connector-summary-read-model.ts) — the dialect-split
 * SQL is not exercised by the SQLite-host tests at all.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  foldConnectorSummaryStreamFacts,
  getConnectorSummaryEvidence,
  rebuildConnectorSummaryEvidence,
} from '../server/connector-summary-read-model.ts';
import { closePostgresStorage, initPostgresStorage, postgresQuery } from '../server/postgres-storage.js';
import { dedicatedPostgresTestUrl } from './helpers/dedicated-postgres-test-url.js';

const NOW = '2026-07-18T00:00:00.000Z';
const CONNECTOR_ID = 'https://test.pdpp.dev/connectors/summary-facts-reliability-pg';
const INSTANCE_ID = 'cin_summary_facts_reliability_pg';

const MANIFEST = {
  protocol_version: '0.1.0',
  connector_id: CONNECTOR_ID,
  version: '1.0.0',
  display_name: 'Summary Facts Reliability Probe (Postgres)',
  capabilities: { public_listing: { listed: true, status: 'test' } },
  streams: [
    {
      name: 'messages',
      primary_key: ['id'],
      coverage_strategy: 'full_inventory',
      schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  ],
};

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);

// spine_events.event_seq is a GLOBALLY unique key on Postgres (unlike
// SQLite's per-file-scoped table), so every test file sharing the dedicated
// test database must claim its own disjoint numeric range — never reset to
// 0. Matches the convention in connector-summary-stream-facts-monotonic-postgres.test.js.
let seededEventSeq = 2_000_000;

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
     ) VALUES ($1, 'owner_local', $2, 'Summary Facts Reliability Probe (Postgres)', 'active', 'account', $1, '{}'::jsonb, $3, $3, NULL)`,
    [INSTANCE_ID, CONNECTOR_ID, NOW],
  );
}

async function seedTerminalEvent({ runId, streams }) {
  seededEventSeq += 1;
  const data = {
    connector_instance_id: INSTANCE_ID,
    connection_id: INSTANCE_ID,
    collection_facts: { reference_only: true, schema_version: 1, streams },
  };
  await postgresQuery(
    `INSERT INTO spine_events(
       event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
       actor_type, actor_id, object_type, object_id, status, run_id, connector_instance_id, data_json, version
     ) VALUES($1, $2, 'run.completed', $3, $3, 'test', $4, 'runtime', 'test-connector', 'run', $5, 'succeeded', $5, $6, $7::jsonb, '1')`,
    [`evt_${seededEventSeq}`, seededEventSeq, NOW, `trace_${seededEventSeq}`, runId, INSTANCE_ID, JSON.stringify(data)],
  );
  return seededEventSeq;
}

async function cleanup() {
  await postgresQuery('DELETE FROM connector_summary_evidence WHERE connector_id = $1', [CONNECTOR_ID]);
  await postgresQuery('DELETE FROM spine_events WHERE connector_instance_id = $1', [INSTANCE_ID]);
  await postgresQuery('DELETE FROM connector_instances WHERE connector_id = $1', [CONNECTOR_ID]);
  await postgresQuery('DELETE FROM connectors WHERE connector_id = $1', [CONNECTOR_ID]);
}

async function evidenceRow() {
  const result = await postgresQuery(
    'SELECT stream_facts_event_seq, stream_facts_fold_version, stream_latest_facts_json, terminal_facts_state, terminal_facts_reason_code FROM connector_summary_evidence WHERE connector_instance_id = $1',
    [INSTANCE_ID],
  );
  return result.rows[0];
}

test(
  'real PostgreSQL: a bounded pass (maxEvents:1) processes AT MOST one event and stays stale/incomplete, never current',
  { skip: !POSTGRES_URL },
  async () => {
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });
    try {
      await cleanup();
      await seedConnector();
      await seedInstance();
      await rebuildConnectorSummaryEvidence();

      const seq1 = await seedTerminalEvent({ runId: 'run_1', streams: [{ stream: 'messages', collected: 1, checkpoint: 'committed' }] });
      await seedTerminalEvent({ runId: 'run_2', streams: [{ stream: 'threads', collected: 1, checkpoint: 'committed' }] });
      await seedTerminalEvent({ runId: 'run_3', streams: [{ stream: 'labels', collected: 1, checkpoint: 'committed' }] });

      const result = await foldConnectorSummaryStreamFacts([INSTANCE_ID], { maxEvents: 1 });
      assert.equal(result.incomplete, true);
      assert.equal(result.resumeAfterSeq, seq1, 'processed at most one event, not the whole in-flight batch');

      const row = await evidenceRow();
      assert.equal(Number(row.stream_facts_event_seq), seq1);
      assert.equal(row.terminal_facts_state, 'stale', 'an incomplete pass must never read current on real PostgreSQL');
      assert.equal(row.terminal_facts_reason_code, 'terminal_fold_incomplete');
      assert.ok(Number(row.stream_facts_fold_version) >= 2, 'the version is already stamped current from the first partial write');
      const facts = row.stream_latest_facts_json;
      assert.equal(Object.keys(facts).length, 1, 'exactly the one event actually processed is present');

      const evidence = await getConnectorSummaryEvidence(INSTANCE_ID);
      assert.equal(evidence.terminal_facts.state, 'stale');
      assert.equal(evidence.terminal_facts.reason_code, 'terminal_fold_incomplete');
    } finally {
      await cleanup();
      await closePostgresStorage();
    }
  },
);

test(
  'real PostgreSQL: multi-round resume — bounded rounds accumulate and only the genuinely converged final round reads current',
  { skip: !POSTGRES_URL },
  async () => {
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });
    try {
      await cleanup();
      await seedConnector();
      await seedInstance();
      await rebuildConnectorSummaryEvidence();

      for (let i = 0; i < 5; i += 1) {
        await seedTerminalEvent({ runId: `run_${i}`, streams: [{ stream: `stream_${i}`, collected: 1, checkpoint: 'committed' }] });
      }

      const round1 = await foldConnectorSummaryStreamFacts([INSTANCE_ID], { maxEvents: 2 });
      assert.equal(round1.incomplete, true);
      const afterRound1 = await evidenceRow();
      assert.equal(afterRound1.terminal_facts_state, 'stale');
      assert.equal(Object.keys(afterRound1.stream_latest_facts_json).length, 2);

      const round2 = await foldConnectorSummaryStreamFacts([INSTANCE_ID], { maxEvents: 2 });
      assert.equal(round2.incomplete, true, 'still short of the full 5-event history (2+2=4 < 5)');
      const afterRound2 = await evidenceRow();
      assert.equal(afterRound2.terminal_facts_state, 'stale');
      assert.equal(Object.keys(afterRound2.stream_latest_facts_json).length, 4, 'accumulated, not restarted');

      const round3 = await foldConnectorSummaryStreamFacts([INSTANCE_ID]);
      assert.equal(round3.incomplete, false);
      const afterRound3 = await evidenceRow();
      assert.equal(afterRound3.terminal_facts_state, 'current', 'only the genuinely converged final round reads current');
      assert.equal(afterRound3.terminal_facts_reason_code, null);
      assert.equal(Object.keys(afterRound3.stream_latest_facts_json).length, 5);
    } finally {
      await cleanup();
      await closePostgresStorage();
    }
  },
);

test(
  'real PostgreSQL: exact-boundary convergence — a maxEvents budget equal to the remaining history reads current, not falsely incomplete',
  { skip: !POSTGRES_URL },
  async () => {
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });
    try {
      await cleanup();
      await seedConnector();
      await seedInstance();
      await rebuildConnectorSummaryEvidence();

      for (let i = 0; i < 3; i += 1) {
        await seedTerminalEvent({ runId: `run_${i}`, streams: [{ stream: `stream_${i}`, collected: 1, checkpoint: 'committed' }] });
      }

      const result = await foldConnectorSummaryStreamFacts([INSTANCE_ID], { maxEvents: 3 });
      assert.equal(result.incomplete, false, 'exact-boundary convergence on real PostgreSQL');
      assert.equal(result.resumeAfterSeq, null);

      const row = await evidenceRow();
      assert.equal(row.terminal_facts_state, 'current');
      assert.equal(row.terminal_facts_reason_code, null);
      assert.equal(Object.keys(row.stream_latest_facts_json).length, 3);
    } finally {
      await cleanup();
      await closePostgresStorage();
    }
  },
);

test(
  'real PostgreSQL: a future-version row is never folded/replayed/mutated durably — this binary fails it closed at read time only',
  { skip: !POSTGRES_URL },
  async () => {
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });
    try {
      await cleanup();
      await seedConnector();
      await seedInstance();
      await rebuildConnectorSummaryEvidence();
      await seedTerminalEvent({ runId: 'run_1', streams: [{ stream: 'messages', collected: 1, checkpoint: 'committed' }] });

      const futureFacts = {
        messages: { fact: { stream: 'messages', collected: 42, checkpoint: 'committed' }, run_id: 'future_run', event_seq: 1, evidence_as_of: null },
      };
      await postgresQuery(
        `UPDATE connector_summary_evidence
            SET stream_latest_facts_json = $2::jsonb, stream_facts_event_seq = 1, stream_facts_fold_version = 99,
                terminal_facts_state = 'current', terminal_facts_reason_code = NULL, dirty = 0, state = 'fresh'
          WHERE connector_instance_id = $1`,
        [INSTANCE_ID, JSON.stringify(futureFacts)],
      );

      const beforeRow = await evidenceRow();
      assert.equal(Number(beforeRow.stream_facts_fold_version), 99);
      assert.equal(beforeRow.terminal_facts_state, 'current');

      const result = await foldConnectorSummaryStreamFacts([INSTANCE_ID]);
      assert.equal(result.participants, 0, 'the future-version row never participates on real PostgreSQL');

      const afterRow = await evidenceRow();
      assert.deepEqual(afterRow, beforeRow, 'the durable row is byte-for-byte unchanged by this older binary\'s fold pass');

      const evidence = await getConnectorSummaryEvidence(INSTANCE_ID);
      assert.equal(evidence.terminal_facts.state, 'stale', 'this binary fails the future-version row closed for its OWN observation');
      assert.equal(evidence.terminal_facts.reason_code, 'fold_logic_version_incompatible_future');

      const rawRowAfterRead = await evidenceRow();
      assert.equal(rawRowAfterRead.terminal_facts_state, 'current', 'the stored state is untouched — still current for a compatible reader');
      assert.deepEqual(rawRowAfterRead, beforeRow, 'reading through this older binary left zero durable trace on real PostgreSQL');
    } finally {
      await cleanup();
      await closePostgresStorage();
    }
  },
);
