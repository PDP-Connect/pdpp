// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `count_state: "known_zero"` requires POSITIVE canonical proof of an exact
 * zero, never an absence of evidence.
 *
 * The canonical per-stream read is a `GROUP BY stream` over live records, so
 * it is SPARSE: a stream that was never collected and a stream whose records
 * were all deleted are both simply missing from it. Deriving the count state
 * from that read alone therefore cannot distinguish "the provider genuinely
 * returned nothing" from "we never successfully collected this", and the
 * absent case was being reported as an authoritative exact zero.
 *
 * The record-source checkpoint (`version_counter`) is the orthogonal
 * observation axis that separates them: an entry exists only once ingest
 * allocated a version for that stream, so it is proof the stream WAS
 * canonically observed.
 *
 *   - never observed        -> `unobserved`  (no count claim at all)
 *   - observed, no records  -> `known_zero`  (proven exact zero — preserved)
 *   - observed, has records -> `known`
 *
 * Attempt outcome (a run failed, was interrupted, or never ran) stays on its
 * own axis and is deliberately NOT folded into `count_state`: a failed
 * attempt against a never-observed stream is `unobserved` for the same
 * reason a never-attempted one is — neither produced a canonical count.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { reconcileConnectorSummaryEvidence } from "../server/connector-summary-evidence-engine.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { deleteRecord, ingestRecord } from "../server/records.ts";
import { listConnectorSummaries } from "../server/ref-control.ts";

const OWNER = "owner_local";
const NOW = "2026-08-08T00:00:00.000Z";

