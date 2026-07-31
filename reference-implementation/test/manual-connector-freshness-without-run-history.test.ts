// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Live fleet symptom (fleet-evidence-tail-0731): a manual-refresh connection
 * with genuinely complete, current per-stream coverage evidence — reconciled
 * from a real terminal run's `collection_facts` recorded on the spine — but
 * NO `run_history` row (its historical runs predate/bypassed the
 * run-history-writer generalization, or could not be attributed by the
 * backfill sweep) read `freshness.captured_at: null` / `freshness.status:
 * "unknown"` even though its streams had genuinely fresh, complete records.
 *
 * Root cause: `getConnectorRecordProjection`'s retained-size row shaping
 * (`ref-control.ts`) built `RecordProjectionRow`s from `retained_size_stream`
 * rows without ever populating `last_updated` — the column is named
 * `computed_at` on `retained_size_stream`/`retained_size_connection`
 * (retained-size-read-model.ts's `shapeStreamRow`/`shapeConnectionRow`), but
 * the mapping into `RecordProjectionRow.last_updated` was missing (silently
 * `null`/`undefined` via an unchecked cast in two call sites, hardcoded
 * `null` in a third). `buildConnectorFreshness` derives `freshness.
 * captured_at` from `recordLastUpdatedAt`, which falls back to `live.
 * freshness.captured_at` (built from that same broken field) whenever no
 * `run_history`-derived classifying run exists — so `captured_at` was always
 * null for exactly this shape of connection, and the manual-refresh-policy
 * "unknown -> current" promotion (which requires `captured_at` to already be
 * truthy) never fired either.
 *
 * This test proves the freshness half of the fix: a manual-refresh
 * connection with real, current retained-size evidence but no `run_history`
 * row now surfaces a non-null, current `freshness` instead of an unknown/
 * null one.
 *
 * NOT in scope / NOT fixed by this change (documented, not silently
 * dropped): `owner_state.resolver` still resolves `not_measured` for this
 * exact fixture, because the connection-level `coverage` health axis
 * (`mapCoverageAxis`, ref-control.ts) is deliberately, independently gated on
 * `lastRun.status === "succeeded"` — by design, a stream's own
 * `collection_report` completeness (sourced from `latestStreamFacts`, i.e.
 * spine-reconciled evidence) never promotes the connection-level coverage
 * axis; it only ever degrades it (`rollupCollectionReportCoverageOverride`).
 * Closing that half of the live symptom requires either a new run recording
 * a `run_history` row going forward, or a deliberate, separately-reviewed
 * change to how legacy/ambiguous runs are attributed during backfill — see
 * fleet-evidence-tail-0731.md.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { rebuildConnectorSummaryEvidence } from "../server/connector-summary-read-model.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import {
  type ConnectorSummary,
  invalidateConnectorSummariesCache,
  listConnectorSummaries,
} from "../server/ref-control.ts";

const OWNER = "owner_local";
const NOW = "2026-07-31T00:00:00.000Z";
const CONNECTOR_ID = "https://test.pdpp.dev/connectors/manual-freshness-without-run-history";
const INSTANCE_ID = "cin_manual_freshness_without_run_history";
const STREAM = "orders";
const RUN_ID = "run_manual_freshness_without_run_history";

const MANIFEST = {
  capabilities: {
    public_listing: { listed: true, status: "test" },
    refresh_policy: {
      maximum_staleness_seconds: 86_400,
      rationale: "Manual freshness probe manifest has no automatic refresh.",
      recommended_mode: "manual",
    },
  },
  connector_id: CONNECTOR_ID,
  display_name: "Manual Freshness Without Run History Probe",
  protocol_version: "0.1.0",
  streams: [
    {
      coverage_strategy: "checkpoint_window",
      freshness_strategy: "manual_as_of",
      name: STREAM,
      primary_key: ["id"],
      schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
    },
  ],
  version: "1.0.0",
};

