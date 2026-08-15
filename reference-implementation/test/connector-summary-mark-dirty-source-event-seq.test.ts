// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `markDirty`'s `sourceEventSeq` normalization, pinned as ONE shared
 * contract both storage backends bind identically.
 *
 * Background: each backend used to inline its own guard, and they disagreed.
 * Postgres guarded `null` AND `undefined` — it had to, because
 * `Number(undefined)` is `NaN` and its bigint column rejects that outright
 * ("invalid input syntax for type bigint: 'NaN'"), throwing before the UPDATE
 * ran. That made every omitted-`sourceEventSeq` dirty-mark a silent no-op,
 * swallowed by `markConnectorSummaryEvidenceDirty`'s best-effort catch.
 * SQLite guarded only `null`, so it bound `NaN` — which better-sqlite3
 * coerces to SQL NULL, so `COALESCE(?, source_event_seq)` preserved the prior
 * value anyway. That accident is precisely why the drift never produced a
 * SQLite symptom and why no existing test caught it.
 *
 * So NO durable-outcome test on SQLite can discriminate the two guard shapes
 * — verified, not assumed: reverting the SQLite call site to its pre-fix form
 * leaves every durable-outcome case in this file green. The divergence is
 * observable only in the value that gets BOUND, so the discriminating tests
 * assert `normalizeSourceEventSeq` directly (see the block above them).
 *
 * The durable-outcome tests below are therefore CONTRACT tests, not
 * discriminating ones: they pin the owner-visible behavior both backends must
 * share (`source_event_seq` preserved or advanced, `dirty` always set) so a
 * future change cannot regress it silently.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { markConnectorSummaryEvidenceDirty, normalizeSourceEventSeq } from "../server/connector-summary-read-model.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";

const NOW = "2026-08-10T00:00:00.000Z";
const INSTANCE_ID = "cin_mark_dirty";

function withTempDb(fn: () => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-mark-dirty-"));
    try {
      initDb(join(dir, "pdpp.sqlite"));
      await fn();
    } finally {
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  };
}

/**
 * Seeds one evidence row. `sourceEventSeq: null` is the case that makes an
 * errant `NaN` bind observable — with a prior value present, `COALESCE`
 * masks the difference entirely.
 */
