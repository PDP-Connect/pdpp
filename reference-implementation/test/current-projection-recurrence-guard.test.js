/**
 * Current-projection recurrence guard.
 *
 * Motivation: the live Chase connection exhibited a real current/history
 * projection-integrity failure — `record_changes` held 1,145 latest
 * non-deleted `transactions` keys while the current `records` projection held
 * only 15 rows. The owner repaired live state with
 * `scripts/repair/record-current-projection-repair.mjs`. This suite closes the
 * recurrence question for the reference store: it asserts that the active
 * mutation paths keep the current projection in lockstep with the
 * authoritative history, and it pins the one residual structural hazard
 * (non-atomic bulk delete on SQLite) so a future regression is loud.
 *
 * The invariant under guard (verbatim from the repair tool):
 *
 *   For each (connector_instance_id, stream, record_key), the current
 *   `records` row SHALL represent the latest-version retained `record_changes`
 *   row: a non-deleted latest history row requires a matching non-deleted
 *   current row (same version + json); a deleted latest history row requires
 *   no non-deleted current row.
 *
 * Coverage:
 *   1. The checker is falsifiable — a hand-constructed drift of each class is
 *      detected and classified correctly (so a green run means something).
 *   2. The atomic ingest path never drifts across upsert / re-ingest / delete /
 *      re-add churn (the path that would have to regress to recreate Chase).
 *   3. History pruning (PDPP_CHANGE_HISTORY_LIMIT) does not, by itself, create
 *      missing/stale current drift; it can only create unresolved_pruned, and
 *      only when current advances past the retained tail — which the ingest
 *      path never does.
 *   4. The bulk scoped-delete paths leave NO drift on successful completion.
 *   5. A *torn* bulk delete (record_changes cleared, records left behind —
 *      the exact shape a crash between the two un-transacted SQLite `exec()`
 *      statements would leave) is detected as unresolved_pruned. This is the
 *      residual-risk pin: it documents that those paths are not transactionally
 *      coupled on SQLite and that the drift would be catchable.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { closeDb, getDb, initDb } from '../server/db.js';
import {
  deleteAllRecords,
  deleteAllRecordsForConnector,
  deleteConnectionRecordRowsSqlite,
  deleteRecord,
  ingestRecord,
} from '../server/records.js';
import {
  PROJECTION_MISMATCH_KINDS,
  assertNoCurrentProjectionDrift,
  classifyProjectionMismatch,
  detectCurrentProjectionDrift,
} from './helpers/current-projection-invariant.js';

const CONNECTOR_ID = 'https://test.pdpp.org/connectors/projection-guard';
const STREAM = 'transactions';
const EMITTED = '2026-04-28T12:00:00.000Z';

function setup() {
  initDb();
}

function teardown() {
  delete process.env.PDPP_CHANGE_HISTORY_LIMIT;
  closeDb();
}

function upsert(id, payload = {}) {
  return ingestRecord(CONNECTOR_ID, {
    stream: STREAM,
    key: id,
    data: { id, ...payload },
    emitted_at: EMITTED,
    op: 'upsert',
  });
}

function ingestDelete(id) {
  return ingestRecord(CONNECTOR_ID, {
    stream: STREAM,
    key: id,
    data: { id },
    emitted_at: EMITTED,
    op: 'delete',
  });
}

// The default-account connector_instance_id the reference resolver assigns
// when a storage target is a bare connector id string. Tests scope drift
// checks to it where a precise scope is useful; most assertions run unscoped
// (whole store) which is the strongest form.
function instanceIdFor() {
  // Derive it the same way the runtime does: read it back from a written row.
  const row = getDb()
    .prepare(`SELECT connector_instance_id FROM records WHERE connector_id = ? LIMIT 1`)
    .get(CONNECTOR_ID)
    || getDb()
      .prepare(`SELECT connector_instance_id FROM record_changes WHERE connector_id = ? LIMIT 1`)
      .get(CONNECTOR_ID);
  return row ? row.connector_instance_id : null;
}

// ── 1. The checker is falsifiable ──────────────────────────────────────────

test('classifier matches the repair tool decision tree', () => {
  const K = PROJECTION_MISMATCH_KINDS;
  // consistent: live latest, matching current
  assert.equal(classifyProjectionMismatch({ version: 3, deleted: false, jsonEqual: true }, { version: 3, deleted: false }), null);
  // missing_current: live latest, no current
  assert.equal(classifyProjectionMismatch({ version: 3, deleted: false, jsonEqual: false }, null), K.MISSING_CURRENT);
  // missing_current: live latest, current is deleted
  assert.equal(classifyProjectionMismatch({ version: 3, deleted: false, jsonEqual: false }, { version: 3, deleted: true }), K.MISSING_CURRENT);
  // stale_current: version mismatch
  assert.equal(classifyProjectionMismatch({ version: 4, deleted: false, jsonEqual: true }, { version: 3, deleted: false }), K.STALE_CURRENT);
  // stale_current: json mismatch at same version
  assert.equal(classifyProjectionMismatch({ version: 3, deleted: false, jsonEqual: false }, { version: 3, deleted: false }), K.STALE_CURRENT);
  // latest_deleted: deleted latest, live current
  assert.equal(classifyProjectionMismatch({ version: 5, deleted: true, jsonEqual: false }, { version: 4, deleted: false }), K.LATEST_DELETED);
  // deleted latest + deleted current = consistent
  assert.equal(classifyProjectionMismatch({ version: 5, deleted: true, jsonEqual: false }, { version: 5, deleted: true }), null);
  // unresolved_pruned: current newer than all retained history
  assert.equal(classifyProjectionMismatch({ version: 2, deleted: false, jsonEqual: false }, { version: 9, deleted: false }), K.UNRESOLVED_PRUNED);
});

test('detector flags a hand-constructed missing_current drift (the Chase shape)', () => {
  setup();
  try {
    const cin = 'cin_synthetic';
    // History says key "k1" exists at v1 (non-deleted), but the current
    // `records` projection has no row for it — exactly the Chase symptom at
    // unit scale.
    getDb()
      .prepare(
        `INSERT INTO record_changes(connector_id, connector_instance_id, stream, record_key, version, record_json, emitted_at, deleted, deleted_at)
         VALUES(?, ?, ?, 'k1', 1, '{"id":"k1"}', ?, 0, NULL)`,
      )
      .run(CONNECTOR_ID, cin, STREAM, EMITTED);

    const drift = detectCurrentProjectionDrift({ connectorInstanceId: cin, stream: STREAM });
    assert.equal(drift.length, 1);
    assert.equal(drift[0].kind, PROJECTION_MISMATCH_KINDS.MISSING_CURRENT);
    assert.equal(drift[0].recordKey, 'k1');
    assert.equal(drift[0].latestHistoryVersion, 1);
    assert.equal(drift[0].currentExists, false);
  } finally {
    teardown();
  }
});

test('detector flags a hand-constructed orphan-current as unresolved_pruned', () => {
  setup();
  try {
    const cin = 'cin_orphan';
    // A current row with NO retained history at all — the signature of a bulk
    // delete that cleared record_changes but left records behind.
    getDb()
      .prepare(
        `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted)
         VALUES(?, ?, ?, 'orphan', '{"id":"orphan"}', ?, 7, 0)`,
      )
      .run(CONNECTOR_ID, cin, STREAM, EMITTED);

    const drift = detectCurrentProjectionDrift({ connectorInstanceId: cin, stream: STREAM });
    assert.equal(drift.length, 1);
    assert.equal(drift[0].kind, PROJECTION_MISMATCH_KINDS.UNRESOLVED_PRUNED);
    assert.equal(drift[0].recordKey, 'orphan');
  } finally {
    teardown();
  }
});

// ── 2. The atomic ingest path never drifts ─────────────────────────────────

test('ingest upsert/re-ingest/delete/re-add churn never drifts the current projection', async () => {
  setup();
  try {
    await upsert('a', { v: 1 });
    await upsert('b', { v: 1 });
    await upsert('c', { v: 1 });
    assertNoCurrentProjectionDrift();

    // No-op re-ingest (identical payload) — must not perturb anything.
    await upsert('a', { v: 1 });
    assertNoCurrentProjectionDrift();

    // Real update bumps version on both tables in lockstep.
    await upsert('a', { v: 2 });
    assertNoCurrentProjectionDrift();

    // Delete: latest history becomes deleted, current becomes deleted — the
    // (deleted latest, deleted current) consistent state, NOT latest_deleted.
    await ingestDelete('b');
    assertNoCurrentProjectionDrift();

    // Re-add a previously deleted key: current clears its delete flag, history
    // appends a live row at a newer version.
    await upsert('b', { v: 9 });
    assertNoCurrentProjectionDrift();

    // Direct delete path (deleteRecord) — same atomic unit.
    await deleteRecord(CONNECTOR_ID, STREAM, 'c');
    assertNoCurrentProjectionDrift();
  } finally {
    teardown();
  }
});

// ── 3. History pruning does not create missing/stale current drift ──────────

test('PDPP_CHANGE_HISTORY_LIMIT pruning never strands the current projection', async () => {
  process.env.PDPP_CHANGE_HISTORY_LIMIT = '2';
  setup();
  try {
    // Churn a single key well past the retention horizon. Each changed write
    // appends a history row and prunes the oldest; the current row always
    // tracks the newest version, which is always retained.
    for (let v = 1; v <= 8; v += 1) {
      await upsert('hot', { v });
      assertNoCurrentProjectionDrift();
    }

    // The retained history tail must still contain the version the current
    // row points at (otherwise the current row would be unresolved_pruned).
    const cin = instanceIdFor();
    const drift = detectCurrentProjectionDrift({ connectorInstanceId: cin, stream: STREAM });
    assert.equal(drift.length, 0, 'pruning must not orphan the current row');
  } finally {
    teardown();
  }
});

// ── 4. Bulk scoped-delete success paths leave no drift ──────────────────────

test('deleteAllRecords (per-stream) leaves no drift on success', async () => {
  setup();
  try {
    await upsert('a', { v: 1 });
    await upsert('b', { v: 1 });
    await deleteAllRecords(CONNECTOR_ID, STREAM);
    // Both tables emptied for the scope → nothing to be inconsistent about.
    assertNoCurrentProjectionDrift();
    assert.equal(detectCurrentProjectionDrift().length, 0);
  } finally {
    teardown();
  }
});

test('deleteAllRecordsForConnector leaves no drift on success', async () => {
  setup();
  try {
    await upsert('a', { v: 1 });
    await upsert('b', { v: 1 });
    await ingestDelete('b');
    await deleteAllRecordsForConnector(CONNECTOR_ID);
    assertNoCurrentProjectionDrift();
  } finally {
    teardown();
  }
});

test('deleteConnectionRecordRowsSqlite leaves no drift on success', async () => {
  setup();
  try {
    await upsert('a', { v: 1 });
    await upsert('b', { v: 1 });
    const cin = instanceIdFor();
    // Phase-2 helper is normally composed inside the store's writeTransaction;
    // invoked directly here it still clears both tables for the instance.
    deleteConnectionRecordRowsSqlite(cin);
    assertNoCurrentProjectionDrift();
  } finally {
    teardown();
  }
});

// ── 5. Residual-risk pin: a torn bulk delete is detectable ──────────────────

test('a torn bulk delete (record_changes cleared, records left) is caught as unresolved_pruned', async () => {
  setup();
  try {
    await upsert('a', { v: 1 });
    await upsert('b', { v: 1 });
    const cin = instanceIdFor();

    // Simulate the exact post-crash state of the NON-ATOMIC SQLite bulk-delete
    // paths: the `record_changes` delete committed but the process died before
    // the `records` delete. `deleteAllRecords` / `deleteAllRecordsForConnector`
    // issue these as two separate `exec()` statements with NO surrounding
    // writeTransaction, so this interleaving is reachable on a real crash.
    getDb()
      .prepare(`DELETE FROM record_changes WHERE connector_instance_id = ? AND stream = ?`)
      .run(cin, STREAM);

    const drift = detectCurrentProjectionDrift();
    assert.ok(drift.length >= 2, 'orphaned current rows must be detected');
    for (const p of drift) {
      assert.equal(p.kind, PROJECTION_MISMATCH_KINDS.UNRESOLVED_PRUNED);
    }
  } finally {
    teardown();
  }
});
