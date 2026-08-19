// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Callsite proof for the "Holding 0 records." defect, through the real product
 * route (`getConnectorSummaryForRoute`) rather than a pure-function seam.
 *
 * The unit test (`retained-records-unmeasured-not-zero.test.ts`) pins the
 * guard; this file pins the WIRING — that the summary projection feeds the
 * rendered verdict the authoritative evidence count and not the sparse
 * retained-size sum. Without it, reverting the callsite to
 * `retainedRecords: live.totalRecords` is caught only by an unused-variable
 * typecheck error, which is a weak oracle for a user-visible lie.
 *
 * Fixture reproduces the live shape observed 2026-08-19 (prod Postgres):
 *   - `source_kind='manual'`, `status='paused'`, zero runs ever
 *   - a `connector_summary_evidence` row whose `total_records` is CORRECT and
 *     whose `record_snapshot_state` is `current`
 *   - NO `retained_size_stream` / `retained_size_connection` rows at all
 *
 * google-maps (cin_50f5bf4b7ecbc7acd6f4c254) held 299,248 records this way and
 * was told it held 0.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { closeDb, getDb, initDb } from "../server/db.ts";
import { getConnectorSummaryForRoute, invalidateConnectorSummariesCache } from "../server/ref-control.ts";
import { makeTemporaryDbPath } from "./helpers/temp-dir.ts";

const CONNECTOR_ID = "test_retained_manual_import";
const INSTANCE_ID = "cin_retained_manual_import";
const NOW = "2026-08-19T00:00:00.000Z";
const RETAINED_RECORDS = 299_248;

/** The exact false statement this file exists to prevent. */
const HOLDING_ZERO_RECORDS = /Holding\s+0\s+records/;

/** Manifest with the two streams the live google-maps import declares. */
function seedConnector(): void {
  const manifest = {
    capabilities: { public_listing: { tier: "supported" } },
    connector_id: CONNECTOR_ID,
    display_name: CONNECTOR_ID,
    protocol_version: "0.1.0",
    streams: [{ name: "timeline_points" }, { name: "timeline_segments" }],
    version: "1.0.0",
  };
  getDb()
    .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(CONNECTOR_ID, JSON.stringify(manifest), NOW);
}

