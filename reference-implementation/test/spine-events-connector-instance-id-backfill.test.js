// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Migration-safe scoped terminal history (Sol fourth-verdict P1.1 /
 * minimum-closure item 1): "Backfill only terminal spine_events rows whose
 * new column is null, deriving the exact same precedence from
 * data_json.connector_instance_id then data_json.connection_id... Add
 * upgrade-shaped SQLite and real-PostgreSQL tests that create old-schema/
 * old-row data before bootstrap, then exercise the real scoped route and
 * startup fold. Prove historical facts and checkpoints converge without
 * reading unrelated connections."
 *
 * Sol's deterministic reproduction: a migration-shaped terminal event with
 * `data_json.connector_instance_id` set but the new
 * `spine_events.connector_instance_id` column NULL folds
 * `{folded:0, participants:0}` on the SCOPED path (the real single-
 * connection route, `getConnectorSummaryForRoute`) while the checkpoint
 * stays put — historical evidence silently incomplete after upgrade.
 *
 * This file proves the fix: a bounded, idempotent, set-based backfill
 * migration (`migrateSpineEventsConnectorInstanceIdBackfill` on SQLite, the
 * equivalent inline `UPDATE` in the Postgres bootstrap DDL) that runs on
 * `initDb`/`initPostgresStorage` and converges pre-existing terminal rows
 * whose column is NULL but whose `data_json` carries a genuine identity —
 * without touching rows attributed to OTHER connections, and without
 * touching non-terminal event types.
 */

import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { closeDb, getDb, initDb } from '../server/db.js';
import {
  foldConnectorSummaryStreamFacts,
  getConnectorSummaryEvidence,
  rebuildConnectorSummaryEvidence,
  runBoundedSummaryEvidenceSweep,
} from '../server/connector-summary-read-model.ts';
import { getConnectorSummaryForRoute } from '../server/ref-control.ts';
import { dedicatedPostgresTestUrl } from './helpers/dedicated-postgres-test-url.js';
import { closePostgresStorage, initPostgresStorage, postgresQuery } from '../server/postgres-storage.js';

const NOW = '2026-07-17T00:00:00.000Z';

const MANIFEST = {
  protocol_version: '0.1.0',
  connector_id: 'spine-backfill-target',
  version: '1.0.0',
  display_name: 'Spine Backfill Target',
  capabilities: { public_listing: { listed: true, status: 'test' } },
  streams: [{ name: 'messages', primary_key: ['id'] }],
};

const UNRELATED_MANIFEST = {
  protocol_version: '0.1.0',
  connector_id: 'spine-backfill-unrelated',
  version: '1.0.0',
  display_name: 'Spine Backfill Unrelated',
  capabilities: { public_listing: { listed: true, status: 'test' } },
  streams: [{ name: 'messages', primary_key: ['id'] }],
};

// ─── SQLite ─────────────────────────────────────────────────────────────

