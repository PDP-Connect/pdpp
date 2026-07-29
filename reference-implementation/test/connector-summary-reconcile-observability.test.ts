// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  reconcileDirtyConnectorSummaryEvidence,
  setConnectorSummaryReconcileObservationSink,
} from "../server/connector-summary-read-model.ts";
import {
  type ConnectorSummaryReconcileObservation,
  createConnectorSummaryReconcileObservationSink,
} from "../server/connector-summary-reconcile-observability.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";

const MISSING_REASON_PATTERN = /"missing":1/;
const PRIVATE_DATA_PATTERN = /owner@example\.test|secret-token-value|opaque-cursor|raw failure text/;

const CLEAN: ConnectorSummaryReconcileObservation = {
  candidateReasonCounts: {},
  candidatesInspected: 41,
  durationMs: 23,
  failed: 0,
  failureClasses: [],
  incomplete: false,
  repaired: 0,
  resumePending: false,
  scopeKind: "complete",
  scopeSize: 41,
  skipped: 0,
};

function captureRecords() {
  const records: Record<string, unknown>[] = [];
  return {
    logger: { info: (record: Record<string, unknown>) => records.push(record) },
    records,
  };
}

test("reconcile telemetry samples successful zero-repair barriers at the configured deterministic rate", () => {
  const { logger, records } = captureRecords();
  const observe = createConnectorSummaryReconcileObservationSink(logger, { zeroRepairSampleEvery: 2 });

  observe(CLEAN);
  assert.equal(records.length, 0, "the first clean barrier is not logged");
  observe(CLEAN);

  assert.deepEqual(records, [
    {
      candidate_reason_counts: {},
      candidates_inspected: 41,
      duration_ms: 23,
      failed: 0,
      failure_classes: [],
      incomplete: false,
      observation: "connector_summary_reconcile",
      repaired: 0,
      resume_state: "none",
      scope_kind: "complete",
      scope_size: 41,
      skipped: 0,
      zero_repair_sample_every: 2,
    },
  ]);
});

test("reconcile telemetry always reports an actual repair with its sanitized candidate reason", () => {
  const { logger, records } = captureRecords();
  const observe = createConnectorSummaryReconcileObservationSink(logger, { zeroRepairSampleEvery: 100 });

  observe({ ...CLEAN, candidateReasonCounts: { missing: 1 }, repaired: 1, scopeKind: "scoped", scopeSize: 1 });

  assert.equal(records.length, 1);
  assert.equal(records[0]?.repaired, 1);
  assert.deepEqual(records[0]?.candidate_reason_counts, { missing: 1 });
  assert.equal(records[0]?.scope_kind, "scoped");
});

test("reconcile telemetry always reports failure and incomplete resume state", () => {
  const { logger, records } = captureRecords();
  const observe = createConnectorSummaryReconcileObservationSink(logger);

  observe({
    ...CLEAN,
    failed: 2,
    failureClasses: ["terminal_facts", "untrusted raw error"],
    incomplete: true,
    resumePending: true,
    skipped: 3,
  });

  assert.equal(records.length, 1);
  assert.equal(records[0]?.failed, 2);
  assert.deepEqual(records[0]?.failure_classes, ["terminal_facts"]);
  assert.equal(records[0]?.incomplete, true);
  assert.equal(records[0]?.resume_state, "pending");
  assert.equal(records[0]?.skipped, 3);
});

test("reconcile telemetry redacts unknown reason data and never spreads caller fields", () => {
  const { logger, records } = captureRecords();
  const observe = createConnectorSummaryReconcileObservationSink(logger, { zeroRepairSampleEvery: 1 });
  const unsafe = {
    ...CLEAN,
    candidateReasonCounts: { missing: 1, "owner@example.test": 9 },
    credential: "secret-token-value",
    cursor: "opaque-cursor",
    error: "raw failure text",
    owner: "owner@example.test",
  } as ConnectorSummaryReconcileObservation;

  observe(unsafe);

  const encoded = JSON.stringify(records[0]);
  assert.match(encoded, MISSING_REASON_PATTERN);
  assert.doesNotMatch(encoded, PRIVATE_DATA_PATTERN);
});

test("a telemetry logger failure cannot change reconciliation control flow", () => {
  const observe = createConnectorSummaryReconcileObservationSink({
    info: () => {
      throw new Error("logging unavailable");
    },
  });

  assert.doesNotThrow(() => observe({ ...CLEAN, repaired: 1 }));
});

test("a throwing observation sink leaves real reconciliation semantics unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-summary-reconcile-observability-"));
  try {
    initDb(join(dir, "pdpp.sqlite"));
    const connectorId = "https://test.pdpp.dev/connectors/observability";
    const instanceId = "cin_observability";
    getDb()
      .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
      .run(connectorId, JSON.stringify({ connector_id: connectorId }), "2026-07-29T00:00:00.000Z");
    getDb()
      .prepare(
        `INSERT INTO connector_instances(
           connector_instance_id, owner_subject_id, connector_id, display_name, status,
           source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
         ) VALUES (?, 'owner_local', ?, 'Observability', 'active', 'account', ?, '{}', ?, ?, NULL)`
      )
      .run(instanceId, connectorId, instanceId, "2026-07-29T00:00:00.000Z", "2026-07-29T00:00:00.000Z");
    setConnectorSummaryReconcileObservationSink(() => {
      throw new Error("telemetry unavailable");
    });

    const result = await reconcileDirtyConnectorSummaryEvidence();
    assert.equal(result.reconciled, 1, "the missing evidence row is still repaired");
    assert.equal(
      getDb().prepare("SELECT state FROM connector_summary_evidence WHERE connector_instance_id = ?").get(instanceId)
        ?.state,
      "fresh",
      "the same durable post-reconcile state is written"
    );
  } finally {
    setConnectorSummaryReconcileObservationSink(null);
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
});
