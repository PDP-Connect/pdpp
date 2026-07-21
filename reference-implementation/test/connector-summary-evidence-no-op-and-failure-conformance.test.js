// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * OpenSpec task 2.2 (openspec/changes/reconcile-active-summary-evidence
 * design.md "Acceptance Strategy"): production-entry-point proof that the
 * summary primitive stays converged/current through semantic no-op,
 * absent/repeated delete, accepted replay, partial-prefix resume, direct
 * write/delete, and post-commit projection/index failure — the six named
 * cases not already covered by the oracle's lost-marker-changed-ingest test
 * (`reconcile-active-summary-evidence-oracle.test.js`).
 *
 * design.md "Exact reset-safe record checkpoint": "Ordinary changed
 * ingest/direct soft-delete advances the relevant stream counter; semantic
 * no-op, absent/repeated delete, and exact accepted replay advance neither
 * component." Every no-op/replay test below proves this at the checkpoint
 * level (not just the record count), so a false-dirty repair pass can never
 * be triggered by input that changed nothing.
 *
 * The post-commit index-failure case exercises a real production fault
 * seam: `records.js`'s durable commit (and its checkpoint advance) happens
 * strictly BEFORE `maintainRecordIndexes` runs, and
 * `markConnectorSummaryEvidenceDirty` runs strictly AFTER that — so an
 * index-maintenance failure prevents the dirty marker from ever firing,
 * even though the canonical record and its checkpoint are already durably
 * committed. The summary primitive must self-heal purely from its own
 * checkpoint comparison, never depending on the (skipped) dirty marker.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { closeDb, getDb, initDb } from '../server/db.js';
import { reconcileConnectorSummaryEvidence } from '../server/connector-summary-evidence-engine.ts';
import {
  __setRecordIndexFaultHookForTest,
  deleteRecord,
  ingestRecord,
} from '../server/records.js';

const OWNER = 'owner_local';
const NOW = '2026-07-17T00:00:00.000Z';

