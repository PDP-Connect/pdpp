/**
 * Orphan cleanup: complete-census vs scoped point-delete
 * (openspec/changes/reconcile-active-summary-evidence/design.md
 * "One scope-safe reconciliation primitive"):
 *
 *   - A complete unscoped pass (`connectorInstanceIds: null`) may delete
 *     evidence rows absent from the complete authoritative
 *     `connector_instances` set.
 *   - A scoped pass (`connectorInstanceIds: [...]`) may delete ONLY the
 *     exact requested row after a point lookup proves that connection no
 *     longer exists. Absence from a subset is never evidence a sibling is
 *     orphaned — a scoped pass must never touch evidence for a connection
 *     outside its requested set, even if that sibling would also fail a
 *     hypothetical point lookup.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { closeDb, getDb, initDb } from '../server/db.js';
import { reconcileConnectorSummaryEvidence } from '../server/connector-summary-evidence-engine.ts';

const OWNER = 'owner_local';
const NOW = '2026-07-17T00:00:00.000Z';

async function withTempDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'pdpp-orphan-cleanup-'));
  try {
    initDb(join(dir, 'pdpp.sqlite'));
    return await fn();
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedConnector(connectorId) {
  getDb()
    .prepare('INSERT OR IGNORE INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)')
    .run(connectorId, JSON.stringify({ connector_id: connectorId }), NOW);
}

function seedInstance(connectorInstanceId, connectorId, ownerSubjectId = OWNER) {
  seedConnector(connectorId);
  getDb()
    .prepare(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       ) VALUES (?, ?, ?, ?, 'active', 'account', ?, '{}', ?, ?, NULL)`,
    )
    .run(connectorInstanceId, ownerSubjectId, connectorId, connectorId, connectorInstanceId, NOW, NOW);
}

function evidenceRowExists(connectorInstanceId) {
  return Boolean(
    getDb()
      .prepare('SELECT 1 FROM connector_summary_evidence WHERE connector_instance_id = ?')
      .get(connectorInstanceId),
  );
}

test('complete unscoped pass drops evidence for a connection no longer in the authoritative set', () =>
  withTempDb(async () => {
    seedInstance('cin_keep', 'gmail');
    seedInstance('cin_drop', 'oura');
    await reconcileConnectorSummaryEvidence(null);
    assert.ok(evidenceRowExists('cin_keep'));
    assert.ok(evidenceRowExists('cin_drop'));

    getDb().prepare('DELETE FROM connector_instances WHERE connector_instance_id = ?').run('cin_drop');
    await reconcileConnectorSummaryEvidence(null);

    assert.ok(evidenceRowExists('cin_keep'), 'the live connection survives the complete census');
    assert.equal(evidenceRowExists('cin_drop'), false, 'the deleted connection is dropped by the complete census');
  }));

test('scoped pass deletes only the exact requested connection proven gone, never a sibling outside its scope', () =>
  withTempDb(async () => {
    seedInstance('cin_gone', 'gmail');
    seedInstance('cin_untouched_sibling', 'oura');
    await reconcileConnectorSummaryEvidence(null);
    assert.ok(evidenceRowExists('cin_gone'));
    assert.ok(evidenceRowExists('cin_untouched_sibling'));

    // Delete BOTH underlying connections, but scope the reconcile pass to
    // ONLY 'cin_gone'. A scoped pass must never infer the sibling is
    // orphaned from its own absence outside the requested subset.
    getDb().prepare('DELETE FROM connector_instances WHERE connector_instance_id = ?').run('cin_gone');
    getDb().prepare('DELETE FROM connector_instances WHERE connector_instance_id = ?').run('cin_untouched_sibling');

    const result = await reconcileConnectorSummaryEvidence(['cin_gone']);

    assert.equal(evidenceRowExists('cin_gone'), false, 'the exact requested, now-gone connection is point-deleted');
    assert.ok(
      evidenceRowExists('cin_untouched_sibling'),
      'a sibling connection OUTSIDE the requested scope is never touched, even though it is also gone',
    );
    assert.ok(result.repaired >= 1, 'the scoped point-delete counts toward the result');
  }));

test('scoped pass repairs the requested connection without discovering or touching any sibling', () =>
  withTempDb(async () => {
    seedInstance('cin_scoped', 'gmail');
    seedInstance('cin_other', 'oura');
    await reconcileConnectorSummaryEvidence(null);

    // Mutate canonical state for BOTH connections, but scope the pass to
    // only one. Only the scoped connection's evidence should repair.
    getDb()
      .prepare(
        `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, semantic_time, version, deleted)
         VALUES ('gmail', 'cin_scoped', 'messages', 'r1', '{}', ?, ?, 1, 0)`,
      )
      .run(NOW, NOW);
    getDb()
      .prepare(
        `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, semantic_time, version, deleted)
         VALUES ('oura', 'cin_other', 'sleep', 'r2', '{}', ?, ?, 1, 0)`,
      )
      .run(NOW, NOW);

    const result = await reconcileConnectorSummaryEvidence(['cin_scoped']);

    assert.equal(result.discovered, 1, 'scoped discovery reads exactly the requested connection, not the full set');
    const scopedRow = getDb()
      .prepare('SELECT total_records FROM connector_summary_evidence WHERE connector_instance_id = ?')
      .get('cin_scoped');
    assert.equal(scopedRow.total_records, 1, 'the scoped connection repaired to its fresh canonical count');
    const otherRow = getDb()
      .prepare('SELECT total_records FROM connector_summary_evidence WHERE connector_instance_id = ?')
      .get('cin_other');
    assert.equal(otherRow.total_records, 0, 'the sibling outside scope was never repaired by this call');
  }));

// ─── two-subject owner-scope invariant (Sol P1.3) ─────────────────────────
//
// Discovery/pruning must treat "complete" as complete across every subject
// in connector_instances, not just REFERENCE_OWNER_SUBJECT_ID ('owner_local').
// A prior owner_subject_id filter on the unscoped instance query created a
// genuine cross-subject destructive-interference bug: evidence reads/prunes
// were already unfiltered by subject, so a distinct subject's evidence row
// could be read into the "live" set while its own connector_instances row
// never appeared in the owner-local-only instanceRows — making a complete
// pass treat a genuinely-live other-subject connection as orphaned.

test('a scoped pass materializing evidence for a distinct (non-owner_local) subject is never deleted by the next complete pass', () =>
  withTempDb(async () => {
    seedInstance('cin_owner_local', 'gmail', OWNER);
    seedInstance('cin_grant_subject', 'oura', 'grant_subject');

    // Scoped reconciliation for ONLY the distinct-subject connection —
    // exactly the shape a client-grant-materialized connection's first
    // observation takes (e.g. via getConnectorSummaryForRoute/getConnectorDetail
    // resolving one already-known connectorInstanceId). No owner predicate
    // gates the scoped path (by design — it addresses an exact instance id),
    // so this correctly creates fresh evidence for 'grant_subject'.
    const scopedResult = await reconcileConnectorSummaryEvidence(['cin_grant_subject']);
    assert.equal(scopedResult.failed, 0);
    assert.ok(evidenceRowExists('cin_grant_subject'), 'the scoped pass materializes evidence for the distinct subject');
    assert.ok(
      getDb().prepare('SELECT 1 FROM connector_instances WHERE connector_instance_id = ?').get('cin_grant_subject'),
      'the distinct subject\'s canonical connector_instances row genuinely exists throughout',
    );

    // The next COMPLETE (unscoped) pass — e.g. the startup sweep or the
    // bare list route's pre-fetch — must discover and preserve BOTH
    // subjects' live connections, never delete the distinct subject's
    // evidence just because it belongs to a different owner_subject_id.
    const completeResult = await reconcileConnectorSummaryEvidence(null);
    assert.equal(completeResult.discovered, 2, 'the complete census discovers both subjects\' connections, not just owner_local');
    assert.ok(evidenceRowExists('cin_owner_local'), 'the owner_local connection survives the complete pass');
    assert.ok(
      evidenceRowExists('cin_grant_subject'),
      'the distinct-subject connection survives the complete pass — its still-live connector_instances row must not be treated as orphaned',
    );
    assert.ok(
      getDb().prepare('SELECT 1 FROM connector_instances WHERE connector_instance_id = ?').get('cin_grant_subject'),
      'the distinct subject\'s canonical connector_instances row is untouched by the complete pass (evidence-layer bug only, never a canonical-layer mutation)',
    );
  }));

test('a complete pass genuinely prunes a distinct-subject connection once its own connector_instances row is truly gone', () =>
  withTempDb(async () => {
    seedInstance('cin_owner_local', 'gmail', OWNER);
    seedInstance('cin_grant_subject', 'oura', 'grant_subject');
    await reconcileConnectorSummaryEvidence(null);
    assert.ok(evidenceRowExists('cin_grant_subject'));

    // The distinct subject's connection is genuinely deleted (not merely
    // "not owner_local") — pruning must still correctly drop its evidence,
    // proving the fix does not simply skip cross-subject pruning wholesale.
    getDb().prepare('DELETE FROM connector_instances WHERE connector_instance_id = ?').run('cin_grant_subject');
    await reconcileConnectorSummaryEvidence(null);

    assert.ok(evidenceRowExists('cin_owner_local'), 'the still-live owner_local connection survives');
    assert.equal(
      evidenceRowExists('cin_grant_subject'),
      false,
      'a genuinely-deleted distinct-subject connection is still correctly pruned — this is real orphan cleanup, not cross-subject immunity',
    );
  }));
