// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * DB-backed oracle for the HISTORICAL semantic-time repair
 * (`backfillSqliteRecordSemanticTimesForManifest` in mode `ingest-stamped`).
 *
 * The coercion rules themselves are pinned by semantic-time-absence-oracle;
 * what this file pins is the repair's SAFETY contract, which is what makes it
 * safe to run against the owner's real data:
 *
 *   1. It CORRECTS, it does not merely fill blanks. The shipped ingest fix was
 *      forward-only, so 20,725 already-stored rows carried
 *      `semantic_time = emitted_at`. A backfill that only touched empty values
 *      would leave every one of them wrong.
 *   2. It NEVER overwrites a semantic_time that is already a real, distinct
 *      date — even when today's manifest would recompute a different value.
 *   3. It is IDEMPOTENT: a second pass writes nothing.
 *   4. A stream can end up MIXED — real dates for records that have one,
 *      absence for records whose declared field is a provider sentinel. This
 *      is the steam/owned_games shape observed live (444 real / 284 absent).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { closeDb, getDb, initDb } from "../server/db.ts";
import { backfillSqliteRecordSemanticTimesForManifest } from "../server/records.ts";

const CONNECTOR_ID = "steam";
const INSTANCE_ID = "cin_test_instance";
const INGEST_AT = "2026-08-08T03:32:21.567Z";

/** Manifest shaped like the live steam one: owned_games keys off rtime_last_played. */
const MANIFEST = {
  connector_id: CONNECTOR_ID,
  streams: [{ consent_time_field: "rtime_last_played", name: "owned_games", primary_key: ["id"] }],
};

function withTempDb(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-semtime-repair-"));
    try {
      initDb(join(dir, "pdpp.sqlite"));
      await fn();
    } finally {
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  };
}

function insertRecord(recordKey: string, data: Record<string, unknown>, semanticTime: string): void {
  getDb()
    .prepare(
      `INSERT INTO records
         (connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, semantic_time, version, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0)`
    )
    .run(CONNECTOR_ID, INSTANCE_ID, "owned_games", recordKey, JSON.stringify(data), INGEST_AT, semanticTime);
}

function semanticTimeOf(recordKey: string): string {
  const row = getDb()
    .prepare(`SELECT semantic_time FROM records WHERE record_key = ?`)
    .get(recordKey) as { semantic_time: string } | undefined;
  assert.ok(row, `expected a row for ${recordKey}`);
  return row.semantic_time;
}

test(
  "ingest-stamped mode CORRECTS a wrong semantic_time, not just an empty one",
  withTempDb(async () => {
    // The exact live defect: semantic_time == emitted_at, while the payload
    // carries a real Jan-2016 date in the manifest-declared field.
    insertRecord("played", { id: "played", rtime_last_played: 1_452_378_173 }, INGEST_AT);

    const result = await backfillSqliteRecordSemanticTimesForManifest(MANIFEST, { mode: "ingest-stamped" });

    assert.equal(result.updated, 1);
    assert.equal(semanticTimeOf("played"), "2016-01-09T22:22:53.000Z");
  })
);

test(
  "a provider sentinel becomes ABSENCE, never 1970 and never the ingest clock",
  withTempDb(async () => {
    // rtime_last_played = 0 means "never played". Absence is the correct answer.
    insertRecord("never", { id: "never", rtime_last_played: 0 }, INGEST_AT);

    await backfillSqliteRecordSemanticTimesForManifest(MANIFEST, { mode: "ingest-stamped" });

    const stored = semanticTimeOf("never");
    assert.equal(stored, "", "sentinel must store the empty-string absence encoding");
    assert.notEqual(stored, INGEST_AT, "must never retain the ingest timestamp");
  })
);