async function withTempDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'pdpp-summary-noop-'));
  try {
    initDb(join(dir, 'pdpp.sqlite'));
    return await fn();
  } finally {
    __setRecordIndexFaultHookForTest(null);
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

function checkpointFor(connectorInstanceId) {
  return getDb()
    .prepare('SELECT record_checkpoint_json FROM connector_summary_evidence WHERE connector_instance_id = ?')
    .get(connectorInstanceId)?.record_checkpoint_json;
}

test('semantic no-op (byte-identical re-ingest) advances neither the checkpoint nor repair work', () =>
  withTempDb(async () => {
    const connectorId = 'https://test.pdpp.dev/connectors/semantic-noop';
    seedManifestConnector(connectorId, ['messages']);
    seedInstance('cin_semantic_noop', connectorId);
    const target = storageTargetFor(connectorId, 'cin_semantic_noop');

    const first = await ingestRecord(target, {
      stream: 'messages',
      key: 'msg_1',
      data: { id: 'msg_1', text: 'hello' },
      emitted_at: NOW,
    });
    assert.equal(first.changed, true, 'fixture premise: the first write is a genuine change');
    await reconcileConnectorSummaryEvidence(null);
    const checkpointAfterFirst = checkpointFor('cin_semantic_noop');

    // Byte-identical re-ingest of the exact same payload: records.js's
    // `wouldBeUnchangedUpsert` path treats this as a semantic no-op (its
    // provenance anchor is intact), never allocating a new version.
    const replay = await ingestRecord(target, {
      stream: 'messages',
      key: 'msg_1',
      data: { id: 'msg_1', text: 'hello' },
      emitted_at: '2026-07-17T00:05:00.000Z',
    });
    assert.equal(replay.changed, false, 'byte-identical re-ingest is a genuine no-op, not a new version');

    const result = await reconcileConnectorSummaryEvidence(null);
    assert.equal(result.repaired, 0, 'a semantic no-op triggers zero repair work — the checkpoint never moved');
    assert.equal(checkpointFor('cin_semantic_noop'), checkpointAfterFirst, 'the composite checkpoint is byte-identical after the no-op');

    const row = getDb()
      .prepare('SELECT total_records FROM connector_summary_evidence WHERE connector_instance_id = ?')
      .get('cin_semantic_noop');
    assert.equal(row.total_records, 1, 'the no-op does not fabricate a second record');
  }));

test('deleting an absent record is a no-op that advances neither the checkpoint nor repair work', () =>
  withTempDb(async () => {
    const connectorId = 'https://test.pdpp.dev/connectors/absent-delete';
    seedManifestConnector(connectorId, ['messages']);
    seedInstance('cin_absent_delete', connectorId);
    const target = storageTargetFor(connectorId, 'cin_absent_delete');

    await reconcileConnectorSummaryEvidence(null);
    const checkpointBefore = checkpointFor('cin_absent_delete');

    // Delete a record that was never ingested — records.js's
    // `deleteRecordWithinCoordinator` returns `{ kind: 'noop' }` for
    // `!current`.
    const outcome = await deleteRecord(target, 'messages', 'never_existed');
    assert.equal(outcome, 0, 'deleting an absent record is a genuine no-op');

    const result = await reconcileConnectorSummaryEvidence(null);
    assert.equal(result.repaired, 0, 'an absent delete triggers zero repair work');
    assert.equal(checkpointFor('cin_absent_delete'), checkpointBefore, 'the composite checkpoint is unchanged by an absent delete');
  }));

test('repeated delete of the same record is a no-op on the second call and advances neither the checkpoint nor repair work', () =>
  withTempDb(async () => {
    const connectorId = 'https://test.pdpp.dev/connectors/repeated-delete';
    seedManifestConnector(connectorId, ['messages']);
    seedInstance('cin_repeated_delete', connectorId);
    const target = storageTargetFor(connectorId, 'cin_repeated_delete');

    await ingestRecord(target, {
      stream: 'messages',
      key: 'msg_1',
      data: { id: 'msg_1' },
      emitted_at: NOW,
    });
    const firstDelete = await deleteRecord(target, 'messages', 'msg_1');
    assert.equal(firstDelete, 1, 'fixture premise: the first delete is a genuine change');
    await reconcileConnectorSummaryEvidence(null);
    const checkpointAfterFirstDelete = checkpointFor('cin_repeated_delete');

    // Deleting the already-deleted record a second time: `current.deleted`
    // is true, so `deleteRecordWithinCoordinator` returns a no-op again.
    const secondDelete = await deleteRecord(target, 'messages', 'msg_1');
    assert.equal(secondDelete, 0, 'deleting an already-deleted record is a genuine no-op');

    const result = await reconcileConnectorSummaryEvidence(null);
    assert.equal(result.repaired, 0, 'a repeated delete triggers zero repair work');
    assert.equal(
      checkpointFor('cin_repeated_delete'),
      checkpointAfterFirstDelete,
      'the composite checkpoint is unchanged by the repeated delete',
    );
  }));

test('an accepted replay of an already-committed batch prefix advances neither the checkpoint nor repair work', () =>
  withTempDb(async () => {
    const connectorId = 'https://test.pdpp.dev/connectors/accepted-replay';
    seedManifestConnector(connectorId, ['messages']);
    seedInstance('cin_accepted_replay', connectorId);
    const target = storageTargetFor(connectorId, 'cin_accepted_replay');

    // A "batch" of two records lands and commits durably.
    await ingestRecord(target, { stream: 'messages', key: 'msg_1', data: { id: 'msg_1' }, emitted_at: NOW });
    await ingestRecord(target, { stream: 'messages', key: 'msg_2', data: { id: 'msg_2' }, emitted_at: NOW });
    await reconcileConnectorSummaryEvidence(null);
    const checkpointAfterBatch = checkpointFor('cin_accepted_replay');

    // The client retries the exact same batch (e.g. it never saw the 200
    // OK) — an accepted replay. Every record in the replay is byte-identical
    // to what is already durably committed, so every one is a no-op.
    const replay1 = await ingestRecord(target, { stream: 'messages', key: 'msg_1', data: { id: 'msg_1' }, emitted_at: NOW });
    const replay2 = await ingestRecord(target, { stream: 'messages', key: 'msg_2', data: { id: 'msg_2' }, emitted_at: NOW });
    assert.equal(replay1.changed, false);
    assert.equal(replay2.changed, false);

    const result = await reconcileConnectorSummaryEvidence(null);
    assert.equal(result.repaired, 0, 'an accepted replay triggers zero repair work');
    assert.equal(checkpointFor('cin_accepted_replay'), checkpointAfterBatch, 'the composite checkpoint is unchanged by the replay');

    const row = getDb()
      .prepare('SELECT total_records FROM connector_summary_evidence WHERE connector_instance_id = ?')
      .get('cin_accepted_replay');
    assert.equal(row.total_records, 2, 'the replay does not double-count the two records');
  }));

test('resuming a partial batch prefix repairs only the genuinely new suffix, not the already-committed prefix', () =>
  withTempDb(async () => {
    const connectorId = 'https://test.pdpp.dev/connectors/partial-prefix-resume';
    seedManifestConnector(connectorId, ['messages']);
    seedInstance('cin_partial_prefix', connectorId);
    const target = storageTargetFor(connectorId, 'cin_partial_prefix');

    // Simulate a batch of 3 whose first 2 records committed durably before
    // the client connection dropped (a partial prefix) — the connector-summary
    // primitive has already converged on that prefix.
    await ingestRecord(target, { stream: 'messages', key: 'msg_1', data: { id: 'msg_1' }, emitted_at: NOW });
    await ingestRecord(target, { stream: 'messages', key: 'msg_2', data: { id: 'msg_2' }, emitted_at: NOW });
    await reconcileConnectorSummaryEvidence(null);
    const checkpointAfterPrefix = checkpointFor('cin_partial_prefix');

    // The client resumes by re-sending the WHOLE original batch: the first
    // two records replay as no-ops (already committed), and only the third
    // is genuinely new.
    const resumeReplay1 = await ingestRecord(target, { stream: 'messages', key: 'msg_1', data: { id: 'msg_1' }, emitted_at: NOW });
    const resumeReplay2 = await ingestRecord(target, { stream: 'messages', key: 'msg_2', data: { id: 'msg_2' }, emitted_at: NOW });
    const resumeNew = await ingestRecord(target, { stream: 'messages', key: 'msg_3', data: { id: 'msg_3' }, emitted_at: NOW });
    assert.equal(resumeReplay1.changed, false, 'the already-committed prefix replays as a no-op');
    assert.equal(resumeReplay2.changed, false, 'the already-committed prefix replays as a no-op');
    assert.equal(resumeNew.changed, true, 'only the genuinely new suffix record is a change');

    const result = await reconcileConnectorSummaryEvidence(null);
    assert.equal(result.repaired, 1, 'the resumed batch repairs exactly the one connection whose checkpoint moved, not the whole prefix again');
    assert.notEqual(
      checkpointFor('cin_partial_prefix'),
      checkpointAfterPrefix,
      'the stored checkpoint DID move once, reflecting the new suffix record, after the repair pass persisted it',
    );

    const row = getDb()
      .prepare('SELECT total_records FROM connector_summary_evidence WHERE connector_instance_id = ?')
      .get('cin_partial_prefix');
    assert.equal(row.total_records, 3, 'the resumed batch lands the new record without duplicating the already-committed prefix');
  }));

test('a direct changed write (bypassing ingestRecord) is detected and repaired by the primitive without a dirty hook', () =>
  withTempDb(async () => {
    const connectorId = 'https://test.pdpp.dev/connectors/direct-write';
    seedManifestConnector(connectorId, ['messages']);
    seedInstance('cin_direct_write', connectorId);
    await reconcileConnectorSummaryEvidence(null);

    // A direct writer (e.g. a bulk-import script, migration, or another
    // process) inserts a canonical record without going through
    // `ingestRecord` at all — so `markConnectorSummaryEvidenceDirty` never
    // fires. The composite checkpoint's underlying version_counter still
    // advances because it shares the same allocator.
    getDb()
      .prepare(
        `INSERT INTO version_counter(connector_id, connector_instance_id, stream, max_version) VALUES (?, ?, 'messages', 1)
         ON CONFLICT(connector_instance_id, stream) DO UPDATE SET max_version = 1`,
      )
      .run(connectorId, 'cin_direct_write');
    getDb()
      .prepare(
        `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted)
         VALUES (?, ?, 'messages', 'direct_msg', '{"id":"direct_msg"}', ?, 1, 0)`,
      )
      .run(connectorId, 'cin_direct_write', NOW);
    getDb()
      .prepare(
        `INSERT INTO record_changes(connector_id, connector_instance_id, stream, record_key, version, record_json, emitted_at, deleted)
         VALUES (?, ?, 'messages', 'direct_msg', 1, '{"id":"direct_msg"}', ?, 0)`,
      )
      .run(connectorId, 'cin_direct_write', NOW);

    const result = await reconcileConnectorSummaryEvidence(null);
    assert.equal(result.repaired, 1, 'the direct write is detected purely from the checkpoint mismatch, no dirty hook required');

    const row = getDb()
      .prepare('SELECT total_records FROM connector_summary_evidence WHERE connector_instance_id = ?')
      .get('cin_direct_write');
    assert.equal(row.total_records, 1, 'the directly-written record is reflected in the repaired canonical count');
  }));

test('a direct changed delete (bypassing deleteRecord) is detected and repaired by the primitive without a dirty hook', () =>
  withTempDb(async () => {
    const connectorId = 'https://test.pdpp.dev/connectors/direct-delete';
    seedManifestConnector(connectorId, ['messages']);
    seedInstance('cin_direct_delete', connectorId);
    const target = storageTargetFor(connectorId, 'cin_direct_delete');
    await ingestRecord(target, { stream: 'messages', key: 'msg_1', data: { id: 'msg_1' }, emitted_at: NOW });
    await reconcileConnectorSummaryEvidence(null);

    // A direct writer marks the record deleted and advances the version
    // counter without going through `deleteRecord` — no dirty marker fires.
    getDb()
      .prepare('UPDATE version_counter SET max_version = 2 WHERE connector_instance_id = ? AND stream = ?')
      .run('cin_direct_delete', 'messages');
    getDb()
      .prepare('UPDATE records SET deleted = 1, version = 2 WHERE connector_instance_id = ? AND record_key = ?')
      .run('cin_direct_delete', 'msg_1');
    getDb()
      .prepare(
        `INSERT INTO record_changes(connector_id, connector_instance_id, stream, record_key, version, record_json, emitted_at, deleted)
         VALUES (?, ?, 'messages', 'msg_1', 2, '{"id":"msg_1"}', ?, 1)`,
      )
      .run(connectorId, 'cin_direct_delete', NOW);

    const result = await reconcileConnectorSummaryEvidence(null);
    assert.equal(result.repaired, 1, 'the direct delete is detected purely from the checkpoint mismatch, no dirty hook required');

    const row = getDb()
      .prepare('SELECT total_records FROM connector_summary_evidence WHERE connector_instance_id = ?')
      .get('cin_direct_delete');
    assert.equal(row.total_records, 0, 'the directly-deleted record is reflected in the repaired canonical count');
  }));

test('a post-commit index-maintenance failure cannot prevent the summary primitive from converging on the durably-committed record', () =>
  withTempDb(async () => {
    const connectorId = 'https://test.pdpp.dev/connectors/index-failure';
    seedManifestConnector(connectorId, ['messages']);
    seedInstance('cin_index_failure', connectorId);
    const target = storageTargetFor(connectorId, 'cin_index_failure');
    await reconcileConnectorSummaryEvidence(null);

    // Force the post-commit lexical-index phase to throw. records.js's
    // durable commit (and checkpoint advance) already happened by the time
    // `maintainRecordIndexes` runs; `markConnectorSummaryEvidenceDirty`
    // (which runs strictly AFTER index maintenance) never executes.
    __setRecordIndexFaultHookForTest((point) => {
      if (point === 'after-lexical-index') {
        throw new Error('simulated post-commit index-maintenance failure');
      }
    });

    await assert.rejects(
      ingestRecord(target, { stream: 'messages', key: 'msg_1', data: { id: 'msg_1' }, emitted_at: NOW }),
      /simulated post-commit index-maintenance failure/,
      'the ingest call surfaces the index failure to its caller',
    );
    __setRecordIndexFaultHookForTest(null);

    // Despite the index failure — and despite the dirty marker never firing
    // — the record was durably committed. The summary primitive's own
    // checkpoint comparison (not the dirty marker) must still detect and
    // repair it.
    const result = await reconcileConnectorSummaryEvidence(null);
    assert.equal(
      result.repaired,
      1,
      'the primitive detects the durably-committed record purely from the checkpoint mismatch, independent of the skipped dirty marker',
    );

    const row = getDb()
      .prepare('SELECT total_records FROM connector_summary_evidence WHERE connector_instance_id = ?')
      .get('cin_index_failure');
    assert.equal(row.total_records, 1, 'the record committed before the index failure is reflected in the repaired canonical count');
  }));
