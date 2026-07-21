/**
 * Scoped fold vs. unrelated TERMINAL EVENT volume (Sol third-verdict P1.2 /
 * minimum-closure item 2): "Scope terminal high-water/event work to
 * attributable requested connections... prove the mounted HTTP journey on
 * SQLite AND real PostgreSQL with unrelated connections AND thousands of
 * unrelated terminal events, measuring executions/rows rather than
 * prepare/cache misses; assert unrelated history does not advance the
 * target through unbounded work."
 *
 * The prior N-slope test (`connector-summary-evidence-scoped-route-n-slope.
 * test.js`) varied only the NUMBER OF UNRELATED CONNECTIONS — it never
 * seeded unrelated TERMINAL EVENT history — and counted prepared-statement/
 * pool-call COUNTS rather than rows scanned. A constant statement count can
 * coexist with arbitrarily large global terminal-event batch work (the exact
 * gap Sol reproduced: one target row at checkpoint 0, 4,001 terminal events
 * attributed only to an unrelated connection — the scoped fold executed a
 * constant NUMBER of SELECTs but scanned/folded the full unrelated history
 * and advanced the target checkpoint to the global high-water mark).
 *
 * This file proves the opposite property directly: seeds thousands of
 * terminal events attributed ONLY to unrelated connections, then proves
 * (a) the ROWS returned by the terminal-event read scale with the TARGET's
 * own attributable history, not the unrelated volume, (b) the target's
 * checkpoint advances only to ITS OWN highest attributable event_seq, not
 * the global max, and (c) the real mounted route
 * (`getConnectorSummaryForRoute`) produces a correct, cheap result despite
 * the unrelated volume — on both SQLite and real PostgreSQL.
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
} from '../server/connector-summary-read-model.ts';
import { getConnectorSummaryForRoute } from '../server/ref-control.ts';
import { dedicatedPostgresTestUrl } from './helpers/dedicated-postgres-test-url.js';
import { closePostgresStorage, getPostgresPool, initPostgresStorage, postgresQuery } from '../server/postgres-storage.js';

const NOW = '2026-07-17T00:00:00.000Z';
const UNRELATED_TERMINAL_EVENT_COUNT = 4001;

const MANIFEST = {
  protocol_version: '0.1.0',
  connector_id: 'scoped-fold-target',
  version: '1.0.0',
  display_name: 'Scoped Fold Target',
  capabilities: { public_listing: { listed: true, status: 'test' } },
  streams: [{ name: 'messages', primary_key: ['id'] }],
};

const UNRELATED_MANIFEST = {
  protocol_version: '0.1.0',
  connector_id: 'scoped-fold-unrelated',
  version: '1.0.0',
  display_name: 'Scoped Fold Unrelated',
  capabilities: { public_listing: { listed: true, status: 'test' } },
  streams: [{ name: 'messages', primary_key: ['id'] }],
};

// ─── SQLite ─────────────────────────────────────────────────────────────

function withTempDb(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdpp-scoped-fold-history-'));
    try {
      initDb(join(dir, 'pdpp.sqlite'));
      await fn();
    } finally {
      closeDb();
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
 * Insert a terminal event with connector_instance_id populated on the FIRST-
 * CLASS COLUMN (not just data_json) — the exact shape `emitSpineEvent` now
 * produces after the P1.2 schema/write-path fix. Using the raw column here
 * (rather than routing every seed event through `emitSpineEvent`) keeps
 * seeding thousands of rows fast while still exercising the same column the
 * scoped SQL read filters on.
 */
function seedSqliteTerminalEvent(connectorInstanceId, streams) {
  sqliteEventSeq += 1;
  const data = {
    connector_instance_id: connectorInstanceId,
    connection_id: connectorInstanceId,
    collection_facts: { reference_only: true, schema_version: 1, streams },
  };
  getDb()
    .prepare(
      `INSERT INTO spine_events(
         event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
         actor_type, actor_id, object_type, object_id, status, run_id, connector_instance_id, data_json, version
       )
       VALUES(?, ?, 'run.completed', ?, ?, 'test', ?, 'runtime', 'test-connector', 'run', ?, 'succeeded', ?, ?, ?, '1')`,
    )
    .run(
      `evt_${sqliteEventSeq}`,
      sqliteEventSeq,
      NOW,
      NOW,
      `trace_${sqliteEventSeq}`,
      `run_${sqliteEventSeq}`,
      `run_${sqliteEventSeq}`,
      connectorInstanceId,
      JSON.stringify(data),
    );
  return sqliteEventSeq;
}