test(
  "one stream can be MIXED: dated where a date exists, absent where it does not",
  withTempDb(async () => {
    insertRecord("played", { id: "played", rtime_last_played: 1_452_378_173 }, INGEST_AT);
    insertRecord("never", { id: "never", rtime_last_played: 0 }, INGEST_AT);

    const result = await backfillSqliteRecordSemanticTimesForManifest(MANIFEST, { mode: "ingest-stamped" });

    assert.equal(result.updated, 2);
    assert.equal(semanticTimeOf("played"), "2016-01-09T22:22:53.000Z");
    assert.equal(semanticTimeOf("never"), "");
    const outcome = result.streams.find((entry) => entry.stream === "owned_games");
    assert.ok(outcome);
    assert.equal(outcome.toSemanticDate, 1);
    assert.equal(outcome.toAbsence, 1);
  })
);

test(
  "a real semantic_time that differs from emitted_at is NEVER overwritten",
  withTempDb(async () => {
    // This row's stored date disagrees with what the manifest would recompute.
    // ingest-stamped mode must leave it alone: it is not provably wrong, and a
    // recompute would destroy information the repair has no license to discard.
    const preexisting = "2015-05-05T00:00:00.000Z";
    insertRecord("hand-corrected", { id: "hand-corrected", rtime_last_played: 1_452_378_173 }, preexisting);

    const result = await backfillSqliteRecordSemanticTimesForManifest(MANIFEST, { mode: "ingest-stamped" });

    assert.equal(result.updated, 0);
    assert.equal(semanticTimeOf("hand-corrected"), preexisting);
  })
);

test(
  "drift mode DOES rewrite that same row — the two modes are genuinely different",
  withTempDb(async () => {
    // Counterweight to the test above: proves the preservation is the MODE's
    // doing, not an accident of the row's shape.
    insertRecord("hand-corrected", { id: "hand-corrected", rtime_last_played: 1_452_378_173 }, "2015-05-05T00:00:00.000Z");

    const result = await backfillSqliteRecordSemanticTimesForManifest(MANIFEST, { mode: "drift" });

    assert.equal(result.updated, 1);
    assert.equal(semanticTimeOf("hand-corrected"), "2016-01-09T22:22:53.000Z");
  })
);

test(
  "the repair is idempotent: a second pass writes nothing",
  withTempDb(async () => {
    insertRecord("played", { id: "played", rtime_last_played: 1_452_378_173 }, INGEST_AT);
    insertRecord("never", { id: "never", rtime_last_played: 0 }, INGEST_AT);

    const first = await backfillSqliteRecordSemanticTimesForManifest(MANIFEST, { mode: "ingest-stamped" });
    const second = await backfillSqliteRecordSemanticTimesForManifest(MANIFEST, { mode: "ingest-stamped" });

    assert.equal(first.updated, 2);
    assert.equal(second.updated, 0, "a converged repair must be a no-op");
    assert.equal(semanticTimeOf("played"), "2016-01-09T22:22:53.000Z");
    assert.equal(semanticTimeOf("never"), "");
  })
);

test(
  "dry run reports what it would write and changes nothing",
  withTempDb(async () => {
    insertRecord("played", { id: "played", rtime_last_played: 1_452_378_173 }, INGEST_AT);

    const preview = await backfillSqliteRecordSemanticTimesForManifest(MANIFEST, {
      dryRun: true,
      mode: "ingest-stamped",
    });

    assert.equal(preview.updated, 1, "dry run must still report the intended change");
    assert.equal(semanticTimeOf("played"), INGEST_AT, "dry run must not write");
  })
);

test(
  "a stream whose manifest declares NO time field is repaired to absence",
  withTempDb(async () => {
    // gmail/labels, steam/profile, usaa/accounts: no declared semantic field at
    // all, so every ingest-stamped row there is pure fabrication.
    insertRecord("no-field", { id: "no-field", name: "Half-Life 2" }, INGEST_AT);

    const result = await backfillSqliteRecordSemanticTimesForManifest(
      { connector_id: CONNECTOR_ID, streams: [{ name: "owned_games", primary_key: ["id"] }] },
      { mode: "ingest-stamped" }
    );

    assert.equal(result.updated, 1);
    assert.equal(semanticTimeOf("no-field"), "");
  })
);
