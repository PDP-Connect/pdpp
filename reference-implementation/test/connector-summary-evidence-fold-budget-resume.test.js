// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Budgeted, resumable per-connection fold (Sol fourth-verdict P1.2 /
 * minimum-closure item 2): "Make fold work itself budgeted and resumable.
 * Add an explicit max-events/time budget to the fold and return durable/
 * typed continuation state for an incomplete connection/page. Startup must
 * resume the same incomplete fold before advancing its connection cursor.
 * Gate prunedComplete on both a complete canonical connection census and
 * complete folds. Add a single-connection, multi-batch deterministic
 * oracle on SQLite and real PostgreSQL proving the first pass stops within
 * the work bound, reports incomplete without complete pruning, follow-ups
 * resume rather than restart/skip, and eventual state equals an unbounded
 * oracle."
 *
 * Sol's deterministic reproduction: one connection with 2,001 attributable
 * terminal events, `runBoundedSummaryEvidenceSweep({maxDurationMs:1,
 * pageSize:25})` still folded all 2,001 events and returned
 * `incomplete:false`/`resumeAfterId:null`/`prunedComplete:true` — the fold's
 * own batch-drain loop had no deadline/max-events budget at all, so page-
 * level resumability could not help: there was never anything to resume.
 *
 * This file proves the fix at three layers:
 *   1. `foldConnectorSummaryStreamFacts` itself respects an explicit
 *      `maxDurationMs`/`maxEvents` budget, stops mid-drain, and writes a
 *      genuine PARTIAL-progress checkpoint (not the pass's full high-water
 *      mark) that a follow-up call resumes from.
 *   2. `runBoundedSummaryEvidenceSweep` threads a page's remaining budget
 *      into its fold, reports the WHOLE sweep incomplete when any page's
 *      fold does not converge, resumes the SAME page (not past it), and
 *      only runs complete-set pruning once every page AND every fold
 *      genuinely converged.
 *   3. A multi-round walk (repeatedly calling the sweep with its own
 *      returned cursor) converges to EXACTLY the same final state an
 *      unbounded oracle call would reach — proving resumption, not
 *      silent loss.
 */

import assert from 'node:assert/strict';
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
import { dedicatedPostgresTestUrl } from './helpers/dedicated-postgres-test-url.js';
import { closePostgresStorage, initPostgresStorage, postgresQuery } from '../server/postgres-storage.js';

const NOW = '2026-07-17T00:00:00.000Z';
const EVENT_COUNT = 2001;

// ─── SQLite ─────────────────────────────────────────────────────────────

