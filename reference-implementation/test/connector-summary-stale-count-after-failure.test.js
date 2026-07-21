// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Sol P2.3: nullable stream counts are not honest end-to-end after a
 * persisted failure.
 *
 * A repair-candidate upsert failure IS now durably persisted (Sol P1.1) —
 * the row's `record_snapshot_state` correctly flips to `failed`/non-current.
 * But `stream_records_json`, the JSON blob holding each stream's
 * `count_state`/`record_count`, is NOT one of the columns
 * `persistFailedEvidence*` touches — it is left exactly as the LAST
 * successful repair wrote it. Downstream shaping/synthesis
 * (`ref-control.ts`) forwarded those stale entries unchanged, so a stream
 * whose canonical checkpoint moved (a new record landed) but whose repair
 * attempt failed still reads `count_state: "known_zero"` / `record_count: 0`
 * — an exact-zero claim the repair never actually verified.
 *
 * Fix: `count_state` for any stream reading `known`/`known_zero` is
 * corrected to `stale` whenever `record_snapshot.state !== "current"` — the
 * approved semantics (spec.md: "prior count may be retained after its
 * checkpoint moved or repair failed"). The `ProjectionReliable` health gate
 * was already correctly closing (Sol P1.1); this closes the SEPARATE,
 * stream-level honesty gap Sol's second probe found underneath it.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { closeDb, getDb, initDb } from "../server/db.js";
import { reconcileConnectorSummaryEvidence } from "../server/connector-summary-evidence-engine.ts";
import { invalidateConnectorSummariesCache, listConnectorSummaries } from "../server/ref-control.ts";
import { ingestRecord } from "../server/records.js";

const OWNER = "owner_local";
const NOW = "2026-07-17T00:00:00.000Z";
const CONNECTOR_ID = "https://test.pdpp.dev/connectors/stale-count-after-failure";
const INSTANCE_ID = "cin_stale_count_after_failure";
const STREAM = "messages";

const MANIFEST = {
  protocol_version: "0.1.0",
  connector_id: CONNECTOR_ID,
  version: "1.0.0",
  display_name: "Stale Count After Failure Probe",
  capabilities: {
    public_listing: { listed: true, status: "test" },
  },
  streams: [
    {
      name: STREAM,
      primary_key: ["id"],
      coverage_strategy: "full_inventory",
      schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
  ],
};

async function withTempDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-stale-count-after-failure-"));
  invalidateConnectorSummariesCache();
  initDb(join(dir, "pdpp.sqlite"));
  try {
    return await fn();
  } finally {
    invalidateConnectorSummariesCache();
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedConnector() {
  getDb()
    .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(CONNECTOR_ID, JSON.stringify(MANIFEST), NOW);
}

function seedInstance() {
  getDb()
    .prepare(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       ) VALUES (?, ?, ?, ?, 'active', 'account', ?, '{}', ?, ?, NULL)`,
    )
    .run(INSTANCE_ID, OWNER, CONNECTOR_ID, "Stale Count After Failure Probe", INSTANCE_ID, NOW, NOW);
}

function storageTarget() {
  return { connector_id: CONNECTOR_ID, connector_instance_id: INSTANCE_ID };
}

async function listBypassCache() {
  return listConnectorSummaries(null, { concurrency: 1, includeRunSummaries: false });
}

function summaryFor(summaries) {
  const summary = summaries.find((row) => row.connector_instance_id === INSTANCE_ID);
  assert.ok(summary, "summary for the probe connection must be visible");
  return summary;
}

function projectionReliable(summary) {
  return summary.connection_health.conditions.find((condition) => condition.type === "ProjectionReliable");
}

test("a repair-candidate upsert failure with a checkpoint that already moved forward reads the stream as stale, never a fabricated known_zero", () =>
  withTempDb(async () => {
    seedConnector();
    seedInstance();

    // First pass: create a genuinely current, correct zero-record evidence
    // row — `stream_records_json` legitimately reads `known_zero` here,
    // because it IS zero and IS verified.
    const first = await reconcileConnectorSummaryEvidence(null);
    assert.equal(first.failed, 0);
    const beforeSummary = summaryFor(await listBypassCache());
    const beforeStream = beforeSummary.stream_records.find((entry) => entry.stream === STREAM);
    assert.ok(beforeStream, "the declared stream is present before any record lands");
    assert.equal(beforeStream.count_state, "known_zero", "fixture premise: genuinely zero and verified");
    assert.equal(beforeStream.record_count, 0);

    // A real record lands via the production ingest path — the true count
    // is now 1, but the durable stream_records_json still (wrongly, absent
    // this fix) reads the pre-ingest known_zero/0 once repair fails below.
    await ingestRecord(storageTarget(), {
      stream: STREAM,
      key: "msg_1",
      data: { id: "msg_1" },
      emitted_at: NOW,
    });

    // Fault injection: reject ONLY the repair upsert's INSERT (matching
    // reconcile-summary-evidence-failure-persistence.test.js's probe 1
    // exactly) — the failure-marker UPDATE still lands, so record_snapshot_state
    // durably flips to non-current while stream_records_json is left
    // completely untouched by that UPDATE (it is not one of the columns
    // persistFailedEvidenceSqlite's UPDATE statement sets).
    getDb().exec(
      `CREATE TRIGGER fault_stale_count_insert
         BEFORE INSERT ON connector_summary_evidence
       BEGIN
         SELECT RAISE(ABORT, 'injected summary-evidence upsert fault');
       END`,
    );
    let summary;
    try {
      const result = await reconcileConnectorSummaryEvidence(null);
      assert.equal(result.failed, 1, "the repair pass detects and counts the failure");

      const rawRow = getDb()
        .prepare("SELECT record_snapshot_state, stream_records_json FROM connector_summary_evidence WHERE connector_instance_id = ?")
        .get(INSTANCE_ID);
      assert.notEqual(rawRow.record_snapshot_state, "current", "the durable row is genuinely marked non-current by the failure");
      assert.match(rawRow.stream_records_json, /"count_state":"known_zero"/, "fixture premise: the RAW stored JSON is still the untouched pre-failure known_zero — proving the bug exists at the storage layer before the read-side fix is applied");

      summary = summaryFor(await listBypassCache());
    } finally {
      getDb().exec("DROP TRIGGER fault_stale_count_insert");
    }

    const projection = projectionReliable(summary);
    assert.equal(projection?.status, "false", "ProjectionReliable is false (Sol P1.1, already closed) — the health gate closes correctly");

    const afterStream = summary.stream_records.find((entry) => entry.stream === STREAM);
    assert.ok(afterStream, "the declared stream is still present, not omitted");
    // The decisive assertion: the wire-facing count_state must be corrected
    // to `stale`, never left as the fabricated `known_zero` the raw stored
    // JSON still holds.
    assert.equal(
      afterStream.count_state,
      "stale",
      "count_state must read stale (checkpoint moved, repair failed) — known_zero would be an exact-zero claim the failed repair never verified",
    );
    // spec.md: "prior count may be retained" — the last-known value (0) is
    // kept as a non-authoritative hint, not nulled to unknown; this is a
    // real distinction from unobserved/unknown, so it must not be null.
    assert.equal(afterStream.record_count, 0, "the prior known count is retained as a non-authoritative hint under count_state: stale, per spec.md");
  }));