async function countRowsReturned(fn) {
  let rowsReturned = 0;
  const originalPrepare = Database.prototype.prepare;
  Database.prototype.prepare = function patchedPrepare(sql, ...rest) {
    const stmt = originalPrepare.call(this, sql, ...rest);
    if (!/FROM spine_events/.test(sql)) {
      return stmt;
    }
    const originalAll = stmt.all.bind(stmt);
    const originalGet = stmt.get.bind(stmt);
    stmt.all = (...args) => {
      const rows = originalAll(...args);
      rowsReturned += Array.isArray(rows) ? rows.length : 0;
      return rows;
    };
    stmt.get = (...args) => {
      const row = originalGet(...args);
      rowsReturned += row ? 1 : 0;
      return row;
    };
    return stmt;
  };
  try {
    const result = await fn();
    return { result, rowsReturned };
  } finally {
    Database.prototype.prepare = originalPrepare;
  }
}

test(
  'SQLite: scoped fold reads/folds ONLY the target connection\'s terminal history — 4,001 unrelated terminal events do not inflate rows scanned or advance the checkpoint',
  withTempDb(async () => {
    seedSqliteConnection('cin_scoped_target', MANIFEST.connector_id, MANIFEST);
    seedSqliteConnection('cin_scoped_unrelated', UNRELATED_MANIFEST.connector_id, UNRELATED_MANIFEST);
    await rebuildConnectorSummaryEvidence();

    // Thousands of terminal events, every one attributed ONLY to the
    // unrelated connection — none reference the target at all.
    for (let i = 0; i < UNRELATED_TERMINAL_EVENT_COUNT; i += 1) {
      seedSqliteTerminalEvent('cin_scoped_unrelated', [
        { stream: 'messages', resolved: true, record_count: i },
      ]);
    }
    // One genuine terminal event for the target, folded LAST (highest
    // event_seq) so any accidental use of the global high-water mark vs. a
    // target-scoped one is indistinguishable by "did it fold anything" alone
    // — the checkpoint-value assertion below is what actually catches it.
    const targetEventSeq = seedSqliteTerminalEvent('cin_scoped_target', [
      { stream: 'messages', resolved: true, record_count: 7 },
    ]);

    const { result: foldResult, rowsReturned } = await countRowsReturned(() =>
      foldConnectorSummaryStreamFacts(['cin_scoped_target']),
    );

    assert.equal(foldResult.participants, 1, 'only the one requested connection participates');
    assert.equal(foldResult.folded, 1, 'exactly the target\'s own one attributable fact set is folded');
    assert.equal(foldResult.refused, 0, 'no unrelated event is even visited, so none is counted refused');
    assert.ok(
      rowsReturned < 50,
      `scoped fold read/returned ${rowsReturned} spine_events rows against 4,001 unrelated terminal events — ` +
        `rows scanned must scale with the target's own history, not unrelated volume`,
    );

    const evidence = await getConnectorSummaryEvidence('cin_scoped_target');
    assert.equal(
      evidence.stream_facts_event_seq,
      targetEventSeq,
      'checkpoint advances to the TARGET connection\'s own highest attributable event_seq, not the global max ' +
        '(the 4,001 unrelated events all have higher event_seq than the target\'s single event)',
    );
    assert.equal(
      evidence.stream_latest_facts?.messages?.fact?.record_count,
      7,
      'the target\'s own fact genuinely folded',
    );

    // The unrelated connection's own evidence is untouched by the scoped
    // fold call above (it was never in scope) — confirms isolation, not
    // merely omission from this pass's return value.
    const unrelatedEvidence = await getConnectorSummaryEvidence('cin_scoped_unrelated');
    assert.equal(
      unrelatedEvidence.stream_facts_event_seq,
      0,
      'the unrelated connection was stamped to checkpoint 0 by the earlier rebuildConnectorSummaryEvidence ' +
        '(no terminal events existed yet at that time) and the scoped fold call must not have touched it',
    );
  }),
);

