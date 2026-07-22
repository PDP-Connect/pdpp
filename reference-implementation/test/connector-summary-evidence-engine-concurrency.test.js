// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Concurrency and cross-axis conformance
 * (openspec/changes/reconcile-active-summary-evidence design.md
 * "One scope-safe reconciliation primitive" + "Orthogonal projection
 * evidence"):
 *
 *   - A repair candidate's fenced re-read (inside the writer-fence
 *     transaction) is what gets persisted, never the pre-lock discovery
 *     snapshot — proven by landing a genuine ingest AFTER discovery reads
 *     the row but BEFORE the fenced repair transaction runs, then proving
 *     the persisted evidence reflects the ingest, not the stale snapshot.
 *   - The four evidence components are independent: a failed terminal
 *     fold does not launder a current, correct canonical count, and vice
 *     versa.
 *   - `known_zero` for a declared stream is independent of collection
 *     coverage (a completely different, unmeasured axis) — a stream can be
 *     an exact zero while coverage for the connection remains unmeasured.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { closeDb, getDb, initDb } from '../server/db.js';
import {
  reconcileConnectorSummaryEvidence,
} from '../server/connector-summary-evidence-engine.ts';
import { ingestRecord } from '../server/records.js';
import { listConnectorSummaries } from '../server/ref-control.ts';

const OWNER = 'owner_local';
const NOW = '2026-07-17T00:00:00.000Z';

