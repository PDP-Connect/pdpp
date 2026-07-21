/**
 * Wired forward-evidence-debt probe (P1-A fix, Fable review PART 2 §2/§5).
 *
 * `hasForwardEvidenceDebt`'s unit tests (recovery-decision.test.js) fed
 * synthetic evidence shapes and could not catch a defect in how the REAL
 * probe sites (`server/index.js`, `server/scheduler-manager-factory.js`,
 * `runtime/controller.ts`) actually construct that shape from a durable
 * evidence row. The original implementation read `terminal_facts.as_of`
 * (`row.computed_at`, the projection's own observation/repair timestamp —
 * refreshed by the very `reconcileDirtyConnectorSummaryEvidence` call the
 * probe makes immediately before the read), so the bound could never fire
 * once evidence was healed to `current` regardless of how old the
 * underlying terminal event actually was. A synthetic unit test never
 * exercises this because it never round-trips through a real reconcile.
 *
 * This file drives the exact real pipeline every wired probe site uses:
 * `reconcileDirtyConnectorSummaryEvidence([id])` then
 * `getConnectorSummaryEvidence(id)`, feeding the result straight into
 * `hasForwardEvidenceDebt` — proving the wiring, not just the pure
 * predicate.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { closeDb, getDb, initDb } from '../server/db.js';
import { getConnectorSummaryEvidence, reconcileDirtyConnectorSummaryEvidence } from '../server/connector-summary-read-model.ts';
import { hasForwardEvidenceDebt } from '../runtime/recovery-decision.ts';
import { dedicatedPostgresTestUrl } from './helpers/dedicated-postgres-test-url.js';
import { closePostgresStorage, initPostgresStorage, postgresQuery } from '../server/postgres-storage.js';

const SCHEDULE_INTERVAL_MS = 15 * 60 * 1000; // 15m schedule -> bound = max(4*15m, 1h) = 1h

const MANIFEST = {
  protocol_version: '0.1.0',
  connector_id: 'forward-evidence-debt-wired-probe',
  version: '1.0.0',
  display_name: 'Forward Evidence Debt Wired Probe',
  capabilities: { public_listing: { listed: true, status: 'test' } },
  streams: [{ name: 'messages', primary_key: ['id'] }],
};

// ─── SQLite ─────────────────────────────────────────────────────────────

function withTempDbPath(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdpp-forward-evidence-debt-'));
    const dbPath = join(dir, 'pdpp.sqlite');
    try {
      initDb(dbPath);
      await fn();
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function seedSqliteConnection(connectorInstanceId, now) {
  getDb()
    .prepare('INSERT OR IGNORE INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)')
    .run(MANIFEST.connector_id, JSON.stringify(MANIFEST), now);
  getDb()
    .prepare(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       ) VALUES (?, 'owner_local', ?, 'x', 'active', 'account', ?, '{}', ?, ?, NULL)`,
    )
    .run(connectorInstanceId, MANIFEST.connector_id, connectorInstanceId, now, now);
}

let sqliteEventSeq = 0;

function seedSqliteTerminalEvent(connectorInstanceId, occurredAt, { streams = true } = {}) {
  sqliteEventSeq += 1;
  const data = {
    connector_instance_id: connectorInstanceId,
    connection_id: connectorInstanceId,
    ...(streams
      ? {
          collection_facts: {
            reference_only: true,
            schema_version: 1,
            streams: [{ stream: 'messages', checkpoint: 'committed', considered: 1, collected: 1 }],
          },
        }
      : {}),
  };
  getDb()
    .prepare(
      `INSERT INTO spine_events(
         event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
         actor_type, actor_id, object_type, object_id, status, run_id, connector_instance_id, manifest_generation, data_json, version
       ) VALUES (?, ?, 'run.completed', ?, ?, 'test', ?, 'runtime', 'test-connector', 'run', ?, 'succeeded', ?, ?, 0, ?, '1')`,
    )
    .run(
      `evt_${sqliteEventSeq}`,
      sqliteEventSeq,
      occurredAt,
      occurredAt,
      `trace_${sqliteEventSeq}`,
      `run_${sqliteEventSeq}`,
      `run_${sqliteEventSeq}`,
      connectorInstanceId,
      JSON.stringify(data),
    );
}

test(
  'SQLite: a connection whose only forward evidence is 3 days old reads debt=true through the real wired pipeline',
  withTempDbPath(async () => {
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    seedSqliteConnection('cin_old_evidence', now);
    seedSqliteTerminalEvent('cin_old_evidence', old);

    await reconcileDirtyConnectorSummaryEvidence(['cin_old_evidence']);
    const evidence = await getConnectorSummaryEvidence('cin_old_evidence');
    assert.equal(evidence.terminal_facts?.state, 'current', 'premise: the fold accepted the terminal event as current');
    // The defect this pins: terminal_facts.as_of is the projection's OWN
    // observation timestamp (fresh, from the reconcile call above), not the
    // evidence's real age — proving the wiring must not read it.
    assert.ok(
      Date.now() - Date.parse(evidence.terminal_facts.as_of) < 60_000,
      'premise: terminal_facts.as_of is fresh (the reconcile just stamped it), NOT 3 days old',
    );

    assert.equal(
      hasForwardEvidenceDebt(evidence, Date.now(), SCHEDULE_INTERVAL_MS),
      true,
      'a 3-day-old fact (bound 1h) must read as debt through the real wired pipeline',
    );
  }),
);

test(
  'SQLite: a connection whose only forward evidence is fresh reads debt=false through the real wired pipeline',
  withTempDbPath(async () => {
    const now = new Date().toISOString();
    const fresh = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5m ago
    seedSqliteConnection('cin_fresh_evidence', now);
    seedSqliteTerminalEvent('cin_fresh_evidence', fresh);

    await reconcileDirtyConnectorSummaryEvidence(['cin_fresh_evidence']);
    const evidence = await getConnectorSummaryEvidence('cin_fresh_evidence');
    assert.equal(evidence.terminal_facts?.state, 'current');

    assert.equal(
      hasForwardEvidenceDebt(evidence, Date.now(), SCHEDULE_INTERVAL_MS),
      false,
      'a 5-minute-old fact (bound 1h) must NOT read as debt',
    );
  }),
);

test(
  'SQLite: a connection with current-but-empty terminal facts (no fact-carrying event ever) reads debt=true',
  withTempDbPath(async () => {
    const now = new Date().toISOString();
    seedSqliteConnection('cin_empty_evidence', now);
    // No terminal event at all: `stampZeroCheckpointForBootstrap` marks the
    // row current with a genuinely empty fact map (checkpointed-empty, not
    // unobserved) — this must still read as debt, since there is nothing to
    // measure freshness against.
    await reconcileDirtyConnectorSummaryEvidence(['cin_empty_evidence']);
    const evidence = await getConnectorSummaryEvidence('cin_empty_evidence');
    assert.equal(evidence.terminal_facts?.state, 'current', 'premise: a connection with no terminal history ever is current');
    assert.equal(evidence.stream_latest_facts, null, 'premise: the fact map is genuinely empty');

    assert.equal(
      hasForwardEvidenceDebt(evidence, Date.now(), SCHEDULE_INTERVAL_MS),
      true,
      'current-but-empty forward evidence is debt — absence is not fresh evidence',
    );
  }),
);

// ─── Postgres (gated) ───────────────────────────────────────────────────

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);

async function seedPostgresConnection(connectorInstanceId, now) {
  await postgresQuery('INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3) ON CONFLICT (connector_id) DO NOTHING', [
    MANIFEST.connector_id,
    JSON.stringify(MANIFEST),
    now,
  ]);
  await postgresQuery(
    `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
     ) VALUES ($1, 'owner_local', $2, 'x', 'active', 'account', $1, '{}'::jsonb, $3, $3, NULL)`,
    [connectorInstanceId, MANIFEST.connector_id, now],
  );
}

async function seedPostgresTerminalEvent(connectorInstanceId, occurredAt, { streams = true } = {}) {
  const data = {
    connector_instance_id: connectorInstanceId,
    connection_id: connectorInstanceId,
    ...(streams
      ? {
          collection_facts: {
            reference_only: true,
            schema_version: 1,
            streams: [{ stream: 'messages', checkpoint: 'committed', considered: 1, collected: 1 }],
          },
        }
      : {}),
  };
  await postgresQuery(
    `INSERT INTO spine_events(
       event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
       actor_type, actor_id, object_type, object_id, status, run_id, connector_instance_id, manifest_generation, data_json, version
     ) VALUES($1, (SELECT COALESCE(MAX(event_seq),0)+1 FROM spine_events), 'run.completed', $2, $2, 'test', $3, 'runtime', 'test-connector', 'run', $4, 'succeeded', $4, $5, 0, $6::jsonb, '1')`,
    [
      `evt_pg_fed_${connectorInstanceId}`,
      occurredAt,
      `trace_${connectorInstanceId}`,
      `run_${connectorInstanceId}`,
      connectorInstanceId,
      JSON.stringify(data),
    ],
  );
}

async function cleanupPostgres(connectorInstanceIds) {
  for (const id of connectorInstanceIds) {
    await postgresQuery('DELETE FROM connector_summary_evidence WHERE connector_instance_id = $1', [id]);
    await postgresQuery('DELETE FROM spine_events WHERE connector_instance_id = $1', [id]);
    await postgresQuery('DELETE FROM connector_instances WHERE connector_instance_id = $1', [id]);
  }
  await postgresQuery('DELETE FROM connectors WHERE connector_id = $1', [MANIFEST.connector_id]);
}

test(
  'real PostgreSQL: a connection whose only forward evidence is 3 days old reads debt=true through the real wired pipeline',
  { skip: !POSTGRES_URL },
  async () => {
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });
    try {
      const now = new Date().toISOString();
      const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
      await seedPostgresConnection('cin_old_evidence_pg', now);
      await seedPostgresTerminalEvent('cin_old_evidence_pg', old);

      await reconcileDirtyConnectorSummaryEvidence(['cin_old_evidence_pg']);
      const evidence = await getConnectorSummaryEvidence('cin_old_evidence_pg');
      assert.equal(evidence.terminal_facts?.state, 'current');
      assert.ok(Date.now() - Date.parse(evidence.terminal_facts.as_of) < 60_000, 'premise: terminal_facts.as_of is fresh');

      assert.equal(hasForwardEvidenceDebt(evidence, Date.now(), SCHEDULE_INTERVAL_MS), true);
    } finally {
      await cleanupPostgres(['cin_old_evidence_pg']);
      await closePostgresStorage();
    }
  },
);

test(
  'real PostgreSQL: a connection whose only forward evidence is fresh reads debt=false through the real wired pipeline',
  { skip: !POSTGRES_URL },
  async () => {
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });
    try {
      const now = new Date().toISOString();
      const fresh = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      await seedPostgresConnection('cin_fresh_evidence_pg', now);
      await seedPostgresTerminalEvent('cin_fresh_evidence_pg', fresh);

      await reconcileDirtyConnectorSummaryEvidence(['cin_fresh_evidence_pg']);
      const evidence = await getConnectorSummaryEvidence('cin_fresh_evidence_pg');
      assert.equal(evidence.terminal_facts?.state, 'current');

      assert.equal(hasForwardEvidenceDebt(evidence, Date.now(), SCHEDULE_INTERVAL_MS), false);
    } finally {
      await cleanupPostgres(['cin_fresh_evidence_pg']);
      await closePostgresStorage();
    }
  },
);

test(
  'real PostgreSQL: a connection with current-but-empty terminal facts reads debt=true',
  { skip: !POSTGRES_URL },
  async () => {
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });
    try {
      const now = new Date().toISOString();
      await seedPostgresConnection('cin_empty_evidence_pg', now);

      await reconcileDirtyConnectorSummaryEvidence(['cin_empty_evidence_pg']);
      const evidence = await getConnectorSummaryEvidence('cin_empty_evidence_pg');
      assert.equal(evidence.terminal_facts?.state, 'current');
      assert.equal(evidence.stream_latest_facts, null);

      assert.equal(hasForwardEvidenceDebt(evidence, Date.now(), SCHEDULE_INTERVAL_MS), true);
    } finally {
      await cleanupPostgres(['cin_empty_evidence_pg']);
      await closePostgresStorage();
    }
  },
);