function withTempDbPath(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdpp-spine-backfill-'));
    const dbPath = join(dir, 'pdpp.sqlite');
    try {
      await fn(dbPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function seedSqliteConnection(connectorInstanceId, connectorId, manifest) {
  getDb()
    .prepare('INSERT OR IGNORE INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)')
    .run(connectorId, JSON.stringify(manifest), NOW);
  getDb()
    .prepare(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       ) VALUES (?, 'owner_local', ?, 'x', 'active', 'account', ?, '{}', ?, ?, NULL)`,
    )
    .run(connectorInstanceId, connectorId, connectorInstanceId, NOW, NOW);
}

let sqliteEventSeq = 0;

/**
 * Insert a terminal event with `data_json` identity but the
 * `connector_instance_id` COLUMN left NULL — the exact migration-shaped
 * (pre-upgrade) row shape Sol's verdict reproduced. `column` accepts an
 * explicit override so a test can simulate "this row predates the column"
 * by inserting it as NULL directly, distinct from a genuinely unattributed
 * legacy event (identityFields null).
 */
function seedSqliteTerminalEventOldShape(connectorInstanceId, streams, { identityFields = true } = {}) {
  sqliteEventSeq += 1;
  const data = {
    ...(identityFields ? { connector_instance_id: connectorInstanceId, connection_id: connectorInstanceId } : {}),
    collection_facts: { reference_only: true, schema_version: 1, streams },
  };
  // This fixture is intentionally pre-trigger as well as pre-column: a
  // current write is source-stamped immediately and must not masquerade as
  // an upgrade-era row.
  getDb().exec('DROP TRIGGER IF EXISTS stamp_terminal_manifest_generation');
  getDb()
    .prepare(
      `INSERT INTO spine_events(
         event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
         actor_type, actor_id, object_type, object_id, status, run_id, connector_instance_id, data_json, version
       )
       VALUES(?, ?, 'run.completed', ?, ?, 'test', ?, 'runtime', 'test-connector', 'run', ?, 'succeeded', ?, NULL, ?, '1')`,
    )
    .run(
      `evt_${sqliteEventSeq}`,
      sqliteEventSeq,
      NOW,
      NOW,
      `trace_${sqliteEventSeq}`,
      `run_${sqliteEventSeq}`,
      `run_${sqliteEventSeq}`,
      JSON.stringify(data),
    );
  return sqliteEventSeq;
}

test(
  'SQLite: migration backfills identity but keeps pre-generation terminal facts historical',
  withTempDbPath(async (dbPath) => {
    // Boot 1: create the connection + a current evidence row at checkpoint 0
    // (no terminal events exist yet) — the migration/column/index already
    // exist from this boot forward.
    initDb(dbPath);
    seedSqliteConnection('cin_backfill_target', MANIFEST.connector_id, MANIFEST);
    await rebuildConnectorSummaryEvidence();
    const before = await getConnectorSummaryEvidence('cin_backfill_target');
    assert.equal(before.stream_facts_event_seq, 0, 'starts genuinely checkpointed-empty, not unobserved');

    // Insert a migration-shaped terminal event: data_json carries the
    // identity, but the column is NULL — exactly what a row written before
    // this migration existed would look like.
    const targetEventSeq = seedSqliteTerminalEventOldShape('cin_backfill_target', [
      { stream: 'messages', resolved: true, record_count: 7 },
    ]);
    const preBackfillColumn = getDb()
      .prepare('SELECT connector_instance_id FROM spine_events WHERE event_id = ?')
      .get(`evt_${targetEventSeq}`);
    assert.equal(preBackfillColumn.connector_instance_id, null, 'fixture: the column is genuinely NULL before reboot');
    closeDb();

    // Boot 2 ("the upgrade boot"): initDb runs the backfill migration.
    initDb(dbPath);
    const postBackfillColumn = getDb()
      .prepare('SELECT connector_instance_id FROM spine_events WHERE event_id = ?')
      .get(`evt_${targetEventSeq}`);
    assert.equal(
      postBackfillColumn.connector_instance_id,
      'cin_backfill_target',
      'the backfill migration populates the column from data_json.connector_instance_id on the next boot',
    );

    assert.equal(
      getDb().prepare('SELECT manifest_generation FROM spine_events WHERE event_id = ?').get(`evt_${targetEventSeq}`).manifest_generation,
      null,
      'identity migration never invents a source generation for an old terminal row',
    );

    // The real SCOPED path sees the row but refuses it as historical.
    const scoped = await foldConnectorSummaryStreamFacts(['cin_backfill_target']);
    assert.equal(scoped.participants, 1);
    assert.equal(scoped.folded, 0);
    assert.equal(scoped.refused, 1);

    const evidence = await getConnectorSummaryEvidence('cin_backfill_target');
    assert.equal(evidence.stream_facts_event_seq, 0, 'historical rows do not advance current terminal proof');
    assert.equal(evidence.stream_latest_facts, null);
    assert.equal(evidence.terminal_facts?.state, 'stale');
    assert.equal(evidence.terminal_facts?.reason_code, 'terminal_facts_historical');

    closeDb();
  }),
);

test(
  'SQLite: the backfill does not cross connections and leaves genuinely unattributable legacy events refused',
  withTempDbPath(async (dbPath) => {
    initDb(dbPath);
    seedSqliteConnection('cin_backfill_target', MANIFEST.connector_id, MANIFEST);
    seedSqliteConnection('cin_backfill_unrelated', UNRELATED_MANIFEST.connector_id, UNRELATED_MANIFEST);
    await rebuildConnectorSummaryEvidence();

    const targetSeq = seedSqliteTerminalEventOldShape('cin_backfill_target', [
      { stream: 'messages', resolved: true, record_count: 3 },
    ]);
    const unrelatedSeq = seedSqliteTerminalEventOldShape('cin_backfill_unrelated', [
      { stream: 'messages', resolved: true, record_count: 9 },
    ]);
    // A genuinely unattributable legacy event: no identity in data_json at
    // all (a real pre-scoping connector-wide event) — the backfill must
    // leave this NULL, not fabricate an attribution.
    const unattributedSeq = seedSqliteTerminalEventOldShape('cin_backfill_target', [], { identityFields: false });
    closeDb();

    initDb(dbPath);
    const rows = getDb()
      .prepare('SELECT event_id, connector_instance_id FROM spine_events WHERE event_id IN (?, ?, ?)')
      .all(`evt_${targetSeq}`, `evt_${unrelatedSeq}`, `evt_${unattributedSeq}`);
    const byId = Object.fromEntries(rows.map((r) => [r.event_id, r.connector_instance_id]));
    assert.equal(byId[`evt_${targetSeq}`], 'cin_backfill_target');
    assert.equal(byId[`evt_${unrelatedSeq}`], 'cin_backfill_unrelated');
    assert.equal(
      byId[`evt_${unattributedSeq}`],
      null,
      'a genuinely unattributable legacy event (no identity in data_json) stays NULL — the backfill never fabricates one',
    );

    // Scoped fold for the target sees ONLY its own backfilled row.
    const scoped = await foldConnectorSummaryStreamFacts(['cin_backfill_target']);
    assert.equal(scoped.participants, 1);
    assert.equal(scoped.folded, 0);
    assert.equal(scoped.refused, 1, 'the source-attributed legacy event is historical; unattributed history is never scoped in');

    const targetEvidence = await getConnectorSummaryEvidence('cin_backfill_target');
    assert.equal(targetEvidence.stream_latest_facts, null);
    assert.equal(targetEvidence.terminal_facts?.state, 'stale');
    const unrelatedEvidence = await getConnectorSummaryEvidence('cin_backfill_unrelated');
    assert.equal(unrelatedEvidence.stream_facts_event_seq, 0, 'the unrelated connection is untouched by the target-scoped fold');

    closeDb();
  }),
);

test(
  'SQLite: the real mounted route and startup sweep preserve historical terminal uncertainty after reboot',
  withTempDbPath(async (dbPath) => {
    initDb(dbPath);
    seedSqliteConnection('cin_backfill_route', MANIFEST.connector_id, MANIFEST);
    getDb()
      .prepare(
        `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, semantic_time, version, deleted)
         VALUES (?, 'cin_backfill_route', 'messages', 'r1', '{}', ?, ?, 1, 0)`,
      )
      .run(MANIFEST.connector_id, NOW, NOW);
    await rebuildConnectorSummaryEvidence();
    seedSqliteTerminalEventOldShape('cin_backfill_route', [{ stream: 'messages', resolved: true, record_count: 1 }]);
    closeDb();

    initDb(dbPath);
    const routeSummary = await getConnectorSummaryForRoute('cin_backfill_route');
    assert.ok(routeSummary, 'the real single-connection route resolves after the upgrade boot');
    assert.equal(routeSummary.total_records, 1);
    assert.equal(
      routeSummary.stream_records?.find((s) => s.stream === 'messages')?.record_count,
      1,
      'canonical records remain visible independently of terminal provenance',
    );

    assert.equal(routeSummary.terminal_facts.state, 'stale');

    // The startup sweep (which pages connections into the same scoped
    // barrier) preserves the same source-provenance refusal.
    const sweep = await runBoundedSummaryEvidenceSweep({ maxDurationMs: 60_000, pageSize: 25 });
    assert.equal(sweep.incomplete, false);
    const evidence = await getConnectorSummaryEvidence('cin_backfill_route');
    assert.equal(evidence.stream_facts_event_seq, 0);
    assert.equal(evidence.terminal_facts?.state, 'stale');

    closeDb();
  }),
);

// ─── Postgres (gated) ───────────────────────────────────────────────────

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);

async function seedPostgresConnection(connectorInstanceId, connectorId, manifest) {
  await postgresQuery('DELETE FROM connectors WHERE connector_id = $1', [connectorId]);
  await postgresQuery('INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3)', [
    connectorId,
    JSON.stringify(manifest),
    NOW,
  ]);
  await postgresQuery(
    `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
     ) VALUES ($1, 'owner_local', $2, 'x', 'active', 'account', $1, '{}'::jsonb, $3, $3, NULL)`,
    [connectorInstanceId, connectorId, NOW],
  );
}

let postgresEventSeq = 0;

async function seedPostgresTerminalEventOldShape(connectorInstanceId, streams, { identityFields = true } = {}) {
  postgresEventSeq += 1;
  const data = {
    ...(identityFields ? { connector_instance_id: connectorInstanceId, connection_id: connectorInstanceId } : {}),
    collection_facts: { reference_only: true, schema_version: 1, streams },
  };
  await postgresQuery('ALTER TABLE spine_events DISABLE TRIGGER stamp_terminal_manifest_generation');
  try {
    await postgresQuery(
      `INSERT INTO spine_events(
       event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
       actor_type, actor_id, object_type, object_id, status, run_id, connector_instance_id, data_json, version
     )
     VALUES($1, (SELECT COALESCE(MAX(event_seq),0)+1 FROM spine_events), 'run.completed', $2, $2, 'test', $3, 'runtime', 'test-connector', 'run', $4, 'succeeded', $5, NULL, $6::jsonb, '1')`,
    [
      `evt_pg_backfill_${postgresEventSeq}`,
      NOW,
      `trace_pg_backfill_${postgresEventSeq}`,
      `run_pg_backfill_${postgresEventSeq}`,
      `run_pg_backfill_${postgresEventSeq}`,
      JSON.stringify(data),
      ],
    );
  } finally {
    await postgresQuery('ALTER TABLE spine_events ENABLE TRIGGER stamp_terminal_manifest_generation');
  }
  return `evt_pg_backfill_${postgresEventSeq}`;
}

async function cleanupPostgres() {
  for (const connectorId of [MANIFEST.connector_id, UNRELATED_MANIFEST.connector_id]) {
    await postgresQuery('DELETE FROM connector_summary_evidence WHERE connector_id = $1', [connectorId]);
    await postgresQuery('DELETE FROM records WHERE connector_id = $1', [connectorId]);
    await postgresQuery('DELETE FROM connector_instances WHERE connector_id = $1', [connectorId]);
    await postgresQuery('DELETE FROM connectors WHERE connector_id = $1', [connectorId]);
  }
  await postgresQuery('DELETE FROM spine_events WHERE event_id LIKE $1', ['evt_pg_backfill_%']);
  postgresEventSeq = 0;
}

test(
  'real PostgreSQL: migration backfills identity but refuses pre-generation terminal facts',
  { skip: !POSTGRES_URL },
  async () => {
    let beforeCheckpoint;
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });
    try {
      await cleanupPostgres();
      await seedPostgresConnection('cin_backfill_target_pg', MANIFEST.connector_id, MANIFEST);
      await rebuildConnectorSummaryEvidence();
      const before = await getConnectorSummaryEvidence('cin_backfill_target_pg');
      beforeCheckpoint = Number(before.stream_facts_event_seq);

      const eventId = await seedPostgresTerminalEventOldShape('cin_backfill_target_pg', [
        { stream: 'messages', resolved: true, record_count: 7 },
      ]);
      const preBackfill = await postgresQuery('SELECT connector_instance_id FROM spine_events WHERE event_id = $1', [
        eventId,
      ]);
      assert.equal(preBackfill.rows[0].connector_instance_id, null, 'fixture: genuinely NULL before reboot');
    } finally {
      await closePostgresStorage();
    }

    // "Reboot": close and reopen storage — the bootstrap DDL (including the
    // backfill UPDATE) runs again on initPostgresStorage.
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });
    try {
      const eventRow = await postgresQuery(
        "SELECT event_id, connector_instance_id, manifest_generation FROM spine_events WHERE event_id LIKE 'evt_pg_backfill_%' ORDER BY event_seq DESC LIMIT 1",
      );
      assert.equal(
        eventRow.rows[0].connector_instance_id,
        'cin_backfill_target_pg',
        'the backfill UPDATE populates the column from data_json on the next bootstrap',
      );
      assert.equal(eventRow.rows[0].manifest_generation, null, 'bootstrap does not invent legacy source provenance');

      const scoped = await foldConnectorSummaryStreamFacts(['cin_backfill_target_pg']);
      assert.equal(scoped.participants, 1);
      assert.equal(scoped.folded, 0);
      assert.equal(scoped.refused, 1);

      const evidence = await getConnectorSummaryEvidence('cin_backfill_target_pg');
      assert.equal(Number(evidence.stream_facts_event_seq), beforeCheckpoint);
      assert.equal(evidence.stream_latest_facts, null);
      assert.equal(evidence.terminal_facts?.state, 'stale');
      assert.equal(evidence.terminal_facts?.reason_code, 'terminal_facts_historical');
    } finally {
      await cleanupPostgres();
      await closePostgresStorage();
    }
  },
);

test(
  'real PostgreSQL: the backfill does not cross connections and leaves genuinely unattributable legacy events NULL',
  { skip: !POSTGRES_URL },
  async () => {
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });
    let targetEventId;
    let unrelatedEventId;
    let unattributedEventId;
    let unrelatedBaseline;
    try {
      await cleanupPostgres();
      await seedPostgresConnection('cin_backfill_target_pg', MANIFEST.connector_id, MANIFEST);
      await seedPostgresConnection('cin_backfill_unrelated_pg', UNRELATED_MANIFEST.connector_id, UNRELATED_MANIFEST);
      await rebuildConnectorSummaryEvidence();
      unrelatedBaseline = Number((await getConnectorSummaryEvidence('cin_backfill_unrelated_pg')).stream_facts_event_seq);

      targetEventId = await seedPostgresTerminalEventOldShape('cin_backfill_target_pg', [
        { stream: 'messages', resolved: true, record_count: 3 },
      ]);
      unrelatedEventId = await seedPostgresTerminalEventOldShape('cin_backfill_unrelated_pg', [
        { stream: 'messages', resolved: true, record_count: 9 },
      ]);
      unattributedEventId = await seedPostgresTerminalEventOldShape('cin_backfill_target_pg', [], {
        identityFields: false,
      });
    } finally {
      await closePostgresStorage();
    }

    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });
    try {
      const rows = await postgresQuery(
        'SELECT event_id, connector_instance_id FROM spine_events WHERE event_id = ANY($1::text[])',
        [[targetEventId, unrelatedEventId, unattributedEventId]],
      );
      const byId = Object.fromEntries(rows.rows.map((r) => [r.event_id, r.connector_instance_id]));
      assert.equal(byId[targetEventId], 'cin_backfill_target_pg');
      assert.equal(byId[unrelatedEventId], 'cin_backfill_unrelated_pg');
      assert.equal(byId[unattributedEventId], null, 'a genuinely unattributable legacy event stays NULL on real PostgreSQL too');

      const scoped = await foldConnectorSummaryStreamFacts(['cin_backfill_target_pg']);
      assert.equal(scoped.participants, 1);
      assert.equal(scoped.folded, 0);
      assert.equal(scoped.refused, 1);

      const unrelatedEvidence = await getConnectorSummaryEvidence('cin_backfill_unrelated_pg');
      assert.equal(Number(unrelatedEvidence.stream_facts_event_seq), unrelatedBaseline, 'the unrelated connection is untouched by the target-scoped fold');
    } finally {
      await cleanupPostgres();
      await closePostgresStorage();
    }
  },
);
