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

// ── 6. Ingest self-heals an unanchored current row ──────────────────────────
//
// History pruning by stream-global version cutoff can strand the provenance
// anchor of a still-current, unchanged record: a cold key written once whose
// `record_changes` row falls below the retention horizon while a hot key
// churns the stream forward. The current `records` row survives, but its only
// retained history row is gone — the unresolved_pruned / orphan class the
// offline repair tool refuses to reconstruct. Source-backed resync IS able to
// reconstruct it: when the source re-sends the byte-identical payload, ingest
// re-anchors the current row at a NEW stream version instead of suppressing
// the write as a plain no-op. These tests pin that behavior, prove the normal
// anchored no-op is untouched, and prove the heal is durable through pruning.

function countHistoryRows(cin, recordKey) {
  return getDb()
    .prepare(
      `SELECT COUNT(*) AS c FROM record_changes
        WHERE connector_instance_id = ? AND stream = ? AND record_key = ?`,
    )
    .get(cin, STREAM, recordKey).c;
}

function readVersionCounter(cin) {
  const row = getDb()
    .prepare(`SELECT max_version FROM version_counter WHERE connector_instance_id = ? AND stream = ?`)
    .get(cin, STREAM);
  return row ? row.max_version : null;
}

function readCurrentVersion(cin, recordKey) {
  const row = getDb()
    .prepare(`SELECT version FROM records WHERE connector_instance_id = ? AND stream = ? AND record_key = ?`)
    .get(cin, STREAM, recordKey);
  return row ? row.version : null;
}

// Strand a key's anchor directly: delete its retained `record_changes` row(s)
// while leaving the current `records` row in place. This reproduces the exact
// post-prune orphan state — a still-current, unchanged record whose provenance
// anchor is gone — WITHOUT relying on the prune path to strand it. The prune
// path no longer strands live-key anchors (anchor-preserving prune), so the
// orphan must be seeded the same way the Postgres self-heal test seeds it
// (raw delete of the anchor row), not by driving hot-key churn through prune.
function deleteAnchor(cin, recordKey) {
  getDb()
    .prepare(
      `DELETE FROM record_changes
        WHERE connector_instance_id = ? AND stream = ? AND record_key = ?`,
    )
    .run(cin, STREAM, recordKey);
}

// Build the hot/cold scenario, then strand cold by deleting its anchor: cold@v1,
// then `hotWrites` changed writes to a hot key advance the stream counter past
// the horizon (so the heal's new version is genuinely head-of-window), and
// finally cold's anchor row is removed directly to simulate the prune that the
// anchor-preserving guard now (correctly) refuses to perform.
async function strandColdAnchor(hotWrites) {
  await upsert('cold', { v: 1 });
  for (let i = 0; i < hotWrites; i += 1) {
    await upsert('hot', { v: i + 2 });
  }
  deleteAnchor(instanceIdFor(), 'cold');
}

test('unchanged reingest of an unanchored current row recreates its anchor (self-heal)', async () => {
  process.env.PDPP_CHANGE_HISTORY_LIMIT = '2';
  setup();
  try {
    await strandColdAnchor(10);
    const cin = instanceIdFor();

    // Pre-state: cold is orphaned — zero retained history, current still v1,
    // and the invariant checker flags exactly one unresolved_pruned drift.
    assert.equal(countHistoryRows(cin, 'cold'), 0, 'cold anchor stranded away');
    const preDrift = detectCurrentProjectionDrift({ connectorInstanceId: cin, stream: STREAM });
    assert.equal(preDrift.length, 1);
    assert.equal(preDrift[0].kind, PROJECTION_MISMATCH_KINDS.UNRESOLVED_PRUNED);
    assert.equal(preDrift[0].recordKey, 'cold');
    const counterBefore = readVersionCounter(cin);

    // Source-backed resync: the SAME payload is re-sent. Normally a no-op;
    // here it must self-heal because the anchor is missing.
    const result = await upsert('cold', { v: 1 });
    assert.deepEqual(result, { accepted: true, changed: true, self_healed: true });

    // A fresh anchor now exists at a NEW (head-of-window) version, not the
    // stale v1 that would re-prune on the next changed write.
    assert.equal(countHistoryRows(cin, 'cold'), 1, 'cold re-anchored');
    assert.equal(readVersionCounter(cin), counterBefore + 1, 'heal allocates exactly one new version');
    assert.equal(readCurrentVersion(cin, 'cold'), counterBefore + 1, 'current row tracks the new anchor');

    // The projection invariant is fully restored.
    assert.equal(
      detectCurrentProjectionDrift({ connectorInstanceId: cin, stream: STREAM }).length,
      0,
      'self-heal clears the drift',
    );
    assertNoCurrentProjectionDrift();
  } finally {
    teardown();
  }
});