function withTempDb(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdpp-fold-budget-'));
    try {
      initDb(join(dir, 'pdpp.sqlite'));
      await fn();
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function seedSqliteConnection(connectorInstanceId, connectorId = 'c1') {
  getDb()
    .prepare('INSERT OR IGNORE INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)')
    .run(connectorId, '{}', NOW);
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

function seedSqliteTerminalEvents(connectorInstanceId, count) {
  const stmt = getDb().prepare(
    `INSERT INTO spine_events(
       event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
       actor_type, actor_id, object_type, object_id, status, run_id, connector_instance_id, data_json, version
     ) VALUES (?, ?, 'run.completed', ?, ?, 'test', ?, 'runtime', 'test', 'run', ?, 'succeeded', ?, ?, ?, '1')`,
  );
  for (let i = 0; i < count; i += 1) {
    sqliteEventSeq += 1;
    const data = JSON.stringify({
      connector_instance_id: connectorInstanceId,
      connection_id: connectorInstanceId,
      collection_facts: { reference_only: true, schema_version: 1, streams: [{ stream: 'messages', resolved: true, record_count: sqliteEventSeq }] },
    });
    stmt.run(
      `evt_${sqliteEventSeq}`,
      sqliteEventSeq,
      NOW,
      NOW,
      `trace_${sqliteEventSeq}`,
      `run_${sqliteEventSeq}`,
      `run_${sqliteEventSeq}`,
      connectorInstanceId,
      data,
    );
  }
  return sqliteEventSeq;
}

test(
  'SQLite: foldConnectorSummaryStreamFacts itself respects an explicit maxEvents budget and reports incomplete without reaching the high-water mark',
  withTempDb(async () => {
    seedSqliteConnection('cin_budget_target');
    await rebuildConnectorSummaryEvidence();
    const targetSeq = seedSqliteTerminalEvents('cin_budget_target', EVENT_COUNT);

    const result = await foldConnectorSummaryStreamFacts(['cin_budget_target'], { maxEvents: 500 });

    assert.equal(result.incomplete, true, 'the fold genuinely stopped before reaching the full 2,001-event history');
    assert.ok(result.resumeAfterSeq !== null && result.resumeAfterSeq < targetSeq, 'the resume cursor is a real partial position, not the final high-water mark');

    const evidence = await getConnectorSummaryEvidence('cin_budget_target');
    assert.equal(
      Number(evidence.stream_facts_event_seq),
      result.resumeAfterSeq,
      'the durable checkpoint is written at the PARTIAL position the drain reached, not the full maxSeq',
    );
    assert.notEqual(Number(evidence.stream_facts_event_seq), targetSeq, 'the checkpoint has NOT falsely advanced to the full high-water mark');
  }),
);

test(
  'SQLite: a follow-up call with the same scope RESUMES from the partial checkpoint rather than restarting or skipping, converging to the unbounded oracle value',
  withTempDb(async () => {
    seedSqliteConnection('cin_budget_resume');
    await rebuildConnectorSummaryEvidence();
    const targetSeq = seedSqliteTerminalEvents('cin_budget_resume', EVENT_COUNT);

    const first = await foldConnectorSummaryStreamFacts(['cin_budget_resume'], { maxEvents: 500 });
    assert.equal(first.incomplete, true);
    const afterFirst = await getConnectorSummaryEvidence('cin_budget_resume');
    const checkpointAfterFirst = Number(afterFirst.stream_facts_event_seq);
    assert.ok(checkpointAfterFirst > 0 && checkpointAfterFirst < targetSeq);

    // Repeated bounded calls (never an unbounded one) walk the whole
    // history to completion — proving genuine multi-round resumption.
    let rounds = 1;
    let last = first;
    while (last.incomplete) {
      last = await foldConnectorSummaryStreamFacts(['cin_budget_resume'], { maxEvents: 500 });
      rounds += 1;
      assert.ok(rounds < 20, 'sanity bound: must converge well within 20 bounded rounds for 2,001 events at 500/round');
    }

    const finalEvidence = await getConnectorSummaryEvidence('cin_budget_resume');
    assert.equal(Number(finalEvidence.stream_facts_event_seq), targetSeq, 'eventual state equals the unbounded oracle checkpoint');
    assert.equal(
      finalEvidence.stream_latest_facts?.messages?.fact?.record_count,
      targetSeq,
      'eventual state equals the unbounded oracle fact (record_count is stamped equal to its own event_seq by the fixture) — the LAST event genuinely folded, not merely the checkpoint advanced',
    );
    assert.ok(rounds > 1, 'genuinely took multiple rounds — this is resumption, not a single lucky call');
  }),
);

test(
  'SQLite: runBoundedSummaryEvidenceSweep reports the WHOLE sweep incomplete and skips complete pruning when a page\'s fold does not converge',
  withTempDb(async () => {
    seedSqliteConnection('cin_sweep_budget');
    await rebuildConnectorSummaryEvidence();
    seedSqliteTerminalEvents('cin_sweep_budget', EVENT_COUNT);

    const result = await runBoundedSummaryEvidenceSweep({
      maxDurationMs: 60_000,
      pageSize: 25,
      maxEventsPerFold: 500,
    });

    assert.equal(result.incomplete, true, 'the sweep is incomplete because the page\'s own fold did not converge, even though discovery+repair for the page finished');
    assert.equal(result.prunedComplete, false, 'complete-set pruning must NOT run when a page\'s fold left terminal history unfolded');
    assert.ok(result.resumeAfterId !== undefined, 'a resume cursor is returned');
  }),
);

test(
  'SQLite: a follow-up sweep resumes the SAME still-incomplete page (not past it) and eventually converges with complete pruning',
  withTempDb(async () => {
    // 30 connections across two pages (pageSize 25): page 1 = 25 ordinary
    // connections with no terminal history, page 2 = 5 connections, one of
    // which (cin_0026) carries a large terminal history a small
    // maxEventsPerFold cannot finish in one shot.
    for (let i = 0; i < 30; i += 1) {
      seedSqliteConnection(`cin_${String(i).padStart(4, '0')}`);
    }
    await rebuildConnectorSummaryEvidence();
    const targetSeq = seedSqliteTerminalEvents('cin_0026', 4500);

    let rounds = 0;
    let afterId = null;
    let last;
    do {
      rounds += 1;
      last = await runBoundedSummaryEvidenceSweep({
        maxDurationMs: 60_000,
        pageSize: 25,
        maxEventsPerFold: 200,
        afterId,
      });
      afterId = last.resumeAfterId;
      assert.ok(rounds < 30, 'sanity bound: must converge well within 30 rounds');
    } while (last.incomplete);

    assert.equal(last.prunedComplete, true, 'the final converging round runs complete-set pruning');

    const targetEvidence = await getConnectorSummaryEvidence('cin_0026');
    assert.equal(
      Number(targetEvidence.stream_facts_event_seq),
      targetSeq,
      'the stuck connection eventually reaches the unbounded oracle checkpoint across resumed rounds',
    );
    // Every OTHER connection (converged in the very first page) is untouched
    // by the later resumed rounds re-processing page 2 — proving resumption
    // targets exactly the incomplete page, not a blanket restart.
    const untouchedEvidence = await getConnectorSummaryEvidence('cin_0000');
    assert.equal(Number(untouchedEvidence.stream_facts_event_seq), 0);
    assert.ok(rounds > 1, 'genuinely required multiple rounds — proves resumption, not a single lucky sweep');
  }),
);

// ─── Postgres (gated) ───────────────────────────────────────────────────

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);

async function seedPostgresConnection(connectorInstanceId, connectorId = 'c1_pg_budget') {
  await postgresQuery('INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3) ON CONFLICT DO NOTHING', [
    connectorId,
    '{}',
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

async function seedPostgresTerminalEvents(connectorInstanceId, count) {
  for (let i = 0; i < count; i += 1) {
    postgresEventSeq += 1;
    const data = {
      connector_instance_id: connectorInstanceId,
      connection_id: connectorInstanceId,
      collection_facts: { reference_only: true, schema_version: 1, streams: [{ stream: 'messages', resolved: true, record_count: postgresEventSeq }] },
    };
    // eslint-disable-next-line no-await-in-loop
    await postgresQuery(
      `INSERT INTO spine_events(
         event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
         actor_type, actor_id, object_type, object_id, status, run_id, connector_instance_id, data_json, version
       ) VALUES($1, (SELECT COALESCE(MAX(event_seq),0)+1 FROM spine_events), 'run.completed', $2, $2, 'test', $3, 'runtime', 'test', 'run', $4, 'succeeded', $5, $6, $7::jsonb, '1')`,
      [
        `evt_pg_budget_${postgresEventSeq}`,
        NOW,
        `trace_pg_budget_${postgresEventSeq}`,
        `run_pg_budget_${postgresEventSeq}`,
        `run_pg_budget_${postgresEventSeq}`,
        connectorInstanceId,
        JSON.stringify(data),
      ],
    );
  }
  return postgresEventSeq;
}

async function cleanupPostgres() {
  await postgresQuery('DELETE FROM connector_summary_evidence WHERE connector_id = $1', ['c1_pg_budget']);
  await postgresQuery('DELETE FROM connector_instances WHERE connector_id = $1', ['c1_pg_budget']);
  await postgresQuery('DELETE FROM connectors WHERE connector_id = $1', ['c1_pg_budget']);
  await postgresQuery('DELETE FROM spine_events WHERE event_id LIKE $1', ['evt_pg_budget_%']);
  postgresEventSeq = 0;
}

test(
  'real PostgreSQL: foldConnectorSummaryStreamFacts respects an explicit maxEvents budget, reports incomplete, and a follow-up call resumes to the unbounded oracle value',
  { skip: !POSTGRES_URL },
  async () => {
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });
    try {
      await cleanupPostgres();
      await seedPostgresConnection('cin_budget_target_pg');
      await rebuildConnectorSummaryEvidence();
      const targetSeq = await seedPostgresTerminalEvents('cin_budget_target_pg', EVENT_COUNT);

      const first = await foldConnectorSummaryStreamFacts(['cin_budget_target_pg'], { maxEvents: 500 });
      assert.equal(first.incomplete, true);
      assert.ok(first.resumeAfterSeq !== null && first.resumeAfterSeq < targetSeq);

      const afterFirst = await getConnectorSummaryEvidence('cin_budget_target_pg');
      assert.equal(Number(afterFirst.stream_facts_event_seq), first.resumeAfterSeq);
      assert.notEqual(Number(afterFirst.stream_facts_event_seq), targetSeq);

      let rounds = 1;
      let last = first;
      while (last.incomplete) {
        // eslint-disable-next-line no-await-in-loop
        last = await foldConnectorSummaryStreamFacts(['cin_budget_target_pg'], { maxEvents: 500 });
        rounds += 1;
        assert.ok(rounds < 20);
      }

      const finalEvidence = await getConnectorSummaryEvidence('cin_budget_target_pg');
      assert.equal(Number(finalEvidence.stream_facts_event_seq), targetSeq, 'eventual state equals the unbounded oracle checkpoint on real PostgreSQL');
      assert.equal(
        finalEvidence.stream_latest_facts?.messages?.fact?.record_count,
        targetSeq,
        'record_count is stamped equal to its own event_seq by the fixture',
      );
      assert.ok(rounds > 1);
    } finally {
      await cleanupPostgres();
      await closePostgresStorage();
    }
  },
);

test(
  'real PostgreSQL: runBoundedSummaryEvidenceSweep reports incomplete and skips complete pruning when a page\'s fold does not converge, then resumes',
  { skip: !POSTGRES_URL },
  async () => {
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });
    try {
      await cleanupPostgres();
      await seedPostgresConnection('cin_sweep_budget_pg');
      await rebuildConnectorSummaryEvidence();
      const targetSeq = await seedPostgresTerminalEvents('cin_sweep_budget_pg', EVENT_COUNT);

      const first = await runBoundedSummaryEvidenceSweep({
        maxDurationMs: 60_000,
        pageSize: 25,
        maxEventsPerFold: 500,
      });
      assert.equal(first.incomplete, true, 'the sweep is incomplete on real PostgreSQL because the page\'s own fold did not converge');
      assert.equal(first.prunedComplete, false, 'complete-set pruning must not run on real PostgreSQL either');

      let rounds = 1;
      let last = first;
      let afterId = first.resumeAfterId;
      while (last.incomplete) {
        // eslint-disable-next-line no-await-in-loop
        last = await runBoundedSummaryEvidenceSweep({
          maxDurationMs: 60_000,
          pageSize: 25,
          maxEventsPerFold: 500,
          afterId,
        });
        afterId = last.resumeAfterId;
        rounds += 1;
        assert.ok(rounds < 30);
      }
      assert.equal(last.prunedComplete, true);

      const finalEvidence = await getConnectorSummaryEvidence('cin_sweep_budget_pg');
      assert.equal(Number(finalEvidence.stream_facts_event_seq), targetSeq, 'converges to the unbounded oracle value on real PostgreSQL after resumed rounds');
      assert.ok(rounds > 1);
    } finally {
      await cleanupPostgres();
      await closePostgresStorage();
    }
  },
);