async function withTempDb<T>(fn: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-count-state-proof-"));
  try {
    initDb(join(dir, "pdpp.sqlite"));
    return await fn();
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
}

function seedManifestConnector(connectorId: string, streams: string[]) {
  const manifest = {
    capabilities: {
      public_listing: { tier: "supported" },
    },
    connector_id: connectorId,
    display_name: connectorId,
    protocol_version: "0.1.0",
    streams: streams.map((name: string) => ({
      coverage_strategy: "full_inventory",
      name,
      primary_key: ["id"],
      schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
    })),
    version: "1.0.0",
  };
  getDb()
    .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(connectorId, JSON.stringify(manifest), NOW);
  return manifest;
}

function seedInstance(connectorInstanceId: string, connectorId: string): void {
  getDb()
    .prepare(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       ) VALUES (?, ?, ?, ?, 'active', 'account', ?, '{}', ?, ?, NULL)`
    )
    .run(connectorInstanceId, OWNER, connectorId, connectorId, connectorInstanceId, NOW, NOW);
}

function storageTargetFor(connectorId: string, connectorInstanceId: string) {
  return { connector_id: connectorId, connector_instance_id: connectorInstanceId };
}

async function streamEntryFor(connectorInstanceId: string, stream: string) {
  const summaries = await listConnectorSummaries(null, { concurrency: 1 });
  const summary = summaries.find((row) => row.connector_instance_id === connectorInstanceId);
  assert.ok(summary, "the connection is visible");
  const entry = summary.stream_records.find((row) => row.stream === stream);
  assert.ok(entry, `the declared stream ${stream} is visible`);
  return { entry, summary };
}

test("a declared stream that was never canonically observed reads unobserved, never a synthesized known_zero", () =>
  withTempDb(async () => {
    const connectorId = "https://test.pdpp.dev/connectors/never-observed";
    seedManifestConnector(connectorId, ["messages"]);
    seedInstance("cin_never_observed", connectorId);
    // No ingest of any kind: no records, and critically no `version_counter`
    // entry, so nothing has ever canonically observed this stream. This is
    // the live-fleet shape a first sync that never completed leaves behind.
    await reconcileConnectorSummaryEvidence(null);

    const { entry, summary } = await streamEntryFor("cin_never_observed", "messages");
    assert.equal(
      entry.count_state,
      "unobserved",
      "an absent canonical row is an absence of evidence, NOT proof the provider returned nothing"
    );
    assert.equal(entry.declaration_state, "declared", "declaration is an orthogonal axis and still reads declared");
    assert.equal(
      summary.total_records_state,
      "unobserved",
      "the aggregate cannot claim an exact zero when its only stream was never observed"
    );
  }));

test("a stream whose only collection attempt failed reads unobserved, and the failure stays off the count axis", () =>
  withTempDb(async () => {
    const connectorId = "https://test.pdpp.dev/connectors/attempted-then-failed";
    seedManifestConnector(connectorId, ["messages"]);
    seedInstance("cin_failed", connectorId);
    // A collection attempt ran against this connection and terminated
    // without ever committing a record for the stream — the shape an auth
    // failure or an interrupted collector leaves behind. The attempt is
    // recorded on the run axis (a schedule row that has been touched),
    // while the stream itself still has NO canonical observation: no
    // records, and no `version_counter` entry.
    getDb()
      .prepare(
        `INSERT INTO connector_schedules(connector_instance_id, connector_id, interval_seconds, created_at, updated_at)
         VALUES (?, ?, 3600, ?, ?)`
      )
      .run("cin_failed", connectorId, NOW, NOW);
    await reconcileConnectorSummaryEvidence(null);

    const observedRow = getDb()
      .prepare("SELECT COUNT(*) AS n FROM version_counter WHERE connector_instance_id = ?")
      .get("cin_failed") as { n: number } | undefined;
    assert.equal(
      observedRow?.n,
      0,
      "fixture premise: the failed attempt allocated no version, so nothing canonically observed the stream"
    );

    const { entry } = await streamEntryFor("cin_failed", "messages");
    assert.equal(
      entry.count_state,
      "unobserved",
      "a failed attempt produced no canonical count, so the stream stays unobserved"
    );
    // The ruling keeps attempt/failure ORTHOGONAL: `count_state` carries only
    // what is known about the COUNT. That a run failed is carried by the run
    // and health surfaces, and must never be laundered into the count
    // vocabulary — asserted here so a future change cannot fold it in.
    assert.ok(
      !["failed", "attempt_failed", "error"].includes(entry.count_state),
      "attempt outcome must never appear in the count vocabulary"
    );
  }));

test("a genuinely observed stream emptied by deletes still reads known_zero — a true zero is preserved", () =>
  withTempDb(async () => {
    const connectorId = "https://test.pdpp.dev/connectors/proven-zero";
    seedManifestConnector(connectorId, ["messages"]);
    seedInstance("cin_proven_zero", connectorId);
    // Ingest allocates a version (the canonical observation), then the
    // record is deleted. Live canonical records are now zero, but the
    // checkpoint proves the stream WAS observed — this is an exact,
    // provable zero and must keep reading known_zero.
    await ingestRecord(storageTargetFor(connectorId, "cin_proven_zero"), {
      data: { id: "msg_1" },
      emitted_at: NOW,
      key: "msg_1",
      stream: "messages",
    });
    await deleteRecord(storageTargetFor(connectorId, "cin_proven_zero"), "messages", "msg_1");
    await reconcileConnectorSummaryEvidence(null);

    const { entry } = await streamEntryFor("cin_proven_zero", "messages");
    assert.equal(entry.record_count, 0, "fixture premise: no live canonical records remain");
    assert.equal(
      entry.count_state,
      "known_zero",
      "an observed stream with no live records is a PROVEN exact zero — the fix must not over-correct true zeros away"
    );
  }));

test("a stream with live records still reads known, and a mixed connection does not claim an aggregate zero", () =>
  withTempDb(async () => {
    const connectorId = "https://test.pdpp.dev/connectors/mixed";
    seedManifestConnector(connectorId, ["messages", "attachments"]);
    seedInstance("cin_mixed", connectorId);
    // Only `messages` is ever collected; `attachments` is declared but never
    // observed. The two streams must land on different count states from the
    // same repair pass.
    await ingestRecord(storageTargetFor(connectorId, "cin_mixed"), {
      data: { id: "msg_1" },
      emitted_at: NOW,
      key: "msg_1",
      stream: "messages",
    });
    await reconcileConnectorSummaryEvidence(null);

    const { entry: messages, summary } = await streamEntryFor("cin_mixed", "messages");
    assert.equal(messages.count_state, "known", "a collected stream reports its exact count");
    assert.equal(messages.record_count, 1);

    const { entry: attachments } = await streamEntryFor("cin_mixed", "attachments");
    assert.equal(
      attachments.count_state,
      "unobserved",
      "a sibling stream that was never collected is unobserved even though the connection has data"
    );
    assert.equal(summary.total_records_state, "known", "a nonzero total is a real measurement");
  }));