test('unchanged reingest remains a plain no-op when the anchor is present (no version churn)', async () => {
  // The anti-churn guard: with the anchor intact, an identical reingest must
  // NOT allocate a version, append history, or report self-heal. (This is the
  // Slack workspace 31k-version regression the no-op suppression prevents; the
  // self-heal must not weaken it.)
  setup();
  try {
    await upsert('k', { v: 1 });
    const cin = instanceIdFor();
    const counterBefore = readVersionCounter(cin);
    const historyBefore = countHistoryRows(cin, 'k');

    const result = await upsert('k', { v: 1 });
    assert.deepEqual(result, { accepted: true, changed: false }, 'no self_healed flag, no change');
    assert.equal(readVersionCounter(cin), counterBefore, 'version_counter unchanged');
    assert.equal(countHistoryRows(cin, 'k'), historyBefore, 'no history row appended');
    assertNoCurrentProjectionDrift();
  } finally {
    teardown();
  }
});

test('a full source resync converges a multi-key stranded projection to zero drift', async () => {
  // Convergence under a full source resync. Pre-existing residue (anchors that
  // were stranded before anchor-preserving prune deployed, or by a torn bulk
  // delete) leaves several live keys orphaned at once. A real account resync
  // re-sends every live key; each unanchored key self-heals at a fresh
  // head-of-window version, and once the sweep covers every live key the
  // projection is consistent across the store. Here LIMIT >= liveKeys, so the
  // retention window holds all re-anchored keys and the resync reaches zero
  // drift.
  //
  // The orphans are seeded directly (raw anchor delete), not via prune churn:
  // anchor-preserving prune no longer strands a live-key anchor, so the prune
  // path can no longer manufacture this pre-state. Direct deletion reproduces
  // the exact residue (current row present, anchor gone) that a pre-fix prune
  // or a torn bulk delete leaves behind.
  process.env.PDPP_CHANGE_HISTORY_LIMIT = '3';
  setup();
  try {
    // Three live keys; a hot key advances the stream counter well past the
    // horizon so each heal's new version is genuinely head-of-window.
    await upsert('cold-a', { v: 1 });
    await upsert('cold-b', { v: 1 });
    for (let i = 0; i < 12; i += 1) {
      await upsert('hot', { v: i + 3 });
    }
    const cin = instanceIdFor();

    // Strand both cold anchors directly (the prune that used to do this is now
    // anchor-preserving). hot stays anchored at its latest version.
    deleteAnchor(cin, 'cold-a');
    deleteAnchor(cin, 'cold-b');
    assert.equal(countHistoryRows(cin, 'cold-a'), 0, 'cold-a stranded');
    assert.equal(countHistoryRows(cin, 'cold-b'), 0, 'cold-b stranded');
    const drift = detectCurrentProjectionDrift({ connectorInstanceId: cin, stream: STREAM });
    assert.equal(drift.length, 2, 'both cold keys orphaned before resync');

    // Full source resync: re-send every live key with its unchanged payload.
    // The cold keys self-heal; hot is already anchored so it stays a no-op.
    assert.equal((await upsert('cold-a', { v: 1 })).self_healed, true);
    assert.equal((await upsert('cold-b', { v: 1 })).self_healed, true);
    const hotResync = await upsert('hot', { v: 14 });
    assert.equal(hotResync.changed, false, 'still-anchored hot key resync is a plain no-op');

    // Anchor-preserving prune keeps every live key's anchor, so cold-a, cold-b,
    // and hot anchors all survive the heal sweep. The full resync converges to
    // zero drift across the store.
    assert.ok(countHistoryRows(cin, 'cold-a') >= 1);
    assert.ok(countHistoryRows(cin, 'cold-b') >= 1);
    assert.ok(countHistoryRows(cin, 'hot') >= 1, 'hot anchor retained within the horizon');
    assertNoCurrentProjectionDrift();
  } finally {
    teardown();
  }
});
