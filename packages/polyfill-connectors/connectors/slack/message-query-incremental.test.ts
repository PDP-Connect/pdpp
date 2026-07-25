// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Proves the incremental message-read rewrite (threshold pushed INTO the
// dedup CTE) is emit-identical to the reference "full aggregate then filter"
// query across every threshold shape, and that its incremental behavior is
// correct (new rows emitted, old rows not, latest chunk wins). All fixtures
// are synthetic in-memory archives — no private payloads.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { buildMessageRowsQuery } from "./index.ts";

interface Thresholds {
  channelLastTs: Record<string, string>;
  legacyLastTs: string | null;
}

interface Seed {
  channelId: string;
  chunkId: number;
  data: string;
  ts: string;
}

function makeArchive(rows: readonly Seed[]): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE MESSAGE (
      CHANNEL_ID TEXT NOT NULL,
      TS TEXT NOT NULL,
      THREAD_TS TEXT,
      IS_PARENT INTEGER,
      TXT TEXT,
      NUM_FILES INTEGER,
      DATA BLOB,
      CHUNK_ID INTEGER NOT NULL
    );
  `);
  const stmt = db.prepare(
    "INSERT INTO MESSAGE (CHANNEL_ID, TS, THREAD_TS, IS_PARENT, TXT, NUM_FILES, DATA, CHUNK_ID) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );
  for (const r of rows) {
    stmt.run(r.channelId, r.ts, null, 0, r.data, 0, r.data, r.chunkId);
  }
  return db;
}

// Independent reference: aggregate over the WHOLE table, then filter — the
// pre-rewrite shape. Kept inline so the test does not depend on the code under
// test to define "correct".
function referenceQuery(thresholds: Thresholds): { params: string[]; sql: string } {
  const channelThresholds = Object.entries(thresholds.channelLastTs)
    .filter(([id, ts]) => id.length > 0 && ts.length > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  const params: string[] = [];
  const thresholdCte =
    channelThresholds.length > 0
      ? `,
    thresholds(channel_id, last_ts) AS (
      VALUES ${channelThresholds
        .map(([id, ts]) => {
          params.push(id, ts);
          return "(?, ?)";
        })
        .join(", ")}
    )`
      : "";
  const join = channelThresholds.length > 0 ? "LEFT JOIN thresholds t ON t.channel_id = m.CHANNEL_ID" : "";
  let where = "";
  if (channelThresholds.length > 0 && thresholds.legacyLastTs) {
    where = "WHERE m.TS > COALESCE(t.last_ts, ?)";
    params.push(thresholds.legacyLastTs);
  } else if (channelThresholds.length > 0) {
    where = "WHERE t.last_ts IS NULL OR m.TS > t.last_ts";
  } else if (thresholds.legacyLastTs) {
    where = "WHERE m.TS > ?";
    params.push(thresholds.legacyLastTs);
  }
  return {
    params,
    sql: `
    WITH latest AS (
      SELECT CHANNEL_ID, TS, MAX(CHUNK_ID) AS mx FROM MESSAGE GROUP BY CHANNEL_ID, TS
    )${thresholdCte}
    SELECT m.CHANNEL_ID, m.TS, m.DATA, m.CHUNK_ID
    FROM MESSAGE m
    JOIN latest ON latest.CHANNEL_ID = m.CHANNEL_ID AND latest.TS = m.TS AND latest.mx = m.CHUNK_ID
    ${join}
    ${where}`,
  };
}

function runRows(db: DatabaseSync, q: { params: string[]; sql: string }): string[] {
  const rows = db.prepare(q.sql).all(...q.params) as Array<{
    CHANNEL_ID: string;
    TS: string;
    DATA: unknown;
    mx?: number;
  }>;
  // Fingerprint each emitted row by (channel, ts, winning DATA) and sort for
  // order-independent comparison.
  return rows.map((r) => `${r.CHANNEL_ID}|${r.TS}|${String(r.DATA)}`).sort((a, b) => a.localeCompare(b));
}

// A rich fixture: two channels, multiple TS, several with duplicate chunks so
// MAX(CHUNK_ID) actually has to choose, spanning below/at/above the cursors.
const FIXTURE: Seed[] = [
  { channelId: "C1", ts: "100.000001", chunkId: 1, data: "c1-100-v1" },
  { channelId: "C1", ts: "100.000001", chunkId: 5, data: "c1-100-v2-latest" },
  { channelId: "C1", ts: "200.000001", chunkId: 2, data: "c1-200-v1" },
  { channelId: "C1", ts: "200.000001", chunkId: 9, data: "c1-200-v2-latest" },
  { channelId: "C1", ts: "300.000001", chunkId: 3, data: "c1-300-only" },
  { channelId: "C2", ts: "150.000001", chunkId: 1, data: "c2-150-only" },
  { channelId: "C2", ts: "250.000001", chunkId: 4, data: "c2-250-v1" },
  { channelId: "C2", ts: "250.000001", chunkId: 7, data: "c2-250-v2-latest" },
];

const SHAPES: Array<{ name: string; thresholds: Thresholds }> = [
  { name: "no cursor (first run, full coverage)", thresholds: { channelLastTs: {}, legacyLastTs: null } },
  { name: "legacy-only cursor", thresholds: { channelLastTs: {}, legacyLastTs: "180.000000" } },
  {
    name: "per-channel cursors",
    thresholds: { channelLastTs: { C1: "100.000001", C2: "250.000001" }, legacyLastTs: null },
  },
  {
    name: "per-channel + legacy fallback",
    thresholds: { channelLastTs: { C1: "100.000001" }, legacyLastTs: "180.000000" },
  },
];

for (const shape of SHAPES) {
  test(`incremental message query is emit-identical to reference: ${shape.name}`, () => {
    const db = makeArchive(FIXTURE);
    const actual = runRows(db, buildMessageRowsQuery(shape.thresholds));
    const expected = runRows(db, referenceQuery(shape.thresholds));
    assert.deepEqual(actual, expected, `emitted set diverged for shape: ${shape.name}`);
    db.close();
  });
}

test("no cursor emits every unique (channel, ts) with the latest chunk's DATA", () => {
  const db = makeArchive(FIXTURE);
  const rows = runRows(db, buildMessageRowsQuery({ channelLastTs: {}, legacyLastTs: null }));
  assert.deepEqual(rows, [
    "C1|100.000001|c1-100-v2-latest",
    "C1|200.000001|c1-200-v2-latest",
    "C1|300.000001|c1-300-only",
    "C2|150.000001|c2-150-only",
    "C2|250.000001|c2-250-v2-latest",
  ]);
  db.close();
});

test("per-channel cursor emits only rows strictly newer than the channel's cursor", () => {
  const db = makeArchive(FIXTURE);
  // C1 cursor at 100 → emit 200, 300 (not 100). C2 cursor at 250 → emit nothing.
  const rows = runRows(
    db,
    buildMessageRowsQuery({ channelLastTs: { C1: "100.000001", C2: "250.000001" }, legacyLastTs: null })
  );
  assert.deepEqual(rows, ["C1|200.000001|c1-200-v2-latest", "C1|300.000001|c1-300-only"]);
  db.close();
});

test("a newer higher-CHUNK_ID row for a past-cursor TS wins the dedup", () => {
  // Simulate a resume adding a richer chunk (id 12) for an already-known but
  // above-cursor TS. Latest chunk must win.
  const db = makeArchive([
    ...FIXTURE,
    { channelId: "C1", ts: "300.000001", chunkId: 12, data: "c1-300-resumed-latest" },
  ]);
  const rows = runRows(db, buildMessageRowsQuery({ channelLastTs: { C1: "100.000001" }, legacyLastTs: null }));
  assert.ok(rows.includes("C1|300.000001|c1-300-resumed-latest"), "latest chunk for 300 must win");
  assert.ok(!rows.includes("C1|300.000001|c1-300-only"), "stale chunk for 300 must not be emitted");
  db.close();
});

test("legacy-only cursor filters across all channels", () => {
  const db = makeArchive(FIXTURE);
  const rows = runRows(db, buildMessageRowsQuery({ channelLastTs: {}, legacyLastTs: "180.000000" }));
  // Only TS > 180: C1 200, C1 300, C2 250 (not C1 100, not C2 150).
  assert.deepEqual(rows, [
    "C1|200.000001|c1-200-v2-latest",
    "C1|300.000001|c1-300-only",
    "C2|250.000001|c2-250-v2-latest",
  ]);
  db.close();
});