/** A PAUSED, MANUAL-source connection — the live shape, never run. */
function seedPausedManualInstance(): void {
  getDb()
    .prepare(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       ) VALUES (?, ?, ?, ?, 'paused', 'manual', ?, '{}', ?, ?, NULL)`
    )
    .run(INSTANCE_ID, "owner_local", CONNECTOR_ID, CONNECTOR_ID, INSTANCE_ID, NOW, NOW);
}

/**
 * The maintained evidence row: counts are CORRECT and the snapshot is current.
 * This is the authority the rendered verdict must read. Deliberately seeds NO
 * `retained_size_stream`/`retained_size_connection` rows, so the retained-size
 * projection sums zero rows to `0` exactly as it does in production.
 */
function seedCorrectEvidenceWithNoRetainedSizeRows(recordSnapshotState: "current" | "stale" = "current"): void {
  const streamRecords = [
    {
      count_state: "known",
      declaration_state: "declared",
      record_count: 246_559,
      retained_record_count: null,
      stream: "timeline_points",
    },
    {
      count_state: "known",
      declaration_state: "declared",
      record_count: 52_689,
      retained_record_count: null,
      stream: "timeline_segments",
    },
  ];
  const columns = getDb().prepare("SELECT name FROM pragma_table_info('connector_summary_evidence')").all() as {
    name: string;
  }[];
  const available = new Set(columns.map((column) => column.name));
  const values: Record<string, unknown> = {
    computed_at: NOW,
    connector_id: CONNECTOR_ID,
    connector_instance_id: INSTANCE_ID,
    dirty: 0,
    display_name: CONNECTOR_ID,
    last_record_updated_at: NOW,
    manifest_declaration_state: "current",
    manifest_generation: 0,
    record_checkpoint_json: JSON.stringify({
      streams: [{ stream: "timeline_points" }, { stream: "timeline_segments" }],
    }),
    record_snapshot_reason_code: recordSnapshotState === "current" ? null : "record_snapshot_stale",
    record_snapshot_state: recordSnapshotState,
    retained_bytes_json: JSON.stringify({}),
    retained_bytes_state: "stale",
    source_kind: "manual",
    state: "fresh",
    status: "paused",
    stream_count: 2,
    stream_records_json: JSON.stringify(streamRecords),
    total_records: RETAINED_RECORDS,
    total_retained_bytes: 0,
  };
  const names = Object.keys(values).filter((name) => available.has(name));
  getDb()
    .prepare(`INSERT INTO connector_summary_evidence(${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`)
    .run(...names.map((name) => values[name]));
}

function retainedSizeRowCount(): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM retained_size_stream WHERE connector_instance_id = ?")
    .get(INSTANCE_ID) as { n: number };
  return row.n;
}

test("route: a paused manual import with a correct evidence row and NO retained-size rows reports its real count", async () => {
  const dbPath = makeTemporaryDbPath("pdpp-retained-manual-import-");
  initDb(dbPath);
  try {
    seedConnector();
    seedPausedManualInstance();
    seedCorrectEvidenceWithNoRetainedSizeRows();
    invalidateConnectorSummariesCache();

    assert.equal(
      retainedSizeRowCount(),
      0,
      "precondition: the retained-size projection has never measured this connection"
    );

    const summary = (await getConnectorSummaryForRoute(INSTANCE_ID)) as {
      rendered_verdict?: { progress?: { headline?: string; retained_records?: number | null } };
      total_records?: number;
    } | null;
    assert.ok(summary, "expected a summary for the seeded connection");

    assert.equal(
      summary.total_records,
      RETAINED_RECORDS,
      "precondition: the evidence row's count is the authoritative total"
    );

    const progress = summary.rendered_verdict?.progress;
    const headline = progress?.headline ?? "";

    // The defect, stated as an assertion: this connection holds 299,248
    // records, so it must never be told it holds zero.
    assert.ok(
      !HOLDING_ZERO_RECORDS.test(headline),
      `a connection holding ${RETAINED_RECORDS} records must never render "Holding 0 records"; got ${JSON.stringify(headline)}`
    );
    assert.notStrictEqual(progress?.retained_records, 0, "an unmeasured retained-size projection must not report 0");

    // And it must state the truth, from the authoritative evidence count.
    assert.strictEqual(progress?.retained_records, RETAINED_RECORDS);
    assert.strictEqual(headline, "Holding 299,248 records.");
  } finally {
    invalidateConnectorSummariesCache();
    closeDb();
  }
});

test("route: a STALE evidence snapshot withholds the count entirely rather than asserting a number", async () => {
  // A non-current snapshot means the stored counts predate a failure. The
  // honest response is to make no count claim — not to restate a number that
  // may no longer hold, and emphatically not to fall back to the sparse
  // retained-size zero.
  const dbPath = makeTemporaryDbPath("pdpp-retained-manual-import-stale-");
  initDb(dbPath);
  try {
    seedConnector();
    seedPausedManualInstance();
    seedCorrectEvidenceWithNoRetainedSizeRows("stale");
    invalidateConnectorSummariesCache();

    assert.equal(retainedSizeRowCount(), 0, "precondition: no retained-size measurement exists");

    const summary = (await getConnectorSummaryForRoute(INSTANCE_ID)) as {
      rendered_verdict?: { progress?: { headline?: string; retained_records?: number | null } };
    } | null;
    assert.ok(summary, "expected a summary for the seeded connection");

    const progress = summary.rendered_verdict?.progress;
    const headline = progress?.headline ?? "";

    assert.strictEqual(
      progress?.retained_records,
      null,
      "a stale snapshot must withhold the count, not assert a possibly-outdated number"
    );
    assert.ok(
      !HOLDING_ZERO_RECORDS.test(headline),
      `a stale snapshot must never render "Holding 0 records"; got ${JSON.stringify(headline)}`
    );
    assert.strictEqual(headline, "Refresh to update.", `got ${JSON.stringify(headline)}`);
  } finally {
    invalidateConnectorSummariesCache();
    closeDb();
  }
});