async function withTempDb<T>(fn: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-manual-freshness-without-run-history-"));
  invalidateConnectorSummariesCache();
  initDb(join(dir, "pdpp.sqlite"));
  try {
    return await fn();
  } finally {
    invalidateConnectorSummariesCache();
    closeDb();
    rmSync(dir, { force: true, recursive: true });
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
       ) VALUES (?, ?, ?, ?, 'active', 'account', ?, '{}', ?, ?, NULL)`
    )
    .run(INSTANCE_ID, OWNER, CONNECTOR_ID, "Manual Freshness Without Run History Probe", INSTANCE_ID, NOW, NOW);
}

function seedRecord() {
  getDb()
    .prepare(
      `INSERT INTO records(
         connector_id, connector_instance_id, stream, record_key, record_json,
         emitted_at, semantic_time, version, deleted
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0)`
    )
    .run(CONNECTOR_ID, INSTANCE_ID, STREAM, "order_1", JSON.stringify({ id: "order_1" }), NOW, NOW);
}

function seedRetainedSize() {
  getDb()
    .prepare(
      `INSERT INTO retained_size_connection(
         connector_instance_id, connector_id, current_record_json_bytes,
         record_history_json_bytes, blob_bytes, record_count, dirty, computed_at
       ) VALUES (?, ?, 100, 10, 5, 1, 0, ?)`
    )
    .run(INSTANCE_ID, CONNECTOR_ID, NOW);
  getDb()
    .prepare(
      `INSERT INTO retained_size_stream(
         connector_instance_id, connector_id, stream, record_count, dirty, computed_at
       ) VALUES (?, ?, ?, 1, 0, ?)`
    )
    .run(INSTANCE_ID, CONNECTOR_ID, STREAM, NOW);
}

// A real terminal run's `collection_facts`, recorded on the spine — the
// same provenance `connector_summary_evidence.stream_latest_facts` is
// reconciled from — but with NO corresponding `run_history` row. Reproduces
// the live gap: a legacy/unattributed run whose facts are real and correct,
// but whose `run_history` backfill could not (or has not yet) landed a row.
function seedTerminalCollectionFactWithoutRunHistory() {
  getDb()
    .prepare(
      `INSERT INTO spine_events(
         event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
         actor_type, actor_id, object_type, object_id, status, run_id, connector_instance_id, data_json, version
       ) VALUES (?, 1, 'run.completed', ?, ?, 'test', ?, 'runtime', 'test-connector', 'run', ?, 'succeeded', ?, ?, ?, '1')`
    )
    .run(
      "evt_manual_freshness_without_run_history",
      NOW,
      NOW,
      "trace_manual_freshness_without_run_history",
      RUN_ID,
      RUN_ID,
      INSTANCE_ID,
      JSON.stringify({
        collection_facts: {
          reference_only: true,
          schema_version: 1,
          streams: [{ checkpoint: "committed", collected: 1, stream: STREAM }],
        },
        connection_id: INSTANCE_ID,
        connector_instance_id: INSTANCE_ID,
      })
    );
}

// biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
async function listBypassCache() {
  return listConnectorSummaries(null, { concurrency: 1, includeRunSummaries: false });
}

function summaryFor(summaries: readonly ConnectorSummary[]): ConnectorSummary {
  const summary = summaries.find((row) => row.connector_instance_id === INSTANCE_ID);
  assert.ok(summary, "summary for the probe connection must be visible");
  return summary;
}

test("a manual-refresh connection with real ingested records but no run_history row surfaces current, non-null freshness instead of an unknown/null one", () =>
  withTempDb(async () => {
    seedConnector();
    seedInstance();
    seedRecord();
    seedRetainedSize();
    seedTerminalCollectionFactWithoutRunHistory();

    // The evidence engine reconciles `stream_latest_facts`/`record_snapshot`
    // straight from the spine event above — never from `run_history` (a
    // separate table this fixture deliberately leaves empty, the live gap
    // this probe reproduces).
    await rebuildConnectorSummaryEvidence();

    const summary = summaryFor(await listBypassCache());

    assert.equal(summary.last_run, null, "fixture premise: genuinely no run_history row exists");
    const streamEntry = summary.collection_report.find((entry) => entry.stream === STREAM);
    assert.ok(streamEntry, "the declared stream must be present in the collection report");
    assert.equal(
      streamEntry.coverage_condition,
      "complete",
      "fixture premise: per-stream coverage is genuinely complete via the spine-reconciled evidence, matching the live symptom"
    );
    assert.ok(
      summary.freshness.captured_at,
      "freshness.captured_at must be populated from retained-size evidence when no run_history row exists"
    );
    assert.equal(
      summary.freshness.status,
      "current",
      "a manual-refresh connection with real evidence must read current, not unknown"
    );
  }));