async function withTempDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'pdpp-summary-concurrency-'));
  try {
    initDb(join(dir, 'pdpp.sqlite'));
    return await fn();
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedManifestConnector(connectorId, streams) {
  const manifest = {
    protocol_version: '0.1.0',
    connector_id: connectorId,
    version: '1.0.0',
    display_name: connectorId,
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
  getDb()
    .prepare('INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)')
    .run(connectorId, JSON.stringify(manifest), NOW);
  return manifest;
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

function storageTargetFor(connectorId, connectorInstanceId) {
  return { connector_id: connectorId, connector_instance_id: connectorInstanceId };
}

test('a fenced repair reflects an ingest that lands after discovery but before the fence, never the stale pre-lock snapshot', () =>
  withTempDb(async () => {
    const connectorId = 'https://test.pdpp.dev/connectors/concurrent-ingest';
    seedManifestConnector(connectorId, ['messages']);
    seedInstance('cin_concurrent', connectorId);

    // First pass: create the evidence row with 0 records.
    await reconcileConnectorSummaryEvidence(null);
    const before = getDb()
      .prepare('SELECT total_records FROM connector_summary_evidence WHERE connector_instance_id = ?')
      .get('cin_concurrent');
    assert.equal(before.total_records, 0);

    // Mark the row dirty (as an ingest normally would) WITHOUT actually
    // running the record through the durable ingest path yet — this
    // simulates "an ingest is about to land" the way discovery would see
    // the row as a dirty candidate but the underlying canonical write has
    // not landed when discovery itself runs.
    getDb()
      .prepare('UPDATE connector_summary_evidence SET dirty = 1 WHERE connector_instance_id = ?')
      .run('cin_concurrent');

    // The record lands via the REAL durable ingest path (allocates a
    // version, advances the checkpoint) BEFORE the repair pass below runs
    // its fenced re-read. A primitive that repaired from a pre-lock
    // snapshot captured before this ingest would persist 0 records; the
    // correct primitive re-reads canonical state INSIDE the fence and
    // persists 1.
    await ingestRecord(storageTargetFor(connectorId, 'cin_concurrent'), {
      stream: 'messages',
      key: 'msg_1',
      data: { id: 'msg_1' },
      emitted_at: NOW,
    });

    const result = await reconcileConnectorSummaryEvidence(null);
    assert.equal(result.repaired, 1, 'the dirty row is repaired');

    const after = getDb()
      .prepare('SELECT total_records FROM connector_summary_evidence WHERE connector_instance_id = ?')
      .get('cin_concurrent');
    assert.equal(after.total_records, 1, 'the fenced repair reflects the ingest, not a stale pre-lock snapshot');
  }));

test('two back-to-back reconcile passes converge to the same fresh canonical state without regressing each other', () =>
  withTempDb(async () => {
    const connectorId = 'https://test.pdpp.dev/connectors/two-pass-converge';
    seedManifestConnector(connectorId, ['messages']);
    seedInstance('cin_two_pass', connectorId);

    await ingestRecord(storageTargetFor(connectorId, 'cin_two_pass'), {
      stream: 'messages',
      key: 'msg_1',
      data: { id: 'msg_1' },
      emitted_at: NOW,
    });

    // Pass 1: creates + repairs.
    const pass1 = await reconcileConnectorSummaryEvidence(null);
    assert.equal(pass1.repaired, 1);

    // A second record lands between pass 1 and pass 2.
    await ingestRecord(storageTargetFor(connectorId, 'cin_two_pass'), {
      stream: 'messages',
      key: 'msg_2',
      data: { id: 'msg_2' },
      emitted_at: NOW,
    });

    // Pass 2: discovery sees the checkpoint mismatch from msg_2's ingest
    // (which marks the row dirty via markConnectorSummaryEvidenceDirty AND
    // advances the version_counter checkpoint) and repairs again.
    const pass2 = await reconcileConnectorSummaryEvidence(null);
    assert.ok(pass2.repaired >= 1, 'the second pass detects and repairs the new checkpoint mismatch');

    const finalRow = getDb()
      .prepare('SELECT total_records FROM connector_summary_evidence WHERE connector_instance_id = ?')
      .get('cin_two_pass');
    assert.equal(finalRow.total_records, 2, 'both passes converge to the same fresh canonical total, never regressing');
  }));

test('a failed terminal fold does not launder a current, correct canonical record count (component independence)', () =>
  withTempDb(async () => {
    const connectorId = 'https://test.pdpp.dev/connectors/failed-terminal-current-count';
    seedManifestConnector(connectorId, ['messages']);
    seedInstance('cin_failed_terminal', connectorId);
    await ingestRecord(storageTargetFor(connectorId, 'cin_failed_terminal'), {
      stream: 'messages',
      key: 'msg_1',
      data: { id: 'msg_1' },
      emitted_at: NOW,
    });
    await reconcileConnectorSummaryEvidence(null);

    // Force ONLY the terminal fold's own write to fail, while the
    // record_snapshot component is already current from the repair above.
    // NOTE: renaming `spine_events` (as this test previously did) does not
    // isolate a pure fold failure in this codebase — discovery's own fixed
    // query (`readSqliteDiscoveryContext`'s `maxTerminalEventSeq` lookup)
    // ALSO reads `spine_events` unconditionally, so that fault breaks
    // discovery too (see `reconcile-summary-evidence-failure-persistence
    // .test.js` probe 2, and the reconcile-active-summary-evidence 2026-07
    // fail-open fix report). A trigger scoped to exactly the fold's write
    // column (`stream_facts_event_seq`) isolates the fold from discovery
    // and the record-snapshot repair machinery, which is what this test's
    // title actually claims to exercise.
    getDb().exec(
      `CREATE TRIGGER fault_fold_write_only
         BEFORE UPDATE OF stream_facts_event_seq ON connector_summary_evidence
         WHEN NEW.stream_facts_event_seq IS NOT OLD.stream_facts_event_seq
       BEGIN
         SELECT RAISE(ABORT, 'injected fold write fault');
       END`,
    );
    try {
      const { reconcileDirtyConnectorSummaryEvidence } = await import('../server/connector-summary-read-model.ts');
      await reconcileDirtyConnectorSummaryEvidence();
    } finally {
      getDb().exec('DROP TRIGGER fault_fold_write_only');
    }

    const row = getDb()
      .prepare(
        'SELECT total_records, record_snapshot_state, terminal_facts_state FROM connector_summary_evidence WHERE connector_instance_id = ?',
      )
      .get('cin_failed_terminal');
    assert.equal(row.total_records, 1, 'the canonical count is untouched by the terminal-fold failure');
    assert.equal(row.record_snapshot_state, 'current', 'record_snapshot stays current — the fold failure is NOT laundered onto it');
    assert.notEqual(row.terminal_facts_state, 'current', 'ONLY terminal_facts reflects the fold failure');
  }));

test('a declared stream reads known_zero independent of collection coverage remaining unmeasured', () =>
  withTempDb(async () => {
    const connectorId = 'https://test.pdpp.dev/connectors/known-zero-unknown-coverage';
    seedManifestConnector(connectorId, ['messages']);
    seedInstance('cin_no_coverage', connectorId);
    // No records, no runs, no terminal spine events at all — collection
    // coverage for this connection has never been measured (no
    // classifying run exists to derive a coverage axis from).

    const summaries = await listConnectorSummaries(null, { concurrency: 1 });
    const summary = summaries.find((row) => row.connector_instance_id === 'cin_no_coverage');
    assert.ok(summary, 'the connection is visible even with zero collection history');

    const streamEntry = summary.stream_records.find((entry) => entry.stream === 'messages');
    assert.ok(streamEntry, 'the declared stream is visible');
    assert.equal(streamEntry.count_state, 'known_zero', 'the canonical snapshot proves an exact zero record count');
    assert.equal(streamEntry.declaration_state, 'declared');

    // Coverage is a wholly separate axis (collection_report /
    // connection_health.axes.coverage), derived from run/classifying-run
    // evidence — NOT from the record count. With no run ever attempted,
    // coverage must read unknown/unmeasured, independent of the exact
    // known_zero record count above.
    assert.equal(summary.connection_health.axes.coverage, 'unknown', 'coverage is a distinct, unmeasured axis');
  }));