function seedEvidenceRow(sourceEventSeq: number | null): void {
  getDb().prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES ('c1', '{}', ?)").run(NOW);
  getDb()
    .prepare(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       ) VALUES (?, 'owner_local', 'c1', 'x', 'active', 'account', ?, '{}', ?, ?, NULL)`
    )
    .run(INSTANCE_ID, INSTANCE_ID, NOW, NOW);
  getDb()
    .prepare(
      `INSERT INTO connector_summary_evidence(
         connector_instance_id, connector_id, dirty, state, source_event_seq, computed_at
       ) VALUES (?, 'c1', 0, 'fresh', ?, ?)`
    )
    .run(INSTANCE_ID, sourceEventSeq, NOW);
}

function readRow(): { dirty: number; sourceEventSeq: number | null } {
  const row = getDb()
    .prepare("SELECT dirty, source_event_seq FROM connector_summary_evidence WHERE connector_instance_id = ?")
    .get<{ dirty: number; source_event_seq: number | null }>(INSTANCE_ID);
  assert.ok(row, "evidence row exists");
  return {
    dirty: Number(row.dirty ?? 0),
    sourceEventSeq: row.source_event_seq === null ? null : Number(row.source_event_seq),
  };
}

/**
 * The DISCRIMINATING layer. These assert the shared normalizer directly,
 * because the durable-outcome tests below CANNOT distinguish the two guard
 * shapes on SQLite: better-sqlite3 coerces `NaN` to SQL NULL, so both the old
 * (`=== null ? null : Number(v)`) and new forms leave `COALESCE` seeing NULL
 * and produce byte-identical rows. Verified, not assumed — reverting the
 * SQLite call site to its pre-fix form leaves all five durable-outcome tests
 * green.
 *
 * The divergence is only observable at the value that gets BOUND, which is
 * exactly what these pin. Against the old SQLite guard,
 * `normalizeSourceEventSeq("abc")` is `NaN` (and `NaN !== null`), so
 * `assert.equal(..., null)` fails deterministically. Postgres would reject
 * that same `NaN` at the bigint column and lose the whole dirty mark; no
 * live Postgres was reachable here (the dedicated 127.0.0.1:55447 test
 * listener is not running), so that half is pinned by the shared contract
 * rather than by an executed cross-backend run.
 */
test("normalizeSourceEventSeq maps every non-finite input to SQL NULL, never NaN", () => {
  // The pre-fix SQLite guard returned NaN for each of these.
  assert.equal(normalizeSourceEventSeq("not-a-number"), null, "an unparseable string is NULL, not NaN");
  assert.equal(normalizeSourceEventSeq({}), null, "an object is NULL, not NaN");
  assert.equal(normalizeSourceEventSeq([1, 2]), null, "a multi-element array is NULL, not NaN");
  assert.equal(normalizeSourceEventSeq(Number.NaN), null, "an explicit NaN is NULL");
  assert.equal(normalizeSourceEventSeq(Number.POSITIVE_INFINITY), null, "Infinity is not a bindable bigint");
  assert.equal(normalizeSourceEventSeq(Number.NEGATIVE_INFINITY), null, "-Infinity is not a bindable bigint");
});

test("normalizeSourceEventSeq maps both nullish inputs to SQL NULL — the case the Postgres fix established", () => {
  assert.equal(normalizeSourceEventSeq(null), null, "explicit null is NULL");
  assert.equal(
    normalizeSourceEventSeq(undefined),
    null,
    "omitted (undefined) is NULL — this is what NaN'd on Postgres"
  );
});

test("normalizeSourceEventSeq preserves every genuinely parseable seq unchanged", () => {
  assert.equal(normalizeSourceEventSeq(0), 0, "zero is a real seq, never coerced away by a falsy check");
  assert.equal(normalizeSourceEventSeq(61), 61, "a plain number passes through");
  assert.equal(normalizeSourceEventSeq("77"), 77, "a numeric string still coerces, exactly as before");
});

test(
  "an unparseable sourceEventSeq never binds NaN — the stored seq stays NULL and the row is still marked dirty",
  withTempDb(async () => {
    seedEvidenceRow(null);

    // The old SQLite guard computed `NaN` here; the shared normalizer yields
    // `null`. Both store NULL on SQLite, so this case pins the contract
    // rather than discriminating the fix — the normalizer tests above do that.
    await markConnectorSummaryEvidenceDirty({
      connectorInstanceId: INSTANCE_ID,
      reason: "unparseable seq",
      sourceEventSeq: "not-a-number",
    });

    const row = readRow();
    assert.equal(row.sourceEventSeq, null, "an unparseable seq must never be stored as a value");
    assert.equal(row.dirty, 1, "a malformed seq must never cost the dirty mark itself — it is a best-effort hint");
  })
);

test(
  "an unparseable sourceEventSeq PRESERVES an existing stored seq rather than clobbering it",
  withTempDb(async () => {
    seedEvidenceRow(4242);

    await markConnectorSummaryEvidenceDirty({
      connectorInstanceId: INSTANCE_ID,
      reason: "unparseable seq over an existing value",
      sourceEventSeq: {},
    });

    const row = readRow();
    assert.equal(row.sourceEventSeq, 4242, "COALESCE must see SQL NULL, so the known-good seq survives");
    assert.equal(row.dirty, 1, "the dirty mark still lands");
  })
);

test(
  "an omitted sourceEventSeq preserves the existing stored seq and still marks dirty",
  withTempDb(async () => {
    seedEvidenceRow(99);

    // The common shape: all 35 production call sites omit `sourceEventSeq`
    // entirely. Not discriminating on SQLite (both guard shapes agree here),
    // but it pins the contract that the Postgres fix established.
    await markConnectorSummaryEvidenceDirty({
      connectorInstanceId: INSTANCE_ID,
      reason: "record ingest changed connection count/stream evidence",
    });

    const row = readRow();
    assert.equal(row.sourceEventSeq, 99, "an omitted seq must leave the stored value untouched");
    assert.equal(row.dirty, 1, "the dirty mark lands");
  })
);

test(
  "an explicit numeric sourceEventSeq is still written through unchanged",
  withTempDb(async () => {
    seedEvidenceRow(5);

    await markConnectorSummaryEvidenceDirty({
      connectorInstanceId: INSTANCE_ID,
      reason: "explicit seq",
      sourceEventSeq: 61,
    });

    assert.equal(readRow().sourceEventSeq, 61, "a genuine seq must still advance the stored value");
  })
);

test(
  "a numeric-STRING sourceEventSeq is still coerced and written through — normalization did not narrow the accepted shape",
  withTempDb(async () => {
    seedEvidenceRow(5);

    await markConnectorSummaryEvidenceDirty({
      connectorInstanceId: INSTANCE_ID,
      reason: "numeric string seq",
      sourceEventSeq: "77",
    });

    assert.equal(readRow().sourceEventSeq, 77, "a parseable numeric string is a valid seq, exactly as before");
  })
);
