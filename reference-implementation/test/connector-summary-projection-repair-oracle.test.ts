// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end projection oracle for the asynchronous summary repair contract.
 *
 * The fail-before assertion proves that a normal read does not silently clear
 * a dirty evidence row. The pass-after assertion runs the existing repair
 * barrier, then reads the same production list projection and proves that the
 * row becomes reliable. A clean sibling is the counterweight: repairing one
 * connection must not make an unrelated connection unreliable.
 *
 * The six streams are deliberately generic. This test exercises the shared
 * projection machinery, not connector-specific behavior.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  markConnectorSummaryEvidenceDirty,
  rebuildConnectorSummaryEvidence,
  reconcileDirtyConnectorSummaryEvidence,
} from "../server/connector-summary-read-model.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { listConnectorSummaries } from "../server/ref-control.ts";

const NOW = "2026-08-12T18:00:00.000Z";
const TARGET_ID = "cin_projection_oracle_target";
const SIBLING_ID = "cin_projection_oracle_sibling";
const CONNECTOR_ID = "projection-oracle";
const STREAMS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"] as const;

function withTempDb(fn: () => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-summary-projection-oracle-"));
    initDb(join(dir, "pdpp.sqlite"));
    try {
      await fn();
    } finally {
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  };
}

function seedFixture(): void {
  const manifest = JSON.stringify({
    connector_id: CONNECTOR_ID,
    display_name: "Projection oracle",
    protocol_version: "0.1.0",
    streams: STREAMS.map((name) => ({ name, primary_key: ["id"] })),
    version: "1.0.0",
  });
  const db = getDb();
  db.prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)").run(
    CONNECTOR_ID,
    manifest,
    NOW
  );
  const insert = db.prepare(
    `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
     ) VALUES (?, 'owner_local', ?, ?, 'active', 'account', ?, '{}', ?, ?, NULL)`
  );
  insert.run(TARGET_ID, CONNECTOR_ID, "target", TARGET_ID, NOW, NOW);
  insert.run(SIBLING_ID, CONNECTOR_ID, "sibling", SIBLING_ID, NOW, NOW);
}

async function summaryFor(connectorInstanceId: string) {
  const summaries = await listConnectorSummaries();
  const summary = summaries.find((row) => row.connector_instance_id === connectorInstanceId);
  assert.ok(summary, `expected summary for ${connectorInstanceId}`);
  return summary;
}

test(
  "dirty evidence is Not measured before repair and reliable after the existing barrier",
  withTempDb(async () => {
    seedFixture();
    await rebuildConnectorSummaryEvidence();

    await markConnectorSummaryEvidenceDirty({
      connectorInstanceId: TARGET_ID,
      reason: "successful six-stream collection changed canonical evidence",
    });

    const before = await summaryFor(TARGET_ID);
    const projectionBefore = before.connection_health.conditions.find(
      (condition) => condition.type === "ProjectionReliable"
    );
    assert.ok(projectionBefore);
    assert.equal(projectionBefore.status, "false");
    assert.equal(before.connection_health.state, "unknown");
    assert.deepEqual(before.connection_health.unknown_reasons, ["summary_evidence_dirty_backstop"]);

    const siblingBefore = await summaryFor(SIBLING_ID);
    const siblingProjectionBefore = siblingBefore.connection_health.conditions.find(
      (condition) => condition.type === "ProjectionReliable"
    );
    assert.ok(siblingProjectionBefore);
    assert.equal(siblingProjectionBefore.status, "true");
    assert.deepEqual(siblingBefore.connection_health.unknown_reasons, []);

    await reconcileDirtyConnectorSummaryEvidence(null);

    const after = await summaryFor(TARGET_ID);
    const projectionAfter = after.connection_health.conditions.find(
      (condition) => condition.type === "ProjectionReliable"
    );
    assert.ok(projectionAfter);
    assert.equal(projectionAfter.status, "true");
    assert.notEqual(after.connection_health.state, "unknown");
    assert.deepEqual(after.connection_health.unknown_reasons, []);
    const evidence = getDb()
      .prepare("SELECT dirty, state FROM connector_summary_evidence WHERE connector_instance_id = ?")
      .get<{ dirty: number; state: string }>(TARGET_ID);
    assert.deepEqual(evidence, { dirty: 0, state: "fresh" });

    const siblingAfter = await summaryFor(SIBLING_ID);
    const siblingProjectionAfter = siblingAfter.connection_health.conditions.find(
      (condition) => condition.type === "ProjectionReliable"
    );
    assert.ok(siblingProjectionAfter);
    assert.equal(siblingProjectionAfter.status, "true");
    assert.deepEqual(siblingAfter.connection_health.unknown_reasons, []);
  })
);