test(
  'SQLite: the real mounted route (getConnectorSummaryForRoute) resolves correctly despite thousands of unrelated terminal events',
  withTempDb(async () => {
    seedSqliteConnection('cin_scoped_target', MANIFEST.connector_id, MANIFEST);
    seedSqliteConnection('cin_scoped_unrelated', UNRELATED_MANIFEST.connector_id, UNRELATED_MANIFEST);
    getDb()
      .prepare(
        `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, semantic_time, version, deleted)
         VALUES (?, 'cin_scoped_target', 'messages', 'r1', '{}', ?, ?, 1, 0)`,
      )
      .run(MANIFEST.connector_id, NOW, NOW);
    await rebuildConnectorSummaryEvidence();

    for (let i = 0; i < UNRELATED_TERMINAL_EVENT_COUNT; i += 1) {
      seedSqliteTerminalEvent('cin_scoped_unrelated', [
        { stream: 'messages', resolved: true, record_count: i },
      ]);
    }
    seedSqliteTerminalEvent('cin_scoped_target', [{ stream: 'messages', resolved: true, record_count: 1 }]);

    const { result: summary, rowsReturned } = await countRowsReturned(() =>
      getConnectorSummaryForRoute('cin_scoped_target'),
    );

    assert.ok(summary, 'the route resolves a real synthesized summary');
    assert.equal(summary.total_records, 1);
    assert.ok(
      rowsReturned < 50,
      `getConnectorSummaryForRoute (full discovery+fold+synthesis chain) read/returned ${rowsReturned} spine_events ` +
        `rows against 4,001 unrelated terminal events — must not scale with unrelated history`,
    );
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

async function seedPostgresTerminalEvent(connectorInstanceId, streams) {
  postgresEventSeq += 1;
  const data = {
    connector_instance_id: connectorInstanceId,
    connection_id: connectorInstanceId,
    collection_facts: { reference_only: true, schema_version: 1, streams },
  };
  await postgresQuery(
    `INSERT INTO spine_events(
       event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
       actor_type, actor_id, object_type, object_id, status, run_id, connector_instance_id, data_json, version
     )
     VALUES($1, $2, 'run.completed', $3, $3, 'test', $4, 'runtime', 'test-connector', 'run', $5, 'succeeded', $6, $7, $8::jsonb, '1')`,
    [
      `evt_pg_${postgresEventSeq}`,
      postgresEventSeq,
      NOW,
      `trace_pg_${postgresEventSeq}`,
      `run_pg_${postgresEventSeq}`,
      `run_pg_${postgresEventSeq}`,
      connectorInstanceId,
      JSON.stringify(data),
    ],
  );
  return postgresEventSeq;
}

async function cleanupPostgres() {
  for (const connectorId of [MANIFEST.connector_id, UNRELATED_MANIFEST.connector_id]) {
    await postgresQuery('DELETE FROM connector_summary_evidence WHERE connector_id = $1', [connectorId]);
    await postgresQuery('DELETE FROM records WHERE connector_id = $1', [connectorId]);
    await postgresQuery('DELETE FROM connector_instances WHERE connector_id = $1', [connectorId]);
    await postgresQuery('DELETE FROM connectors WHERE connector_id = $1', [connectorId]);
  }
  await postgresQuery('DELETE FROM spine_events WHERE event_id LIKE $1', ['evt_pg_%']);
  postgresEventSeq = 0;
}

async function countPostgresRowsReturned(fn) {
  let rowsReturned = 0;
  const pool = getPostgresPool();
  const original = pool.query.bind(pool);
  pool.query = async (...args) => {
    const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text;
    const result = await original(...args);
    if (typeof sql === 'string' && /FROM spine_events/.test(sql)) {
      rowsReturned += Array.isArray(result?.rows) ? result.rows.length : 0;
    }
    return result;
  };
  try {
    const result = await fn();
    return { result, rowsReturned };
  } finally {
    pool.query = original;
  }
}

test(
  'real PostgreSQL: scoped fold reads/folds ONLY the target connection\'s terminal history despite 4,001 unrelated terminal events',
  { skip: !POSTGRES_URL },
  async () => {
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });
    try {
      await cleanupPostgres();
      await seedPostgresConnection('cin_scoped_target_pg', MANIFEST.connector_id, MANIFEST);
      await seedPostgresConnection('cin_scoped_unrelated_pg', UNRELATED_MANIFEST.connector_id, UNRELATED_MANIFEST);
      await rebuildConnectorSummaryEvidence();

      for (let i = 0; i < UNRELATED_TERMINAL_EVENT_COUNT; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await seedPostgresTerminalEvent('cin_scoped_unrelated_pg', [
          { stream: 'messages', resolved: true, record_count: i },
        ]);
      }
      const targetEventSeq = await seedPostgresTerminalEvent('cin_scoped_target_pg', [
        { stream: 'messages', resolved: true, record_count: 7 },
      ]);

      const { result: foldResult, rowsReturned } = await countPostgresRowsReturned(() =>
        foldConnectorSummaryStreamFacts(['cin_scoped_target_pg']),
      );

      assert.equal(foldResult.participants, 1);
      assert.equal(foldResult.folded, 1);
      assert.equal(foldResult.refused, 0);
      assert.ok(
        rowsReturned < 50,
        `scoped fold read/returned ${rowsReturned} spine_events rows against 4,001 unrelated terminal events on ` +
          `real PostgreSQL — rows scanned must scale with the target's own history, not unrelated volume`,
      );

      const evidence = await getConnectorSummaryEvidence('cin_scoped_target_pg');
      assert.equal(
        evidence.stream_facts_event_seq,
        targetEventSeq,
        'checkpoint advances to the TARGET connection\'s own highest attributable event_seq on real PostgreSQL, ' +
          'not the global max',
      );
      assert.equal(evidence.stream_latest_facts?.messages?.fact?.record_count, 7);
    } finally {
      await cleanupPostgres();
      await closePostgresStorage();
    }
  },
);

test(
  'real PostgreSQL: the real mounted route resolves correctly despite thousands of unrelated terminal events',
  { skip: !POSTGRES_URL },
  async () => {
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });
    try {
      await cleanupPostgres();
      await seedPostgresConnection('cin_scoped_target_pg', MANIFEST.connector_id, MANIFEST);
      await seedPostgresConnection('cin_scoped_unrelated_pg', UNRELATED_MANIFEST.connector_id, UNRELATED_MANIFEST);
      await postgresQuery(
        `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted, primary_key_text)
         VALUES ($1, 'cin_scoped_target_pg', 'messages', 'r1', '{}'::jsonb, $2, 1, false, 'r1')`,
        [MANIFEST.connector_id, NOW],
      );
      await rebuildConnectorSummaryEvidence();

      for (let i = 0; i < UNRELATED_TERMINAL_EVENT_COUNT; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await seedPostgresTerminalEvent('cin_scoped_unrelated_pg', [
          { stream: 'messages', resolved: true, record_count: i },
        ]);
      }
      await seedPostgresTerminalEvent('cin_scoped_target_pg', [{ stream: 'messages', resolved: true, record_count: 1 }]);

      const { result: summary, rowsReturned } = await countPostgresRowsReturned(() =>
        getConnectorSummaryForRoute('cin_scoped_target_pg'),
      );

      assert.ok(summary);
      assert.equal(summary.total_records, 1);
      assert.ok(
        rowsReturned < 50,
        `getConnectorSummaryForRoute read/returned ${rowsReturned} spine_events rows against 4,001 unrelated ` +
          `terminal events on real PostgreSQL — must not scale with unrelated history`,
      );
    } finally {
      await cleanupPostgres();
      await closePostgresStorage();
    }
  },
);
