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

// ── 3b. Multi-key anchor preservation (the live recurrence) ────────────────
//
// The single-key test above can NEVER catch the live bug: with one key the
// per-stream version always equals that key's latest version, so a
// `version <= nextVersion - limit` cutoff never reaches the anchor. The live
// Chase / USAA / reddit / github drift required at least two keys — a COLD key
// written once and never touched again, and a HOT key whose churn advances the
// per-stream version far past `cold.version + limit`. A pure stream-version
// cutoff then deletes the cold key's only history row (its anchor), stranding
// the unchanged current row as `unresolved_pruned`. These tests fail against a
// stream-cutoff prune and pass only with anchor preservation.

test('pruning preserves a cold-key anchor while a hot key advances the stream past the limit', async () => {
  process.env.PDPP_CHANGE_HISTORY_LIMIT = '2';
  setup();
  try {
    // Cold key: written once at v1, never touched again. Its current row stays
    // at v1; its sole anchor is the v1 record_changes row.
    await upsert('cold', { v: 1 });
    assertNoCurrentProjectionDrift();

    // Hot key: churn it well past v1 + limit so a naive cutoff
    // (version <= nextVersion - 2) would sweep the cold anchor away.
    for (let v = 1; v <= 8; v += 1) {
      await upsert('hot', { v });
      // The invariant must hold after EVERY write, not just at the end —
      // anchor preservation is per-prune, not a post-hoc repair.
      assertNoCurrentProjectionDrift();
    }

    const cin = instanceIdFor();
    // Whole-store check: no class of drift anywhere for this connection.
    assert.equal(
      detectCurrentProjectionDrift({ connectorInstanceId: cin, stream: STREAM }).length,
      0,
      'cold-key anchor must survive hot-key stream advance',
    );

    // Bounded-pruning is NOT sacrificed: the cold key keeps exactly its 1
    // anchor row (not unbounded), and the hot key's history is still bounded at
    // the retention limit (anchor + at most limit-1 older retained rows).
    const counts = getDb()
      .prepare(
        `SELECT record_key, COUNT(*) AS n
           FROM record_changes
          WHERE connector_instance_id = ? AND stream = ?
          GROUP BY record_key`,
      )
      .all(cin, STREAM);
    const byKey = Object.fromEntries(counts.map((r) => [r.record_key, Number(r.n)]));
    assert.equal(byKey.cold, 1, 'cold key retains exactly its anchor row');
    assert.ok(byKey.hot <= 2, `hot key history stays bounded (got ${byKey.hot})`);
  } finally {
    teardown();
  }
});

test('a cold key DELETED after the stream advances keeps its deleted anchor (no resurrection)', async () => {
  process.env.PDPP_CHANGE_HISTORY_LIMIT = '2';
  setup();
  try {
    // Cold key lives at v1, then is deleted at v2. After the delete its current
    // row is a tombstone at v2 and its anchor is the deleted v2 history row.
    await upsert('cold', { v: 1 });
    await ingestDelete('cold');
    // Hot key now advances the stream version far past v2 + limit.
    for (let v = 1; v <= 10; v += 1) {
      await upsert('hot', { v });
      assertNoCurrentProjectionDrift();
    }

    const cin = instanceIdFor();
    // The deleted-tombstone anchor must survive: otherwise the cold key would
    // become an orphan current row (unresolved_pruned) OR — worse — lose the
    // proof that it is deleted. The (deleted latest, deleted current) state is
    // consistent, so there must be zero drift.
    assert.equal(
      detectCurrentProjectionDrift({ connectorInstanceId: cin, stream: STREAM }).length,
      0,
      'deleted cold-key anchor must survive the stream advance',
    );
    // Confirm the anchor is the deleted v2 row, still present.
    const anchor = getDb()
      .prepare(
        `SELECT version, deleted FROM record_changes
          WHERE connector_instance_id = ? AND stream = ? AND record_key = 'cold'`,
      )
      .all(cin, STREAM);
    assert.equal(anchor.length, 1, 'exactly the deleted anchor is retained for the cold key');
    assert.equal(anchor[0].deleted, 1, 'retained cold anchor is the deleted tombstone');
  } finally {
    teardown();
  }
});

test('many cold keys all keep their anchors when one hot key advances the stream', async () => {
  process.env.PDPP_CHANGE_HISTORY_LIMIT = '3';
  setup();
  try {
    // A realistic shape: dozens of keys written once (the long tail of a
    // transactions stream) plus one key that keeps changing. Every cold key's
    // anchor must survive regardless of how far the hot key pushes the version.
    for (let i = 0; i < 40; i += 1) {
      await upsert(`cold-${i}`, { v: 1 });
    }
    for (let v = 1; v <= 30; v += 1) {
      await upsert('hot', { v });
    }
    const cin = instanceIdFor();
    assert.equal(
      detectCurrentProjectionDrift({ connectorInstanceId: cin, stream: STREAM }).length,
      0,
      'no cold-key anchor may be stranded by the hot key',
    );
    // Every cold key keeps exactly one anchor row; total history is bounded
    // (40 cold anchors + a bounded hot tail), not the full 70-version log.
    const total = getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM record_changes WHERE connector_instance_id = ? AND stream = ?`,
      )
      .get(cin, STREAM);
    assert.ok(Number(total.n) <= 40 + 3, `history stays bounded (got ${total.n})`);
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
